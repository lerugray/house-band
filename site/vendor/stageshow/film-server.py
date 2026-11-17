#!/usr/bin/env python3
# Static server for filming site/: serves files, answers /api/* with 200 {} so the
# homepage's own account/event calls do not show up as resource errors in the film reports.
import http.server, sys, functools
class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
    def _api(self):
        b = b'{}'
        self.send_response(200); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(b))); self.end_headers()
        if self.command != 'HEAD': self.wfile.write(b)
    def do_GET(self):
        if self.path.startswith('/api/'): return self._api()
        super().do_GET()
    def do_POST(self):
        n = int(self.headers.get('Content-Length') or 0); self.rfile.read(n)
        self._api()
root, port = sys.argv[1], int(sys.argv[2])
http.server.ThreadingHTTPServer(('127.0.0.1', port), functools.partial(H, directory=root)).serve_forever()
