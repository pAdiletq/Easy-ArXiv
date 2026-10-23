"""Verify the static deployment boundary without reading local credentials."""

import importlib.util
import json
from pathlib import Path
import re
import shutil
import tempfile
import unittest
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("build_pages", ROOT / "scripts/build_pages.py")
pages = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pages)


class PagesBuildTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="easy-arxiv-pages-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for source in set(pages.PAGE_FILES.values()) | set(pages.ASSET_FILES) | {"cloudflare/pages-worker.mjs"}:
            target = self.root / source
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / source, target)

    def test_routes_preserve_the_actual_page_contents(self):
        output = pages.build(self.root)
        for target, source in pages.PAGE_FILES.items():
            self.assertEqual((output / target).read_bytes(), (ROOT / source).read_bytes())
        self.assertEqual((output / "_worker.js").read_bytes(), (ROOT / "cloudflare/pages-worker.mjs").read_bytes())
        self.assertTrue((output / "404.html").is_file())

    def test_only_explicit_public_sources_are_included(self):
        marker = "BUILD-TEST-PRIVATE-CONTENT-DO-NOT-PUBLISH"
        for name in (".env", "server.py", "data/saved.sqlite", "static/data/config.json",
                     "static/js/.env", "static/images/research-desk.png", "static/extra.json"):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(marker)
        output = pages.build(self.root)
        expected = set(pages.PAGE_FILES) | set(pages.ASSET_FILES) | {"_worker.js", "_routes.json", "_headers", "404.html"}
        actual = {str(p.relative_to(output)).replace("\\", "/") for p in output.rglob("*") if p.is_file()}
        self.assertEqual(actual, expected)
        for path in output.rglob("*"):
            if path.is_file():
                self.assertNotIn(marker.encode(), path.read_bytes())

    def test_stale_output_is_removed_and_missing_inputs_fail_before_deletion(self):
        output = pages.build(self.root)
        (output / "stale-secret.txt").write_text("synthetic stale content")
        pages.build(self.root)
        self.assertFalse((output / "stale-secret.txt").exists())
        (self.root / "static/brand.svg").unlink()
        with self.assertRaisesRegex(ValueError, "Missing or unsafe public source"):
            pages.build(self.root)
        self.assertTrue((output / "index.html").is_file())

    def test_static_assets_and_module_imports_resolve_in_output(self):
        output = pages.build(self.root)
        for path in output.rglob("*"):
            if not path.is_file() or path.suffix not in {".html", ".css", ".js"} or path.name == "_worker.js":
                continue
            content = path.read_text(encoding="utf-8")
            references = re.findall(r'''(?:src|href)=["'](/static/[^"']+)["']''', content)
            references += re.findall(r'''url\(["']?(/static/[^'"\)]+)''', content)
            references += re.findall(r'''(?:from\s+|import\s*)["']((?:\./|/static/)[^"']+)["']''', content)
            for reference in references:
                clean = urlsplit(reference).path
                target = output / clean.lstrip("/") if clean.startswith("/") else path.parent / clean
                self.assertTrue(target.is_file(), f"Missing {reference} in {path.relative_to(output)}")

    def test_only_auth_api_and_legacy_root_callback_use_the_worker(self):
        output = pages.build(self.root)
        routes = json.loads((output / "_routes.json").read_text())
        self.assertEqual(routes["version"], 1)
        self.assertEqual(set(routes["include"]), {"/", "/api", "/api/*", "/auth", "/auth/*"})
        self.assertNotIn("/*", routes["include"])


if __name__ == "__main__":
    unittest.main()
