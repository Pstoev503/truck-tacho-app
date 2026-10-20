"""Guard, script and cleanup tests for check-browser-staging.py, with stub docker/bash/browser and fake drivers.

Usage: APP_DIR=<clean checkout of APP_SHA (INT-31)> python test-check-browser-staging.py

None of these tests starts a browser or Docker. A stub `docker` on PATH records every call and
answers label inspections; fake browser drivers (small Node scripts in a temp dir) stand in for
scripts/browser-staging.mjs to exercise the runner's handling of S7 success, failure, timeout and
left-over processes. These are NOT the S7 result: that is only the real run in
.github/workflows/browser-staging.yml. Standard library only (plus the `node` already on PATH).
"""
import hashlib
import importlib.util
import io
import json
import os
import re
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RUNNER = os.path.join(HERE, "check-browser-staging.py")
RUNBOOK = os.path.join(ROOT, "docs", "runbooks", "isolated-staging-check-v2.md")
APP_DIR = os.environ.get("APP_DIR", "")
ACCEPTED_V2_BLOB = "f0d7750ff89f8f4c6e5259e35e0cee419df53ce4"
# blobs of the accepted STAGING-CANDIDATE-01 files at da5dcfac072464382614d739c65b857c6b887c22 (read only)
ACCEPTED_BLOBS = {
    "scripts/check-candidate-staging.py": "fb1fae87894985ea067ee55c92a882f2bb5d6bfb",
    "scripts/test-check-candidate-staging.py": "7c808c477ee0696d6dc1993a95a9ccac32f17c1b",
    "docs/runbooks/isolated-staging-check-v2.md": ACCEPTED_V2_BLOB,
}

spec = importlib.util.spec_from_file_location("check_browser_staging", RUNNER)
st = importlib.util.module_from_spec(spec)
spec.loader.exec_module(st)
S7_MARKERS = [m for m in st.EXPECTED_MARKERS if m.startswith("S7 ")]

DOCKER_STUB = r'''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ["STUB_LOG"], "a") as f:
    f.write(json.dumps(["docker"] + args) + "\n")
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
    sys.exit(1)
sys.exit(0)
'''
RECORDER = r'''#!/usr/bin/env python3
import json, os, sys
with open(os.environ["STUB_LOG"], "a") as f:
    f.write(json.dumps([os.path.basename(sys.argv[0])] + sys.argv[1:2]) + "\n")
print("Stub 1.0")
sys.exit(int(os.environ.get("STUB_EXIT_" + os.path.basename(sys.argv[0]).upper(), "0")))
'''


def git_blob(path):
    with open(path, "rb") as f:
        return st.git_blob_sha(f.read())


def require_app():
    if not APP_DIR or not os.path.exists(os.path.join(APP_DIR, ".git")):
        raise AssertionError("APP_DIR must point to a clean checkout of APP_SHA")


def tmpdir(test, prefix):
    d = tempfile.mkdtemp(prefix=prefix)
    test.addCleanup(shutil.rmtree, d, True)
    return d


class Stubs:
    """docker (label-aware), and recording `bash`, `browser` and (optionally) `node` executables."""

    def __init__(self, test, state=None, recorders=()):
        self.dir = tmpdir(test, "t10-b7-stub-")
        self.log = os.path.join(self.dir, "calls.jsonl")
        self.state = os.path.join(self.dir, "state.json")
        with open(self.state, "w") as f:
            json.dump(state or {}, f)
        self.bin = os.path.join(self.dir, "bin")
        os.mkdir(self.bin)
        self.write("docker", DOCKER_STUB)
        for name in recorders:
            self.write(name, RECORDER)
        self.browser = self.write_outside("browser", RECORDER)
        self.env = {"PATH": self.bin + os.pathsep + os.environ["PATH"], "STUB_LOG": self.log,
                    "STUB_STATE": self.state}

    def write(self, name, text):
        return self._write(os.path.join(self.bin, name), text)

    def write_outside(self, name, text):
        return self._write(os.path.join(self.dir, name), text)

    @staticmethod
    def _write(path, text):
        with open(path, "w") as f:
            f.write(text)
        os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC)
        return path

    def calls(self, tool=None):
        if not os.path.exists(self.log):
            return []
        with open(self.log) as f:
            calls = [json.loads(line) for line in f]
        return [c for c in calls if tool is None or c[0] == tool]

    def removals(self):
        return [c[1:] for c in self.calls("docker") if c[1:2] == ["rm"] or c[1:3] in (["image", "rm"], ["network", "rm"])]


