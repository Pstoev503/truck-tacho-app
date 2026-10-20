"""Runs the v2 isolated-staging runbook plus S7 in a real headless browser, in a disposable CI runner.

Based on the accepted scripts/check-candidate-staging.py (STAGING-CANDIDATE-01, da5dcfa): the
same pins (APP INT-31, v2 runbook blob), guards, verbatim blocks and cleanup checks. Added: one
reported browser line after the `s6` block (scripts/browser-staging.mjs, S7 of the runbook),
browser/Node guards before Docker, the S7 markers, and a check that no process of this run's
temp dir (the browser profile lives there) is left.

Usage: python check-browser-staging.py --app APP_CHECKOUT --runbook RUNBOOK_MD --browser CHROME
                                       [--driver browser-staging.mjs] [--timeout S]

Before anything touches Docker or the network it checks:
  * APP_CHECKOUT is a clean Git checkout of exactly APP_SHA (INT-31);
  * RUNBOOK_MD is exactly the Git blob RUNBOOK_BLOB (docs/runbooks/isolated-staging-check-v2.md
    in this harness; the harness head is recorded at run time, not embedded here);
  * every <!-- run:NAME --> marker is unique and followed by a ```bash block, and
    every allowlisted block exists;
  * CHROME answers --version and `node` has a built-in WebSocket (S7 NOT RUN otherwise).
Then it runs, in one bash process with APP_CHECKOUT as working directory, the
allowlisted blocks verbatim in ORDER. The only lines it adds (printed in full
before the run) are the orchestration in ORCHESTRATION: TERM/INT end the shell
so the runbook's own `trap cleanup EXIT` still runs, and after `vars` the run
id and temp dir are written to a metadata file for the post-run check, and after `s6`
one line runs the browser driver (before the shell exits, so the EXIT cleanup comes after it).
No runbook command or helper is replaced. Blocks outside the allowlist (for
example docker-7) are never executed.

After bash ends (pass, failed assertion or timeout) it checks that no container,
network or image with the exact run label is left, that the temp dir is gone and that no
process still names that temp dir (the browser and its helpers).
Exit 0 only if every expected marker was printed and nothing is left.

Standard library only. Prints no tokens, passwords or environment.
"""
import argparse
import hashlib
import io
import os
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time

APP_SHA = "9c6fbc9d64041ac401c3cd87bcb3f4d2eaafc354"
RUNBOOK_PATH = "docs/runbooks/isolated-staging-check-v2.md"
RUNBOOK_BLOB = "f0d7750ff89f8f4c6e5259e35e0cee419df53ce4"
ORDER = ["vars", "docker-0", "docker-1", "docker-2", "docker-3", "router-script", "docker-4",
         "docker-5", "helpers", "owner", "s1", "s2", "s3", "s4", "s5", "s6"]
EXPECTED_MARKERS = [
    "PASS: 21 local files reachable from planner.html",
    "PASS: 15 local files reachable from boss.html",
    "owner ok", "S1 ok", "S2 ok", "S3 ok", "S4 ok", "S5 ok",
    # the three boss.html helpers added after INT-27, each served over HTTP with an exact MIME type
    "S6 served boss: /ui/api-error-message.mjs text/javascript",
    "S6 served boss: /ui/provider-geometry.mjs text/javascript",
    "S6 served boss: /ui/route-options-response.mjs text/javascript",
    "S6 ok",
    # S7, only printed by scripts/browser-staging.mjs after real browser assertions
    "S7 browser launched: ",
    "S7 desktop-1280 step 1 ok", "S7 desktop-1280 step 2 ok", "S7 desktop-1280 step 3 ok",
    "S7 desktop-1280 step 4 ok", "S7 desktop-1280 step 5 ok", "S7 desktop-1280 step 6 ok",
    "S7 desktop-1280 ok (1280x900): 0 JS exceptions",
    "S7 mobile-375 step 1 ok", "S7 mobile-375 step 2 ok", "S7 mobile-375 step 3 ok",
    "S7 mobile-375 step 4 ok", "S7 mobile-375 step 5 ok", "S7 mobile-375 step 6 ok",
    "S7 mobile-375 ok (375x812 mobile): 0 JS exceptions",
    "S7 js exceptions: 0",
    "S7 ok (desktop-1280, mobile-375",
    "S7 cleanup: browser stopped (0 own processes left), profile dir removed",
]
HERE = os.path.dirname(os.path.abspath(__file__))
DRIVER = os.path.join(HERE, "browser-staging.mjs")
LABEL_KEY = "t10.stage.run"

