// S7 of docs/runbooks/isolated-staging-check-v2.md in a real headless Chrome/Chromium.
//
// Usage: node browser-staging.mjs --base http://127.0.0.1:18080 --browser /usr/bin/google-chrome
//          --router <fake router container id> --profile-dir <new dir> [--timeout 300]
//
// Drives boss.html served by the running staging API only through UI input (mouse clicks,
// typed text, keys) over the Chrome DevTools Protocol, using Node's built-in WebSocket; no
// npm package. Every request that leaves the --base origin is failed (BlockedByClient) and
// counted; Chrome runs with background networking off and every host name unresolvable.
// The fake router's request log is read with `docker logs <id>` (read only).
//
// Prints `S7 …` evidence lines; never prints tokens, passwords or request headers.
// Exit 0 only when every assertion held at every width; 1 on any failure; 2 for bad arguments.
// The browser process, its contexts and the profile dir are this run's own and are always removed.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const OWNER = Object.freeze({ email: 'owner@stage.test', password: 'synthetic-pass-123' });
export const POINTS = Object.freeze(['42.7, 23.3', '43.2, 27.9']);
export const PROFILE = Object.freeze([
  ['tpHeight', '4,1'], ['tpWidth', '2.55'], ['tpLength', '16.5'], ['tpGross', '40'],
  ['tpAxleLoad', '11.5'], ['tpAxleCount', '5']
]);
export const PROFILE_IDS = Object.freeze([...PROFILE.map(([id]) => id), 'tpHazmat']);
export const WIDTHS = Object.freeze([
  { label: 'desktop-1280', width: 1280, height: 900, mobile: false, scale: 1 },
  { label: 'mobile-375', width: 375, height: 812, mobile: true, scale: 2 }
]);
export const LOGOUT_PAUSE_MS = 2000;
const PROFILE_MESSAGE = 'Попълни правилно всички 7 параметъра на камиона — без тях вариантите не се искат.';
const CHANGED_MESSAGE = 'Параметрите на камиона са променени — избраният вариант е премахнат. Поискай варианти отново.';
const NO_GEOMETRY = 'няма избрана пътна геометрия';
const PROVIDER_GEOMETRY = 'по линията от маршрутизатора';

export class S7Error extends Error {}

export function parseArgs(argv) {
  const out = { timeout: 300 };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!['--base', '--browser', '--router', '--profile-dir', '--timeout'].includes(key) || value === undefined) {
      throw new S7Error(`bad argument: ${key}`);
    }
    out[key.slice(2).replace('-dir', 'Dir')] = value;
  }
  for (const k of ['base', 'browser', 'router', 'profileDir']) if (!out[k]) throw new S7Error(`missing --${k}`);
  const base = new URL(out.base);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname) || base.username || base.password
      || (base.pathname !== '/' && base.pathname !== '')) {
    throw new S7Error('--base must be a loopback http origin');
  }
  out.base = base.origin;
  out.timeout = Number(out.timeout);
  if (!(out.timeout > 0)) throw new S7Error('--timeout must be positive');
  return out;
}

/** Only the exact staging origin may be reached from the page; everything else is blocked. */
export function isAllowedUrl(url, base) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol === 'data:' || u.protocol === 'blob:') return true;   // in-page, no network
  return u.origin === new URL(base).origin;
}

/** Fake router log (`docker logs`) → JSON bodies of the requests it received, in order. */
export function parseRouterLog(text) {
  return String(text).split('\n').filter(l => l.startsWith('ROUTER-REQUEST ')).map(l => JSON.parse(l.slice(15)));
}

export function dockerRouterLog(id) {
  return () => {
    const r = spawnSync('docker', ['logs', id], { encoding: 'utf8', timeout: 30_000 });
    if (r.status !== 0) throw new S7Error(`docker logs failed (${r.status ?? r.error?.code})`);
    return parseRouterLog(r.stdout + r.stderr);
  };
}