def make_repo(test):
    d = tmpdir(test, "t10-b7-repo-")
    git = lambda *a: subprocess.run(["git", "-C", d, *a], check=True, capture_output=True)
    git("init", "-q")
    with open(os.path.join(d, "f.txt"), "w") as f:
        f.write("x\n")
    git("add", "f.txt")
    git("-c", "user.name=t", "-c", "user.email=t@example.test", "commit", "-q", "-m", "t")
    return d


def runbook_text():
    with open(RUNBOOK, encoding="utf-8") as f:
        return f.read()


def write_runbook(test, text):
    p = os.path.join(tmpdir(test, "t10-b7-runbook-"), "runbook.md")
    with open(p, "w", encoding="utf-8") as f:
        f.write(text)
    return p, st.git_blob_sha(text.encode("utf-8"))


def no_leftovers(_args):
    return subprocess.CompletedProcess([], 0, "", "")


def fake_driver(test, body):
    """A Node script used as T10_BROWSER_DRIVER; `args` holds the parsed --key value pairs."""
    path = os.path.join(tmpdir(test, "t10-b7-driver-"), "driver.mjs")
    with open(path, "w") as f:
        f.write("const a = process.argv.slice(2); const args = {};\n"
                "for (let i = 0; i < a.length; i += 2) args[a[i].slice(2)] = a[i + 1];\n"
                f"const MARKERS = {json.dumps(S7_MARKERS)};\n" + body + "\n")
    return path


class CliGuardTests(unittest.TestCase):
    """Every guard stops the command line before the first docker, bash or browser launch."""

    def cli(self, app, runbook, stubs, browser=None, extra_env=None):
        env = dict(os.environ, **stubs.env, **(extra_env or {}))
        proc = subprocess.run([sys.executable, "-I", RUNNER, "--app", app, "--runbook", runbook,
                               "--browser", browser or stubs.browser, "--timeout", "30"],
                              env=env, capture_output=True, text=True, timeout=120)
        out = proc.stdout + proc.stderr
        self.assertNotIn("Traceback", out)
        return proc.returncode, out

    def assertStopped(self, code, out, stubs, needle, browser_calls=0):
        self.assertEqual(code, 2, out)
        self.assertIn("GUARD FAIL", out)
        self.assertIn(needle, out)
        self.assertEqual(stubs.calls("docker"), [], "no docker call, not even `docker version`")
        self.assertEqual(stubs.calls("bash"), [], "no bash call")
        self.assertEqual(len(stubs.calls("browser")), browser_calls)
        self.assertNotIn("RESULT: PASS", out)

    def test_wrong_app_sha_stops_before_docker_bash_and_browser(self):
        stubs = Stubs(self, recorders=["bash"])
        self.assertStopped(*self.cli(make_repo(self), RUNBOOK, stubs), stubs, "expected " + st.APP_SHA)

    def test_dirty_app_checkout_stops_before_docker_bash_and_browser(self):
        require_app()
        copy = os.path.join(tmpdir(self, "t10-b7-dirty-"), "app")
        shutil.copytree(APP_DIR, copy, symlinks=True)
        with open(os.path.join(copy, "untracked-local-change.txt"), "w") as f:
            f.write("x")
        stubs = Stubs(self, recorders=["bash"])
        self.assertStopped(*self.cli(copy, RUNBOOK, stubs), stubs, "local changes")

    def test_wrong_runbook_blob_stops_before_docker_bash_and_browser(self):
        require_app()
        path, _ = write_runbook(self, runbook_text().replace("S6 ok", "S6 OK"))
        stubs = Stubs(self, recorders=["bash"])
        self.assertStopped(*self.cli(APP_DIR, path, stubs), stubs, "expected " + st.RUNBOOK_BLOB)

    def test_missing_browser_is_s7_not_run_before_docker(self):
        require_app()
        stubs = Stubs(self, recorders=["bash"])
        code, out = self.cli(APP_DIR, RUNBOOK, stubs, browser=os.path.join(stubs.dir, "no-such-chrome"))
        self.assertStopped(code, out, stubs, "S7 NOT RUN")

    def test_browser_that_cannot_answer_version_stops_before_docker(self):
        require_app()
        stubs = Stubs(self, recorders=["bash"])
        code, out = self.cli(APP_DIR, RUNBOOK, stubs, extra_env={"STUB_EXIT_BROWSER": "1"})
        self.assertStopped(code, out, stubs, "browser --version failed", browser_calls=1)
        self.assertEqual(stubs.calls("browser"), [["browser", "--version"]])

    def test_node_without_websocket_stops_before_docker(self):
        require_app()
        stubs = Stubs(self, recorders=["bash", "node"])
        code, out = self.cli(APP_DIR, RUNBOOK, stubs, extra_env={"STUB_EXIT_NODE": "3"})
        self.assertStopped(code, out, stubs, "no built-in WebSocket", browser_calls=1)


