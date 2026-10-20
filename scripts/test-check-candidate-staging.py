"""Guard, pin and cleanup tests for check-candidate-staging.py, with a recording docker stub.

Usage: APP_DIR=<clean checkout of APP_SHA (INT-31)> python test-check-candidate-staging.py

Adapted from the accepted scripts/test-check-isolated-staging.py (STAGING-CI-01) to the
new inputs: APP 9c6fbc9 and docs/runbooks/isolated-staging-check-v2.md. The S6 tests run
the literal v2 `s6` block against a local stdlib HTTP server (no Docker, no browser).

No real Docker is used: a stub `docker` executable is put first on PATH. It writes
every call (argv) to a log, answers label inspections from a JSON state and never
creates or removes anything. Runs that need the runbook's own `docker-0` block use
the real app checkout (its `git rev-parse HEAD` check) and a free loopback port 18080.
Standard library only.
"""
import importlib.util
import io
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
RUNNER = os.path.join(HERE, "check-candidate-staging.py")
RUNBOOK = os.path.join(os.path.dirname(HERE), "docs", "runbooks", "isolated-staging-check-v2.md")
RUNBOOK_V1 = os.path.join(os.path.dirname(HERE), "docs", "runbooks", "isolated-staging-check-v1.md")
APP_DIR = os.environ.get("APP_DIR", "")

spec = importlib.util.spec_from_file_location("check_candidate_staging", RUNNER)
st = importlib.util.module_from_spec(spec)
spec.loader.exec_module(st)

STUB = r'''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ["STUB_LOG"], "a") as f:
    f.write(json.dumps(args) + "\n")
state = json.load(open(os.environ["STUB_STATE"]))
def label(i):
    v = state.get("labels", {}).get(i)
    if v is None:
        return None
    return os.environ.get("T10_RUN", "") if v == "own" else ("" if v == "none" else v)
if args[:2] == ["inspect", "-f"] or args[:3] == ["network", "inspect", "-f"]:
    v = label(args[-1])
    if v is None:
        sys.exit(1)
    print(v)
    sys.exit(0)
if args and args[0] == "inspect":
    sys.exit(1)                      # step-0 name/tag lookups: nothing exists
if args[:2] == ["image", "rm"]:
    sys.exit(1 if args[-1] in state.get("refuse_image_rm", []) else 0)
sys.exit(0)
'''


def require_app():
    if not APP_DIR or not os.path.isdir(os.path.join(APP_DIR, ".git")) and not os.path.isfile(os.path.join(APP_DIR, ".git")):
        raise AssertionError("APP_DIR must point to a clean checkout of APP_SHA")


class Stub:
    def __init__(self, test, state=None):
        self.dir = tempfile.mkdtemp(prefix="t10-stub-")
        test.addCleanup(shutil.rmtree, self.dir, True)
        self.log = os.path.join(self.dir, "calls.jsonl")
        self.state = os.path.join(self.dir, "state.json")
        with open(self.state, "w") as f:
            json.dump(state or {}, f)
        bindir = os.path.join(self.dir, "bin")
        os.mkdir(bindir)
        path = os.path.join(bindir, "docker")
        with open(path, "w") as f:
            f.write(STUB)
        os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC)
        self.bash_log = os.path.join(self.dir, "bash-calls.jsonl")
        bash = os.path.join(bindir, "bash")     # counts bash calls; only installed for CLI guard tests
        self.bash_stub = bash
        with open(bash + ".stub", "w") as f:
            f.write("#!/usr/bin/env python3\nimport json, os, sys\n"
                    "open(os.environ['STUB_BASH_LOG'], 'a').write(json.dumps(sys.argv[1:2]) + '\\n')\n")
        self.env = {"PATH": bindir + os.pathsep + os.environ["PATH"], "STUB_LOG": self.log, "STUB_STATE": self.state,
                    "STUB_BASH_LOG": self.bash_log}

    def install_bash_stub(self):
        os.rename(self.bash_stub + ".stub", self.bash_stub)
        os.chmod(self.bash_stub, os.stat(self.bash_stub).st_mode | stat.S_IEXEC)

    def bash_calls(self):
        if not os.path.exists(self.bash_log):
            return []
        with open(self.bash_log) as f:
            return [json.loads(line) for line in f]

    def calls(self):
        if not os.path.exists(self.log):
            return []
        with open(self.log) as f:
            return [json.loads(line) for line in f]

    def removals(self):
        return [c for c in self.calls() if c[:1] == ["rm"] or c[:2] in (["image", "rm"], ["network", "rm"])]