export const CHROME_FLAGS = Object.freeze([
  '--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
  '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
  '--disable-extensions', '--disable-domain-reliability', '--disable-client-side-phishing-detection',
  '--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication,CertificateTransparencyComponentUpdater',
  '--password-store=basic', '--use-mock-keychain', '--metrics-recording-only', '--disable-breakpad',
  '--disable-crash-reporter', '--no-pings', '--no-proxy-server',
  '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1'
]);

/** The browser gets no proxy settings: with a proxy it would resolve host names past --host-resolver-rules. */
export function browserEnv(env) {
  const out = { ...env };
  for (const k of Object.keys(out)) if (/^(https?|all|no|ftp)_proxy$/i.test(k)) delete out[k];
  return out;
}

/** PIDs whose command line names this run's own profile dir (Linux /proc); nothing else is ever touched. */
export function ownProcesses(profileDir, procRoot = '/proc') {
  const needle = `--user-data-dir=${profileDir}`;
  const found = [];
  let entries = [];
  try { entries = readdirSync(procRoot); } catch { return found; }
  for (const name of entries) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    let cmd;
    try { cmd = readFileSync(`${procRoot}/${name}/cmdline`, 'utf8'); } catch { continue; }
    if (cmd.split('\0').includes(needle)) found.push(Number(name));
  }
  return found;
}

/** Starts the browser with its own new profile dir; resolves with { child, wsUrl } once DevTools is up. */
export async function launchBrowser(bin, profileDir, { launchTimeoutMs = 30_000 } = {}) {
  if (existsSync(profileDir)) throw new S7Error(`profile dir already exists: ${profileDir}`);
  mkdirSync(profileDir, { recursive: true });
  const flags = [...CHROME_FLAGS, `--user-data-dir=${profileDir}`];
  if (process.getuid && process.getuid() === 0) flags.push('--no-sandbox');   // root only (not on the CI runner)
  flags.push('about:blank');
  let child;
  try {
    child = spawn(bin, flags, { stdio: ['ignore', 'ignore', 'pipe'], env: browserEnv(process.env) });
  } catch (e) {
    throw new S7Error(`browser could not be started: ${e.message}`);
  }
  let stderr = '', exited = null, spawnError = null;
  child.stderr.on('data', d => { stderr = (stderr + d).slice(-2000); });
  child.on('exit', (code, signal) => { exited = code ?? signal; });   // killed: code is null
  child.on('error', e => { spawnError = e; });
  const portFile = `${profileDir}/DevToolsActivePort`;
  const deadline = Date.now() + launchTimeoutMs;
  while (Date.now() < deadline) {
    if (spawnError) throw Object.assign(new S7Error(`browser could not be started: ${spawnError.code || spawnError.message}`), { child });
    if (exited !== null) throw Object.assign(new S7Error(`browser exited during launch (${exited}): ${stderr.split('\n').slice(-3).join(' | ')}`), { child });
    if (existsSync(portFile)) {
      const [port, path] = readFileSync(portFile, 'utf8').split('\n');
      if (port && path) return { child, wsUrl: `ws://127.0.0.1:${port.trim()}${path.trim()}` };
    }
    await sleep(100);
  }
  throw Object.assign(new S7Error(`browser did not open DevTools within ${launchTimeoutMs} ms`), { child });
}

export class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.listeners = [];
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, method } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new S7Error(`${method}: ${msg.error.message}`)) : resolve(msg.result);
      } else if (msg.method) {
        for (const l of this.listeners) l(msg);
      }
    });
    ws.addEventListener('close', () => {
      for (const { reject, method } of this.pending.values()) reject(new S7Error(`${method}: DevTools connection closed`));
      this.pending.clear();
    });
  }
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener('open', () => resolve(new Cdp(ws)), { once: true });
      ws.addEventListener('error', () => reject(new S7Error('DevTools WebSocket failed')), { once: true });
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  on(fn) { this.listeners.push(fn); }
  close() { try { this.ws.close(); } catch {} }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** One page in its own browser context, at one viewport. */
