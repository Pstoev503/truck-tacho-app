// S7 and S7C (route-option count) of docs/runbooks/isolated-staging-check-v3.md in a real headless browser.
//
// Usage: node browser-count-staging.mjs --base http://127.0.0.1:18080 --browser /usr/bin/google-chrome
//          --router <fake router container id> --profile-dir <new dir> [--timeout 420]
//
// Reuses the accepted scripts/browser-staging.mjs (read only, imported): the same browser launch,
// isolation (only --base reachable, no proxy, names unresolvable), UI-only input, own-profile cleanup
// and the six S7 steps. Adds S7C per width in a new browser context: the fake router's fixture mode
// (`router_mode` of the runbook: docker exec in the run's own router container) gives 3 valid
// candidates, then 4 and 5001; the app's API answer reaches the page unchanged (no interception).
//
// Prints `S7 …` and `S7C …` evidence lines; never prints tokens, passwords, headers or bodies.
// Exit 0 only when every assertion held at every width; 1 on any failure; 2 for bad arguments.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  Cdp, Page, S7Error, WIDTHS, dockerRouterLog, launchBrowser, ownProcesses, parseArgs, runWidth, stopBrowser
} from './browser-staging.mjs';

export const ROUTER_MODE_CODE = 'import sys; open("/tmp/t10-router-mode", "w").write(sys.argv[1])';
export const MODES = Object.freeze(['1', '3', '4', '5001']);
export const OPTIONS_ERROR = 'Отговорът с вариантите е невалиден. Опитай отново.';
export const RATE = Object.freeze({ max: 9, windowMs: 61_000 });   // server: 10 per 60 s per owner
const NO_GEOMETRY = 'няма избрана пътна геометрия';
const PROVIDER_GEOMETRY = 'по линията от маршрутизатора';
const MANUAL_GEOMETRY = 'по ръчно начертаната линия';
const POINTS = ['42.7, 23.3', '43.2, 27.9'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const check = (cond, message) => { if (!cond) throw new S7Error(message); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** The runbook's router_mode, for the run's own fake router container only. */
export function dockerRouterMode(id, run = spawnSync) {
  return mode => {
    if (!MODES.includes(String(mode))) throw new S7Error(`unknown fixture mode ${mode}`);
    const r = run('docker', ['exec', id, 'python', '-c', ROUTER_MODE_CODE, String(mode)], { encoding: 'utf8', timeout: 30_000 });
    if (r.status !== 0) throw new S7Error(`router_mode ${mode} failed (${r.status ?? r.error?.code})`);
  };
}

/** Keeps POST /api/route-options under the server's per-owner limit by waiting, never by retrying. */
export class RateBudget {
  constructor({ max = RATE.max, windowMs = RATE.windowMs, now = () => Date.now(), wait = sleep, log = () => {} } = {}) {
    Object.assign(this, { max, windowMs, now, wait, log, times: [] });
  }
  async reserve(n = 1) {
    if (n > this.max) throw new S7Error('reservation larger than the rate budget');
    for (;;) {
      const t = this.now();
      this.times = this.times.filter(x => t - x < this.windowMs);
      if (this.times.length + n <= this.max) break;
      const ms = this.times[0] + this.windowMs - t;
      this.log(`S7C rate pacing: waiting ${Math.ceil(ms / 1000)} s (server limit 10 route-options requests per minute per owner)`);
      await this.wait(ms);
    }
    for (let i = 0; i < n; i++) this.times.push(this.now());
  }
}

/** Page that also records the HTTP status of every /api/route-options answer the page receives. */
export class CountPage extends Page {
  constructor(...a) { super(...a); this.routeStatuses = []; }
  onEvent(msg) {
    super.onEvent(msg);
    if (msg.method === 'Network.responseReceived') {
      let path = '';
      try { path = new URL(msg.params.response.url).pathname; } catch {}
      if (path === '/api/route-options') this.routeStatuses.push(msg.params.response.status);
    }
  }
  /** Read-only state once the map has stopped animating (Leaflet redraws path `d` during zoom/pan animations). */
  async snapshot() {
    let prev = null;
    for (let i = 0; i < 40; i++) {
      const cur = await this.read();
      if (!cur.animating && prev && same(prev, cur)) return cur;
      prev = cur;
      await sleep(150);
    }
    throw new S7Error('map did not settle within 6 s');
  }
  read() {
    return this.eval(`(() => {
      const list = document.getElementById('routeOptionsList');
      return {
        animating: !!document.querySelector('#map .leaflet-zoom-anim, #map .leaflet-pan-anim'),
        rKm: document.getElementById('rKm').textContent,
        routeErr: document.getElementById('routeErr').textContent,
        list: list.textContent,
        buttons: list.querySelectorAll('[data-route-option]').length,
        solid: [...document.querySelectorAll('#map path.leaflet-interactive:not([stroke-dasharray])')].map(p => p.getAttribute('d')),
        draft: ['boss_route_draft', 'boss_route_geometry', 'boss_route_name', 'boss_route_notes']
          .map(k => localStorage.getItem(k))
      };
    })()`);
  }
  /** A real click at a fraction of the map, only if the map is what is hit there. */
  async clickMap(fx, fy) {
    const box = await this.eval(`(() => {
      const m = document.getElementById('map');
      m.scrollIntoView({ block: 'center' });
      const r = m.getBoundingClientRect();
      const x = r.left + r.width * ${fx}, y = r.top + r.height * ${fy};
      const hit = document.elementFromPoint(x, y);
      return hit && m.contains(hit) ? { x, y } : { error: 'map not hit' };
    })()`);
    if (box.error) throw new S7Error(box.error);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
  }
}

/** S7C at one viewport: valid maximum, whole-response rejection keeping the prior line, valid retry. */
export async function runCountWidth(cdp, base, spec, { routerLog, setMode, budget, log }) {
  const page = new CountPage(cdp, base, spec, log);
  const w = spec.label;
  let step = 'open';

  async function request(mode) {
    await budget.reserve(1);
    setMode(mode);
    const before = routerLog().length, statuses = page.routeStatuses.length;
    await page.click('#routeOptions');
    await page.waitFor(`(() => { const l = document.getElementById('routeOptionsList');
      return !l.textContent.startsWith('Търся') && (l.querySelector('[data-route-option]') || l.textContent.length > 0); })()`,
    `the answer in mode ${mode}`, 30_000);
    const deadline = Date.now() + 10_000;
    while (page.routeStatuses.length === statuses && Date.now() < deadline) await sleep(50);
    const sent = routerLog();
    check(sent.length === before + 1, `mode ${mode}: expected 1 router request, got ${sent.length - before}`);
    const last = sent[sent.length - 1];
    check(last.costing === 'truck' && last.costing_options?.truck?.height === 4.1, `mode ${mode}: router did not get the truck profile`);
    check(page.routeStatuses[statuses] === 200, `mode ${mode}: API answered ${page.routeStatuses[statuses]}`);
    return page.snapshot();
  }
  async function expectThree(after) {
    const s = await page.snapshot();
    check(s.buttons === 3, `expected 3 options, got ${s.buttons}`);
    const texts = await page.eval(`[...document.querySelectorAll('#routeOptionsList [data-route-option]')].map(b => b.textContent)`);
    ['Вариант 1 · 401 км', 'Вариант 2 · 402 км', 'Вариант 3 · 403 км'].forEach((t, i) => check(texts[i].startsWith(t), `option ${i + 1}: ${texts[i]}`));
    return s;
  }
  async function expectRejectedKeeping(before, mode, kind) {
    const after = await request(mode);
    check(after.list === OPTIONS_ERROR, `mode ${mode}: expected the bounded error, got "${after.list.slice(0, 80)}"`);
    check(after.buttons === 0, `mode ${mode}: ${after.buttons} selectable options (partial list)`);
    check(same(after.solid, before.solid), `mode ${mode}: the ${kind} line changed (${before.solid.length} → ${after.solid.length} solid paths; d ${before.solid.map(d => d.slice(0, 40)).join('|')} → ${after.solid.map(d => d.slice(0, 40)).join('|')})`);
    check(after.rKm === before.rKm, `mode ${mode}: route summary/provenance changed`);
    check(after.routeErr === before.routeErr, `mode ${mode}: selection message changed`);
    check(same(after.draft, before.draft), `mode ${mode}: draft storage changed`);
    return after;
  }

  try {
    await page.open();
    step = '0 login';
    await page.load();
    await page.waitFor(`document.getElementById('login').classList.contains('on')`, 'login screen');
    await page.type('#loginForm input[name=email]', 'owner@stage.test');
    await page.type('#loginForm input[name=password]', 'synthetic-pass-123');
    await page.type('#loginForm input[name=server]', base);
    await page.click('#loginBtn');
    await page.waitFor(`document.getElementById('drivers').classList.contains('on')`, 'logged in');
    await page.tab('route');
    for (const p of POINTS) { await page.type('#coords', p); await page.click('#coordsBtn'); }
    await page.waitFor(`document.querySelectorAll('#pts li').length === 2`, 'two points');
    await page.fillProfile();

    step = '1 valid maximum';
    let s = await request('3');
    await expectThree();
    check(s.rKm.includes(NO_GEOMETRY) && s.solid.length === 0, 'an option was selected automatically');
    await page.click('#routeOptionsList [data-route-option="1"]');
    await page.waitFor(`document.getElementById('routeErr').textContent.startsWith('Избран е вариант 2')`, 'selection of option 2');
    s = await page.snapshot();
    check(s.rKm.includes(PROVIDER_GEOMETRY) && s.solid.length === 1, 'selected provider line not shown');
    log(`S7C ${w} step 1 ok: router mode 3 → API 200, 3 options (401/402/403 km), none selected; option 2 selected; router requests +1, height 4.1`);

    step = '2 overflow 4 keeps provider line';
    await expectRejectedKeeping(s, '4', 'provider');
    log(`S7C ${w} step 2 ok: router mode 4 (primary + 3 alternates) → API 200, bounded error, 0 options; provider line, provenance and draft unchanged; router requests +1`);

    step = '3 overflow 5001 keeps provider line';
    await expectRejectedKeeping(s, '5001', 'provider');
    log(`S7C ${w} step 3 ok: router mode 5001 (primary + 5000 alternates) → API 200, bounded error, 0 options; provider line, provenance and draft unchanged; router requests +1`);

    step = '4 overflow keeps manual line';
    await page.click('#drawRoute');
    await page.waitFor(`document.getElementById('drawRoute').textContent === 'Готово с чертането'`, 'drawing mode');
    await page.clickMap(0.35, 0.3);
    await page.clickMap(0.65, 0.7);
    await page.click('#drawRoute');
    await page.waitFor(`document.getElementById('routeErr').textContent === 'Собственото трасе е запазено.'`, 'manual line saved');
    const manual = await page.snapshot();
    check(manual.rKm.includes(MANUAL_GEOMETRY) && manual.solid.length === 1, 'manual line not shown');
    check(JSON.parse(manual.draft[1]).length === 4, 'manual line not in the draft');
    await expectRejectedKeeping(manual, '4', 'manual');
    log(`S7C ${w} step 4 ok: manual line (4 points, in draft) → router mode 4 → API 200, bounded error, 0 options; manual line, provenance and draft unchanged; router requests +1`);

    step = '5 valid retry';
    await request('3');
    await expectThree();
    await page.click('#routeOptionsList [data-route-option="0"]');
    await page.waitFor(`document.getElementById('routeErr').textContent.startsWith('Избран е вариант 1')`, 'selection after retry');
    s = await page.snapshot();
    check(s.rKm.includes(PROVIDER_GEOMETRY) && s.solid.length === 1, 'retry selection not shown');
    setMode('1');
    log(`S7C ${w} step 5 ok: retry in router mode 3 → 3 options, option 1 selectable and selected; router mode back to 1`);

    step = 'page errors';
    await sleep(1000);
    check(page.exceptions.length === 0, `JS exceptions: ${page.exceptions.join(' | ')}`);
    log(`S7C ${w} ok (${spec.width}x${spec.height}${spec.mobile ? ' mobile' : ''}): 0 JS exceptions, ${page.blocked.length} external requests blocked, ${page.routeStatuses.length} route-options answers all 200`);
    return { blocked: page.blocked };
  } catch (e) {
    const extra = page.exceptions.length && step !== 'page errors' ? `; JS exceptions: ${page.exceptions.join(' | ')}` : '';
    throw new S7Error(`${w} S7C step ${step}: ${e.message}${extra}`);
  } finally {
    try { setMode('1'); } catch {}
    try { await cdp.send('Target.disposeBrowserContext', { browserContextId: page.contextId }); } catch {}
  }
}

export async function main(argv, { log = s => console.log(s), routerLogFor = dockerRouterLog, routerModeFor = dockerRouterMode,
                                  budget = null } = {}) {
  let args;
  try { args = parseArgs(argv); } catch (e) { log(`S7 FAIL: ${e.message}`); return 2; }
  if (existsSync(args.profileDir)) { log(`S7 FAIL: profile dir already exists: ${args.profileDir}`); return 1; }
  let child = null, cdp = null, timer = null, stopping = null;
  const stop = () => (stopping ??= stopBrowser(cdp, child, args.profileDir));
  const onSignal = sig => { log(`S7 FAIL: ${sig} — browser stopped, profile removed`); stop().finally(() => process.exit(143)); };
  process.once('SIGTERM', onSignal); process.once('SIGINT', onSignal);
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new S7Error(`S7/S7C did not finish within ${args.timeout} s`)), args.timeout * 1000);
    });
    await Promise.race([timeout, (async () => {
      if (typeof WebSocket !== 'function') throw new S7Error('this Node has no built-in WebSocket (need Node 22+)');
      const routerLog = routerLogFor(args.router);
      const setMode = routerModeFor(args.router);
      setMode('1');
      const rate = budget || new RateBudget({ log });
      await rate.reserve(1);                                  // S3's request, counted conservatively from now
      const launched = await launchBrowser(args.browser, args.profileDir).catch(e => { child = e.child || null; throw e; });
      child = launched.child;
      cdp = await Cdp.connect(launched.wsUrl);
      const v = await cdp.send('Browser.getVersion');
      log(`S7 browser launched: ${v.product} (protocol ${v.protocolVersion}); Node ${process.version}; headless; own profile dir`);
      const blocked = [];
      for (const spec of WIDTHS) {
        await rate.reserve(2);                                // the two valid requests of the accepted S7 steps
        blocked.push(...(await runWidth(cdp, args.base, spec, routerLog, log)).blocked);
        blocked.push(...(await runCountWidth(cdp, args.base, spec, { routerLog, setMode, budget: rate, log })).blocked);
      }
      const hosts = [...new Set(blocked)].sort();
      log(`S7 js exceptions: 0 (Runtime.exceptionThrown, incl. unhandled rejections) at ${WIDTHS.map(s => s.label).join(', ')} (S7 and S7C)`);
      log(`S7 external requests blocked: ${blocked.length}${hosts.length ? ` (${hosts.join(', ')})` : ''}; only ${args.base} reached`);
    })()]);
    log(`S7 ok (${WIDTHS.map(s => s.label).join(', ')}; real headless browser, synthetic API, fake router)`);
    log(`S7C ok (${WIDTHS.map(s => s.label).join(', ')}; max 3 options, overflow 4 and 5001 rejected whole, prior lines kept, valid retry)`);
    return 0;
  } catch (e) {
    log(`S7 FAIL: ${e.message}`);
    return 1;
  } finally {
    clearTimeout(timer);
    try { await stop(); } catch (e) { log(`S7 cleanup error: ${e.code || e.message}`); }
    process.removeListener('SIGTERM', onSignal); process.removeListener('SIGINT', onSignal);
    const left = ownProcesses(args.profileDir);
    if (existsSync(args.profileDir) || left.length) {
      log(`S7 cleanup FAIL: ${left.length} browser processes left, profile dir ${existsSync(args.profileDir) ? 'still exists' : 'removed'}`);
      return 1;   // eslint-disable-line no-unsafe-finally
    }
    log('S7 cleanup: browser stopped (0 own processes left), profile dir removed');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).then(code => process.exit(code));
}