def runbook_text():
    with open(RUNBOOK, encoding="utf-8") as f:
        return f.read()


def write_runbook(test, text):
    d = tempfile.mkdtemp(prefix="t10-runbook-")
    test.addCleanup(shutil.rmtree, d, True)
    p = os.path.join(d, "runbook.md")
    with open(p, "w", encoding="utf-8") as f:
        f.write(text)
    return p, st.git_blob_sha(text.encode("utf-8"))


def with_test_block(test, body):
    """The accepted runbook plus one test-only block; returns (path, blob)."""
    return write_runbook(test, runbook_text() + f"\n<!-- run:test-scenario -->\n```bash\n{body}\n```\n")


def make_repo(test):
    d = tempfile.mkdtemp(prefix="t10-repo-")
    test.addCleanup(shutil.rmtree, d, True)
    git = lambda *a: subprocess.run(["git", "-C", d, *a], check=True, capture_output=True)
    git("init", "-q")
    with open(os.path.join(d, "f.txt"), "w") as f:
        f.write("x\n")
    git("add", "f.txt")
    git("-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "-m", "t")
    head = subprocess.run(["git", "-C", d, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    return d, head


def no_leftovers(_args):
    return subprocess.CompletedProcess([], 0, "", "")


class GuardTests(unittest.TestCase):
    """Guards stop before any bash/Docker step: the stub log must stay empty."""

    def assertGuard(self, stub, needle, **kwargs):
        with self.assertRaises(st.GuardError) as ctx:
            st.run(out=io.StringIO(), env_extra=stub.env, run_docker=no_leftovers, timeout=30, **kwargs)
        self.assertIn(needle, str(ctx.exception))
        self.assertEqual(stub.calls(), [])

    def test_wrong_app_sha_stops_before_docker(self):
        repo, _ = make_repo(self)
        self.assertGuard(Stub(self), "expected " + st.APP_SHA, app=repo, runbook=RUNBOOK)

    def test_dirty_app_checkout_stops_before_docker(self):
        repo, head = make_repo(self)
        with open(os.path.join(repo, "untracked.txt"), "w") as f:
            f.write("x")
        self.assertGuard(Stub(self), "local changes", app=repo, runbook=RUNBOOK, expected_app=head)

    def test_wrong_runbook_blob_stops_before_docker(self):
        require_app()
        path, _ = write_runbook(self, runbook_text().replace("S1 ok", "S1 OK"))
        self.assertGuard(Stub(self), "expected " + st.RUNBOOK_BLOB, app=APP_DIR, runbook=path)

    def test_missing_marker_stops_before_docker(self):
        require_app()
        path, blob = write_runbook(self, runbook_text().replace("<!-- run:s3 -->", "<!-- s3 -->"))
        self.assertGuard(Stub(self), "missing runbook blocks: s3", app=APP_DIR, runbook=path, expected_blob=blob)

    def test_duplicate_marker_stops_before_docker(self):
        require_app()
        path, blob = write_runbook(self, runbook_text() + "\n<!-- run:s1 -->\n```bash\necho second\n```\n")
        self.assertGuard(Stub(self), "duplicate run markers: s1", app=APP_DIR, runbook=path, expected_blob=blob)

    def test_marker_without_bash_block_stops_before_docker(self):
        require_app()
        path, blob = write_runbook(self, runbook_text() + "\n<!-- run:stray -->\nno code here\n")
        self.assertGuard(Stub(self), "without a bash block: stray", app=APP_DIR, runbook=path, expected_blob=blob)


class CliGuardTests(unittest.TestCase):
    """The command line runs every input guard before the first docker or bash call (incl. `docker version`)."""

    def run_cli(self, app, runbook, env):
        proc = subprocess.run([sys.executable, "-I", RUNNER, "--app", app, "--runbook", runbook, "--timeout", "30"],
                              env=env, capture_output=True, text=True, timeout=120)
        return proc.returncode, proc.stdout + proc.stderr

    def assertCliGuard(self, app, runbook, needle):
        stub = Stub(self)
        stub.install_bash_stub()
        code, out = self.run_cli(app, runbook, dict(os.environ, **stub.env))
        self.assertEqual(code, 2, out)
        self.assertIn("GUARD FAIL", out)
        self.assertIn(needle, out)
        self.assertNotIn("Traceback", out)
        self.assertEqual(stub.calls(), [], "no docker call, not even `docker version`")
        self.assertEqual(stub.bash_calls(), [], "no bash call")

    def test_cli_wrong_app_sha(self):
        repo, _ = make_repo(self)
        self.assertCliGuard(repo, RUNBOOK, "expected " + st.APP_SHA)

    def test_cli_dirty_app_checkout(self):
        require_app()
        copy = os.path.join(tempfile.mkdtemp(prefix="t10-dirty-"), "app")
        self.addCleanup(shutil.rmtree, os.path.dirname(copy), True)
        shutil.copytree(APP_DIR, copy, symlinks=True)
        with open(os.path.join(copy, "untracked-local-change.txt"), "w") as f:
            f.write("x")
        self.assertCliGuard(copy, RUNBOOK, "local changes")

    def test_cli_wrong_runbook_blob(self):
        require_app()
        path, _ = write_runbook(self, runbook_text().replace("S6 ok", "S6 OK"))
        self.assertCliGuard(APP_DIR, path, "expected " + st.RUNBOOK_BLOB)

    def test_cli_missing_marker(self):
        # With the fixed CLI inputs any marker change also changes the blob, so the blob guard stops it first;
        # the marker guard itself is covered at run() level above.
        require_app()
        path, _ = write_runbook(self, runbook_text().replace("<!-- run:s3 -->", "<!-- s3 -->"))
        self.assertCliGuard(APP_DIR, path, "expected " + st.RUNBOOK_BLOB)

    def test_cli_without_docker_on_path_stops_cleanly(self):
        repo, _ = make_repo(self)
        bindir = tempfile.mkdtemp(prefix="t10-nodocker-")
        self.addCleanup(shutil.rmtree, bindir, True)
        os.symlink(shutil.which("git"), os.path.join(bindir, "git"))
        self.assertIsNone(shutil.which("docker", path=bindir))
        code, out = self.run_cli(repo, RUNBOOK, dict(os.environ, PATH=bindir))
        self.assertEqual(code, 2, out)
        self.assertIn("GUARD FAIL", out)
        self.assertNotIn("Traceback", out)
        self.assertNotIn("FileNotFoundError", out)

    def test_cli_historical_checkout_with_copied_new_files_is_refused(self):
        # A checkout of another commit cannot be made to pass by copying the new APP files into it.
        require_app()
        repo, _ = make_repo(self)
        for rel in ("ui/api-error-message.mjs", "ui/provider-geometry.mjs", "ui/route-options-response.mjs"):
            os.makedirs(os.path.join(repo, "ui"), exist_ok=True)
            shutil.copy(os.path.join(APP_DIR, rel), os.path.join(repo, rel))
        self.assertCliGuard(repo, RUNBOOK, "expected " + st.APP_SHA)


V1_STATUS_COMMENT = ("# NOT RUN",)


class PinTests(unittest.TestCase):
    """The v2 runbook, the runner and the actual APP asset graph agree; v2 differs from v1 only where documented."""

    def test_runbook_pins_the_same_app_sha_as_the_runner(self):
        blocks = st.extract_blocks(st.verify_runbook(RUNBOOK))
        self.assertIn(f"export T10_SHA={st.APP_SHA}\n", blocks["vars"])
        self.assertIn('test "$(git rev-parse HEAD)" = "$T10_SHA"', blocks["docker-0"])

    def test_expected_counts_match_the_actual_app_asset_graph(self):
        require_app()
        checker = os.path.join(APP_DIR, "scripts", "check-packaged-web.py")
        graph = {}
        for entry in ("planner.html", "boss.html"):
            out = subprocess.run([sys.executable, "-I", checker, APP_DIR, "--entry", entry],
                                 capture_output=True, text=True, timeout=60).stdout
            graph[entry] = [line[4:] for line in out.splitlines() if line.startswith("ok  ")]
        self.assertEqual((len(graph["planner.html"]), len(graph["boss.html"])), (21, 15))
        blocks = st.extract_blocks(st.verify_runbook(RUNBOOK))
        self.assertIn("'^PASS: 21 local files reachable from planner.html'", blocks["docker-2"])
        self.assertIn("'^PASS: 15 local files reachable from boss.html'", blocks["docker-2"])
        self.assertIn("'^PASS: 21 local files'", blocks["s6"])
        self.assertIn("'^PASS: 15 local files'", blocks["s6"])
        for marker in st.EXPECTED_MARKERS:
            if marker.startswith("S6 served boss: /"):
                self.assertIn(marker.split()[3][1:], graph["boss.html"])

    def test_v2_blocks_differ_from_v1_only_in_the_documented_blocks(self):
        with open(RUNBOOK_V1, encoding="utf-8") as f:
            v1 = st.BLOCK.findall(f.read())
        v2 = st.BLOCK.findall(runbook_text())
        self.assertEqual([n for n, _ in v1], [n for n, _ in v2])
        changed = []
        for (name, old), (_, new) in zip(v1, v2):
            old = "\n".join(line for line in old.split("\n") if not line.startswith(V1_STATUS_COMMENT))
            if old != new:
                changed.append(name)
        self.assertEqual(changed, ["vars", "docker-2", "s6", "docker-7"])
        for name in ("helpers", "owner", "s1", "s2", "s3", "s4", "s5", "docker-0", "docker-5"):
            self.assertNotIn(name, changed)


SERVER = r'''import json, sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
root, port, mode = sys.argv[1], int(sys.argv[2]), sys.argv[3]
TYPES = {".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
         ".png": "image/png", ".json": "application/json", "": "application/octet-stream"}
if mode == "wrong-mjs-type":
    TYPES[".mjs"] = "application/javascript"
class H(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    extensions_map = TYPES
    def __init__(self, *a, **k):
        super().__init__(*a, directory=root, **k)
    def do_GET(self):
        if self.path == "/api/health":
            out = json.dumps({"ok": True}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)
            return
        if mode == "missing-helper" and self.path == "/ui/provider-geometry.mjs":
            self.send_error(404)
            return
        super().do_GET()
    def log_message(self, *a):
        pass
ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
'''

S6_MARKERS = [m for m in st.EXPECTED_MARKERS if m.startswith("S6 ")]


class S6BlockTests(unittest.TestCase):
    """The literal v2 `s6` block through the runner, against a local stdlib server instead of the API container.

    A test-only block starts the server after docker-0 (which needs a free port) and writes the packaged
    lists with the APP's own checker on the checkout root, standing in for docker-2 inside the image."""

    def run_s6(self, mode):
        require_app()
        d = tempfile.mkdtemp(prefix="t10-s6-")
        self.addCleanup(shutil.rmtree, d, True)
        server, pidfile = os.path.join(d, "server.py"), os.path.join(d, "server.pid")
        with open(server, "w") as f:
            f.write(SERVER)

        def stop():
            try:
                with open(pidfile) as f:
                    os.kill(int(f.read().strip()), 15)
            except (OSError, ValueError):
                pass
        self.addCleanup(stop)
        body = (f'python3 -I "{server}" "$PWD" "$T10_PORT" {mode} >/dev/null 2>&1 & echo $! > "{pidfile}"\n'
                'for i in $(seq 100); do curl -s -m 1 "$T10_BASE/api/health" >/dev/null && break; sleep 0.1; done\n'
                'python3 -I scripts/check-packaged-web.py . > "$T10_DIR/pack-planner.txt"\n'
                'python3 -I scripts/check-packaged-web.py . --entry boss.html > "$T10_DIR/pack-boss.txt"')
        text = runbook_text() + f"\n<!-- run:test-scenario -->\n```bash\n{body}\n```\n"
        path, blob = write_runbook(self, text)
        stub = Stub(self, {})
        out = io.StringIO()
        ok, summary = st.run(APP_DIR, path, 120, out=out, expected_blob=blob,
                             order=["vars", "docker-0", "test-scenario", "s6"], expected_markers=S6_MARKERS,
                             env_extra=stub.env, run_docker=no_leftovers)
        return ok, summary, out.getvalue()

    def test_s6_literal_block_passes_with_exact_types_for_all_36_files(self):
        ok, summary, out = self.run_s6("ok")
        self.assertTrue(ok, summary + [out[-2000:]])
        served = [line for line in out.splitlines() if line.startswith("S6 served ")]
        self.assertEqual(sum(line.startswith("S6 served boss: ") for line in served), 15)
        self.assertEqual(sum(line.startswith("S6 served planner: ") for line in served), 21)
        for m in S6_MARKERS:
            self.assertIn(m, out)

    def test_s6_fails_on_an_inexact_javascript_type(self):
        ok, summary, out = self.run_s6("wrong-mjs-type")
        self.assertFalse(ok)
        self.assertIn("is 'application/javascript', expected text/javascript", out)
        self.assertNotIn("S6 ok", out)

    def test_s6_fails_when_a_new_helper_is_not_served(self):
        ok, summary, out = self.run_s6("missing-helper")
        self.assertFalse(ok)
        self.assertNotIn("S6 ok", out)
        self.assertNotIn("S6 served boss: /ui/provider-geometry.mjs", out)


class ScriptTests(unittest.TestCase):
    def test_positive_control_inputs_and_verbatim_script(self):
        require_app()
        st.verify_app(APP_DIR)
        text = st.verify_runbook(RUNBOOK)
        blocks = st.extract_blocks(text)
        self.assertEqual(list(blocks), st.ORDER)
        script = st.build_script(blocks)
        for name, body in blocks.items():
            self.assertIn(f"# ==== runbook block {name} (verbatim) ====\n{body}\n", script)
            self.assertIn(f"<!-- run:{name} -->\n```bash\n{body}\n```", text)
        rest = script
        for name, body in blocks.items():
            rest = rest.replace(f"# ==== runbook block {name} (verbatim) ====\n{body}\n", "", 1)
        self.assertEqual(rest, st.ORCH_PRELUDE + st.ORCH_AFTER_VARS)

    def test_blocks_outside_the_allowlist_are_never_in_the_script(self):
        text = runbook_text() + "\n<!-- run:evil -->\n```bash\ntouch /tmp/t10-evil-marker\n```\n"
        script = st.build_script(st.extract_blocks(text))
        self.assertNotIn("t10-evil-marker", script)
        self.assertNotIn('docker images --filter "label=t10.stage.run=$T10_RUN"', script)  # docker-7
        self.assertNotIn("# ==== runbook block docker-7", script)


class CleanupTests(unittest.TestCase):
    """The runbook's own docker-0 cleanup, run through the runner with a stub docker."""

    def run_with(self, body, state, timeout=60, run_docker=no_leftovers, markers=("test ok",)):
        require_app()
        path, blob = with_test_block(self, body)
        stub = Stub(self, state)
        out = io.StringIO()
        started = time.monotonic()
        ok, summary = st.run(APP_DIR, path, timeout, out=out, expected_blob=blob,
                             order=["vars", "docker-0", "test-scenario"], expected_markers=list(markers),
                             env_extra=stub.env, run_docker=run_docker)
        return ok, summary, out.getvalue(), stub, time.monotonic() - started

    def test_retagged_image_only_own_created_id_is_removed(self):
        ok, summary, out, stub, _ = self.run_with('T10_IMG_ID=img-own; echo "test ok"',
                                                  {"labels": {"img-own": "own", "img-foreign": "other-run"}})
        self.assertTrue(ok, summary)
        self.assertEqual(stub.removals(), [["image", "rm", "img-own"]])
        self.assertFalse(any("t10-stage-api:" in " ".join(c) or "img-foreign" in c for c in stub.removals()))

    def test_foreign_and_unlabelled_resources_are_left_and_reported(self):
        ok, summary, out, stub, _ = self.run_with(
            'T10_API_ID=ctr-foreign; T10_DB_ID=ctr-nolabel; T10_ROUTER_ID=ctr-own; T10_NET_ID=net-own; echo "test ok"',
            {"labels": {"ctr-foreign": "other-run", "ctr-nolabel": "none", "ctr-own": "own", "net-own": "own"}})
        self.assertEqual(sorted(stub.removals()), [["network", "rm", "net-own"], ["rm", "-f", "ctr-own"]])
        self.assertIn("leftover: container ctr-foreign (label is not from this run; not touched)", out)
        self.assertIn("leftover: container ctr-nolabel (label is not from this run; not touched)", out)
        self.assertFalse(ok)
        self.assertIn("cleanup reported leftovers", summary)

    def test_refused_image_removal_is_a_reported_leftover_never_forced(self):
        ok, summary, out, stub, _ = self.run_with('T10_IMG_ID=img-own; echo "test ok"',
                                                  {"labels": {"img-own": "own"}, "refuse_image_rm": ["img-own"]})
        self.assertEqual(stub.removals(), [["image", "rm", "img-own"]])
        self.assertIn("leftover: image img-own (still referenced; not forced)", out)
        self.assertFalse(ok)

    def test_failed_assertion_still_runs_cleanup(self):
        ok, summary, out, stub, _ = self.run_with('T10_DB_ID=ctr-own; test "S1" = "S2"; echo "test ok"',
                                                  {"labels": {"ctr-own": "own"}})
        self.assertEqual(stub.removals(), [["rm", "-f", "ctr-own"]])
        self.assertFalse(ok)
        self.assertTrue(summary[0].startswith("bash exit 1"), summary)
        self.assertNotIn("test ok", out)

    def test_timeout_still_runs_cleanup(self):
        ok, summary, out, stub, elapsed = self.run_with('T10_DB_ID=ctr-own; sleep 60; echo "test ok"',
                                                        {"labels": {"ctr-own": "own"}}, timeout=3)
        self.assertEqual(stub.removals(), [["rm", "-f", "ctr-own"]])
        self.assertFalse(ok)
        self.assertIn("(timeout)", summary[0])
        self.assertLess(elapsed, 30)

    def test_labelled_resource_left_after_the_run_fails_the_check(self):
        def remaining(args):
            stdout = "c0ffee\n" if args[:1] == ["ps"] and any(a.startswith("label=t10.stage.run=") for a in args) else ""
            return subprocess.CompletedProcess(args, 0, stdout, "")
        ok, summary, out, stub, _ = self.run_with('echo "test ok"', {}, run_docker=remaining)
        self.assertFalse(ok)
        self.assertTrue(any("labelled resources left: container: c0ffee" in s for s in summary), summary)

    def test_positive_control_clean_run_passes(self):
        ok, summary, out, stub, _ = self.run_with('T10_ROUTER_ID=ctr-own; T10_IMG_ID=img-own; echo "test ok"',
                                                  {"labels": {"ctr-own": "own", "img-own": "own"}})
        self.assertTrue(ok, summary)
        self.assertEqual(stub.removals(), [["rm", "-f", "ctr-own"], ["image", "rm", "img-own"]])
        self.assertIn("Orchestration lines added", out)
        self.assertNotIn("Bearer", out)


if __name__ == "__main__":
    result = unittest.main(verbosity=2, exit=False).result
    passed = result.wasSuccessful()
    st.annotate("stub tests", f"Ran {result.testsRun} tests; failures {len(result.failures)}, "
                              f"errors {len(result.errors)}, skipped {len(result.skipped)}; "
                              + ("OK" if passed else "FAILED"))
    sys.exit(0 if passed else 1)