export class Page {
  constructor(cdp, base, spec, log) {
    this.cdp = cdp; this.base = base; this.spec = spec; this.log = log;
    this.exceptions = []; this.blocked = []; this.holdLogout = false; this.pausedLogout = null; this.logoutStatus = null;
  }
  async open() {
    const { cdp } = this;
    this.contextId = (await cdp.send('Target.createBrowserContext', { disposeOnDetach: true })).browserContextId;
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', browserContextId: this.contextId });
    this.sessionId = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    cdp.on(msg => { if (msg.sessionId === this.sessionId) this.onEvent(msg); });
    for (const d of ['Page', 'Runtime', 'Network']) await this.send(`${d}.enable`);
    await this.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: this.spec.width, height: this.spec.height, deviceScaleFactor: this.spec.scale, mobile: this.spec.mobile });
  }
  send(method, params) { return this.cdp.send(method, params, this.sessionId); }
  onEvent({ method, params }) {
    if (method === 'Fetch.requestPaused') {
      const { requestId, request, networkId } = params;
      if (!isAllowedUrl(request.url, this.base)) {
        let host = '?'; try { host = new URL(request.url).host || request.url.split(':')[0]; } catch {}
        this.blocked.push(host);
        this.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      } else if (this.holdLogout && request.method === 'POST' && new URL(request.url).pathname === '/api/logout') {
        this.pausedLogout = { requestId, networkId, at: Date.now() };
      } else {
        this.send('Fetch.continueRequest', { requestId }).catch(() => {});
      }
    } else if (method === 'Runtime.exceptionThrown') {
      const d = params.exceptionDetails;
      this.exceptions.push(((d.exception && d.exception.description) || d.text || 'exception').split('\n')[0].slice(0, 200));
    } else if (method === 'Network.responseReceived' && this.pausedLogout && params.requestId === this.pausedLogout.networkId) {
      this.logoutStatus = params.response.status;
    }
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new S7Error(`evaluate failed: ${r.exceptionDetails.text}`);
    return r.result.value;
  }
  async waitFor(expression, what, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      try { last = await this.eval(expression); if (last) return last; } catch (e) { last = e.message; }
      await sleep(100);
    }
    throw new S7Error(`timed out waiting for ${what}`);
  }
  async load(reload = false) {
    if (reload) await this.send('Page.reload', { ignoreCache: true });
    else await this.send('Page.navigate', { url: `${this.base}/boss.html` });
    await this.waitFor(`document.readyState === 'complete' && location.pathname === '/boss.html'
      && !!document.querySelector('section.on')`, 'boss.html to load');
  }
  /** A real mouse click at the centre of the element, only if the element itself is what is hit there. */
  async click(selector) {
    const box = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { error: 'missing' };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return { error: 'not visible' };
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      if (!hit || !(hit === el || el.contains(hit))) return { error: 'covered by ' + (hit ? hit.tagName + '#' + hit.id : 'nothing') };
      return { x, y };
    })()`);
    if (box.error) throw new S7Error(`cannot click ${selector}: ${box.error}`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
    }
  }
  async key(key, code, keyCode, modifiers = 0) {
    await this.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, modifiers });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers });
  }
  /** Click into the field, select what is there (Ctrl+A) and type the text over it. */
  async type(selector, text) {
    await this.click(selector);
    await this.key('a', 'KeyA', 65, 2);
    await this.send('Input.insertText', { text });
    const value = await this.eval(`document.querySelector(${JSON.stringify(selector)}).value`);
    if (value !== text) throw new S7Error(`typing into ${selector} gave a different value`);
  }
  async fillProfile() {
    for (const [id, value] of PROFILE) await this.type(`#${id}`, value);
    await this.key('Tab', 'Tab', 9);            // from the axle count to the hazmat select, like a user
    await this.waitFor(`document.activeElement && document.activeElement.id === 'tpHazmat'`, 'focus on hazmat');
    await this.key('ArrowDown', 'ArrowDown', 40);   // "Избери" → "Не"
    await this.waitFor(`document.getElementById('tpHazmat').value === 'no'`, 'hazmat = Не');
  }
  text(id) { return this.eval(`document.getElementById(${JSON.stringify(id)}).textContent`); }
  async tab(name) {
    await this.click(`nav button[data-tab="${name}"]`);
    await this.waitFor(`document.getElementById(${JSON.stringify(name)}).classList.contains('on')`, `${name} tab`);
  }
  solidLines() {   // the route line from the provider is solid; the straight point-to-point line is dashed
    return this.eval(`document.querySelectorAll('#map path.leaflet-interactive:not([stroke-dasharray])').length`);
  }
  profileBlank() { return this.eval(`${JSON.stringify(PROFILE_IDS)}.every(id => document.getElementById(id).value === '')`); }
  async dispose() {
    try { await this.cdp.send('Target.disposeBrowserContext', { browserContextId: this.contextId }); } catch {}
  }
}

