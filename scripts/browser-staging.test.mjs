// Unit tests for scripts/browser-staging.mjs (node --test). They never start a real browser:
// launches use missing or fake executables, so these cover argument checks, the request policy,
// router-log parsing and the driver's own cleanup — NOT the S7 result, which only the real
// browser run in .github/workflows/browser-staging.yml produces.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  CHROME_FLAGS, browserEnv, isAllowedUrl, main, ownProcesses, parseArgs, parseRouterLog
} from './browser-staging.mjs';

const BASE = 'http://127.0.0.1:18080';
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'b7-test-'));
  test.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
};
const args = (browser, profileDir, timeout = '20') =>
  ['--base', BASE, '--browser', browser, '--router', 'router-x', '--profile-dir', profileDir, '--timeout', timeout];
async function runMain(argv) {
  const lines = [];
  const code = await main(argv, { log: s => lines.push(s), routerLogFor: () => () => [] });
  return { code, out: lines.join('\n') };
}
function fakeBrowser(dir, body) {
  const p = join(dir, 'fake-browser');
  writeFileSync(p, `#!${process.execPath}\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

test('arguments: only a loopback http origin, all required options, positive timeout', () => {
  const ok = parseArgs(args('/x/chrome', '/tmp/p'));
  assert.equal(ok.base, BASE);
  assert.equal(ok.profileDir, '/tmp/p');
  assert.equal(ok.timeout, 20);
  for (const base of ['https://127.0.0.1:18080', 'http://example.test', 'http://u:p@127.0.0.1:18080', 'http://127.0.0.1:18080/app']) {
    assert.throws(() => parseArgs(['--base', base, ...args('/x', '/p').slice(2)]), /loopback/, base);
  }
  assert.throws(() => parseArgs(['--base', BASE]), /missing --browser/);
  assert.throws(() => parseArgs([...args('/x', '/p'), '--extra', '1']), /bad argument/);
  assert.throws(() => parseArgs(args('/x', '/p', '0')), /positive/);
});

test('request policy: only the exact staging origin; tiles, search and other ports are blocked', () => {
  assert.ok(isAllowedUrl(`${BASE}/boss.html`, BASE));
  assert.ok(isAllowedUrl(`${BASE}/api/route-options`, BASE));
  assert.ok(isAllowedUrl('data:image/png;base64,AAAA', BASE));
  for (const url of ['https://tile.openstreetmap.org/7/1/2.png', 'https://nominatim.openstreetmap.org/search?q=x',
                     'http://127.0.0.1:8002/route', 'http://localhost:18080/boss.html', 'https://127.0.0.1:18080/',
                     'http://127.0.0.1:180800/', 'not a url']) {
    assert.equal(isAllowedUrl(url, BASE), false, url);
  }
});

test('router log: only ROUTER-REQUEST lines, parsed as JSON in order', () => {
  const log = 'noise\nROUTER-REQUEST {"costing":"truck","n":1}\nROUTER-REQUEST {"n":2}\nother ROUTER-REQUEST {"n":3}\n';
  assert.deepEqual(parseRouterLog(log), [{ costing: 'truck', n: 1 }, { n: 2 }]);
  assert.deepEqual(parseRouterLog(''), []);
});

test('browser isolation: no proxy variables, no proxy, background networking off, all names unresolvable', () => {
  const env = browserEnv({ HTTPS_PROXY: 'x', http_proxy: 'x', ALL_PROXY: 'x', NO_PROXY: 'x', PATH: '/bin', HOME: '/h' });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'PATH']);
  for (const flag of ['--headless=new', '--no-proxy-server', '--disable-background-networking', '--disable-sync',
                      '--disable-component-update', '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1']) {
    assert.ok(CHROME_FLAGS.includes(flag), flag);
  }
  assert.ok(!CHROME_FLAGS.some(f => f.startsWith('--remote-debugging-address')), 'DevTools stays on loopback');
});

test('own processes: exact --user-data-dir match only', () => {
  const root = scratch();
  const put = (pid, argv) => { mkdirSync(join(root, String(pid))); writeFileSync(join(root, String(pid), 'cmdline'), argv.join('\0') + '\0'); };
  put(21, ['chrome', '--user-data-dir=/run/a/browser-profile']);
  put(22, ['chrome', '--user-data-dir=/run/a/browser-profile-2']);
  put(23, ['bash', '-c', 'echo /run/a/browser-profile']);
  mkdirSync(join(root, 'self'));
  assert.deepEqual(ownProcesses('/run/a/browser-profile', root), [21]);
});

test('missing browser: S7 FAIL, no S7 ok, profile dir removed', async () => {
  const dir = scratch();
  const profile = join(dir, 'profile');
  const { code, out } = await runMain(args(join(dir, 'no-such-chrome'), profile));
  assert.equal(code, 1);
  assert.match(out, /S7 FAIL: browser could not be started/);
  assert.doesNotMatch(out, /S7 ok|step \d ok/);
  assert.ok(!existsSync(profile));
  assert.match(out, /S7 cleanup: browser stopped \(0 own processes left\), profile dir removed/);
});

test('browser that exits during launch: S7 FAIL with its exit code, cleanup done', async () => {
  const dir = scratch();
  const profile = join(dir, 'profile');
  const { code, out } = await runMain(args(fakeBrowser(dir, 'process.exit(5)'), profile));
  assert.equal(code, 1);
  assert.match(out, /S7 FAIL: browser exited during launch \(5\)/);
  assert.ok(!existsSync(profile));
});

test('browser that never opens DevTools: overall timeout, its own process stopped, profile dir removed', async () => {
  const dir = scratch();
  const profile = join(dir, 'profile');
  const started = Date.now();
  const { code, out } = await runMain(args(fakeBrowser(dir, 'setTimeout(() => {}, 120000)'), profile, '2'));
  assert.equal(code, 1);
  assert.match(out, /S7 FAIL: S7 did not finish within 2 s/);
  assert.deepEqual(ownProcesses(profile), []);
  assert.ok(!existsSync(profile));
  assert.ok(Date.now() - started < 20_000);
});

test('an existing profile dir is never reused or removed', async () => {
  const dir = scratch();
  const profile = join(dir, 'profile');
  mkdirSync(profile);
  writeFileSync(join(profile, 'keep'), 'x');
  const lines = [];
  const code = await main(args(fakeBrowser(dir, 'process.exit(0)'), profile), { log: s => lines.push(s), routerLogFor: () => () => [] });
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /profile dir already exists/);
  assert.ok(existsSync(join(profile, 'keep')), 'the existing dir is left as it was');
});

test('bad arguments exit 2 without starting anything', async () => {
  const { code, out } = await runMain(['--base', 'https://example.test']);
  assert.equal(code, 2);
  assert.match(out, /S7 FAIL/);
});
