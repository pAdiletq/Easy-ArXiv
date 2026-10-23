"""Build the public Pages artifact from an explicit, reviewed file list.

No environment variables, runtime data, Python server files, or dotfiles are
read or copied. Run from any directory: python scripts/build_pages.py.
"""

from pathlib import Path
import json
import shutil


ROOT = Path(__file__).resolve().parents[1]
PAGE_FILES = {
    "index.html": "static/index.html",
    "papers.html": "static/papers.html",
    "read.html": "static/reader.html",
    "saved.html": "static/saved.html",
    "quest.html": "static/quest.html",
    "ai_quest.html": "static/quest.html",
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
    "static/js/hero.js",
    "static/js/papers.js",
    "static/js/quest.js",
    "static/js/search-ui.js",
    "static/images/cornell-campus.jpg",
)


def build(root: Path = ROOT) -> Path:
    root = root.resolve()
    output = root / "dist"
    # Always replace only this project's literal dist directory. Refuse links
    # so a misplaced symlink cannot redirect deletion or copy outside it.
    if output.is_symlink() or output.resolve().parent != root:
        raise ValueError("The build output must be a real dist directory inside the project")
    files = {**PAGE_FILES, **{name: name for name in ASSET_FILES},
             "_worker.js": "cloudflare/pages-worker.mjs"}
    for source in files.values():
        path = root / source
        if not path.is_file() or path.is_symlink() or not path.resolve().is_relative_to(root):
            raise ValueError(f"Missing or unsafe public source: {source}")
    if output.exists():
        shutil.rmtree(output)
    output.mkdir()
    for destination, source in files.items():
        target = output / destination
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(root / source, target)
    routes = {
        "version": 1,
        "description": "Proxy API and OAuth only; the root also supports the legacy ORCID callback.",
        "include": ["/", "/api", "/api/*", "/auth", "/auth/*"],
        "exclude": [],
    }
    (output / "_routes.json").write_text(json.dumps(routes, indent=2) + "\n", encoding="utf-8")
    (output / "_headers").write_text(
        "/*\n"
        "  X-Content-Type-Options: nosniff\n"
        "  Referrer-Policy: strict-origin-when-cross-origin\n"
        "  X-Frame-Options: DENY\n"
        "  Permissions-Policy: camera=(), microphone=(), geolocation=()\n",
        encoding="utf-8",
    )
    # An explicit 404 prevents Pages treating every unknown path as an SPA.
    (output / "404.html").write_text(
        '<!doctype html><html lang="en"><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<title>Page not found · Easy ArXiv</title><body>'
        '<h1>Page not found</h1><p><a href="/">Return to Easy ArXiv</a></p>'
        '</body></html>\n', encoding="utf-8",
    )
    return output


if __name__ == "__main__":
    destination = build()
    print(f"Pages build ready: {destination.name} ({sum(1 for p in destination.rglob('*') if p.is_file())} files)")
