// Unit tests for scripts/browser-count-staging.mjs (node --test). No real browser, Docker or server:
// fake clocks, recorded `docker exec` argv and synthetic DevTools events. These cover the fixture-mode
// control, rate pacing, response-status recording and the driver's own failure cleanup — NOT the
// S7/S7C result, which only the real run in .github/workflows/count-staging.yml produces.
//
// APP_DIR must point to the clean INT-32 checkout: the bounded message and the cap are read from it.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import {
  CountPage, MODES, OPTIONS_ERROR, RATE, ROUTER_MODE_CODE, RateBudget, dockerRouterMode, main
} from './browser-count-staging.mjs';

const HERE = new URL('.', import.meta.url).pathname;
const RUNBOOK = join(HERE, '..', 'docs', 'runbooks', 'isolated-staging-check-v3.md');
const BASE = 'http://127.0.0.1:18080';

test('rate budget: at most 9 route-options requests per 61 s window, waits instead of failing', async () => {
  let t = 0;
  const waits = [], logs = [];
  const budget = new RateBudget({ now: () => t, wait: async ms => { waits.push(ms); t += ms; }, log: s => logs.push(s) });
  for (let i = 0; i < 9; i++) { await budget.reserve(1); t += 1000; }
  assert.deepEqual(waits, []);
  await budget.reserve(2);                        // needs the two oldest to leave the window
  assert.equal(waits.length, 2);
  assert.equal(t, 61_000 + 1000);                 // second oldest (t=1000) expires at 62 s
  assert.ok(budget.times.length <= RATE.max);
  assert.match(logs[0], /S7C rate pacing: waiting \d+ s/);
  await assert.rejects(budget.reserve(RATE.max + 1), /larger than the rate budget/);
});

test('fixture mode: exact docker exec argv for the run\'s own router; unknown modes never reach docker', () => {
  const calls = [];
  const run = (cmd, argv) => { calls.push([cmd, ...argv]); return { status: 0 }; };
  const setMode = dockerRouterMode('router-x', run);
  for (const m of MODES) setMode(m);
  assert.deepEqual(calls.map(c => c.at(-1)), ['1', '3', '4', '5001']);
  assert.deepEqual(calls[0].slice(0, 5), ['docker', 'exec', 'router-x', 'python', '-c']);
  assert.equal(calls[0][5], ROUTER_MODE_CODE);
  assert.throws(() => setMode('2'), /unknown fixture mode/);
  assert.equal(calls.length, 4);
  const failing = dockerRouterMode('router-x', () => ({ status: 1 }));
  assert.throws(() => failing('3'), /router_mode 3 failed/);
});

test('fixture mode code is the runbook router_mode and the router reads the same file', () => {
  const text = readFileSync(RUNBOOK, 'utf8');
  assert.ok(text.includes(`python -c '${ROUTER_MODE_CODE}' "$1"`));
  assert.ok(text.includes('MODE_FILE = "/tmp/t10-router-mode"'));
  assert.ok(text.includes('ALTERNATES = {"1": 0, "3": 2, "4": 3, "5001": 5000}'));
});

test('bounded message and cap match the INT-32 app (read from APP_DIR, not copied)', async () => {
  const app = process.env.APP_DIR;
  assert.ok(app && existsSync(join(app, 'ui', 'route-options-response.mjs')), 'APP_DIR must be the INT-32 checkout');
  const mod = await import(pathToFileURL(join(app, 'ui', 'route-options-response.mjs')).href);
  assert.equal(OPTIONS_ERROR, mod.ROUTE_OPTIONS_RESPONSE_ERROR_MESSAGE);
  assert.equal(mod.MAX_ROUTE_OPTION_CANDIDATES, 3);
  const trip = { status: 0, legs: [{ shape: 'x' }], summary: { length: 1 } };
  assert.equal(mod.normalizeRouteOptionsResponse({ trip, alternates: [{ trip }, { trip }] }).length, 3);
  for (const n of [3, 5000]) {
    assert.throws(() => mod.normalizeRouteOptionsResponse({ trip, alternates: Array.from({ length: n }, () => ({ trip })) }),
      { message: mod.ROUTE_OPTIONS_RESPONSE_ERROR_MESSAGE });
  }
});

test('route-options statuses: only answers for /api/route-options are recorded, in order', () => {
  const page = new CountPage({ on() {} }, BASE, { label: 't', width: 1, height: 1, mobile: false, scale: 1 }, () => {});
  const ev = (url, status) => ({ method: 'Network.responseReceived', params: { requestId: 'r', response: { url, status } } });
  page.onEvent(ev(`${BASE}/api/route-options`, 200));
  page.onEvent(ev(`${BASE}/api/route-options-x`, 500));
  page.onEvent(ev(`${BASE}/boss.html`, 200));
  page.onEvent(ev(`${BASE}/api/route-options`, 429));
  page.onEvent({ method: 'Runtime.exceptionThrown', params: { exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: boom\n at x' } } } });
  assert.deepEqual(page.routeStatuses, [200, 429]);
  assert.deepEqual(page.exceptions, ['Error: boom']);
});

test('missing browser: S7 FAIL, no S7/S7C ok, router reset to mode 1 first, profile dir not left', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'b7c-test-'));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  const profile = join(dir, 'profile'), modes = [], lines = [];
  const code = await main(['--base', BASE, '--browser', join(dir, 'no-such-chrome'), '--router', 'router-x', '--profile-dir', profile, '--timeout', '20'], {
    log: s => lines.push(s), routerLogFor: () => () => [], routerModeFor: () => m => modes.push(m),
    budget: new RateBudget({ wait: async () => {} }) });
  const out = lines.join('\n');
  assert.equal(code, 1);
  assert.deepEqual(modes, ['1']);
  assert.match(out, /S7 FAIL: browser could not be started/);
  assert.doesNotMatch(out, /S7 ok|S7C ok|step \d ok/);
  assert.ok(!existsSync(profile));
  assert.match(out, /S7 cleanup: browser stopped \(0 own processes left\), profile dir removed/);
});

test('bad arguments exit 2 before any fixture or browser action', async () => {
  const modes = [], lines = [];
  const code = await main(['--base', 'https://example.test'], { log: s => lines.push(s), routerModeFor: () => m => modes.push(m) });
  assert.equal(code, 2);
  assert.deepEqual(modes, []);
});

test('unknown fixture mode from the router control stops the run as S7 FAIL', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'b7c-test-'));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  const lines = [];
  const code = await main(['--base', BASE, '--browser', join(dir, 'no-such-chrome'), '--router', 'router-x', '--profile-dir', join(dir, 'p'), '--timeout', '20'], {
    log: s => lines.push(s), routerLogFor: () => () => [],
    routerModeFor: () => () => { throw new Error('router_mode 1 failed (1)'); } });
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /S7 FAIL: router_mode 1 failed/);
});
