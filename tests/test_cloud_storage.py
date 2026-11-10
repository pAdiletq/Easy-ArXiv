"""Offline cloud regressions: multiple workers share durable state, never secrets."""

import copy
import sys
import threading
import time
import unittest
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import HTTPException
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server
from cloud_store import FirestoreStore, opaque_id


class Snapshot:
    def __init__(self, value):
        self.exists = value is not None
        self.value = copy.deepcopy(value)

    def to_dict(self):
        return copy.deepcopy(self.value)


class Reference:
    def __init__(self, database, path):
        self.database, self.path = database, path

    def collection(self, name):
        return Collection(self.database, self.path + "/" + name)

    def get(self, **kwargs):
        return Snapshot(self.database.get(self.path))

    def set(self, value, **kwargs):
        self.database[self.path] = copy.deepcopy(value)

    def create(self, value, **kwargs):
        if self.path in self.database:
            raise ValueError("Document already exists")
        self.set(value)

    def delete(self, **kwargs):
        self.database.pop(self.path, None)


class Collection:
    def __init__(self, database, path):
        self.database, self.path = database, path

    def document(self, identifier):
        return Reference(self.database, self.path + "/" + identifier)

    def stream(self, **kwargs):
        prefix = self.path + "/"
        return [Snapshot(value) for path, value in self.database.items()
                if path.startswith(prefix) and "/" not in path[len(prefix):]]


class Transaction:
    def set(self, reference, value):
        reference.set(value)

    def delete(self, reference):
        reference.delete()


class FirestoreMemory:
    """Shared document data models a provider; recreated clients model workers."""
    def __init__(self):
        self.documents = {}
        self.lock = threading.RLock()

    def client(self):
        provider = self

        class Client:
            def collection(self, name):
                return Collection(provider.documents, name)

            def transaction(self):
                return Transaction()

        return Client()

    def transactional(self, function):
        def run(transaction):
            with self.lock:
                return function(transaction)
        return run

    def store(self):
        return FirestoreStore("test-project", client=self.client(), transactional=self.transactional)


class DurableStoreTests(unittest.TestCase):
    def test_session_survives_new_worker_without_storing_token_or_provider_credentials(self):
        provider = FirestoreMemory()
        provider.store().put_session("test-opaque-browser-token", time.time() + 60,
            {"orcid": "0000-0001-2345-6789", "name": "Researcher", "access_token": "synthetic-test-do-not-store"})
        user = provider.store().get_session("test-opaque-browser-token", time.time())
        self.assertEqual(user, {"orcid": "0000-0001-2345-6789", "name": "Researcher"})
        self.assertNotIn("test-opaque-browser-token", repr(provider.documents))
        self.assertNotIn("synthetic-test-do-not-store", repr(provider.documents))
        self.assertIsNone(provider.store().get_session("unknown", time.time()))
        self.assertIsNone(provider.store().get_session("test-opaque-browser-token", time.time() + 120))
        provider.store().delete_session("test-opaque-browser-token")
        self.assertIsNone(provider.store().get_session("test-opaque-browser-token", time.time()))

    def test_oauth_state_can_only_be_consumed_once_across_workers(self):
        provider = FirestoreMemory()
        provider.store().put_state("state", time.time() + 60)
        self.assertTrue(provider.store().consume_state("state", time.time()))
        self.assertFalse(provider.store().consume_state("state", time.time()))
        provider.store().put_state("expired", time.time() - 1)
        self.assertFalse(provider.store().consume_state("expired", time.time()))

    def test_paper_storage_is_durable_idempotent_and_separate_for_each_user(self):
        provider = FirestoreMemory()
        paper = {"id": "hep-th/9901001", "title": "Original"}
        provider.store().saved("save", "user-a", paper)
        original = provider.store().saved("list", "user-a")[0]
        provider.store().saved("save", "user-a", {**paper, "title": "Updated"})
        self.assertEqual(provider.store().saved("list", "user-b"), [])
        provider.store().saved("delete", "user-b", paper_id=paper["id"])
        updated = provider.store().saved("list", "user-a")
        self.assertEqual(len(updated), 1)
        self.assertEqual(updated[0]["title"], "Updated")
        self.assertEqual(updated[0]["saved_at"], original["saved_at"])
        self.assertIn(opaque_id(paper["id"]), repr(provider.documents))
        provider.store().saved("delete", "user-a", paper_id=paper["id"])
        self.assertEqual(provider.store().saved("list", "user-a"), [])

    def test_ai_limits_share_counts_between_workers_and_accounts(self):
        provider = FirestoreMemory()
        today = datetime(2026, 10, 23, tzinfo=timezone.utc)
        self.assertTrue(provider.store().claim_ai_quota("user-a", today, 1, 2))
        self.assertFalse(provider.store().claim_ai_quota("user-a", today, 1, 2))
        self.assertTrue(provider.store().claim_ai_quota("user-b", today, 1, 2))
        self.assertFalse(provider.store().claim_ai_quota("user-c", today, 1, 2))
        self.assertTrue(provider.store().claim_ai_quota("user-a", today.replace(day=24), 1, 2))


