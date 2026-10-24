"""Serve only the generated, public Formula Lens preview on loopback."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class PreviewHandler(SimpleHTTPRequestHandler):
    # Windows registry MIME associations may otherwise serve .mjs as text/plain.
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      ".mjs": "text/javascript", ".js": "text/javascript",
                      ".css": "text/css", ".wasm": "application/wasm", ".pdf": "application/pdf"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; object-src 'none'; "
                         "connect-src 'self' blob:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; "
                         "font-src 'self' blob: data:; worker-src 'self'")
        super().end_headers()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", required=True, type=Path)
    parser.add_argument("--port", default=5077, type=int)
    options = parser.parse_args()
    directory = options.directory.resolve(strict=True)
    if not directory.is_relative_to(ROOT / ".formula-lens-build") or directory.name != "preview":
        raise SystemExit("Only the generated Formula Lens preview can be served")
    server = ThreadingHTTPServer(("127.0.0.1", options.port), partial(PreviewHandler, directory=str(directory)))
    server.serve_forever()
