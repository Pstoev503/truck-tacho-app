"""Guard and cleanup tests for check-isolated-staging.py, with a recording docker stub.

Usage: APP_DIR=<clean checkout of APP_SHA> python test-check-isolated-staging.py

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
RUNNER = os.path.join(HERE, "check-isolated-staging.py")
RUNBOOK = os.path.join(os.path.dirname(HERE), "docs", "runbooks", "isolated-staging-check-v1.md")
APP_DIR = os.environ.get("APP_DIR", "")

spec = importlib.util.spec_from_file_location("check_isolated_staging", RUNNER)
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
        self.env = {"PATH": bindir + os.pathsep + os.environ["PATH"], "STUB_LOG": self.log, "STUB_STATE": self.state}

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
    unittest.main(verbosity=2)
