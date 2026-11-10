"""Offline regression tests. No arXiv, PDF, OAuth, or AI network requests are made."""

import sys
import unittest
import re
import urllib.parse
import asyncio
import json
import tempfile
from datetime import datetime, timezone, timedelta
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx

from fastapi import HTTPException
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import server


FEED = '''<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">
  <opensearch:totalResults>42</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <title> Attention Is All\n You Need </title>
    <summary>A research paper about attention.</summary>
    <published>2017-06-12T00:00:00Z</published>
    <updated>2023-08-02T00:00:00Z</updated>
    <author><name>Ashish Vaswani</name></author>
    <category term="cs.CL"/>
    <link title="pdf" href="http://arxiv.org/pdf/1706.03762v7"/>
  </entry>
</feed>'''


class ServerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="easy-arxiv-api-tests-")
        self.addCleanup(temporary.cleanup)
        runtime = Path(temporary.name)
        for name, value in (("DATABASE_PATH", runtime / "saved.sqlite"), ("STATS_CACHE_PATH", runtime / "monthly-stats.json"),
                            ("_stats_data", None), ("_stats_fetched_at", 0.0), ("_stats_failed_at", 0.0),
                            ("_stats_loaded_from_disk", False), ("_search_cache", {}), ("_sessions", {})):
            item = patch.object(server, name, value)
            item.start()
            self.addCleanup(item.stop)
        self.client = TestClient(server.app)

    def authenticate(self, owner="0000-0001-2345-6789"):
        token = "test-session-" + owner
        server._sessions[token] = (server.time.time() + 600, {"orcid": owner, "name": "Test Researcher"})
        self.client.cookies.set("easy_arxiv_session", token)

    def test_health(self):
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ok")

    def test_pages_exist_and_have_html_response(self):
        for path in ("/", "/papers", "/read", "/saved", "/quest", "/ai_quest"):
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 200)
                self.assertIn("text/html", response.headers["content-type"])
                self.assertIn("Easy", response.text)

    def test_all_page_script_and_stylesheet_assets_are_served(self):
        paths = set()
        for page in ("/", "/papers", "/read", "/saved", "/quest"):
            html = self.client.get(page).text
            paths.update(re.findall(r'(?:src|href)=["\'](/static/[^"\']+)["\']', html))
        for path in paths:
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 200)
                media_type = response.headers["content-type"].split(";")[0]
                if path.endswith(".js"):
                    self.assertIn(media_type, {"text/javascript", "application/javascript"})
                elif path.endswith(".css"):
                    self.assertEqual(media_type, "text/css")
        for module in ("core.js", "app.js", "quest.js"):
            response = self.client.get(f"/static/js/{module}")
            self.assertEqual(response.status_code, 200)
            self.assertIn(response.headers["content-type"].split(";")[0], {"text/javascript", "application/javascript"})

    def test_public_configuration_never_contains_secrets(self):
        with patch.object(server, "GOOGLE_API_KEY", "private-test-key"), \
             patch.object(server, "ORCID_CLIENT_SECRET", "private-test-secret"):
            response = self.client.get("/api/config")
        self.assertTrue(response.json()["ai_quest_configured"])
        self.assertNotIn("private-test", response.text)
        self.assertEqual(response.headers["cache-control"], "no-store")

    def test_search_rejects_invalid_inputs_without_network(self):
        invalid = (
            {}, {"query": "   "}, {"query": "x", "start": -1}, {"query": "x", "max_results": 51},
            {"query": "x", "sort_by": "invalid"}, {"query": "x", "sort_order": "drop"},
            {"query": "x", "date_from": "2026-02-30"},
            {"query": "x", "date_from": "2026-09-01", "date_to": "2026-01-01"},
            {"query": "https://example.com/abs/1706.03762"},
        )
        with patch.object(server, "query_arxiv", new_callable=AsyncMock) as network:
            for params in invalid:
                with self.subTest(params=params):
                    self.assertEqual(self.client.get("/api/search_papers", params=params).status_code, 422)
            network.assert_not_called()

    def test_search_uses_real_feed_contract(self):
        expected = server.parse_feed(FEED, 0)
        with patch.object(server, "query_arxiv", new_callable=AsyncMock, return_value=expected) as query:
            response = self.client.get("/api/search_papers", params={"query": "attention", "max_results": 15})
        self.assertEqual(response.status_code, 200)
        paper = response.json()["papers"][0]
        self.assertEqual(paper["title"], "Attention Is All You Need")
        self.assertEqual(paper["pdf_url"], "https://arxiv.org/pdf/1706.03762v7")
        self.assertEqual(paper["id"], "1706.03762v7")
        self.assertEqual(response.json()["total"], 42)
        self.assertTrue(response.json()["has_more"])
        self.assertEqual(query.call_args.args[0]["search_query"], 'all:"attention"')

    def test_url_search_uses_id_instead_of_search_expression(self):
        params = server.search_params("https://arxiv.org/abs/1706.03762", "relevance", "descending", None, None, 0, 15)
        self.assertEqual(params["id_list"], "1706.03762")
        self.assertNotIn("search_query", params)

    def test_catalog_without_topic_queries_archive_with_date_range(self):
        with patch.object(server, "query_arxiv", new_callable=AsyncMock, return_value=server.parse_feed(FEED, 0)) as query:
            response = self.client.get("/api/recent_papers", params={"max_results": 15})
        self.assertEqual(response.status_code, 200)
        params = query.call_args.args[0]
        self.assertTrue(params["search_query"].startswith("submittedDate:[199107010000 TO "))
        self.assertNotIn("all:", params["search_query"])
        self.assertEqual(params["sortBy"], "submittedDate")
        self.assertEqual(params["sortOrder"], "descending")
        self.assertEqual(response.json()["source"], "arXiv API")

    def test_catalog_filters_and_invalid_date_range(self):
        with patch.object(server, "query_arxiv", new_callable=AsyncMock, return_value=server.parse_feed(FEED, 15)) as query:
            response = self.client.get("/api/recent_papers", params={"start": 15, "date_from": "2025-01-01", "date_to": "2025-12-31"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(query.call_args.args[0]["search_query"], "submittedDate:[202501010000 TO 202512312359]")
        with patch.object(server, "query_arxiv", new_callable=AsyncMock) as query:
            response = self.client.get("/api/recent_papers", params={"date_from": "2026-10-22", "date_to": "2026-01-01"})
        self.assertEqual(response.status_code, 422)
        query.assert_not_called()

    def test_date_range_and_compatibility_sort(self):
        params = server.search_params("deep learning", "date-asc", "descending", "2025-01-01", "2025-12-31", 0, 15)
        self.assertEqual(params["sortOrder"], "ascending")
        self.assertIn("202501010000 TO 202512312359", params["search_query"])

    def test_canonical_urls_and_old_identifiers(self):
        for source, expected in (
            ("https://arxiv.org/abs/1706.03762v7", "https://arxiv.org/pdf/1706.03762v7"),
            ("https://export.arxiv.org/pdf/hep-th/9901001.pdf", "https://arxiv.org/pdf/hep-th/9901001"),
        ):
            self.assertEqual(server.canonical_pdf_url(source), expected)

    def test_pdf_urls_reject_private_hosts_credentials_and_redirect_tricks(self):
        for url in (
            "http://arxiv.org/pdf/1706.03762", "https://127.0.0.1/pdf/1706.03762",
            "https://arxiv.org.evil.test/pdf/1706.03762", "https://user@arxiv.org/pdf/1706.03762",
            "https://arxiv.org:8443/pdf/1706.03762", "https://arxiv.org/pdf/../../secret",
            "https://arxiv.org/pdf/1706.03762?redirect=evil", "https://arxiv.org/pdf/1706.03762#fake",
        ):
            with self.subTest(url=url), self.assertRaises(HTTPException):
                server.canonical_pdf_url(url)

    def test_ai_configuration_error_precedes_pdf_download(self):
        with patch.object(server, "GOOGLE_API_KEY", None), \
             patch.object(server, "download_pdf", new_callable=AsyncMock) as download:
            response = self.client.get("/api/getPaperData", params={"pdf": "https://arxiv.org/pdf/1706.03762"})
        self.assertEqual(response.status_code, 503)
        download.assert_not_called()

    def test_invalid_ai_url_does_not_download(self):
        with patch.object(server, "download_pdf", new_callable=AsyncMock) as download:
            response = self.client.get("/api/getPaperData", params={"pdf": "https://example.com/a.pdf"})
        self.assertEqual(response.status_code, 422)
        download.assert_not_called()

    def test_provider_json_and_question_validation(self):
        self.assertEqual(server.parse_ai_json('```json\n{"ok":true}\n```'), {"ok": True})
        with self.assertRaises(HTTPException):
            server.parse_ai_json("Not JSON")
        valid = {"questions": {f"q{i}": {"question": f"Q{i}", "options": ["A", "B", "C", "D"], "answer": 1}
                               for i in range(9, 0, -1)}}
        self.assertEqual(server.normalize_questions(valid)["questions"]["q1"]["question"], "Q1")
        valid["questions"]["q1"]["answer"] = True
        with self.assertRaises(HTTPException):
            server.normalize_questions(valid)

    def test_ai_cards_require_nine_complete_topics(self):
        valid = {"flashcards": [{f"Topic {i}": f"Explanation {i}"} for i in range(9)]}
        self.assertEqual(len(server.normalize_cards(valid)["flashcards"]), 9)
        with self.assertRaises(HTTPException):
            server.normalize_cards({"flashcards": [{"Topic": ""}] * 9})

    def test_structured_generation_requests_exact_counts_and_ignores_thought_parts(self):
        provider = AsyncMock()
        provider.__aenter__.return_value = provider
        provider.post.return_value = httpx.Response(200,
            json={"candidates": [{"finishReason": "STOP", "content": {"parts": [
                {"thought": True, "text": "Not part of the JSON output"}, {"text": '{"ok":true}'}]}}]},
            request=httpx.Request("POST", "https://generativelanguage.googleapis.com/test"))
        with patch.object(server, "GOOGLE_API_KEY", "private-test-key"), \
             patch.object(server.httpx, "AsyncClient", return_value=provider):
            result = asyncio.run(server.generate_ai_json("A source paper", schema=server.STUDY_SESSION_SCHEMA))
        self.assertEqual(result, {"ok": True})
        settings = provider.post.call_args.kwargs["json"]["generationConfig"]
        self.assertEqual(settings["responseMimeType"], "application/json")
        self.assertEqual(settings["maxOutputTokens"], 8192)
        schema = settings["responseJsonSchema"]
        for key in ("flashcards", "questions"):
            self.assertEqual(schema["properties"][key]["minItems"], 9)
            self.assertEqual(schema["properties"][key]["maxItems"], 9)
        question = schema["properties"]["questions"]["items"]["properties"]
        self.assertEqual(question["options"]["minItems"], 4)
        self.assertEqual(question["options"]["maxItems"], 4)
        self.assertEqual((question["answer"]["minimum"], question["answer"]["maximum"]), (0, 3))

    def test_quest_uses_one_structured_call_and_preserves_frontend_contract(self):
        study = {"flashcards": [{"topic": f"Topic {index}", "content": f"Explanation {index}"} for index in range(9)],
                 "questions": [{"question": f"Question {index}", "options": ["A", "B", "C", "D"], "answer": index % 4,
                                "explanation": f"Reason {index}"} for index in range(9)]}
        with patch.object(server, "GOOGLE_API_KEY", "private-test-key"), patch.object(server, "_quest_cache", {}), \
             patch.object(server, "download_pdf", new_callable=AsyncMock, return_value=b"%PDF-memory"), \
             patch.object(server, "extract_text_from_pdf", return_value="Paper source text"), \
             patch.object(server, "generate_ai_json", new_callable=AsyncMock, return_value=study) as generate:
            response = self.client.get("/api/getPaperData", params={"pdf": "https://arxiv.org/pdf/1706.03762"})
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(len(data["flashcards"]["flashcards"]), 9)
        self.assertEqual(data["flashcards"]["flashcards"][0], {"Topic 0": "Explanation 0"})
        self.assertEqual(len(data["questions"]["questions"]), 9)
        self.assertEqual(data["questions"]["questions"]["q1"]["explanation"], "Reason 0")
        generate.assert_awaited_once()
        self.assertIs(generate.call_args.kwargs["schema"], server.STUDY_SESSION_SCHEMA)

    def test_extra_questions_and_duplicate_options_are_rejected_not_trimmed(self):
        questions = {f"q{i}": {"question": f"Q{i}", "options": ["A", "B", "C", "D"], "answer": 0} for i in range(1, 11)}
        with self.assertRaises(HTTPException):
            server.normalize_questions({"questions": questions})
        questions.pop("q10")
        questions["q1"]["options"] = ["Answer", "answer", "Other", "Another"]
        with self.assertRaises(HTTPException):
            server.normalize_questions({"questions": questions})

    def test_bad_xml_never_becomes_successful_empty_search(self):
        for data in ("<feed", "<html>maintenance</html>"):
            with self.assertRaises(HTTPException):
                server.parse_feed(data, 0)

    def test_stats_exclude_partial_current_month_and_sort(self):
        content = "month,submissions,historical_delta\n2026-10,30136,0\n2026-08,31173,0\n2026-09,40363,0\n"
        result = server.parse_monthly_stats(content, datetime(2026, 10, 22, tzinfo=timezone.utc))
        self.assertEqual([item["period"] for item in result], ["2026-08", "2026-09"])
        self.assertEqual(result[-1]["value"], 40363)
        with self.assertRaises(ValueError):
            server.parse_monthly_stats("<html>Unavailable</html>")

    def test_stats_use_cached_source_and_keep_original_timestamp(self):
        data = {"months": [{"label": "Sep", "period": "2026-09", "value": 40363}],
                "source_url": server.ARXIV_STATS_PAGE, "updated_at": "2026-10-22T00:00:00+00:00", "stale": False}
        with patch.object(server, "_stats_data", data), \
             patch.object(server, "_stats_fetched_at", server.time.monotonic()):
            response = self.client.get("/api/stats")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["updated_at"], data["updated_at"])
        self.assertEqual(response.json()["source_url"], server.ARXIV_STATS_PAGE)

    def test_stats_outage_is_not_faked_as_empty_live_data(self):
        with patch.object(server, "_stats_data", None), \
             patch.object(server, "_stats_failed_at", server.time.monotonic()):
            response = self.client.get("/api/stats")
        self.assertEqual(response.status_code, 503)

    def test_stats_retry_official_mirror_and_persist_last_success(self):
        provider = AsyncMock()
        provider.__aenter__.return_value = provider
        provider.get.side_effect = [
            httpx.Response(503, request=httpx.Request("GET", server.ARXIV_STATS_CSV)),
            httpx.Response(200, text="month,submissions,historical_delta\n2026-08,31173,0\n2026-09,40363,0\n",
                           request=httpx.Request("GET", server.ARXIV_STATS_MIRROR)),
        ]
        with patch.object(server.httpx, "AsyncClient", return_value=provider):
            response = self.client.get("/api/stats")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(provider.get.await_count, 2)
        self.assertEqual(response.json()["dataset_url"], server.ARXIV_STATS_MIRROR)
        self.assertTrue(server.STATS_CACHE_PATH.is_file())
        stored = json.loads(server.STATS_CACHE_PATH.read_text(encoding="utf-8"))
        self.assertEqual(stored["updated_at"], response.json()["updated_at"])
        self.assertLess(server.STATS_CACHE_PATH.stat().st_size, 32768)

    def test_stats_restore_stale_snapshot_after_restart_with_original_date(self):
        fetched = (datetime.now(timezone.utc) - timedelta(hours=7)).isoformat()
        snapshot = {"months": [{"label": "Aug", "period": "2026-08", "value": 31173},
                               {"label": "Sep", "period": "2026-09", "value": 40363}],
                    "source_url": server.ARXIV_STATS_PAGE, "dataset_url": server.ARXIV_STATS_CSV,
                    "updated_at": fetched, "period_label": "Aug–Sep 2026", "stale": False}
        server.write_stats_snapshot(snapshot)
        with patch.object(server, "_stats_failed_at", server.time.monotonic()), \
             patch.object(server.httpx, "AsyncClient") as provider:
            response = self.client.get("/api/stats")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["stale"])
        self.assertEqual(response.json()["updated_at"], fetched)
        provider.assert_not_called()

    def test_suggestions_are_local_topics_and_cached_titles_without_upstream_requests(self):
        server.remember(server._search_cache, "recent-attention", server.parse_feed(FEED, 0), 128)
        with patch.object(server.httpx, "AsyncClient") as provider:
            response = self.client.get("/api/suggestions", params={"query": "attention"})
        self.assertEqual(response.status_code, 200)
        suggestions = response.json()["suggestions"]
        self.assertTrue(any(item["type"] == "topic" for item in suggestions))
        paper = next(item for item in suggestions if item["type"] == "paper")
        self.assertEqual(paper["id"], "1706.03762")
        self.assertEqual(paper["value"], "1706.03762")
        self.assertEqual(paper["authors"], ["Ashish Vaswani"])
        self.assertLessEqual(len(suggestions), 8)
        provider.assert_not_called()
        self.assertEqual(self.client.get("/api/suggestions", params={"query": "   "}).json(), {"suggestions": []})

    def test_guest_saved_requests_require_login_and_do_not_create_database(self):
        for method, path in (("get", "/api/saved"), ("post", "/api/saved"), ("delete", "/api/saved/1706.03762")):
            with self.subTest(method=method):
                response = getattr(self.client, method)(path)
                self.assertEqual(response.status_code, 401)
                self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertFalse(server.DATABASE_PATH.exists())

    def test_saved_papers_are_persistent_and_separate_for_each_orcid(self):
        paper = server.parse_feed(FEED, 0)["papers"][0]
        self.authenticate()
        first = self.client.post("/api/saved", json={"paper": paper})
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json()["paper"]["id"], "1706.03762")
        self.assertEqual(first.json()["paper"]["pdf_url"], "https://arxiv.org/pdf/1706.03762v7")
        self.assertEqual(len(self.client.get("/api/saved").json()["papers"]), 1)
        self.client.post("/api/saved", json={"paper": {**paper, "title": "Updated paper metadata"}})
        self.assertEqual(len(self.client.get("/api/saved").json()["papers"]), 1)
        self.authenticate("0000-0002-2345-6789")
        self.assertEqual(self.client.get("/api/saved").json(), {"papers": []})
        self.assertEqual(self.client.delete("/api/saved/1706.03762").status_code, 200)
        self.authenticate()
        saved = self.client.get("/api/saved").json()["papers"]
        self.assertEqual(saved[0]["title"], "Updated paper metadata")
        self.client.post("/auth/logout")
        self.assertEqual(self.client.get("/api/saved").status_code, 401)
        self.authenticate()
        self.assertEqual(len(self.client.get("/api/saved").json()["papers"]), 1)
        self.assertTrue(self.client.delete("/api/saved/1706.03762").json()["deleted"])
        self.assertEqual(self.client.get("/api/saved").json(), {"papers": []})

    def test_saved_metadata_validation_and_cross_origin_rejection(self):
        self.authenticate()
        paper = server.parse_feed(FEED, 0)["papers"][0]
        invalid = ({}, {**paper, "pdf_url": "https://example.com/file.pdf"}, {**paper, "authors": "Wrong type"},
                   {**paper, "categories": 123}, {**paper, "published": "not a date"})
        for item in invalid:
            with self.subTest(item=item):
                self.assertEqual(self.client.post("/api/saved", json={"paper": item}).status_code, 422)
        response = self.client.post("/api/saved", json={"paper": paper}, headers={"Origin": "https://other.test"})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.client.delete("/api/saved/1706.03762", headers={"Sec-Fetch-Site": "cross-site"}).status_code, 403)
        self.assertEqual(self.client.post("/api/saved", content=b"not-json").status_code, 422)
        self.assertEqual(self.client.post("/api/saved", json={"paper": {**paper, "summary": "x" * (256 * 1024)}}).status_code, 413)
        self.assertEqual(self.client.get("/api/saved").json(), {"papers": []})

    def test_legacy_saved_identifier_and_expired_session(self):
        self.authenticate()
        response = self.client.post("/api/saved", json={"paper": {"id": "hep-th/9901001", "title": "A legacy paper"}})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.client.delete("/api/saved/hep-th%2F9901001").status_code, 200)
        self.assertEqual(self.client.get("/api/saved").json(), {"papers": []})
        token = self.client.cookies.get("easy_arxiv_session")
        server._sessions[token] = (server.time.time() - 1, {"orcid": "0000-0001-2345-6789"})
        self.assertEqual(self.client.get("/api/saved").status_code, 401)

    def test_orcid_is_optional_and_sessions_are_private(self):
        with patch.object(server, "ORCID_CONFIGURED", False):
            self.assertEqual(self.client.get("/auth/login").status_code, 503)
        response = self.client.get("/api/session")
        self.assertEqual(response.json(), {"authenticated": False, "user": None})
        self.assertEqual(self.client.post("/auth/logout", headers={"Origin": "https://other.test"}).status_code, 403)

    def test_orcid_authorization_callback_and_logout_with_mocked_provider(self):
        provider = AsyncMock()
        provider.__aenter__.return_value = provider
        provider.post.return_value = httpx.Response(200,
            json={"orcid": "0000-0001-2345-6789", "name": "Test Researcher", "access_token": "provider-token-never-exposed"},
            request=httpx.Request("POST", "https://orcid.org/oauth/token"))
        with patch.multiple(server, ORCID_CONFIGURED=True, ORCID_CLIENT_ID="test-client", ORCID_CLIENT_SECRET="test-secret",
                            ORCID_REDIRECT_URI="http://testserver/auth/callback"), \
             patch.object(server.httpx, "AsyncClient", return_value=provider):
            start = self.client.get("/auth/login", follow_redirects=False)
            self.assertEqual(start.status_code, 302)
            authorize = urllib.parse.urlsplit(start.headers["location"])
            params = urllib.parse.parse_qs(authorize.query)
            self.assertEqual(authorize.netloc, "orcid.org")
            self.assertEqual(params["scope"], ["/authenticate"])
            self.assertEqual(params["response_type"], ["code"])
            self.assertEqual(params["redirect_uri"], ["http://testserver/auth/callback"])
            self.assertNotIn("test-secret", start.headers["location"])
            self.assertIn("HttpOnly", start.headers["set-cookie"])
            state = params["state"][0]
            done = self.client.get("/auth/callback", params={"code": "mock-code", "state": state}, follow_redirects=False)
            self.assertEqual(done.status_code, 303)
            self.assertEqual(provider.post.call_args.kwargs["data"]["redirect_uri"], "http://testserver/auth/callback")
            self.assertIn("HttpOnly", done.headers["set-cookie"])
            current = self.client.get("/api/session")
            self.assertEqual(current.json()["user"], {"orcid": "0000-0001-2345-6789", "name": "Test Researcher"})
            self.assertNotIn("provider-token", current.text + str(done.headers))
            replay = self.client.get("/auth/callback", params={"code": "mock-code", "state": state}, follow_redirects=False)
            self.assertEqual(replay.status_code, 400)
            provider.post.assert_awaited_once()
            self.assertEqual(self.client.post("/auth/logout", headers={"Origin": "http://testserver"}).status_code, 200)
            self.assertFalse(self.client.get("/api/session").json()["authenticated"])

    def test_orcid_callback_rejects_cross_browser_state_without_token_request(self):
        with patch.object(server, "ORCID_CONFIGURED", True), \
             patch.object(server.httpx, "AsyncClient") as provider:
            server._oauth_states["different-browser"] = server.time.time() + 60
            response = self.client.get("/auth/callback", params={"code": "mock-code", "state": "different-browser"})
        self.assertEqual(response.status_code, 400)
        provider.assert_not_called()

    def test_registered_homepage_callback_creates_session_without_changing_redirect(self):
        provider = AsyncMock()
        provider.__aenter__.return_value = provider
        provider.post.return_value = httpx.Response(200,
            json={"orcid": "0000-0001-2345-6789", "name": "Test Researcher", "access_token": "private-provider-token"},
            request=httpx.Request("POST", "https://orcid.org/oauth/token"))
        with patch.multiple(server, ORCID_CONFIGURED=True, ORCID_CLIENT_ID="test-client", ORCID_CLIENT_SECRET="test-secret",
                            ORCID_REDIRECT_URI="http://testserver/"), \
             patch.object(server.httpx, "AsyncClient", return_value=provider):
            start = self.client.get("/auth/login", follow_redirects=False)
            params = urllib.parse.parse_qs(urllib.parse.urlsplit(start.headers["location"]).query)
            response = self.client.get("/", params={"code": "mock-code", "state": params["state"][0]}, follow_redirects=False)
            self.assertEqual(response.status_code, 303)
            self.assertEqual(response.headers["cache-control"], "no-store")
            self.assertEqual(response.headers["referrer-policy"], "no-referrer")
            self.assertEqual(provider.post.call_args.kwargs["data"]["redirect_uri"], "http://testserver/")
            self.assertTrue(self.client.get("/api/session").json()["authenticated"])
            self.client.post("/auth/logout")


if __name__ == "__main__":
    unittest.main()
