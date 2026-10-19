"""Negative and positive fixtures for check-served-web.py on local loopback HTTP servers.

Usage: python test-check-served-web.py   (exit 0 when every case behaves as expected)

Each case starts a small http.server on 127.0.0.1:0 that serves an in-memory
site and runs the checker as a subprocess against it, asserting its exit code
and output. Timeouts are short (fractions of a second), so no case waits long.
Standard library only; no network beyond loopback.
"""
import os
import subprocess
import sys
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

CHECKER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "check-served-web.py")

JS, CSS, HTML, PNG = "text/javascript; charset=utf-8", "text/css; charset=utf-8", "text/html; charset=utf-8", "image/png"
HEALTH = ("200", "application/json", b'{"ok": true, "server_time": 0}')


def good_site():
    return {
        "/api/health": HEALTH,
        "/planner.html": ("200", HTML, b'<!doctype html><link rel="stylesheet" href="vendor/lib.css">'
                          b'<link rel="stylesheet" href="ui/map-planner.css">'
                          b'<script type="module" src="ui/map-planner.mjs"></script>'),
        "/ui/map-planner.mjs": ("200", JS, b"import { plan } from '../engine/plan.js';\n"
                                b"import './planner-initial-state.mjs';\nexport const x = plan;\n"),
        "/ui/planner-initial-state.mjs": ("200", JS, b"export const initial = {};\n"),
        "/ui/map-planner.css": ("200", CSS, b"body { margin: 0 }\n"),
        "/engine/plan.js": ("200", "application/javascript", b"export * from './route.js';\nexport const plan = 1;\n"),
        "/engine/route.js": ("200", JS, b"export const route = 1;\n"),
        "/vendor/lib.css": ("200", CSS, b".a { background: url(images/layers.png) }\n"),
        "/vendor/images/layers.png": ("200", PNG, b"\x89PNG\r\n\x1a\n"),
    }


class Site:
    """Serves a dict path -> (status, content type, body); 'hang' waits until released."""

    def __init__(self, routes, fallback=None):
        self.routes, self.fallback = routes, fallback
        self.requests, self.release = [], threading.Event()
        site = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                site.requests.append(self.path)
                entry = site.routes.get(self.path.split("?", 1)[0], site.fallback)
                if entry == "hang":
                    site.release.wait(10)
                    return
                if entry is None:
                    entry = ("404", "text/plain", b"not found")
                status, ctype, body = entry
                self.send_response(int(status))
                if status.startswith("3"):
                    self.send_header("Location", body.decode())
                    body = b""
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *_):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.base = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()


def run_checker(base, *extra):
    started = time.monotonic()
    proc = subprocess.run([sys.executable, "-I", CHECKER, base, "--ready-timeout", "1.5",
                           "--request-timeout", "0.5", *extra],
                          capture_output=True, text=True, timeout=30)
    return proc.returncode, proc.stdout + proc.stderr, time.monotonic() - started


