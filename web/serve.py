#!/usr/bin/env python3
"""Serve the app locally with caching off, so a reload always picks up edits."""
import http.server, sys

class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

port = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
http.server.ThreadingHTTPServer(("127.0.0.1", port), NoCache).serve_forever()