class CloudServerTests(unittest.TestCase):
    def setUp(self):
        self.provider = FirestoreMemory()
        for name, value in {
            "CLOUD_DEPLOYMENT": True, "SAVED_STORE": "firestore", "PUBLIC_ORIGIN": "https://papers.example",
            "FIRESTORE_PROJECT": "test-project", "_cloud_store": self.provider.store(),
            "_quest_cache": {}, "ORCID_CONFIGURED": True, "ORCID_CLIENT_ID": "test-id",
            "ORCID_CLIENT_SECRET": "synthetic-test-client-secret", "ORCID_REDIRECT_URI": "https://papers.example/auth/callback",
        }.items():
            setting = patch.object(server, name, value)
            setting.start()
            self.addCleanup(setting.stop)
        self.client = TestClient(server.app, base_url="https://papers.example")

    def authenticate(self):
        token = "test-session-opaque"
        self.provider.store().put_session(token, time.time() + 600, {"orcid": "0000-0001-2345-6789", "name": "Test"})
        self.client.cookies.set("easy_arxiv_session", token)

    def test_proxy_headers_cannot_override_configured_mutation_origin(self):
        self.authenticate()
        paper = {"id": "1706.03762", "title": "Attention Is All You Need"}
        for headers in (
            {"Origin": "https://attacker.example", "X-Easy-Arxiv-Public-Origin": "https://attacker.example"},
            {"Origin": "https://attacker.example", "X-Forwarded-Host": "attacker.example", "X-Forwarded-Proto": "https"},
            {"Origin": "https://attacker.example", "Host": "attacker.example"},
            {"Origin": "https://papers.example/"}, {},
            {"Origin": "https://papers.example", "Sec-Fetch-Site": "cross-site"},
        ):
            with self.subTest(headers=headers):
                self.assertEqual(self.client.post("/api/saved", json={"paper": paper}, headers=headers).status_code, 403)
        result = self.client.post("/api/saved", json={"paper": paper}, headers={"Origin": "https://papers.example"})
        self.assertEqual(result.status_code, 200)

    def test_oauth_callback_session_and_logout_survive_worker_changes(self):
        oauth = AsyncMock()
        oauth.__aenter__.return_value = oauth
        oauth.post.return_value = httpx.Response(200,
            json={"orcid": "0000-0001-2345-6789", "name": "Test", "access_token": "synthetic-test-provider-token"},
            request=httpx.Request("POST", "https://orcid.org/oauth/token"))
        start = self.client.get("/auth/login", follow_redirects=False)
        state = urllib.parse.parse_qs(urllib.parse.urlsplit(start.headers["location"]).query)["state"][0]
        self.assertIn("Secure", start.headers["set-cookie"])
        server._cloud_store = self.provider.store()  # callback reaches another instance
        with patch.object(server.httpx, "AsyncClient", return_value=oauth):
            done = self.client.get("/auth/callback", params={"code": "test-code", "state": state}, follow_redirects=False)
            self.assertEqual(done.status_code, 303)
            self.assertIn("Secure", done.headers["set-cookie"])
            replay = self.client.get("/auth/callback", params={"code": "test-code", "state": state}, follow_redirects=False)
            self.assertEqual(replay.status_code, 400)
            oauth.post.assert_awaited_once()
        server._cloud_store = self.provider.store()
        self.assertTrue(self.client.get("/api/session").json()["authenticated"])
        self.assertNotIn("synthetic-test-provider-token", repr(self.provider.documents))
        self.assertNotIn("synthetic-test-client-secret", self.client.get("/api/config").text)
        self.assertEqual(self.client.post("/auth/logout", headers={"Origin": "https://papers.example"}).status_code, 200)
        server._cloud_store = self.provider.store()
        self.assertFalse(self.client.get("/api/session").json()["authenticated"])

    def test_unavailable_cloud_store_never_falls_back_to_sqlite_or_memory(self):
        broken = AsyncMock()
        broken.get_session = lambda *args: (_ for _ in ()).throw(RuntimeError("sensitive-provider-error"))
        with patch.object(server, "_cloud_store", broken), patch.object(server, "saved_store") as sqlite:
            self.client.cookies.set("easy_arxiv_session", "token")
            response = self.client.get("/api/session")
            self.assertEqual(response.status_code, 503)
            self.assertNotIn("sensitive-provider-error", response.text)
            sqlite.assert_not_called()

    def test_cloud_ai_requires_login_then_enforces_shared_quota_before_provider_call(self):
        with patch.object(server, "GOOGLE_API_KEY", "synthetic-test-api-key"), \
             patch.object(server, "download_pdf", new_callable=AsyncMock) as download:
            guest = self.client.get("/api/getPaperData", params={"pdf": "https://arxiv.org/pdf/1706.03762"})
            self.assertEqual(guest.status_code, 401)
            self.authenticate()
            server._cloud_store.claim_ai_quota = lambda *args: False
            result = self.client.get("/api/getPaperData", params={"pdf": "https://arxiv.org/pdf/1706.03762"},
                                     headers={"Sec-Fetch-Site": "same-origin"})
            self.assertEqual(result.status_code, 429)
            self.assertEqual(result.headers["cache-control"], "no-store")
            download.assert_not_called()

    def test_production_configuration_rejects_ephemeral_store_bad_origin_and_credentials_file(self):
        with patch.dict(server.os.environ, {"GOOGLE_APPLICATION_CREDENTIALS": "", "FIRESTORE_EMULATOR_HOST": ""}):
            server.validate_deployment_config()
            for setting, value in (("SAVED_STORE", "sqlite"), ("FIRESTORE_PROJECT", None),
                                   ("PUBLIC_ORIGIN", "http://papers.example"),
                                   ("PUBLIC_ORIGIN", "https://papers.example/path")):
                with self.subTest(setting=setting, value=value), patch.object(server, setting, value), self.assertRaises(RuntimeError):
                    server.validate_deployment_config()
            with patch.dict(server.os.environ, {"GOOGLE_APPLICATION_CREDENTIALS": "/secret-key.json"}), self.assertRaises(RuntimeError):
                server.validate_deployment_config()


if __name__ == "__main__":
    unittest.main()