class ScriptTests(unittest.TestCase):
    def test_v2_blocks_verbatim_plus_exactly_three_reported_lines_browser_after_s6(self):
        blocks = st.extract_blocks(st.verify_runbook(RUNBOOK))
        script = st.build_script(blocks)
        rest = script
        for name, body in blocks.items():
            chunk = f"# ==== runbook block {name} (verbatim) ====\n{body}\n"
            self.assertIn(chunk, script)
            rest = rest.replace(chunk, "", 1)
        self.assertEqual(rest, st.ORCH_PRELUDE + st.ORCH_AFTER_VARS + st.ORCH_BROWSER)
        s6 = f"# ==== runbook block s6 (verbatim) ====\n{blocks['s6']}\n"
        self.assertTrue(script.endswith(s6 + st.ORCH_BROWSER), "browser line must come right after s6, last")
        self.assertNotIn("# ==== runbook block docker-7", script)
        for needle in ("--profile-dir \"$T10_DIR/browser-profile\"", "--router \"$T10_ROUTER_ID\"", "--base \"$T10_BASE\""):
            self.assertIn(needle, st.ORCH_BROWSER)

    def test_pins_and_accepted_files_are_unchanged(self):
        self.assertEqual(st.RUNBOOK_BLOB, ACCEPTED_V2_BLOB)
        self.assertEqual(st.APP_SHA, "9c6fbc9d64041ac401c3cd87bcb3f4d2eaafc354")
        for rel, blob in ACCEPTED_BLOBS.items():
            self.assertEqual(git_blob(os.path.join(ROOT, rel)), blob, rel)
        self.assertIn(f"export T10_SHA={st.APP_SHA}\n", st.extract_blocks(runbook_text())["vars"])

    def test_s7_markers_come_from_the_driver_not_from_the_runbook(self):
        text = runbook_text()
        self.assertEqual(len(S7_MARKERS), 18)
        for m in S7_MARKERS:
            self.assertNotIn(m, text)
        with open(st.DRIVER, encoding="utf-8") as f:
            driver = f.read()
        for step in range(1, 7):
            self.assertIn(f"log(`S7 ${{w}} step {step} ok", driver)


