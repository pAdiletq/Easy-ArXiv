"""Durable, server-only Firestore storage using Cloud Run's service identity.

No service-account key files or browser Firebase credentials are used. Tokens are
opaque random values; only their hashes and public ORCID identities are stored.
Firestore TTL policies on ``expires_at`` clean expired auth/quota records. The
application checks expiry itself, so delayed TTL deletion cannot extend access.
"""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import Any


def opaque_id(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


class FirestoreStore:
    def __init__(self, project: str, database: str = "(default)", *, client=None, transactional=None):
        if client is None:
            # Import only in cloud mode; local SQLite development does not need ADC.
            from google.cloud import firestore

            client = firestore.Client(project=project, database=database)
            transactional = firestore.transactional
        self.client = client
        self.transactional = transactional

    def probe(self) -> None:
        # A missing document is fine; permission/network/database errors are not.
        self.client.collection("easy_arxiv_health").document("ready").get(timeout=10, retry=None)

    def _auth(self, kind: str, token: str):
        return self.client.collection("easy_arxiv_" + kind).document(opaque_id(token))

    def put_session(self, token: str, expires: float, user: dict) -> None:
        # Deliberately allowlist fields: never persist the OAuth provider response.
        identity = {"orcid": user["orcid"], "name": user.get("name", "Researcher")}
        self._auth("sessions", token).set({"user": identity, "expires_at": datetime.fromtimestamp(expires, timezone.utc)}, timeout=10, retry=None)

    def get_session(self, token: str, now: float) -> dict | None:
        if not token or len(token) > 256:
            return None
        document = self._auth("sessions", token).get(timeout=10, retry=None)
        data = document.to_dict() if document.exists else None
        if not data or data["expires_at"].timestamp() <= now:
            return None
        return data["user"]

    def delete_session(self, token: str) -> None:
        if token and len(token) <= 256:
            self._auth("sessions", token).delete(timeout=10, retry=None)

    def put_state(self, state: str, expires: float) -> None:
        self._auth("oauth_states", state).create({"expires_at": datetime.fromtimestamp(expires, timezone.utc)}, timeout=10, retry=None)

    def consume_state(self, state: str, now: float) -> bool:
        if not state or len(state) > 256:
            return False
        reference = self._auth("oauth_states", state)

        @self.transactional
        def consume(transaction):
            snapshot = reference.get(transaction=transaction, timeout=10, retry=None)
            if not snapshot.exists:
                return False
            data = snapshot.to_dict()
            transaction.delete(reference)
            return data["expires_at"].timestamp() > now

        return consume(self.client.transaction())

    def saved(self, operation: str, owner: str, paper: dict | None = None, paper_id: str | None = None) -> Any:
        collection = self.client.collection("easy_arxiv_users").document(owner).collection("papers")
        if operation == "list":
            records = []
            for snapshot in collection.stream(timeout=15, retry=None):
                data = snapshot.to_dict()
                records.append({**data["paper"], "saved_at": data["saved_at"]})
            return sorted(records, key=lambda item: (item["saved_at"], item["id"]), reverse=True)
        if operation == "delete":
            collection.document(opaque_id(paper_id)).delete(timeout=10, retry=None)
            return None
        if operation != "save" or paper is None:
            raise ValueError("Unknown saved-paper operation")
        reference = collection.document(opaque_id(paper["id"]))

        @self.transactional
        def save(transaction):
            previous = reference.get(transaction=transaction, timeout=10, retry=None)
            saved_at = previous.to_dict()["saved_at"] if previous.exists else datetime.now(timezone.utc).isoformat()
            transaction.set(reference, {"paper": paper, "saved_at": saved_at})

        save(self.client.transaction())
        return paper

    def claim_ai_quota(self, owner: str, now: datetime, user_limit: int, global_limit: int) -> bool:
        """Atomically reserve one provider call across every Cloud Run instance."""
        day = now.astimezone(timezone.utc).strftime("%Y-%m-%d")
        collection = self.client.collection("easy_arxiv_ai_quotas")
        references = [collection.document(day + "_global"), collection.document(day + "_" + opaque_id(owner))]
        expires = datetime.fromtimestamp(now.timestamp() + 3 * 86400, timezone.utc)

        @self.transactional
        def claim(transaction):
            # Firestore transactions require all reads before any writes.
            counts = []
            for reference in references:
                snapshot = reference.get(transaction=transaction, timeout=10, retry=None)
                counts.append(snapshot.to_dict().get("count", 0) if snapshot.exists else 0)
            if counts[0] >= global_limit or counts[1] >= user_limit:
                return False
            for reference, count in zip(references, counts):
                transaction.set(reference, {"count": count + 1, "expires_at": expires})
            return True

        return claim(self.client.transaction())
