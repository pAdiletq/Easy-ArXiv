"""Package the native-PDF context-menu/side-panel extension from a fixed allowlist.

This builder never accepts a PDF path, copies PDF.js, or includes a PDF viewer.
The optional preview is a separate copy of the same panel runtime, without a
document fixture. Chrome installation and native PDF access remain user actions.
Only the reviewed API client and active-document reader may make HTTPS requests.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import shutil
import uuid
import zipfile

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "extensions" / "formula-lens"
FILES = ("manifest.json", "sidepanel.html", "panel.css", "panel.js", "sidepanel.js",
         "background.js", "selection.js", "formula-engine.js", "formula-worker.js",
         "api-client.js", "paper-fetch.js", "paper-controller.js", "motion.js", "README.md",
         "icons/icon16.png", "icons/icon32.png", "icons/icon48.png", "icons/icon128.png")
NATIVE_PERMISSIONS = {"contextMenus", "sidePanel", "storage", "activeTab"}
LOCAL_ICONS = {str(size): f"icons/icon{size}.png" for size in (16, 32, 48, 128)}
NETWORK_MODULES = {"api-client.js", "paper-fetch.js"}


def validate_native_contract(manifest: dict, inputs: list) -> None:
    forbidden = {"mime_types_handler", "content_scripts", "host_permissions", "optional_host_permissions",
                 "optional_permissions", "externally_connectable"}
    permissions = manifest.get("permissions")
    if (manifest.get("manifest_version") != 3 or forbidden.intersection(manifest) or
            not isinstance(permissions, list) or any(not isinstance(item, str) for item in permissions) or
            set(permissions) != NATIVE_PERMISSIONS or len(permissions) != len(NATIVE_PERMISSIONS)):
        raise ValueError("Formula Lens must remain a native-PDF panel with only its reviewed permissions")
    background = manifest.get("background")
    panel = manifest.get("side_panel")
    if (not isinstance(background, dict) or background.get("service_worker") != "background.js" or
            background.get("type") != "module" or not isinstance(panel, dict) or panel.get("default_path") != "sidepanel.html"):
        raise ValueError("Formula Lens must use its reviewed background module and side panel")
    action = manifest.get("action")
    if (manifest.get("icons") != LOCAL_ICONS or not isinstance(action, dict) or
            action.get("default_icon") != LOCAL_ICONS):
        raise ValueError("Formula Lens icons must use only the packaged local PNG files")
    policy_definition = manifest.get("content_security_policy")
    policy = policy_definition.get("extension_pages") if isinstance(policy_definition, dict) else None
    if not isinstance(policy, str):
        raise ValueError("Formula Lens requires its reviewed extension content policy")
    directives = {}
    for value in policy.split(";"):
        parts = value.split()
        if not parts:
            continue
        if parts[0] in directives:
            raise ValueError("Formula Lens content policy must not contain duplicate directives")
        directives[parts[0]] = parts[1:]
    if (directives.get("connect-src") != ["https:"] or directives.get("script-src") != ["'self'"] or
            directives.get("worker-src") != ["'self'"] or
            directives.get("object-src") != ["'none'"] or directives.get("img-src") != ["'self'"]):
        raise ValueError("Formula Lens requires reviewed HTTPS connections and local executable code")
    forbidden_calls = re.compile(r"\b(?:XMLHttpRequest|WebSocket|EventSource|importScripts|eval|Function)\s*\(|\.\s*sendBeacon\s*\(")
    fetch_calls = re.compile(r"\b(?:fetch|fetcher)\s*\(")
    worker_calls = re.compile(r"\b(?:new\s+)?(?:Worker|SharedWorker)\s*\(")
    local_worker = re.compile(r"\bnew\s+Worker\s*\(\s*(?:new\s+URL\s*\(\s*(['\"])(?:\./)?formula-worker\.js\1\s*,\s*import\.meta\.url\s*\)|(['\"])(?:\./)?formula-worker\.js\2)(?=\s*[,\)])")
    for relative, source in inputs:
        if relative.suffix != ".js":
            continue
        text = source.read_text(encoding="utf-8")
        if forbidden_calls.search(text):
            raise ValueError("Formula Lens runtime contains an unreviewed network or evaluation call")
        if fetch_calls.search(text) and relative.as_posix() not in NETWORK_MODULES:
            raise ValueError("Formula Lens fetch calls must stay inside the reviewed API and active-PDF modules")
        if len(worker_calls.findall(text)) != len(local_worker.findall(text)):
            raise ValueError("Formula Lens workers must use the packaged formula-worker.js path")


def is_link_like(path: Path) -> bool:
    return path.is_symlink() or getattr(path, "is_junction", lambda: False)()


def safe_directory(path: Path, boundary: Path) -> Path:
    boundary = boundary.absolute()
    path = path.absolute()
    resolved_boundary = boundary.resolve(strict=True)
    resolved = path.resolve(strict=True)
    # The resolved equality also catches junctions on older Python versions
    # that do not expose Path.is_junction(), including links inside the root.
    if resolved != path or not path.is_relative_to(boundary) or not resolved.is_relative_to(resolved_boundary) or not resolved.is_dir():
        raise ValueError("Build directory is outside its reviewed source directory")
    current = path
    while True:
        if is_link_like(current):
            raise ValueError("Build inputs and output must not use symlinks or junctions")
        if current == boundary:
            break
        current = current.parent
    return resolved


def safe_file(path: Path, boundary: Path) -> Path:
    safe_directory(path.parent, boundary)
    resolved = path.resolve(strict=True)
    if is_link_like(path) or not resolved.is_relative_to(boundary.resolve()) or not resolved.is_file():
        raise ValueError("Build input is outside its reviewed source directory")
    return resolved


def build(preview: bool = False) -> dict[str, str]:
    if not isinstance(preview, bool):
        raise ValueError("Preview is a boolean panel-preview option, never a document path")
    if is_link_like(ROOT):
        raise ValueError("The project directory must not be a symlink or junction")
    root = ROOT.resolve(strict=True)
    source = safe_directory(SOURCE, root)
    inputs = []
    for filename in FILES:
        inputs.append((Path(filename), safe_file(source / filename, source)))
    manifest = json.loads(safe_file(source / "manifest.json", source).read_text(encoding="utf-8"))
    if not isinstance(manifest, dict):
        raise ValueError("The extension manifest must be an object")
    validate_native_contract(manifest, inputs)
    release_version = manifest.get("version")
    if not isinstance(release_version, str) or not re.fullmatch(r"[0-9]{1,5}(?:\.[0-9]{1,5}){0,3}", release_version) or any(int(part) > 65535 for part in release_version.split(".")):
        raise ValueError("The extension version must be a numeric Chrome manifest version")
    output_parent = root / ".formula-lens-build"
    if is_link_like(output_parent) or output_parent.resolve() != output_parent or output_parent.resolve().parent != root:
        raise ValueError("The extension output must remain inside the project")
    output_parent.mkdir(exist_ok=True)
    safe_directory(output_parent, root)
    destination = output_parent / ("run-" + uuid.uuid4().hex[:12])
    destination.mkdir(exist_ok=False)
    safe_directory(destination, root)
    unpacked = destination / "extension"
    unpacked.mkdir(exist_ok=False)
    for relative, origin in inputs:
        target = unpacked / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        safe_directory(target.parent, unpacked)
        shutil.copyfile(origin, target)
    archive = destination / ("Easy-ArXiv-Formula-Lens-" + manifest["version"] + ".zip")
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as package:
        for relative, _ in inputs:
            package.write(safe_file(unpacked / relative, unpacked), relative.as_posix())
    result = {"extension": str(unpacked), "zip": str(archive)}
    if preview:
        preview_directory = destination / "preview"
        preview_directory.mkdir(exist_ok=False)
        for relative, _ in inputs:
            # Explicit copies, not copytree: unrelated files can never become
            # preview inputs, even if added beside a prior package later.
            target = preview_directory / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            safe_directory(target.parent, preview_directory)
            shutil.copyfile(safe_file(unpacked / relative, unpacked), target)
        result["preview"] = str(preview_directory)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--preview", action="store_true", help="also make a separate local panel-preview copy, without a PDF")
    options = parser.parse_args()
    print(json.dumps(build(options.preview), ensure_ascii=False))