class RunTests(unittest.TestCase):
    """The runner with a stub docker and fake drivers: S7 outcome handling and the run's own cleanup."""

    def run_with(self, driver_body, timeout=60, state=None, markers=None, proc_root="/proc"):
        require_app()
        body = 'T10_DB_ID=ctr-own; T10_ROUTER_ID=router-x; echo "test ok"'
        path, blob = write_runbook(self, runbook_text() + f"\n<!-- run:test-scenario -->\n```bash\n{body}\n```\n")
        stubs = Stubs(self, state or {"labels": {"ctr-own": "own", "router-x": "own"}})
        env = dict(stubs.env, T10_BROWSER=stubs.browser, T10_BROWSER_DRIVER=fake_driver(self, driver_body))
        out = io.StringIO()
        ok, summary = st.run(APP_DIR, path, timeout, out=out, expected_blob=blob,
                             order=["vars", "docker-0", "test-scenario"],
                             expected_markers=["test ok"] + (S7_MARKERS if markers is None else markers),
                             env_extra=env, run_docker=no_leftovers, browser_after="test-scenario",
                             proc_root=proc_root)
        return ok, summary, out.getvalue(), stubs

    def test_positive_control_driver_gets_exact_args_and_cleanup_runs(self):
        ok, summary, out, stubs = self.run_with(
            "if (args.base !== 'http://127.0.0.1:18080' || args.router !== 'router-x'"
            " || !args['profile-dir'].endsWith('/browser-profile') || args.timeout !== '300') process.exit(9);\n"
            "console.log(MARKERS.join('\\n'));")
        self.assertTrue(ok, summary + [out[-1500:]])
        self.assertEqual(stubs.removals(), [["rm", "-f", "router-x"], ["rm", "-f", "ctr-own"]])
        self.assertIn("no process naming this run's temp dir left (browser included)", summary)

    def test_failed_browser_assertion_fails_and_still_runs_cleanup(self):
        ok, summary, out, stubs = self.run_with("console.log('S7 FAIL: desktop-1280 step 3 options: x'); process.exit(1);")
        self.assertFalse(ok)
        self.assertTrue(summary[0].startswith("bash exit 1"), summary)
        self.assertEqual(stubs.removals(), [["rm", "-f", "router-x"], ["rm", "-f", "ctr-own"]])
        self.assertNotIn("test ok\nS7 ok", out)
        self.assertTrue(any(s.startswith("missing markers: S7 browser launched") for s in summary), summary)

    def test_browser_timeout_stops_the_run_and_still_runs_cleanup(self):
        ok, summary, out, stubs = self.run_with("setTimeout(() => {}, 60000);", timeout=4)
        self.assertFalse(ok)
        self.assertIn("(timeout)", summary[0])
        self.assertEqual(stubs.removals(), [["rm", "-f", "router-x"], ["rm", "-f", "ctr-own"]])

    def test_missing_s7_step_marker_fails_even_with_exit_0(self):
        ok, summary, out, stubs = self.run_with(
            "console.log(MARKERS.filter(m => !m.startsWith('S7 mobile-375 step 6')).join('\\n'));")
        self.assertFalse(ok)
        self.assertTrue(any("S7 mobile-375 step 6 ok" in s for s in summary if s.startswith("missing markers")), summary)

    def test_left_browser_process_of_this_run_fails_and_is_not_killed_by_the_runner(self):
        ok, summary, out, stubs = self.run_with(
            "import { spawn } from 'node:child_process';\n"
            "const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)', args['profile-dir']],"
            " { detached: true, stdio: 'ignore' }); c.unref();\n"
            "console.log('PID ' + c.pid); console.log(MARKERS.join('\\n'));")
        pid = int(re.search(r"^PID (\d+)$", out, re.M).group(1))
        self.addCleanup(lambda: os.kill(pid, signal.SIGKILL) if os.path.exists(f"/proc/{pid}") else None)
        self.assertTrue(os.path.exists(f"/proc/{pid}"), "the runner must not kill processes itself")
        self.assertFalse(ok)
        self.assertTrue(any(s.startswith("processes of this run left (not killed): ") and str(pid) in s for s in summary), summary)

    def test_processes_naming_matches_only_this_runs_dir(self):
        root = tmpdir(self, "t10-b7-proc-")
        for pid, cmd in ((11, "chrome\0--user-data-dir=/tmp/t10-stage-AAA/browser-profile\0"),
                         (12, "chrome\0--user-data-dir=/tmp/t10-stage-BBB/browser-profile\0"), (13, "bash\0")):
            os.makedirs(os.path.join(root, str(pid)))
            with open(os.path.join(root, str(pid), "cmdline"), "w") as f:
                f.write(cmd)
        self.assertEqual(st.processes_naming("/tmp/t10-stage-AAA", root), [11])
        self.assertEqual(st.processes_naming("", root), [])


class EvidenceTests(unittest.TestCase):
    def test_evidence_lines_include_s7_and_never_secrets(self):
        self.assertTrue(st.EVIDENCE.match("S7 desktop-1280 step 3 ok: 1 option"))
        self.assertTrue(st.EVIDENCE.match("S7 cleanup: browser stopped (0 own processes left), profile dir removed"))
        self.assertFalse(st.EVIDENCE.match("Authorization: Bearer abc"))
        self.assertFalse(st.EVIDENCE.match("T10_DB_PASSWORD=abc"))


if __name__ == "__main__":
    result = unittest.main(verbosity=2, exit=False).result
    passed = result.wasSuccessful()
    st.annotate("runner tests - stubs - not S7", f"Ran {result.testsRun} tests; failures {len(result.failures)}, "
                                                 f"errors {len(result.errors)}, skipped {len(result.skipped)}; "
                                                 + ("OK" if passed else "FAILED"))
    sys.exit(0 if passed else 1)