MARKER = re.compile(r"<!-- run:([^ >]+) -->")
BLOCK = re.compile(r"<!-- run:([^ >]+) -->\n```bash\n(.*?)\n```", re.S)

# Orchestration added around the verbatim blocks; reported, not hidden.
ORCH_PRELUDE = "trap 'exit 143' TERM INT   # orchestration: a timeout still runs the runbook's EXIT trap\n"
ORCH_AFTER_VARS = ('printf \'%s\\n%s\\n\' "$T10_RUN" "$T10_DIR" > "$T10_META"'
                   "   # orchestration: run id and temp dir for the post-run check\n")
ORCH_BROWSER = ('node "$T10_BROWSER_DRIVER" --base "$T10_BASE" --browser "$T10_BROWSER" --router "$T10_ROUTER_ID" '
                '--profile-dir "$T10_DIR/browser-profile" --timeout 300'
                "   # orchestration: S7 in a real headless browser, before the EXIT cleanup\n")


class GuardError(Exception):
    pass


def git_blob_sha(data):
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def verify_app(app_dir, expected_sha=APP_SHA):
    def git(*args):
        return subprocess.run(["git", "-C", app_dir, *args], capture_output=True, text=True, timeout=30)
    head = git("rev-parse", "HEAD")
    if head.returncode != 0:
        raise GuardError(f"app checkout is not a Git checkout: {app_dir}")
    if head.stdout.strip() != expected_sha:
        raise GuardError(f"app checkout is {head.stdout.strip()}, expected {expected_sha}")
    status = git("status", "--porcelain", "--untracked-files=all")
    if status.returncode != 0 or status.stdout.strip():
        raise GuardError("app checkout has local changes")


def verify_runbook(path, expected_blob=RUNBOOK_BLOB):
    with open(path, "rb") as f:
        data = f.read()
    blob = git_blob_sha(data)
    if blob != expected_blob:
        raise GuardError(f"runbook blob is {blob}, expected {expected_blob}")
    return data.decode("utf-8")


def extract_blocks(text, order=ORDER):
    names = MARKER.findall(text)
    duplicates = sorted({n for n in names if names.count(n) > 1})
    if duplicates:
        raise GuardError(f"duplicate run markers: {', '.join(duplicates)}")
    blocks = dict(BLOCK.findall(text))
    malformed = [n for n in names if n not in blocks]
    if malformed:
        raise GuardError(f"run markers without a bash block: {', '.join(malformed)}")
    missing = [n for n in order if n not in blocks]
    if missing:
        raise GuardError(f"missing runbook blocks: {', '.join(missing)}")
    return {n: blocks[n] for n in order}


def build_script(blocks, order=ORDER, browser_after="s6"):
    parts = [ORCH_PRELUDE]
    for name in order:
        parts.append(f"# ==== runbook block {name} (verbatim) ====\n{blocks[name]}\n")
        if name == "vars":
            parts.append(ORCH_AFTER_VARS)
        if name == browser_after:
            parts.append(ORCH_BROWSER)
    return "".join(parts)


def processes_naming(path, proc_root="/proc"):
    """PIDs whose command line contains this run's temp dir. Only reported, never killed."""
    found = []
    if not path:
        return found
    try:
        names = os.listdir(proc_root)
    except OSError:
        return found
    for name in names:
        if not name.isdigit() or int(name) == os.getpid():
            continue
        try:
            with open(os.path.join(proc_root, name, "cmdline"), "rb") as f:
                cmd = f.read().decode("utf-8", "replace")
        except OSError:
            continue
        if path in cmd:
            found.append(int(name))
    return sorted(found)


