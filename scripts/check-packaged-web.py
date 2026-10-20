"""Checks that a packaged web root can serve a page with all its local assets.

Usage: python check-packaged-web.py [WEB_ROOT] [--entry planner.html|boss.html ...]
       (default WEB_ROOT /app/web, default entry planner.html; --entry may repeat)

Starting from each entry page it follows <script src>, <link href>, <img src>,
the imports of inline <script type="module"> blocks, ES module imports/re-exports
(static and literal dynamic) and CSS url()/@import, and requires every relative
reference to resolve to a readable file inside WEB_ROOT. External URLs (http:,
https:, data:, //host, #fragment) are not local files and are skipped. Links
(<a href>), forms and the text of ordinary scripts are not assets. Each entry's
required files must also be reached through those references, not only exist.
Exits 1 and lists every problem, so a missing file or a broken import anywhere in
the module chain fails the check; exits 2 for bad arguments.

Standard library only: it runs inside the production image without extra packages.
"""
import argparse
import os
import re
import sys
from html.parser import HTMLParser

# Entry page -> files that page must reach. Only these names are accepted as entries.
ENTRY_GRAPHS = {
    "planner.html": ["planner.html", "ui/map-planner.mjs", "ui/map-planner.css"],
    "boss.html": ["boss.html", "ui/truck-profile-input.mjs"],
}
DEFAULT_ENTRY = "planner.html"
# Kept for callers that read them: the planner graph.
REQUIRED = ENTRY_GRAPHS["planner.html"]
ENTRIES = [DEFAULT_ENTRY]

JS_FROM = re.compile(r"(?:^|[;}\n])\s*(?:import|export)\b[^;'\"`]*?\bfrom\s*(['\"])(.+?)\1", re.S)
JS_BARE = re.compile(r"(?:^|[;}\n])\s*import\s*(['\"])(.+?)\1")
JS_DYNAMIC = re.compile(r"\bimport\s*\(\s*(['\"])(.+?)\1\s*\)")
CSS_URL = re.compile(r"url\(\s*(['\"]?)([^'\")]+)\1\s*\)")
CSS_IMPORT = re.compile(r"@import\s+(['\"])(.+?)\1")


def js_references(text):
    return [m.group(2) for rx in (JS_FROM, JS_BARE, JS_DYNAMIC) for m in rx.finditer(text)]


class RefParser(HTMLParser):
    """Collects asset references; refs are (reference, is_module_import) pairs."""

    def __init__(self):
        super().__init__()
        self.refs = []
        self._inline_module = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "script":
            if a.get("src"):
                self.refs.append((a["src"], False))
            elif (a.get("type") or "").strip().lower() == "module":
                self._inline_module = []
        elif tag == "img" and a.get("src"):
            self.refs.append((a["src"], False))
        elif tag == "link" and a.get("href"):
            self.refs.append((a["href"], False))

    def handle_data(self, data):
        if self._inline_module is not None:
            self._inline_module.append(data)

    def handle_endtag(self, tag):
        if tag == "script" and self._inline_module is not None:
            self.refs.extend((ref, True) for ref in js_references("".join(self._inline_module)))
            self._inline_module = None


def is_external(ref):
    r = ref.strip().lower()
    return r == "" or r.startswith(("http:", "https:", "data:", "blob:", "//", "#", "mailto:"))


def references_with_kind(path, text):
    """(reference, is_module_import) for every asset reference in a file."""
    ext = os.path.splitext(path)[1].lower()
    if ext in (".html", ".htm"):
        p = RefParser()
        p.feed(text)
        p.close()
        return p.refs
    if ext in (".js", ".mjs"):
        return [(ref, True) for ref in js_references(text)]
    if ext == ".css":
        return [(m.group(2), False) for rx in (CSS_URL, CSS_IMPORT) for m in rx.finditer(text)]
    return []


def references(path, text):
    return [ref for ref, _ in references_with_kind(path, text)]


def is_bare(ref):
    return not ref.startswith(("./", "../", "/"))


def check(root, entries=(DEFAULT_ENTRY,)):
    root = os.path.realpath(root)
    problems, seen, reached, queue = [], set(), set(), []

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

    required = []
    for entry in entries:
        for req in ENTRY_GRAPHS[entry]:
            if req not in required:
                required.append(req)
    # entry pages start the walk; every other required file must be found through it
    for entry in entries:
        target = os.path.realpath(os.path.join(root, entry))
        reached.add(target)
        visit(target, "required", entry)

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
        for ref, is_module in references_with_kind(path, text):
            if is_external(ref):
                continue
            if is_module and is_bare(ref):
                problems.append(f"{rel}: bare module specifier '{ref}' cannot load without a bundler")
                continue
            target = resolve(os.path.dirname(path), ref)
            if os.path.commonpath([root, target]) == root:
                reached.add(target)
            visit(target, rel, ref)

    for req in required:
        target = os.path.realpath(os.path.join(root, req))
        if target not in reached:
            state = "exists but " if os.path.isfile(target) else ""
            problems.append(f"required: '{req}' {state}is not reached from {' or '.join(entries)}")

    return sorted(os.path.relpath(p, root) for p in seen), problems


def parse_args(argv):
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("web_root", nargs="?", default="/app/web")
    ap.add_argument("--entry", action="append", choices=sorted(ENTRY_GRAPHS),
                    help="entry page to check (repeatable; default planner.html)")
    return ap.parse_args(argv)


def main(argv=None):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    entries = list(dict.fromkeys(args.entry or [DEFAULT_ENTRY]))
    root = args.web_root
    if not os.path.isdir(root):
        print(f"FAIL: WEB_ROOT {root} is not a directory")
        return 1
    files, problems = check(root, entries)
    for f in files:
        print(f"ok  {f}")
    if problems:
        for p in problems:
            print(f"FAIL {p}")
        print(f"FAIL: {len(problems)} problem(s) in {root}")
        return 1
    print(f"PASS: {len(files)} local files reachable from {' + '.join(entries)} in {root}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
