"""Negative and positive fixtures for check-served-web.py on local loopback HTTP servers.

Usage: python test-check-served-web.py   (exit 0 when every case behaves as expected)

Each case starts a small http.server on 127.0.0.1:0 that serves an in-memory
site and runs the checker as a subprocess against it, asserting its exit code
and output. Timeouts are short (fractions of a second), so no case waits long.
Standard library only; no network beyond loopback.
"""
import importlib.util
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
CHECKER = os.path.join(HERE, "check-served-web.py")
FILE_CHECKER = os.path.join(HERE, "check-packaged-web.py")

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


BOSS_INLINE = (b'<!doctype html><link rel="manifest" href="manifest.json">'
               b'<link rel="stylesheet" href="vendor/lib.css">'
               b'<a href="index.html">back</a><form action="/api/owner/login"></form>'
               b'<script src="vendor/lib.js"></script>'
               b'<script type="module">\n'
               b"import { analyze } from './engine/rules.js';\n"
               b"import { PROFILE_FIELDS } from './ui/truck-profile-input.mjs';\n"
               b"const later = () => import('./engine/lazy.js');\n"
               b"fetch('/api/route-options');\n"
               b'</script>')


def boss_site():
    """The boss page: its helper is reachable only through an inline module import."""
    return {
        "/api/health": HEALTH,
        "/boss.html": ("200", HTML, BOSS_INLINE),
        "/manifest.json": ("200", "application/json", b"{}"),
        "/vendor/lib.css": ("200", CSS, b".a { background: url(images/layers.png) }\n"),
        "/vendor/images/layers.png": ("200", PNG, b"\x89PNG\r\n\x1a\n"),
        "/vendor/lib.js": ("200", JS, b"window.L = {};\n"),
        "/engine/rules.js": ("200", JS, b"export * from './time.js';\nexport const analyze = 1;\n"),
        "/engine/time.js": ("200", JS, b"export const clock = 1;\n"),
        "/engine/lazy.js": ("200", JS, b"export const lazy = 1;\n"),
        "/ui/truck-profile-input.mjs": ("200", JS, b"export const PROFILE_FIELDS = [];\n"),
    }


def both_sites():
    routes = good_site()
    routes.update(boss_site())
    return routes


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


class BaseUrlTests(unittest.TestCase):
    """The base URL must be loopback http:// without user info; refused before any request."""

    def test_user_info_is_refused_before_any_request_and_not_echoed(self):
        site = Site(good_site())
        self.addCleanup(site.close)
        host_port = site.base.split("//", 1)[1]
        for userinfo in ("synthetic-user@", "synthetic-user:synthetic-pass@", "@", ":synthetic-pass@",
                         "synthetic%40user:synthetic%3Apass@"):
            code, out, _ = run_checker(f"http://{userinfo}{host_port}", "--entry", "boss.html")
            self.assertEqual(code, 2, f"{userinfo!r}: {out}")
            self.assertIn("must not contain user info", out)
            self.assertNotIn("synthetic", out)
            self.assertNotIn(host_port, out)
        self.assertEqual(site.requests, [])

    def test_loopback_bases_without_user_info_are_accepted(self):
        served = load_served_checker()
        self.assertEqual(served.check_base("http://127.0.0.1:8000"), ("http://127.0.0.1:8000", None))
        self.assertEqual(served.check_base("http://localhost:8000/"), ("http://localhost:8000", None))
        self.assertEqual(served.check_base("http://[::1]:8000"), ("http://[::1]:8000", None))
        origin, err = served.check_base("http://[::1")
        self.assertIsNone(origin)
        self.assertNotIn("::1", err)


