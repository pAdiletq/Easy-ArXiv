"""Build the public Pages artifact from an explicit, reviewed file list.

No secret environment variables, runtime data, Python server files, or dotfiles
are read or copied. The reviewed edge entry is bundled with locked Node build
dependencies. Run from any directory: python scripts/build_pages.py.
"""

from pathlib import Path
import json
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]
PAGE_FILES = {
    "index.html": "static/index.html",
    "papers.html": "static/papers.html",
    "read.html": "static/reader.html",
    "saved.html": "static/saved.html",
    "quest.html": "static/quest.html",
    "ai_quest.html": "static/quest.html",
    "extension-connect.html": "static/extension-connect.html",
}
ASSET_FILES = (
    "static/brand.svg",
    "static/css/app.css",
    "static/css/account-audio.css",
    "static/css/hero.css",
    "static/css/quest.css",
    "static/css/refinements.css",
    "static/css/search-ui.css",
    "static/js/app.js",
    "static/js/audio.js",
    "static/js/core.js",
    "static/js/extension-connect.js",
    "static/js/hero.js",
    "static/js/papers.js",
    "static/js/quest.js",
    "static/js/search-ui.js",
    "static/images/cornell-campus.jpg",
)
WORKER_SOURCES = ("cloudflare/edge-worker.mjs", "scripts/build_worker.mjs")


def bundle_worker(root: Path, output: Path) -> None:
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js must be on PATH to bundle the Pages worker")
    if not (root / "node_modules/esbuild/package.json").is_file():
        raise RuntimeError("Locked build dependencies are missing; run npm ci before building Pages")
    try:
        subprocess.run(
            [node, str(root / "scripts/build_worker.mjs"), str(output)],
            cwd=root, check=True, capture_output=True, timeout=120,
        )
    except (OSError, subprocess.SubprocessError) as error:
        # Do not echo bundler source excerpts, environment values, or stderr.
        raise RuntimeError("Pages worker bundle failed; check sources and locked build dependencies") from error
    if not output.is_file() or output.stat().st_size == 0:
        raise RuntimeError("Pages worker bundle did not produce a worker")


def build(root: Path = ROOT) -> Path:
    root = root.resolve()
    output = root / "dist"
    # Always replace only this project's literal dist directory. Refuse links
    # so a misplaced symlink cannot redirect deletion or copy outside it.
    if output.is_symlink() or output.resolve().parent != root:
        raise ValueError("The build output must be a real dist directory inside the project")
    files = {**PAGE_FILES, **{name: name for name in ASSET_FILES}}
    for source in (*files.values(), *WORKER_SOURCES):
        path = root / source
        if not path.is_file() or path.is_symlink() or not path.resolve().is_relative_to(root):
            raise ValueError(f"Missing or unsafe public source: {source}")
    routes = {
        "version": 1,
        "description": "Edge API, OAuth and health; the root also supports the legacy ORCID callback.",
        "include": ["/", "/api", "/api/*", "/auth", "/auth/*", "/health"],
        "exclude": [],
    }
    headers = (
        "/*\n"
        "  X-Content-Type-Options: nosniff\n"
        "  Referrer-Policy: strict-origin-when-cross-origin\n"
        "  X-Frame-Options: DENY\n"
        "  Permissions-Policy: camera=(), microphone=(), geolocation=()\n"
    )
    # An explicit 404 prevents Pages treating every unknown path as an SPA.
    not_found = (
        '<!doctype html><html lang="en"><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<title>Page not found · Easy ArXiv</title><body>'
        '<h1>Page not found</h1><p><a href="/">Return to Easy ArXiv</a></p>'
        '</body></html>\n'
    )
    # Build completely before replacing the previous artifact. A missing
    # bundler or bad import must not leave a partial, apparently valid dist.
    with tempfile.TemporaryDirectory(prefix=".pages-build-", dir=root) as temporary:
        staging = Path(temporary)
        if staging.resolve().parent != root or staging.is_symlink():
            raise ValueError("The build staging directory must stay inside the project")
        bundle_worker(root, staging / "_worker.js")
        for destination, source in files.items():
            target = staging / destination
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(root / source, target)
        (staging / "_routes.json").write_text(json.dumps(routes, indent=2) + "\n", encoding="utf-8")
        (staging / "_headers").write_text(headers, encoding="utf-8")
        (staging / "404.html").write_text(not_found, encoding="utf-8")
        # Recheck resolved targets immediately before the only delete/move.
        if output.is_symlink() or output.resolve().parent != root or staging.resolve().parent != root:
            raise ValueError("The build output must stay inside the project")
        if output.exists():
            shutil.rmtree(output)
        staging.rename(output)
    return output


if __name__ == "__main__":
    destination = build()
    print(f"Pages build ready: {destination.name} ({sum(1 for p in destination.rglob('*') if p.is_file())} files)")