class ServedWebTests(unittest.TestCase):
    def serve(self, routes, fallback=None):
        site = Site(routes, fallback)
        self.addCleanup(site.close)
        return site

    def assertFails(self, routes, needle, fallback=None):
        site = self.serve(routes, fallback)
        code, out, _ = run_checker(site.base)
        self.assertEqual(code, 1, out)
        self.assertIn(needle, out)
        return site, out

    def test_valid_site_passes_and_follows_recursive_imports(self):
        site = self.serve(good_site())
        code, out, _ = run_checker(site.base)
        self.assertEqual(code, 0, out)
        self.assertIn("PASS: 8 local files", out)
        for path in ("/ui/planner-initial-state.mjs", "/engine/route.js", "/vendor/images/layers.png"):
            self.assertIn(path, site.requests)

    def test_missing_import_404_fails(self):
        routes = good_site()
        del routes["/ui/planner-initial-state.mjs"]
        self.assertFails(routes, "/ui/planner-initial-state.mjs: HTTP 404")

    def test_missing_transitive_import_fails(self):
        routes = good_site()
        del routes["/engine/route.js"]
        self.assertFails(routes, "engine/plan.js: './route.js' -> /engine/route.js: HTTP 404")

    def test_spa_fallback_mjs_as_html_fails(self):
        routes = good_site()
        del routes["/ui/planner-initial-state.mjs"]
        # every unknown path answers 200 with the HTML page, as an SPA fallback would
        fallback = ("200", HTML, b"<!doctype html><title>app</title>")
        self.assertFails(routes, "/ui/planner-initial-state.mjs: Content-Type text/html, expected", fallback)

    def test_spa_fallback_for_image_fails(self):
        routes = good_site()
        del routes["/vendor/images/layers.png"]
        self.assertFails(routes, "/vendor/images/layers.png: answered text/html", ("200", HTML, b"<p>app</p>"))

    def test_wrong_css_mime_fails(self):
        routes = good_site()
        routes["/ui/map-planner.css"] = ("200", "text/plain", b"body { margin: 0 }\n")
        self.assertFails(routes, "/ui/map-planner.css: Content-Type text/plain, expected text/css")

    def test_wrong_js_mime_fails(self):
        routes = good_site()
        routes["/engine/route.js"] = ("200", "application/octet-stream", b"export const route = 1;\n")
        self.assertFails(routes, "/engine/route.js: Content-Type application/octet-stream")

    def test_empty_body_fails(self):
        routes = good_site()
        routes["/engine/route.js"] = ("200", JS, b"")
        self.assertFails(routes, "/engine/route.js: empty body")

    def test_hanging_asset_times_out_quickly(self):
        routes = good_site()
        routes["/engine/route.js"] = "hang"
        site = self.serve(routes)
        code, out, elapsed = run_checker(site.base)
        self.assertEqual(code, 1, out)
        self.assertIn("/engine/route.js: request failed", out)
        self.assertLess(elapsed, 10)

    def test_health_never_ready_fails_within_bound(self):
        routes = good_site()
        routes["/api/health"] = ("503", "application/json", b'{"ok": false}')
        site = self.serve(routes)
        code, out, elapsed = run_checker(site.base)
        self.assertEqual(code, 1, out)
        self.assertIn("server not ready after 1.5s: health answered 503", out)
        self.assertLess(elapsed, 10)
        self.assertNotIn("/planner.html", site.requests)

    def test_health_hanging_fails_within_bound(self):
        routes = good_site()
        routes["/api/health"] = "hang"
        site = self.serve(routes)
        code, out, elapsed = run_checker(site.base)
        self.assertEqual(code, 1, out)
        self.assertIn("server not ready after 1.5s", out)
        self.assertLess(elapsed, 10)

    def test_health_html_fallback_is_not_ready(self):
        routes = good_site()
        routes["/api/health"] = ("200", HTML, b"<!doctype html>")
        self.assertFails(routes, "health answered non-JSON (text/html)")

    def test_nothing_listening_fails_within_bound(self):
        site = Site({})
        base = site.base
        site.close()
        code, out, elapsed = run_checker(base)
        self.assertEqual(code, 1, out)
        self.assertIn("health not reachable", out)
        self.assertLess(elapsed, 10)

    def test_external_urls_are_skipped_and_never_requested(self):
        other = self.serve({"/x.js": ("200", JS, b"export {};")})
        routes = good_site()
        routes["/planner.html"] = (
            "200", HTML,
            routes["/planner.html"][2]
            + f'<script src="{other.base}/x.js"></script>'.encode()
            + b'<script src="https://tile.openstreetmap.org/x.js"></script>'
            + f'<img src="//127.0.0.1:{other.base.rsplit(":", 1)[1]}/x.js">'.encode()
            + b'<img src="data:image/png;base64,AAAA"><a href="#top"></a>')
        site = self.serve(routes)
        code, out, _ = run_checker(site.base)
        self.assertEqual(code, 0, out)
        self.assertEqual(other.requests, [])
        self.assertTrue(all(p.startswith("/") for p in site.requests))

    def test_path_climbing_above_root_fails_without_request(self):
        routes = good_site()
        routes["/engine/route.js"] = ("200", JS, b"import '../../../etc/passwd.js';\n")
        site, _ = self.assertFails(routes, "engine/route.js: '../../../etc/passwd.js' climbs above the web root")
        self.assertFalse(any("passwd" in p for p in site.requests))

    def test_bare_specifier_fails(self):
        routes = good_site()
        routes["/engine/route.js"] = ("200", JS, b"import L from 'leaflet';\n")
        self.assertFails(routes, "bare module specifier 'leaflet'")

    def test_redirect_is_not_followed(self):
        other = self.serve({"/ui/map-planner.css": ("200", CSS, b"body{}")})
        routes = good_site()
        routes["/ui/map-planner.css"] = ("302", "text/plain", f"{other.base}/ui/map-planner.css".encode())
        self.assertFails(routes, "/ui/map-planner.css: HTTP 302")
        self.assertEqual(other.requests, [])

    def test_missing_required_entry_fails(self):
        routes = good_site()
        del routes["/planner.html"]
        self.assertFails(routes, "required: '/planner.html' -> /planner.html: HTTP 404")

    def test_non_loopback_or_bad_base_is_refused(self):
        for base in ("http://10.0.0.1:8000", "https://127.0.0.1:8000", "http://example.org",
                     "http://127.0.0.1:8000/app", "ftp://127.0.0.1"):
            code, out, _ = run_checker(base)
            self.assertEqual(code, 2, f"{base}: {out}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