def verify_tools(browser, node="node"):
    """Browser binary and Node with a built-in WebSocket; returns their version strings. Before any Docker call."""
    if not browser or not os.path.isfile(browser) or not os.access(browser, os.X_OK):
        raise GuardError(f"browser not found or not executable: {browser!r} — S7 NOT RUN")
    try:
        b = subprocess.run([browser, "--version"], capture_output=True, text=True, timeout=60)
        n = subprocess.run([node, "-e", "process.stdout.write(process.version);"
                                        "process.exit(typeof WebSocket === 'function' ? 0 : 3)"],
                           capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise GuardError(f"browser or node did not answer ({exc.__class__.__name__}) — S7 NOT RUN")
    if b.returncode != 0 or not b.stdout.strip():
        raise GuardError(f"browser --version failed ({b.returncode}) — S7 NOT RUN")
    if n.returncode != 0:
        raise GuardError(f"node {n.stdout.strip() or '?'} has no built-in WebSocket (need Node 22+) — S7 NOT RUN")
    return b.stdout.strip(), n.stdout.strip()


def execute(script, cwd, env, timeout, out=sys.stdout):
    """Runs bash in its own process group. Returns (returncode, output, timed_out)."""
    proc = subprocess.Popen(["bash", "-c", script], cwd=cwd, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, start_new_session=True)
    lines, timed_out = [], False
    deadline = time.monotonic() + timeout

    def reader():
        for line in proc.stdout:
            lines.append(line)
            out.write(line)
            out.flush()
    t = threading.Thread(target=reader, daemon=True)
    t.start()
    while proc.poll() is None:
        if time.monotonic() > deadline:
            timed_out = True
            out.write(f"TIMEOUT after {timeout:g}s: sending TERM so the runbook cleanup trap runs\n")
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=120)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
            break
        time.sleep(0.2)
    t.join(timeout=10)
    proc.stdout.close()
    return proc.returncode, "".join(lines), timed_out


def leftovers(run_id, run_docker=None):
    """Resources that still carry the exact run label. Uses only label filters, never patterns."""
    run_docker = run_docker or (lambda args: subprocess.run(["docker", *args], capture_output=True,
                                                            text=True, timeout=60))
    label = f"label={LABEL_KEY}={run_id}"
    found = []
    for kind, args in (("container", ["ps", "-a", "-q", "--filter", label]),
                       ("network", ["network", "ls", "-q", "--filter", label]),
                       ("image", ["images", "-q", "--filter", label])):
        res = run_docker(args)
        if res.returncode != 0:
            found.append(f"{kind}: could not list ({res.returncode})")
            continue
        found += [f"{kind}: {i}" for i in res.stdout.split()]
    return found


def run(app, runbook, timeout, out=sys.stdout, expected_app=APP_SHA, expected_blob=RUNBOOK_BLOB,
        order=ORDER, expected_markers=EXPECTED_MARKERS, run_docker=None, env_extra=None,
        browser_after="s6", proc_root="/proc"):
    """Returns (ok, summary lines). Raises GuardError before any execution if a guard fails."""
    verify_app(app, expected_app)
    text = verify_runbook(runbook, expected_blob)
    blocks = extract_blocks(text, order)
    script = build_script(blocks, order, browser_after)
    out.write("Orchestration lines added around the verbatim runbook blocks:\n")
    out.write("  " + ORCH_PRELUDE + "  " + ORCH_AFTER_VARS + "  " + ORCH_BROWSER)
    out.write(f"Blocks in order: {', '.join(order)}\n")
    meta_dir = tempfile.mkdtemp(prefix="t10-staging-meta-")
    meta = os.path.join(meta_dir, "meta")
    env = dict(os.environ, T10_META=meta, **(env_extra or {}))
    rc, output, timed_out = execute(script, app, env, timeout, out)
    summary = [f"bash exit {rc}" + (" (timeout)" if timed_out else "")]
    ok = rc == 0 and not timed_out
    missing = [m for m in expected_markers if m not in output]
    if missing:
        ok = False
        summary.append("missing markers: " + "; ".join(missing))
    if "leftover:" in output:
        ok = False
        summary.append("cleanup reported leftovers")
    try:
        with open(meta, encoding="utf-8") as f:
            run_id, temp_dir = (f.read().splitlines() + ["", ""])[:2]
    except OSError:
        run_id = temp_dir = ""
    if run_id:
        left = leftovers(run_id, run_docker)
        if left:
            ok = False
            summary.append("labelled resources left: " + ", ".join(left))
        else:
            summary.append(f"no container/network/image with {LABEL_KEY}={run_id} left")
        if temp_dir and os.path.exists(temp_dir):
            ok = False
            summary.append("runbook temp dir still exists")
        procs = processes_naming(temp_dir, proc_root)
        if procs:
            ok = False
            summary.append("processes of this run left (not killed): " + ", ".join(map(str, procs)))
        else:
            summary.append("no process naming this run's temp dir left (browser included)")
    else:
        summary.append("run id not recorded (stopped before docker-0); nothing was created by the runbook")
    if os.path.exists(meta):
        os.unlink(meta)
    os.rmdir(meta_dir)
    return ok, summary


