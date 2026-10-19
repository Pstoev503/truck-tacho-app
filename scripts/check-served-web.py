"""Checks over HTTP that a running server serves the map planner with correct types.

Usage: python check-served-web.py BASE_URL [--ready-timeout S] [--request-timeout S]
       e.g. python check-served-web.py http://127.0.0.1:8000

Waits (bounded) for GET /api/health to answer 200 with JSON {"ok": true}, then
starts at /planner.html and follows every local reference the same way the file
checker does (scripts/check-packaged-web.py is loaded read-only for that). Each
reference must answer 200 with a non-empty body and a fitting Content-Type:
HTML for .html, a JavaScript MIME type for .js/.mjs, text/css for .css, and
anything but HTML for other assets (an HTML answer there is an SPA fallback).

Only loopback http:// base URLs are accepted. Proxies and redirects are not
followed, external URLs (http:, https:, data:, //host, #) are never requested,
and a reference that leaves the base origin or climbs above the web root is an
error. Exits 1 and lists every problem; exits 2 for bad arguments.

Standard library only.
"""
import argparse
import http.client
import importlib.util
import ipaddress
import json
import os
import posixpath
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REQUIRED = ["/planner.html", "/ui/map-planner.mjs", "/ui/map-planner.css"]
ENTRY = "/planner.html"
HEALTH = "/api/health"

JS_TYPES = {"text/javascript", "application/javascript", "application/x-javascript",
            "application/ecmascript", "text/ecmascript"}
EXPECTED = {".html": {"text/html"}, ".htm": {"text/html"}, ".js": JS_TYPES, ".mjs": JS_TYPES,
            ".css": {"text/css"}}
CONTENT_EXTS = (".html", ".htm", ".js", ".mjs", ".css")


def load_file_checker():
    spec = importlib.util.spec_from_file_location("check_packaged_web",
                                                  os.path.join(HERE, "check-packaged-web.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # a 3xx then surfaces as HTTPError and is reported


OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect)


def fetch(url, timeout):
    """Returns (status, content_type, body) or raises OSError on network trouble/timeout."""
    req = urllib.request.Request(url, headers={"Accept": "*/*"})
    try:
        with OPENER.open(req, timeout=timeout) as resp:
            return resp.status, resp.headers.get("Content-Type", ""), resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.headers.get("Content-Type", "") if exc.headers else "", b""


def media_type(content_type):
    return content_type.split(";", 1)[0].strip().lower()


def check_base(base):
    parts = urllib.parse.urlsplit(base)
    if parts.scheme != "http" or not parts.hostname:
        return None, f"base URL must be http://<loopback>[:port], got {base!r}"
    host = parts.hostname
    try:
        loopback = host == "localhost" or ipaddress.ip_address(host).is_loopback
    except ValueError:
        loopback = False
    if not loopback:
        return None, f"base URL host {host!r} is not loopback"
    if parts.path not in ("", "/") or parts.query or parts.fragment:
        return None, "base URL must not have a path, query or fragment"
    return f"http://{parts.netloc}", None


def wait_ready(origin, ready_timeout, request_timeout, poll=0.25):
    deadline = time.monotonic() + ready_timeout
    last = "no answer"
    while True:
        try:
            status, ctype, body = fetch(origin + HEALTH, min(request_timeout, max(0.05, deadline - time.monotonic())))
            if status == 200:
                try:
                    if json.loads(body.decode("utf-8")).get("ok") is True:
                        return None
                    last = "health JSON without ok:true"
                except (ValueError, AttributeError):
                    last = f"health answered non-JSON ({media_type(ctype) or 'no type'})"
            else:
                last = f"health answered {status}"
        except (OSError, http.client.HTTPException) as exc:
            last = f"health not reachable ({exc.__class__.__name__}: {exc})"
        if time.monotonic() + poll > deadline:
            return f"server not ready after {ready_timeout:g}s: {last}"
        time.sleep(poll)


def resolve(from_path, ref):
    """Maps a reference on page from_path to a web-root path, or returns (None, reason)."""
    clean = ref.split("#", 1)[0].split("?", 1)[0]
    if clean.startswith("/"):
        joined = clean
    else:
        joined = posixpath.join(posixpath.dirname(from_path), clean)
    depth = 0
    for seg in joined.split("/"):
        if seg in ("", "."):
            continue
        depth = depth - 1 if seg == ".." else depth + 1
        if depth < 0:
            return None, "climbs above the web root"
    return posixpath.normpath(joined), None


def check(origin, request_timeout, file_checker):
    problems, seen, queue = [], set(), []

    def visit(path, source, ref):
        if path not in seen:
            seen.add(path)
            queue.append((path, source, ref))

    for req in REQUIRED:
        visit(req, "required", req)
    visit(ENTRY, "entry", ENTRY)

    while queue:
        path, source, ref = queue.pop(0)
        url = origin + urllib.parse.quote(path)
        try:
            status, ctype, body = fetch(url, request_timeout)
        except (OSError, http.client.HTTPException) as exc:
            problems.append(f"{source}: '{ref}' -> {path}: request failed ({exc.__class__.__name__}: {exc})")
            continue
        mtype = media_type(ctype)
        if status != 200:
            problems.append(f"{source}: '{ref}' -> {path}: HTTP {status}")
            continue
        if not body:
            problems.append(f"{source}: '{ref}' -> {path}: empty body")
            continue
        ext = posixpath.splitext(path)[1].lower()
        allowed = EXPECTED.get(ext)
        if allowed is not None and mtype not in allowed:
            problems.append(f"{source}: '{ref}' -> {path}: Content-Type {mtype or 'missing'}, "
                            f"expected {' or '.join(sorted(allowed))}")
            continue
        if allowed is None and mtype == "text/html":
            problems.append(f"{source}: '{ref}' -> {path}: answered text/html (SPA fallback?)")
            continue
        if ext not in CONTENT_EXTS:
            continue
        text = body.decode("utf-8", errors="replace")
        for child in file_checker.references(path, text):
            if file_checker.is_external(child):
                continue
            if ext in (".js", ".mjs") and not child.startswith(("./", "../", "/")):
                problems.append(f"{path}: bare module specifier '{child}' cannot load without a bundler")
                continue
            target, reason = resolve(path, child)
            if target is None:
                problems.append(f"{path}: '{child}' {reason}")
                continue
            visit(target, path, child)

    return sorted(seen), problems


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("base_url")
    ap.add_argument("--ready-timeout", type=float, default=60.0)
    ap.add_argument("--request-timeout", type=float, default=10.0)
    args = ap.parse_args(argv)
    origin, err = check_base(args.base_url)
    if err:
        print(f"FAIL: {err}")
        return 2
    if args.ready_timeout <= 0 or args.request_timeout <= 0:
        print("FAIL: timeouts must be positive")
        return 2
    not_ready = wait_ready(origin, args.ready_timeout, args.request_timeout)
    if not_ready:
        print(f"FAIL: {not_ready}")
        return 1
    print(f"ready: {origin}{HEALTH}")
    files, problems = check(origin, args.request_timeout, load_file_checker())
    for p in problems:
        print(f"FAIL {p}")
    if problems:
        print(f"FAIL: {len(problems)} problem(s) at {origin}")
        return 1
    for f in files:
        print(f"ok  {f}")
    print(f"PASS: {len(files)} local files served with expected types from {origin}{ENTRY}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
