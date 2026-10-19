"""Checks that a packaged web root can serve the map planner with all local assets.

Usage: python check-packaged-web.py [WEB_ROOT]   (default /app/web)

Starting from planner.html it follows <script src>, <link href>, <img src>,
ES module imports/re-exports (static and literal dynamic) and CSS url()/@import,
and requires every relative reference to resolve to a readable file inside
WEB_ROOT. External URLs (http:, https:, data:, //host, #fragment) are not local
files and are skipped. Exits 1 and lists every problem, so a missing file or a
broken import anywhere in the module chain fails the check.

Standard library only: it runs inside the production image without extra packages.
"""
import os
import re
import sys
from html.parser import HTMLParser

REQUIRED = ["planner.html", "ui/map-planner.mjs", "ui/map-planner.css"]
ENTRIES = ["planner.html"]

JS_FROM = re.compile(r"(?:^|[;}\n])\s*(?:import|export)\b[^;'\"`]*?\bfrom\s*(['\"])(.+?)\1", re.S)
JS_BARE = re.compile(r"(?:^|[;}\n])\s*import\s*(['\"])(.+?)\1")
JS_DYNAMIC = re.compile(r"\bimport\s*\(\s*(['\"])(.+?)\1\s*\)")
CSS_URL = re.compile(r"url\(\s*(['\"]?)([^'\")]+)\1\s*\)")
CSS_IMPORT = re.compile(r"@import\s+(['\"])(.+?)\1")


class RefParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.refs = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in ("script", "img") and a.get("src"):
            self.refs.append(a["src"])
        elif tag == "link" and a.get("href"):
            self.refs.append(a["href"])


def is_external(ref):
    r = ref.strip().lower()
    return r == "" or r.startswith(("http:", "https:", "data:", "blob:", "//", "#", "mailto:"))


def references(path, text):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".html", ".htm"):
        p = RefParser()
        p.feed(text)
        return p.refs
    if ext in (".js", ".mjs"):
        return [m.group(2) for rx in (JS_FROM, JS_BARE, JS_DYNAMIC) for m in rx.finditer(text)]
    if ext == ".css":
        return [m.group(2) for rx in (CSS_URL, CSS_IMPORT) for m in rx.finditer(text)]
    return []


def check(root):
    root = os.path.realpath(root)
    problems, seen, queue = [], set(), []

    def resolve(base_dir, ref):
        clean = ref.split("#", 1)[0].split("?", 1)[0]
        if clean.startswith("/"):
            target = os.path.join(root, clean.lstrip("/"))
        else:
            target = os.path.join(base_dir, clean)
        return os.path.realpath(target)

    def visit(target, source, ref):
        rel = os.path.relpath(target, root)
        if os.path.commonpath([root, target]) != root:
            problems.append(f"{source}: '{ref}' resolves outside WEB_ROOT")
            return
        if not os.path.isfile(target):
            problems.append(f"{source}: '{ref}' -> {rel} is missing")
            return
        if target not in seen:
            seen.add(target)
            queue.append(target)

    for req in REQUIRED:
        visit(os.path.realpath(os.path.join(root, req)), "required", req)
    for entry in ENTRIES:
        visit(os.path.realpath(os.path.join(root, entry)), "entry", entry)

    while queue:
        path = queue.pop(0)
        rel = os.path.relpath(path, root)
        try:
            with open(path, "rb") as f:
                data = f.read()
        except OSError as exc:
            problems.append(f"{rel}: not readable ({exc})")
            continue
        if os.path.splitext(path)[1].lower() not in (".html", ".htm", ".js", ".mjs", ".css"):
            continue
        text = data.decode("utf-8", errors="replace")
        for ref in references(path, text):
            if is_external(ref):
                continue
            ext = os.path.splitext(path)[1].lower()
            if ext in (".js", ".mjs") and not ref.startswith(("./", "../", "/")):
                problems.append(f"{rel}: bare module specifier '{ref}' cannot load without a bundler")
                continue
            visit(resolve(os.path.dirname(path), ref), rel, ref)

    return sorted(os.path.relpath(p, root) for p in seen), problems


def main():
    root = sys.argv[1] if len(sys.argv) > 1 else "/app/web"
    if not os.path.isdir(root):
        print(f"FAIL: WEB_ROOT {root} is not a directory")
        return 1
    files, problems = check(root)
    for f in files:
        print(f"ok  {f}")
    if problems:
        for p in problems:
            print(f"FAIL {p}")
        print(f"FAIL: {len(problems)} problem(s) in {root}")
        return 1
    print(f"PASS: {len(files)} local files reachable from planner.html in {root}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