function check(cond, message) { if (!cond) throw new S7Error(message); }

/** The S7 steps of the frozen v2 runbook at one viewport. */
export async function runWidth(cdp, base, spec, routerLog, log) {
  const page = new Page(cdp, base, spec, log);
  const w = spec.label;
  let step = 'open';
  try {
    await page.open();
    step = '1 login';
    await page.load();
    await page.waitFor(`document.getElementById('login').classList.contains('on')`, 'login screen');
    await page.type('#loginForm input[name=email]', OWNER.email);
    await page.type('#loginForm input[name=password]', OWNER.password);
    await page.type('#loginForm input[name=server]', base);
    await page.click('#loginBtn');
    await page.waitFor(`document.getElementById('drivers').classList.contains('on')
      && document.getElementById('coName').textContent.includes('Synthetic Stage Co')`, 'logged-in drivers tab');
    check(await page.eval(`!!localStorage.getItem('boss_token')`), 'no session after login');
    await page.tab('route');
    for (const p of POINTS) { await page.type('#coords', p); await page.click('#coordsBtn'); }
    await page.waitFor(`document.querySelectorAll('#pts li').length === 2`, 'two points');
    log(`S7 ${w} step 1 ok: UI login, Route tab, 2 points by coordinates`);

    step = '2 empty profile';
    let before = routerLog().length;
    await page.click('#routeOptions');
    await page.waitFor(`document.getElementById('tpErr').textContent === ${JSON.stringify(PROFILE_MESSAGE)}`, 'profile message');
    const errs = await page.eval(`${JSON.stringify(PROFILE_IDS)}.filter(id => {
      const e = document.getElementById(id + 'Err'); return e.textContent.trim() && e.offsetParent !== null; }).length`);
    check(errs === 7, `expected 7 visible field errors, got ${errs}`);
    check(await page.eval(`document.activeElement.id`) === 'tpHeight', 'focus is not on Височина');
    await sleep(500);
    check(routerLog().length === before, 'an empty profile reached the router');
    log(`S7 ${w} step 2 ok: empty profile → 7 visible field errors, message, focus tpHeight, router requests +0`);

    step = '3 options';
    await page.fillProfile();
    before = routerLog().length;
    await page.click('#routeOptions');
    await page.waitFor(`document.querySelectorAll('#routeOptionsList [data-route-option]').length === 1`, 'one option');
    const option = await page.eval(`document.querySelector('#routeOptionsList [data-route-option]').textContent`);
    check(option.startsWith('Вариант 1 · 401 км'), `unexpected option text: ${option}`);
    check(!(await page.text('routeErr')).includes('Избран е вариант'), 'an option was selected automatically');
    check((await page.text('rKm')).includes(NO_GEOMETRY), 'a road geometry is shown before selection');
    check(await page.solidLines() === 0, 'a solid route line is drawn before selection');
    const sent = routerLog();
    check(sent.length === before + 1, `expected 1 router request, got ${sent.length - before}`);
    const last = sent[sent.length - 1];
    check(last.costing === 'truck' && last.costing_options?.truck?.height === 4.1, 'router did not receive costing truck with height 4.1');
    log(`S7 ${w} step 3 ok: 1 option, none selected, router requests +1, costing truck, height 4.1 (typed "4,1")`);

    step = '4 change';
    await page.click('#routeOptionsList [data-route-option="0"]');
    await page.waitFor(`document.getElementById('routeErr').textContent.startsWith('Избран е вариант 1')`, 'selection');
    check((await page.text('rKm')).includes(PROVIDER_GEOMETRY), 'selected line is not the provider line');
    check(await page.solidLines() === 1, 'selected provider line is not drawn');
    await page.type('#tpHeight', '4,2');
    await page.waitFor(`document.getElementById('routeErr').textContent === ${JSON.stringify(CHANGED_MESSAGE)}`, 'change message');
    check(await page.eval(`document.getElementById('routeOptionsList').children.length`) === 0, 'options were not removed');
    check((await page.text('rKm')).includes(NO_GEOMETRY), 'provider geometry still selected');
    check(await page.solidLines() === 0, 'provider line still drawn');
    log(`S7 ${w} step 4 ok: selected → height changed → options, provider line and selection removed, message shown`);

    step = '5 reload';
    await page.type('#tpHeight', '4,1');
    before = routerLog().length;
    await page.click('#routeOptions');
    await page.waitFor(`document.querySelectorAll('#routeOptionsList [data-route-option]').length === 1`, 'one option again');
    check(routerLog().length === before + 1, 'second valid request did not reach the router once');
    await page.click('#routeOptionsList [data-route-option="0"]');
    await page.waitFor(`document.getElementById('routeErr').textContent.startsWith('Избран е вариант 1')`, 'selection again');
    await page.load(true);
    await page.waitFor(`document.getElementById('drivers').classList.contains('on')`, 'still logged in after reload');
    await page.tab('route');
    check(await page.profileBlank(), 'truck profile fields are not blank after reload');
    check(await page.eval(`document.querySelectorAll('#pts li').length`) === 2, 'points draft not kept');
    check((await page.text('rKm')).includes(NO_GEOMETRY), 'provider line restored after reload');
    check(await page.solidLines() === 0, 'provider line drawn after reload');
    check(await page.eval(`localStorage.getItem('boss_route_geometry')`) === '[]', 'provider geometry stored in the draft');
    log(`S7 ${w} step 5 ok: reload → 7 fields blank, points kept, provider line not restored (${NO_GEOMETRY})`);

    step = '6 logout';
    await page.fillProfile();
    await page.tab('settings');
    page.holdLogout = true;
    await page.click('#logout');
    await page.waitFor(`document.getElementById('login').classList.contains('on')`, 'login screen after logout', 1500);
    check(page.pausedLogout, 'server logout request was not sent');
    check(await page.eval(`localStorage.getItem('boss_token') === null`), 'session token still stored');
    check(await page.profileBlank(), 'truck profile not cleared on logout');
    check(Date.now() - page.pausedLogout.at < LOGOUT_PAUSE_MS, 'UI checks took longer than the pause');
    await sleep(Math.max(0, page.pausedLogout.at + LOGOUT_PAUSE_MS - Date.now()));
    await page.send('Fetch.continueRequest', { requestId: page.pausedLogout.requestId });
    const deadline = Date.now() + 15_000;
    while (page.logoutStatus === null && Date.now() < deadline) await sleep(100);
    check(page.logoutStatus === 200, `server logout answered ${page.logoutStatus}`);
    log(`S7 ${w} step 6 ok: logout → login screen, no boss_token, 7 fields blank while the server logout was paused ${LOGOUT_PAUSE_MS} ms; then resumed, HTTP 200`);

    step = 'page errors';
    await sleep(1000);   // let late timers and promise rejections of this page surface
    check(page.exceptions.length === 0, `JS exceptions: ${page.exceptions.join(' | ')}`);
    log(`S7 ${w} ok (${spec.width}x${spec.height}${spec.mobile ? ' mobile' : ''}): 0 JS exceptions, ${page.blocked.length} external requests blocked`);
    return { blocked: page.blocked, exceptions: page.exceptions };
  } catch (e) {
    const extra = page.exceptions.length && step !== 'page errors' ? `; JS exceptions: ${page.exceptions.join(' | ')}` : '';
    throw new S7Error(`${w} step ${step}: ${e.message}${extra}`);
  } finally {
    await page.dispose();
  }
}