def annotate(title, message):
    """In GitHub Actions, also report as a notice annotation (readable through the API); never secrets."""
    if os.environ.get("GITHUB_ACTIONS") == "true":
        text = message.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
        print(f"::notice title={title}::{text}")


EVIDENCE = re.compile(r"^(PASS: \d+ local files reachable from \S+.*|owner ok|S[1-6] ok.*|S6 served \S+: \S+ \S+|S7 .*)$")


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--app", required=True, help="clean checkout of APP_SHA")
    ap.add_argument("--runbook", required=True, help="the accepted runbook file")
    ap.add_argument("--browser", required=True, help="Chrome/Chromium executable already on the machine")
    ap.add_argument("--driver", default=DRIVER, help="scripts/browser-staging.mjs")
    ap.add_argument("--timeout", type=float, default=900.0)
    args = ap.parse_args(argv)
    print(f"APP_SHA {APP_SHA}\nRUNBOOK {RUNBOOK_PATH} blob {RUNBOOK_BLOB}")
    harness = os.environ.get("GITHUB_SHA", "(local)")
    print(f"harness {harness} run {os.environ.get('GITHUB_RUN_ID', '-')}")
    # All input guards run before the first Docker (or bash) call, including `docker version`.
    try:
        verify_app(os.path.realpath(args.app))
        extract_blocks(verify_runbook(args.runbook))
        if not os.path.isfile(args.driver):
            raise GuardError(f"browser driver not found: {args.driver}")
        browser_version, node_version = verify_tools(args.browser)
    except (GuardError, OSError) as exc:
        print(f"GUARD FAIL: {exc} — nothing was executed")
        annotate("guard", f"FAIL: {exc} — nothing was executed")
        return 2
    try:
        server = subprocess.run(["docker", "version", "--format", "{{.Server.Version}}"],
                                capture_output=True, text=True, timeout=60)
        docker_server = server.stdout.strip() if server.returncode == 0 else "unavailable"
    except (OSError, subprocess.TimeoutExpired):
        docker_server = "unavailable"
    annotate("inputs", f"APP_SHA {APP_SHA}; RUNBOOK {RUNBOOK_PATH} blob {RUNBOOK_BLOB}; "
                       f"harness {harness}; docker server {docker_server}; "
                       f"browser binary reports {browser_version} (not yet launched); node {node_version}")
    log = io.StringIO()

    class Tee:
        def write(self, text):
            sys.stdout.write(text)
            log.write(text)

        def flush(self):
            sys.stdout.flush()
    started = time.monotonic()
    try:
        ok, summary = run(os.path.realpath(args.app), args.runbook, args.timeout, out=Tee(),
                          env_extra={"T10_BROWSER": os.path.realpath(args.browser),
                                     "T10_BROWSER_DRIVER": os.path.realpath(args.driver)})
    except GuardError as exc:
        print(f"GUARD FAIL: {exc} — nothing was executed")
        annotate("guard", f"FAIL: {exc} — nothing was executed")
        return 2
    elapsed = time.monotonic() - started
    evidence = [line for line in log.getvalue().splitlines() if EVIDENCE.match(line)]
    annotate("runbook output", "\n".join(evidence) or "no expected lines")
    for line in summary:
        print(("PASS " if ok else "INFO ") + line)
    annotate("cleanup and result", "\n".join(summary + [f"elapsed {elapsed:.0f}s", "RESULT: " + ("PASS" if ok else "FAIL")]))
    print("RESULT: " + ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
