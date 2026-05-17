#!/usr/bin/env python3
"""
Local dev server that mirrors the production routing rules in `_redirects`.

Why: `python3 -m http.server` and `npx serve` ignore `_redirects` /
`vercel.json`, so unknown paths return a plain "File not found" instead of
the styled `/404.html`, and `/https://github.com/...` URLs 404 instead of
falling through to the SPA.

Usage:
    python3 scripts/serve.py          # default port 5173
    python3 scripts/serve.py 8080     # custom port

Supported `_redirects` syntax:
    /pattern[*]   /target.html  [200|301|302|404]

The trailing `*` in source matches any suffix; rules are matched top-down,
so list specific rules above the catch-all.
"""

import http.server
import os
import re
import socketserver
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REDIRECTS = ROOT / '_redirects'


def parse_redirects():
    """Parse `_redirects` into [(regex, target, status), ...]."""
    rules = []
    if not REDIRECTS.exists():
        return rules
    for raw in REDIRECTS.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        src, target = parts[0], parts[1]
        status = int(parts[2]) if len(parts) >= 3 else 301
        # Convert Netlify-style globs to regex. Only `*` is supported.
        pattern = '^' + re.escape(src).replace(r'\*', '(.*)') + '$'
        rules.append((re.compile(pattern), target, status))
    return rules


RULES = parse_redirects()


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        path = self.path.split('?', 1)[0]
        full = (ROOT / path.lstrip('/')).resolve()

        # Serve the file if it actually exists on disk; redirects only fire
        # for unmatched paths (matches Netlify/Cloudflare default behavior).
        try:
            full.relative_to(ROOT)
            if full.is_file():
                return super().do_GET()
            if full.is_dir() and (full / 'index.html').is_file():
                return super().do_GET()
        except ValueError:
            pass

        for pattern, target, status in RULES:
            if pattern.match(path):
                if status == 200:
                    # Internal rewrite: serve the target file in place.
                    self.path = target
                    return super().do_GET()
                if status in (301, 302):
                    self.send_response(status)
                    self.send_header('Location', target)
                    self.end_headers()
                    return
                if status == 404:
                    file_path = ROOT / target.lstrip('/')
                    if file_path.is_file():
                        body = file_path.read_bytes()
                        self.send_response(404)
                        self.send_header('Content-Type', 'text/html; charset=utf-8')
                        self.send_header('Content-Length', str(len(body)))
                        self.end_headers()
                        self.wfile.write(body)
                        return

        super().do_GET()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5173
    os.chdir(ROOT)
    with socketserver.TCPServer(('', port), Handler) as httpd:
        print(f'Serving {ROOT} on http://localhost:{port}')
        print(f'Loaded {len(RULES)} redirect rule(s) from _redirects')
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print('\nShutting down.')


if __name__ == '__main__':
    main()