export async function stopBrowser(cdp, child, profileDir) {
  if (cdp) { try { await Promise.race([cdp.send('Browser.close'), sleep(5000)]); } catch {} cdp.close(); }
  if (child && child.exitCode === null && child.signalCode === null) {
    const gone = new Promise(r => child.once('exit', r));
    child.kill('SIGTERM');
    if (await Promise.race([gone.then(() => true), sleep(5000).then(() => false)]) === false) {
      child.kill('SIGKILL');
      await Promise.race([gone, sleep(5000)]);
    }
  }
  if (profileDir) {
    // helper processes (zygote, GPU, utility) can outlive the main one for a moment: stop only those with our profile
    for (let i = 0; i < 50 && ownProcesses(profileDir).length; i++) {
      for (const pid of ownProcesses(profileDir)) { try { process.kill(pid, i < 30 ? 'SIGTERM' : 'SIGKILL'); } catch {} }
      await sleep(100);
    }
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

export async function main(argv, { log = s => console.log(s), routerLogFor = dockerRouterLog } = {}) {
  let args;
  try { args = parseArgs(argv); } catch (e) { log(`S7 FAIL: ${e.message}`); return 2; }
  // never reuse or remove a directory this run did not create
  if (existsSync(args.profileDir)) { log(`S7 FAIL: profile dir already exists: ${args.profileDir}`); return 1; }
  let child = null, cdp = null, timer = null, stopping = null;
  const stop = () => (stopping ??= stopBrowser(cdp, child, args.profileDir));
  const onSignal = sig => { log(`S7 FAIL: ${sig} — browser stopped, profile removed`); stop().finally(() => process.exit(143)); };
  process.once('SIGTERM', onSignal); process.once('SIGINT', onSignal);
  try {
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new S7Error(`S7 did not finish within ${args.timeout} s`)), args.timeout * 1000);
    });
    await Promise.race([timeout, (async () => {
      if (typeof WebSocket !== 'function') throw new S7Error('this Node has no built-in WebSocket (need Node 22+)');
      const launched = await launchBrowser(args.browser, args.profileDir).catch(e => { child = e.child || null; throw e; });
      child = launched.child;
      cdp = await Cdp.connect(launched.wsUrl);
      const v = await cdp.send('Browser.getVersion');
      log(`S7 browser launched: ${v.product} (protocol ${v.protocolVersion}); Node ${process.version}; headless; own profile dir`);
      const routerLog = routerLogFor(args.router);
      const results = [];
      for (const spec of WIDTHS) results.push(await runWidth(cdp, args.base, spec, routerLog, log));
      const blocked = results.flatMap(r => r.blocked);
      const hosts = [...new Set(blocked)].sort();
      log(`S7 js exceptions: 0 (Runtime.exceptionThrown, incl. unhandled rejections) at ${WIDTHS.map(s => s.label).join(', ')}`);
      log(`S7 external requests blocked: ${blocked.length}${hosts.length ? ` (${hosts.join(', ')})` : ''}; only ${args.base} reached`);
    })()]);
    log(`S7 ok (${WIDTHS.map(s => s.label).join(', ')}; real headless browser, synthetic API, fake router)`);
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
      return 1;
    }
    log('S7 cleanup: browser stopped (0 own processes left), profile dir removed');
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).then(code => process.exit(code));
}
