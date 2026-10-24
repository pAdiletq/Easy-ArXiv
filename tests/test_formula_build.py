"""Native side-panel package boundaries; no PDF, browser, or dependencies needed."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "build_formula_lens.py"
spec = importlib.util.spec_from_file_location("formula_extension_build", SCRIPT)
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
EXPECTED_RUNTIME = {"manifest.json", "sidepanel.html", "panel.css", "panel.js", "sidepanel.js",
                    "background.js", "attention.js", "selection.js", "README.md"}


def native_manifest():
    return {"version": "0.2.0", "manifest_version": 3,
            "permissions": ["contextMenus", "sidePanel", "storage", "activeTab"],
            "background": {"service_worker": "background.js", "type": "module"},
            "side_panel": {"default_path": "sidepanel.html"},
            "content_security_policy": {"extension_pages": "script-src 'self'; object-src 'none'; connect-src 'none'; img-src 'self'"}}


class FormulaBuildTests(unittest.TestCase):
    def fixture(self, directory):
        root = Path(directory)
        source = root / "extensions" / "formula-lens"
        source.mkdir(parents=True)
        for name in EXPECTED_RUNTIME:
            (source / name).write_text("Reviewed synthetic native-panel fixture", encoding="utf-8")
        (source / "manifest.json").write_text(json.dumps(native_manifest()), encoding="utf-8")
        return root, source

    def test_only_native_panel_runtime_enters_zip_and_unpacked_extension(self):
        with tempfile.TemporaryDirectory() as directory:
            root, source = self.fixture(directory)
            # Leftover viewers, vendor packages, source documents, and unrelated
            # local files must never become inputs to this native-only package.
            extras = (root / "private-not-for-release.txt", source / "private-not-for-release.txt",
                      source / "package-lock.json", source / "viewer.js", source / "viewer.html",
                      source / "fixtures" / "synthetic-document.pdf", source / "vendor" / "pdf.mjs",
                      source / "node_modules" / "pdfjs-dist" / "build" / "pdf.mjs")
            for path in extras:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("Synthetic file outside the runtime allowlist", encoding="utf-8")
            with patch.object(builder, "ROOT", root), patch.object(builder, "SOURCE", source):
                result = builder.build()
            self.assertEqual(set(builder.FILES), EXPECTED_RUNTIME)
            with zipfile.ZipFile(result["zip"]) as package:
                self.assertEqual(set(package.namelist()), EXPECTED_RUNTIME)
                self.assertTrue(all(not Path(name).is_absolute() and ".." not in Path(name).parts for name in package.namelist()))
            unpacked = Path(result["extension"])
            self.assertEqual({p.relative_to(unpacked).as_posix() for p in unpacked.rglob("*") if p.is_file()}, EXPECTED_RUNTIME)
            self.assertEqual(unpacked.resolve().parents[1], (root / ".formula-lens-build").resolve())

    def test_preview_is_a_separate_runtime_copy_without_a_document(self):
        with tempfile.TemporaryDirectory() as directory:
            root, source = self.fixture(directory)
            with patch.object(builder, "ROOT", root), patch.object(builder, "SOURCE", source):
                result = builder.build(preview=True)
            preview = Path(result["preview"])
            unpacked = Path(result["extension"])
            self.assertNotEqual(preview, unpacked)
            self.assertEqual({p.relative_to(preview).as_posix() for p in preview.rglob("*") if p.is_file()}, EXPECTED_RUNTIME)
            for name in EXPECTED_RUNTIME:
                self.assertEqual((preview / name).read_bytes(), (unpacked / name).read_bytes())
            with zipfile.ZipFile(result["zip"]) as package:
                self.assertEqual(set(package.namelist()), EXPECTED_RUNTIME)
                self.assertFalse(any(name.endswith(".pdf") or name.startswith(("fixtures/", "vendor/", "preview/")) for name in package.namelist()))

    def test_a_document_path_can_never_be_used_as_a_preview_option(self):
        with tempfile.TemporaryDirectory() as directory:
            root, source = self.fixture(directory)
            # No file is created or opened: even an explicit path is rejected.
            with patch.object(builder, "ROOT", root), patch.object(builder, "SOURCE", source):
                with self.assertRaisesRegex(ValueError, "never a document path"):
                    builder.build(Path(directory) / "must-not-open.pdf")
            self.assertFalse((root / ".formula-lens-build").exists())

    def test_missing_runtime_fails_before_creating_an_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            root, source = self.fixture(directory)
            (source / "background.js").unlink()
            with patch.object(builder, "ROOT", root), patch.object(builder, "SOURCE", source):
                with self.assertRaises((ValueError, FileNotFoundError)):
                    builder.build()
            self.assertFalse((root / ".formula-lens-build").exists())

    def test_source_outside_project_and_unsafe_version_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory, tempfile.TemporaryDirectory() as other:
            root, source = self.fixture(directory)
            with patch.object(builder, "ROOT", Path(other)), patch.object(builder, "SOURCE", source):
                with self.assertRaises(ValueError):
                    builder.build()
            manifest = native_manifest()
            manifest["version"] = "../../unreviewed"
            (source / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            with patch.object(builder, "ROOT", root), patch.object(builder, "SOURCE", source):
                with self.assertRaisesRegex(ValueError, "manifest version"):
                    builder.build()
            self.assertFalse((root / ".formula-lens-build").exists())

    def test_link_like_output_parent_is_rejected_without_touching_existing_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root, source = self.fixture(directory)
            output = root / ".formula-lens-build"
            output.mkdir()
            marker = output / "keep-existing.txt"
            marker.write_text("Keep this synthetic existing file", encoding="utf-8")
            actual = builder.is_link_like
            with patch.object(builder, "ROOT", root), patch.object(builder, "SOURCE", source), \
                 patch.object(builder, "is_link_like", side_effect=lambda path: path == output or actual(path)):
                with self.assertRaisesRegex(ValueError, "output must remain"):
                    builder.build()
            self.assertEqual(marker.read_text(encoding="utf-8"), "Keep this synthetic existing file")
            self.assertEqual(list(output.iterdir()), [marker])

    def test_repeated_destination_does_not_overwrite_a_previous_package(self):
        with tempfile.TemporaryDirectory() as directory:
            root, source = self.fixture(directory)
            class FixedUUID:
                hex = "a" * 32
            with patch.object(builder, "ROOT", root), patch.object(builder, "SOURCE", source), \
                 patch.object(builder.uuid, "uuid4", return_value=FixedUUID()):
                result = builder.build()
                before = Path(result["zip"]).read_bytes()
                with self.assertRaises(FileExistsError):
                    builder.build()
            self.assertEqual(Path(result["zip"]).read_bytes(), before)

    def test_symlinked_runtime_input_is_not_copied_into_the_package(self):
        with tempfile.TemporaryDirectory() as directory:
            root, source = self.fixture(directory)
            outside = root / "unreviewed-source.js"
            outside.write_text("Synthetic outside-source fixture", encoding="utf-8")
            runtime = source / "background.js"
            runtime.unlink()
            try:
                runtime.symlink_to(outside)
            except OSError:
                self.skipTest("The test host does not permit creating symlinks")
            with patch.object(builder, "ROOT", root), patch.object(builder, "SOURCE", source):
                with self.assertRaises(ValueError):
                    builder.build()
            self.assertFalse((root / ".formula-lens-build").exists())

    def test_manifest_cannot_restore_pdf_replacement_or_expand_site_access(self):
        cases = {"mime_types_handler": {"application/pdf": {"handler_url": "viewer.html"}},
                 "content_scripts": [], "host_permissions": ["<all_urls>"],
                 "externally_connectable": {"matches": ["https://example.invalid/*"]},
                 "optional_permissions": ["scripting"]}
        for key, value in cases.items():
            with self.subTest(key=key), tempfile.TemporaryDirectory() as directory:
                root, source = self.fixture(directory)
                manifest = native_manifest()
                manifest[key] = value
                (source / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
                with patch.object(builder, "ROOT", root), patch.object(builder, "SOURCE", source):
                    with self.assertRaisesRegex(ValueError, "native-PDF panel"):
                        builder.build()
                self.assertFalse((root / ".formula-lens-build").exists())

    def test_remote_network_policy_and_executable_fetch_cannot_enter_package(self):
        for insecure in ("policy", "runtime", "permission"):
            with self.subTest(insecure=insecure), tempfile.TemporaryDirectory() as directory:
                root, source = self.fixture(directory)
                manifest = native_manifest()
                if insecure == "policy":
                    manifest["content_security_policy"]["extension_pages"] = "script-src 'self'; object-src 'none'; connect-src https:; img-src 'self'"
                elif insecure == "permission":
                    manifest["permissions"].append("scripting")
                else:
                    (source / "background.js").write_text('fetch("https://example.invalid/");', encoding="utf-8")
                (source / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
                with patch.object(builder, "ROOT", root), patch.object(builder, "SOURCE", source):
                    with self.assertRaises(ValueError):
                        builder.build()
                self.assertFalse((root / ".formula-lens-build").exists())


if __name__ == "__main__":
    unittest.main()
