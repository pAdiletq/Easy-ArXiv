"""Regression checks use synthetic tokens assembled only inside the tests."""
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "check_public_secrets.py"
spec = importlib.util.spec_from_file_location("public_secret_gate", SCRIPT)
gate = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = gate
spec.loader.exec_module(gate)


class PublicSecretGateTests(unittest.TestCase):
    def test_provider_tokens_are_found_without_values_in_reports(self):
        tokens = ["AI" + "za" + "a" * 35, "gh" + "p_" + "b" * 36, "github_" + "pat_" + "c" * 50]
        for token in tokens:
            findings = gate.scan_text("static/app.js", f'const value = "{token}";')
            self.assertTrue(findings)
            self.assertNotIn(token, repr(findings))

    def test_hardcoded_json_and_assignments_are_blocked(self):
        value = "not-for-source"
        cases = [("orcid_client_secret", ":"), ("GOOGLE_API_KEY", "="),
                 ("ORCID_CLIENT_SECRET", ": str ="), ("access_token", ":")]
        for name, operator in cases:
            text = name + operator + repr(value)
            self.assertTrue(gate.scan_text("config.json", text), text)

    def test_environment_references_and_obvious_placeholders_are_allowed(self):
        for text in ('GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")',
                     'data={"client_secret": ORCID_CLIENT_SECRET}',
                     'ORCID_CLIENT_SECRET = ""', 'api_key="YOUR_API_KEY"',
                     'access_token="SYNTHETIC-TEST-TOKEN"', 'ORCID_CLIENT_SECRET="test-secret"',
                     'secret="private-test-key"'):
            self.assertEqual(gate.scan_text("example.py", text), [], text)

    def test_environment_template_requires_empty_secret_values(self):
        self.assertEqual(gate.scan_text(".env.example", "GOOGLE_API_KEY=\nORCID_CLIENT_SECRET=\nPORT=8080\n"), [])
        self.assertTrue(gate.scan_text(".env.example", "GOOGLE_API_KEY=YOUR_API_KEY\n"))

    def test_private_files_are_blocked_without_reading_their_contents(self):
        for path in (".env", ".env.production", "static/credentials.json", "service-account.json", "data/saved.sqlite", "key.pem", "dist/index.html", "app.pyc"):
            self.assertTrue(gate.forbidden_path(path), path)
        for path in (".env.example", "static/data/topics.json", "data/monthly-stats.json", "server.py"):
            self.assertFalse(gate.forbidden_path(path), path)

    def test_index_and_history_are_checked_even_after_worktree_removes_secret(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def git(*args):
                return subprocess.run(["git", "-C", directory, *args], check=True, capture_output=True)
            git("init", "--quiet")
            git("config", "user.email", "test@example.invalid")
            git("config", "user.name", "Scanner Test")
            target = root / "config.json"
            target.write_text('{"client_secret":""}', encoding="utf-8")
            git("add", ".")
            git("commit", "--quiet", "-m", "Clean baseline")
            baseline = git("rev-parse", "HEAD").stdout.decode().strip()
            target.write_text('{"client_secret":' + repr("not-for-github") + '}', encoding="utf-8")
            git("add", ".")
            self.assertTrue(gate.scan_staged(root))
            git("commit", "--quiet", "-m", "Synthetic fixture")
            target.write_text('{"client_secret":""}', encoding="utf-8")
            git("add", ".")
            git("commit", "--quiet", "-m", "Remove synthetic fixture")
            self.assertEqual(gate.scan_staged(root), [])
            self.assertTrue(gate.scan_history(root))
            self.assertEqual(gate.scan_history(root, baseline), [])
            self.assertTrue(gate.scan_history(root, "HEAD"))
            with self.assertRaises(RuntimeError):
                gate.scan_history(root, "--all")
            with self.assertRaises(RuntimeError):
                gate.scan_history(root, "HEAD --all")

    def test_reviewed_artifact_exception_is_exact_and_history_only(self):
        path, oid = next(iter(gate.REVIEWED_HISTORICAL_ARTIFACTS))
        with patch.object(gate, "git", side_effect=AssertionError("Private artifacts must not be opened")):
            self.assertEqual(gate.scan_blob(Path.cwd(), path, oid, historical=True), [])
            self.assertTrue(gate.scan_blob(Path.cwd(), path, oid))
            self.assertTrue(gate.scan_blob(Path.cwd(), path, "0" * 40, historical=True))
            self.assertTrue(gate.scan_blob(Path.cwd(), "other/app.pyc", oid, historical=True))
            self.assertTrue(gate.scan_blob(Path.cwd(), ".env", oid, historical=True))


if __name__ == "__main__":
    unittest.main()