def load_served_checker():
    spec = importlib.util.spec_from_file_location("check_served_web", CHECKER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class BossEntryTests(unittest.TestCase):
    """--entry boss.html: inline module imports are part of the checked graph."""

    def serve(self, routes, fallback=None):
        site = Site(routes, fallback)
        self.addCleanup(site.close)
        return site

    def run_boss(self, routes, *entries, fallback=None):
        site = self.serve(routes, fallback)
        args = [a for e in (entries or ("boss.html",)) for a in ("--entry", e)]
        code, out, _ = run_checker(site.base, *args)
        return site, code, out

    def test_boss_positive_control_follows_inline_and_nested_imports(self):
        site, code, out = self.run_boss(boss_site())
        self.assertEqual(code, 0, out)
        self.assertIn("PASS: 9 local files served with expected types from", out)
        for path in ("/ui/truck-profile-input.mjs", "/engine/rules.js", "/engine/time.js", "/engine/lazy.js",
                     "/vendor/images/layers.png", "/manifest.json"):
            self.assertIn(path, site.requests)
        # links, forms and API calls in the page are not assets
        for path in ("/index.html", "/api/owner/login", "/api/route-options"):
            self.assertNotIn(path, site.requests)
        self.assertNotIn("/planner.html", site.requests)

    def test_planner_and_boss_entries_together_check_the_union(self):
        site, code, out = self.run_boss(both_sites(), "planner.html", "boss.html")
        self.assertEqual(code, 0, out)
        self.assertIn("PASS: 15 local files", out)
        self.assertIn("/planner.html", site.requests)
        self.assertIn("/ui/truck-profile-input.mjs", site.requests)

    def test_default_entry_is_still_planner_only(self):
        site = self.serve(both_sites())
        code, out, _ = run_checker(site.base)
        self.assertEqual(code, 0, out)
        self.assertNotIn("/boss.html", site.requests)

    def test_missing_inline_helper_fails(self):
        routes = boss_site()
        del routes["/ui/truck-profile-input.mjs"]
        _, code, out = self.run_boss(routes)
        self.assertEqual(code, 1, out)
        self.assertIn("/boss.html: './ui/truck-profile-input.mjs' -> /ui/truck-profile-input.mjs: HTTP 404", out)

    def test_missing_boss_page_fails(self):
        routes = boss_site()
        del routes["/boss.html"]
        _, code, out = self.run_boss(routes)
        self.assertEqual(code, 1, out)
        self.assertIn("required: '/boss.html' -> /boss.html: HTTP 404", out)

    def test_missing_nested_import_of_inline_module_fails(self):
        routes = boss_site()
        del routes["/engine/time.js"]
        _, code, out = self.run_boss(routes)
        self.assertEqual(code, 1, out)
        self.assertIn("/engine/rules.js: './time.js' -> /engine/time.js: HTTP 404", out)

    def test_missing_dynamic_import_of_inline_module_fails(self):
        routes = boss_site()
        del routes["/engine/lazy.js"]
        _, code, out = self.run_boss(routes)
        self.assertEqual(code, 1, out)
        self.assertIn("/boss.html: './engine/lazy.js' -> /engine/lazy.js: HTTP 404", out)

    def test_helper_served_as_text_plain_fails(self):
        routes = boss_site()
        routes["/ui/truck-profile-input.mjs"] = ("200", "text/plain; charset=utf-8", b"export const PROFILE_FIELDS = [];\n")
        _, code, out = self.run_boss(routes)
        self.assertEqual(code, 1, out)
        self.assertIn("/ui/truck-profile-input.mjs: Content-Type text/plain, expected", out)

    def test_helper_html_fallback_fails(self):
        routes = boss_site()
        del routes["/ui/truck-profile-input.mjs"]
        _, code, out = self.run_boss(routes, fallback=("200", HTML, b"<!doctype html><title>app</title>"))
        self.assertEqual(code, 1, out)
        self.assertIn("/ui/truck-profile-input.mjs: Content-Type text/html, expected", out)

    def test_helper_redirect_is_not_followed(self):
        other = self.serve({"/ui/truck-profile-input.mjs": ("200", JS, b"export {};")})
        routes = boss_site()
        routes["/ui/truck-profile-input.mjs"] = ("302", "text/plain", f"{other.base}/ui/truck-profile-input.mjs".encode())
        _, code, out = self.run_boss(routes)
        self.assertEqual(code, 1, out)
        self.assertIn("/ui/truck-profile-input.mjs: HTTP 302", out)
        self.assertEqual(other.requests, [])

    def test_hanging_helper_times_out(self):
        routes = boss_site()
        routes["/ui/truck-profile-input.mjs"] = "hang"
        site = self.serve(routes)
        code, out, elapsed = run_checker(site.base, "--entry", "boss.html")
        self.assertEqual(code, 1, out)
        self.assertIn("/ui/truck-profile-input.mjs: request failed", out)
        self.assertLess(elapsed, 10)

    def test_inline_bare_and_traversal_imports_fail_without_request(self):
        routes = boss_site()
        routes["/boss.html"] = ("200", HTML, BOSS_INLINE.replace(
            b"</script>", b"import L from 'leaflet';\nimport '../../etc/passwd.js';\n</script>"))
        site, code, out = self.run_boss(routes)
        self.assertEqual(code, 1, out)
        self.assertIn("/boss.html: bare module specifier 'leaflet'", out)
        self.assertIn("/boss.html: '../../etc/passwd.js' climbs above the web root", out)
        self.assertFalse(any("passwd" in p or "leaflet" in p for p in site.requests))

    def test_inline_external_imports_are_skipped_and_never_requested(self):
        other = self.serve({"/x.js": ("200", JS, b"export {};")})
        routes = boss_site()
        routes["/boss.html"] = ("200", HTML, BOSS_INLINE.replace(
            b"</script>", f"import '{other.base}/x.js';\nimport 'https://cdn.example.org/y.js';\n</script>".encode()))
        _, code, out = self.run_boss(routes)
        self.assertEqual(code, 0, out)
        self.assertEqual(other.requests, [])

    def test_ordinary_script_and_page_text_are_not_imports(self):
        routes = boss_site()
        routes["/boss.html"] = ("200", HTML, BOSS_INLINE
            + b"<script>\nimport x from './nope-classic.js';\n</script>"
            + b'<script type="text/javascript">import "./nope-typed.js";</script>'
            + b"<pre>\nimport y from './nope-text.js';\n</pre>"
            + b'<script type="module" src="ui/truck-profile-input.mjs">import "./nope-src.js";</script>')
        site, code, out = self.run_boss(routes)
        self.assertEqual(code, 0, out)
        self.assertFalse(any("nope" in p for p in site.requests), site.requests)

    def test_helper_reached_only_if_imported(self):
        routes = boss_site()
        routes["/boss.html"] = ("200", HTML, BOSS_INLINE.replace(
            b"import { PROFILE_FIELDS } from './ui/truck-profile-input.mjs';\n", b""))
        _, code, out = self.run_boss(routes)
        self.assertEqual(code, 1, out)
        self.assertIn("required: '/ui/truck-profile-input.mjs' is not reached from /boss.html", out)

    def test_entry_values_are_restricted(self):
        site = self.serve(boss_site())
        for entry in ("../boss.html", "/etc/passwd", "http://127.0.0.1/boss.html", "index.html", "BOSS.HTML", ""):
            code, out, _ = run_checker(site.base, "--entry", entry)
            self.assertEqual(code, 2, f"{entry!r}: {out}")
        self.assertEqual(site.requests, [])


def load_file_checker():
    spec = importlib.util.spec_from_file_location("check_packaged_web", FILE_CHECKER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FileCheckerTests(unittest.TestCase):
    """check-packaged-web.py on a temporary synthetic web root (no image, no network)."""

    def make_root(self, routes):
        root = tempfile.mkdtemp(prefix="webroot-")
        self.addCleanup(lambda: __import__("shutil").rmtree(root, ignore_errors=True))
        for path, entry in routes.items():
            if path.startswith("/api/"):
                continue
            target = os.path.join(root, path.lstrip("/"))
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "wb") as f:
                f.write(entry[2])
        return root

    def run_file(self, root, *entries):
        args = [a for e in entries for a in ("--entry", e)]
        proc = subprocess.run([sys.executable, "-I", "-", root, *args], stdin=open(FILE_CHECKER, "rb"),
                              capture_output=True, text=True, timeout=30)
        return proc.returncode, proc.stdout + proc.stderr

    def test_planner_and_boss_positive_controls_through_stdin(self):
        root = self.make_root(both_sites())
        code, out = self.run_file(root)
        self.assertEqual(code, 0, out)
        self.assertIn("PASS: 8 local files reachable from planner.html", out)
        code, out = self.run_file(root, "boss.html")
        self.assertEqual(code, 0, out)
        self.assertIn("PASS: 9 local files reachable from boss.html", out)
        self.assertIn("ok  ui/truck-profile-input.mjs", out)
        self.assertIn("ok  engine/lazy.js", out)
        code, out = self.run_file(root, "planner.html", "boss.html")
        self.assertEqual(code, 0, out)
        self.assertIn("PASS: 15 local files reachable from planner.html + boss.html", out)

    def test_missing_helper_nested_or_page_fails(self):
        for missing, needle in (("/ui/truck-profile-input.mjs", "boss.html: './ui/truck-profile-input.mjs' -> ui/truck-profile-input.mjs is missing"),
                                ("/engine/time.js", "engine/rules.js: './time.js' -> engine/time.js is missing"),
                                ("/boss.html", "required: 'boss.html' -> boss.html is missing")):
            routes = boss_site()
            del routes[missing]
            code, out = self.run_file(self.make_root(routes), "boss.html")
            self.assertEqual(code, 1, f"{missing}: {out}")
            self.assertIn(needle, out)
            if missing != "/boss.html":
                # reported once, at the place that needs the file
                self.assertIn("FAIL: 1 problem(s)", out)

    def test_helper_present_but_not_imported_fails(self):
        routes = boss_site()
        routes["/boss.html"] = ("200", HTML, BOSS_INLINE.replace(
            b"import { PROFILE_FIELDS } from './ui/truck-profile-input.mjs';\n", b""))
        code, out = self.run_file(self.make_root(routes), "boss.html")
        self.assertEqual(code, 1, out)
        self.assertIn("required: 'ui/truck-profile-input.mjs' exists but is not reached from boss.html", out)
        self.assertNotIn("ok  ui/truck-profile-input.mjs", out)

    def test_inline_bare_import_and_symlink_escape_fail(self):
        routes = boss_site()
        routes["/boss.html"] = ("200", HTML, BOSS_INLINE.replace(b"</script>", b"import L from 'leaflet';\n</script>"))
        root = self.make_root(routes)
        outside = tempfile.mkdtemp(prefix="outside-")
        self.addCleanup(lambda: __import__("shutil").rmtree(outside, ignore_errors=True))
        with open(os.path.join(outside, "time.js"), "w") as f:
            f.write("export const clock = 1;\n")
        os.remove(os.path.join(root, "engine", "time.js"))
        os.symlink(os.path.join(outside, "time.js"), os.path.join(root, "engine", "time.js"))
        code, out = self.run_file(root, "boss.html")
        self.assertEqual(code, 1, out)
        self.assertIn("boss.html: bare module specifier 'leaflet'", out)
        self.assertIn("engine/rules.js: './time.js' resolves outside WEB_ROOT", out)

    def test_inline_parser_reads_only_module_scripts(self):
        fc = load_file_checker()
        html = (BOSS_INLINE + b"<script>import a from './classic.js';</script>"
                b"<p>import b from './text.js';</p><script type=' MODULE '>export * from './upper.js';</script>").decode()
        refs = fc.references_with_kind("boss.html", html)
        modules = [r for r, is_module in refs if is_module]
        self.assertEqual(modules, ["./engine/rules.js", "./ui/truck-profile-input.mjs", "./engine/lazy.js", "./upper.js"])
        self.assertEqual([r for r, is_module in refs if not is_module], ["manifest.json", "vendor/lib.css", "vendor/lib.js"])
        self.assertEqual(fc.references("planner.html", '<script type="module" src="ui/a.mjs"></script>'), ["ui/a.mjs"])

    def test_entry_values_are_restricted(self):
        root = self.make_root(boss_site())
        for entry in ("../boss.html", "/etc/passwd", "index.html", "boss"):
            code, out = self.run_file(root, entry)
            self.assertEqual(code, 2, f"{entry!r}: {out}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
