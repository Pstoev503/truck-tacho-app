import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { PROFILE_FIELDS } from './truck-profile-input.mjs';
import {
  MAX_ROUTE_OPTION_CANDIDATES,
  normalizeRouteOptionsResponse,
  ROUTE_OPTIONS_RESPONSE_ERROR_MESSAGE
} from './route-options-response.mjs';

const PRIMARY = { legs: [{}], summary: { length: 10, time: 60 } };
const DIRECT = { legs: [{}], summary: { length: 20, time: 120 } };

test('keeps a valid primary trip when alternates are missing', () => {
  assert.deepEqual(normalizeRouteOptionsResponse({ trip: PRIMARY }), [PRIMARY]);
});

test('keeps a valid primary trip when alternates are null', () => {
  assert.deepEqual(normalizeRouteOptionsResponse({ trip: PRIMARY, alternates: null }), [PRIMARY]);
});

test('keeps a valid primary trip when alternates are empty', () => {
  assert.deepEqual(normalizeRouteOptionsResponse({ trip: PRIMARY, alternates: [] }), [PRIMARY]);
});

test('normalizes wrapped alternate trips', () => {
  const wrapped = { trip: DIRECT };
  assert.deepEqual(normalizeRouteOptionsResponse({ trip: PRIMARY, alternates: [wrapped] }), [PRIMARY, DIRECT]);
});

test('keeps direct alternate-trip compatibility', () => {
  assert.deepEqual(normalizeRouteOptionsResponse({ trip: PRIMARY, alternates: [DIRECT] }), [PRIMARY, DIRECT]);
});

for (const [label, alternates] of [
  ['two wrapped trips', [{ trip: DIRECT }, { trip: PRIMARY }]],
  ['two direct trips', [DIRECT, PRIMARY]],
  ['mixed wrapped and direct trips', [{ trip: DIRECT }, PRIMARY]]
]) {
  test(`accepts exactly two valid ${label}`, () => {
    assert.deepEqual(normalizeRouteOptionsResponse({ trip: PRIMARY, alternates }), [PRIMARY, ...alternates.map(item => item.trip || item)]);
  });
}

test('rejects three valid alternates as a whole response', () => {
  assert.throws(
    () => normalizeRouteOptionsResponse({ trip: PRIMARY, alternates: [DIRECT, PRIMARY, DIRECT] }),
    error => error.message === ROUTE_OPTIONS_RESPONSE_ERROR_MESSAGE
  );
});

test('rejects 5000 alternates before reading any entries', () => {
  let inspected = 0;
  const alternates = new Array(5000);
  for (let index = 0; index < alternates.length; index++) {
    Object.defineProperty(alternates, index, { get() { inspected++; return DIRECT; } });
  }
  assert.throws(
    () => normalizeRouteOptionsResponse({ trip: PRIMARY, alternates }),
    error => error.message === ROUTE_OPTIONS_RESPONSE_ERROR_MESSAGE
  );
  assert.equal(inspected, 0);
});

test('rejects frozen overflow input without mutating it', () => {
  const alternates = Object.freeze([Object.freeze({ trip: DIRECT }), Object.freeze(DIRECT), Object.freeze({ trip: PRIMARY })]);
  const response = Object.freeze({ trip: PRIMARY, alternates });
  const before = JSON.stringify(response);
  assert.throws(
    () => normalizeRouteOptionsResponse(response),
    error => error.message === ROUTE_OPTIONS_RESPONSE_ERROR_MESSAGE
  );
  assert.equal(JSON.stringify(response), before);
});

test('rejects malformed entries in an over-limit list without exposing the marker', () => {
  const response = {
    trip: PRIMARY,
    alternates: [{ trip: { legs: [] } }, DIRECT, { privateMarker: 'private-overflow-marker' }]
  };
  assert.throws(
    () => normalizeRouteOptionsResponse(response),
    error => error.message === ROUTE_OPTIONS_RESPONSE_ERROR_MESSAGE &&
      !error.message.includes('private-overflow-marker')
  );
});

test('keeps over-limit error bounded and independent of private response data', () => {
  const response = {
    trip: PRIMARY,
    alternates: [DIRECT, DIRECT, DIRECT],
    privateMarker: 'do-not-disclose-this-provider-data'
  };
  assert.throws(
    () => normalizeRouteOptionsResponse(response),
    error => error.message === ROUTE_OPTIONS_RESPONSE_ERROR_MESSAGE &&
      error.message.length <= 100 &&
      !error.message.includes('do-not-disclose-this-provider-data')
  );
});

test('accepts the maximum candidate count and rejects a larger alternate array before inspecting entries', () => {
  assert.equal(MAX_ROUTE_OPTION_CANDIDATES, 3);
  assert.deepEqual(
    normalizeRouteOptionsResponse({ trip: PRIMARY, alternates: [DIRECT, DIRECT] }),
    [PRIMARY, DIRECT, DIRECT]
  );

  const alternates = new Array(5000);
  Object.defineProperty(alternates, 0, { get() { throw new Error('alternate entry was inspected'); } });
  assert.throws(
    () => normalizeRouteOptionsResponse({ trip: PRIMARY, alternates }),
    error => error.message === ROUTE_OPTIONS_RESPONSE_ERROR_MESSAGE
  );
});

test('rejects a 185051-byte response containing 5000 alternates as one whole response', () => {
  const response = {
    trip: PRIMARY,
    alternates: Array.from({ length: 5000 }, () => ({ legs: [{}] })),
    padding: ''
  };
  const fixedBytes = Buffer.byteLength(JSON.stringify(response));
  response.padding = 'x'.repeat(185051 - fixedBytes);
  assert.equal(Buffer.byteLength(JSON.stringify(response)), 185051);
  assert.throws(
    () => normalizeRouteOptionsResponse(response),
    error => error.message === ROUTE_OPTIONS_RESPONSE_ERROR_MESSAGE
  );
});

for (const [name, response] of [
  ['null response', null],
  ['array response', []],
  ['string response', 'provider marker'],
  ['missing primary trip', { alternates: [] }],
  ['null primary trip', { trip: null }],
  ['primary trip with missing legs', { trip: {} }],
  ['primary trip with empty legs', { trip: { legs: [] } }],
  ['primary trip with non-array legs', { trip: { legs: {} } }],
  ['object alternates', { trip: PRIMARY, alternates: {} }],
  ['string alternates', { trip: PRIMARY, alternates: 'provider marker' }],
  ['null alternate', { trip: PRIMARY, alternates: [null] }],
  ['primitive alternate', { trip: PRIMARY, alternates: [7] }],
  ['malformed wrapped trip', { trip: PRIMARY, alternates: [{ trip: null }] }],
  ['wrapped trip with malformed legs', { trip: PRIMARY, alternates: [{ trip: { legs: [] } }] }],
  ['direct trip with non-array legs', { trip: PRIMARY, alternates: [{ legs: 'bad' }] }],
  ['mixed valid and malformed alternates', { trip: PRIMARY, alternates: [DIRECT, { trip: {} }] }]
]) {
  test(`rejects ${name} with one bounded message`, () => {
    assert.throws(
      () => normalizeRouteOptionsResponse(response),
      error => error.message === ROUTE_OPTIONS_RESPONSE_ERROR_MESSAGE &&
        error.message.length <= 100 &&
        !error.message.includes('provider marker')
    );
  });
}

test('does not mutate the response or its trip objects', () => {
  const response = Object.freeze({
    trip: Object.freeze({ legs: Object.freeze([Object.freeze({ shape: 'synthetic' })]) }),
    alternates: Object.freeze([Object.freeze({ trip: Object.freeze({ legs: Object.freeze([Object.freeze({})]) }) })])
  });
  const before = JSON.stringify(response);
  normalizeRouteOptionsResponse(response);
  assert.equal(JSON.stringify(response), before);
});

const BOSS_URL = new URL('../boss.html', import.meta.url);
const BOSS_SOURCE = process.env.ROUTE_OPTIONS_BOSS_SOURCE
  ? readFileSync(process.env.ROUTE_OPTIONS_BOSS_SOURCE, 'utf8')
  : readFileSync(BOSS_URL, 'utf8');

class FakeElement {
  constructor(doc, id = '') {
    this.doc = doc;
    this.id = id;
    this.value = '';
    this.placeholder = '';
    this.innerHTML = '';
    this.style = {};
    this.dataset = {};
    this.attrs = {};
    this.listeners = {};
    this.children = [];
    this._text = '';
    const set = new Set();
    this.classList = {
      add: c => set.add(c),
      remove: c => set.delete(c),
      contains: c => set.has(c),
      toggle: (c, on = !set.has(c)) => { if (on) set.add(c); else set.delete(c); return on; }
    };
  }
  get textContent() { return this.children.length ? this.children.map(c => c.textContent).join('\n') : this._text; }
  set textContent(value) { this.children = []; this._text = String(value); }
  replaceChildren(...nodes) { this.children = nodes; this._text = ''; }
  appendChild(node) { this.children.push(node); return node; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  getAttribute(key) { return this.attrs[key] ?? null; }
  focus() { this.doc.activeElement = this; }
  closest(selector) {
    const match = selector.match(/\[data-([a-z-]+)\]/);
    if (!match) return null;
    const key = match[1].replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    return this.dataset[key] != null ? this : null;
  }
  querySelector() { return new FakeElement(this.doc); }
  remove() {}
  scrollIntoView() {}
}

function fakeDocument() {
  const doc = { activeElement: null, visibilityState: 'visible', elements: new Map() };
  doc.getElementById = id => {
    if (!doc.elements.has(id)) {
      const el = new FakeElement(doc, id);
      if (id === 'loginForm') { el.server = new FakeElement(doc); el.password = new FakeElement(doc); }
      doc.elements.set(id, el);
    }
    return doc.elements.get(id);
  };
  doc.querySelectorAll = () => [];
  doc.createElement = () => new FakeElement(doc);
  return doc;
}

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: key => map.has(key) ? map.get(key) : null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key)
  };
}

const jsonResponse = data => ({ status: 200, ok: true, json: async () => data });
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };

async function loadBoss({ storage, routes }) {
  const script = BOSS_SOURCE.slice(
    BOSS_SOURCE.indexOf('<script type="module">') + '<script type="module">'.length,
    BOSS_SOURCE.lastIndexOf('</script>')
  );
  const bindings = {};
  const body = [];
  for (const line of script.split('\n')) {
    const match = line.match(/^import \{([^}]+)\} from '([^']+)';$/);
    if (!match) { body.push(line); continue; }
    const module = await import(new URL(match[2], BOSS_URL));
    for (const part of match[1].split(',')) {
      const [name, alias] = part.trim().split(/\s+as\s+/);
      bindings[alias || name] = module[name];
    }
  }

  const document = fakeDocument();
  const requests = [];
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    requests.push({ path, method: init.method || 'GET' });
    const handler = routes[path];
    return handler ? handler(init) : jsonResponse({});
  };
  const timer = (fn, ms) => { const timerId = setTimeout(fn, ms); timerId.unref?.(); return timerId; };
  const context = vm.createContext({
    ...bindings,
    document,
    window: { scrollTo() {}, open() {} },
    localStorage: storage,
    fetch,
    navigator: {},
    location: { protocol: 'http:', origin: 'http://boss.test', href: 'http://boss.test/boss.html' },
    confirm: () => true,
    prompt: () => null,
    setTimeout: timer,
    clearTimeout,
    setInterval: () => 0,
    console,
    URL,
    JSON,
    Promise,
    Date,
    Math,
    Object,
    Array,
    Number,
    String,
    Error,
    Set,
    Map
  });
  const probe = `
globalThis.__boss = {
  S, get pts() { return pts; }, get geom() { return geom; },
  get geomOrigin() { return typeof geomOrigin === 'undefined' ? undefined : geomOrigin; },
  get routeAlternatives() { return routeAlternatives; }, ctl: routeOptionsCtl
};`;
  vm.runInContext(body.join('\n') + probe, context, { filename: 'boss.html#inline' });
  await settle();

  const $ = id => document.getElementById(id);
  const fire = async (id, type = 'click', target) => {
    const el = $(id);
    const event = { target: target || el, preventDefault() {}, key: '' };
    const result = el['on' + type]?.(event);
    const settled = result && typeof result.then === 'function'
      ? result.then(value => ({ value }), error => ({ error }))
      : { value: result };
    for (const fn of el.listeners[type] || []) fn(event);
    await settle();
    const outcome = await settled;
    if (outcome.error) throw outcome.error;
    return outcome.value;
  };
  return {
    boss: context.__boss,
    $,
    fire,
    requests,
    storage,
    instrumentRouteEffects() {
      vm.runInContext(`
        globalThis.__routeEffects = { saved: 0, drawn: 0, selected: 0 };
        const originalSaveDraft = saveDraft;
        saveDraft = (...args) => { __routeEffects.saved++; return originalSaveDraft(...args); };
        const originalDrawRoute = drawRoute;
        drawRoute = (...args) => { __routeEffects.drawn++; return originalDrawRoute(...args); };
        const originalMarkProviderSelected = routeOptionsCtl.markProviderSelected.bind(routeOptionsCtl);
        routeOptionsCtl.markProviderSelected = (...args) => {
          __routeEffects.selected++;
          return originalMarkProviderSelected(...args);
        };
      `, context);
      return vm.runInContext('__routeEffects', context);
    }
  };
}

const BASE_ROUTES = {
  '/api/health': () => jsonResponse({ ok: true }),
  '/api/me': () => jsonResponse({ user: { id: 1, name: 'Synthetic owner', role: 'owner' }, company: { id: 1, name: 'Synthetic Co' } }),
  '/api/drivers': () => jsonResponse({ drivers: [] }),
  '/api/routes': () => jsonResponse({ routes: [] })
};
const LOGGED_IN = () => memoryStorage({ boss_server: 'http://boss.test', boss_token: 'synthetic-token' });
const FORM_VALUES = { heightM: '4.1', widthM: '2.55', lengthM: '16.5', grossWeightT: '40', axleLoadT: '11.5', axleCount: '5' };
const ENCODED_SHAPE = (() => {
  const encodeOne = value => {
    value = value < 0 ? ~(value << 1) : value << 1;
    let out = '';
    while (value >= 0x20) {
      out += String.fromCharCode((0x20 | (value & 0x1f)) + 63);
      value >>= 5;
    }
    return out + String.fromCharCode(value + 63);
  };
  let out = '', previousLat = 0, previousLon = 0;
  for (const [lat, lon] of [[42.7, 23.3], [43, 25], [43.2, 27.9]]) {
    const nextLat = Math.round(lat * 1e6), nextLon = Math.round(lon * 1e6);
    out += encodeOne(nextLat - previousLat) + encodeOne(nextLon - previousLon);
    previousLat = nextLat;
    previousLon = nextLon;
  }
  return out;
})();
const ROUTER_ANSWER = { trip: { legs: [{ shape: ENCODED_SHAPE }], summary: { length: 401, time: 18600 } } };

async function prepareBoss(kind, malformedAlternates) {
  let calls = 0;
  const page = await loadBoss({
    storage: LOGGED_IN(),
    routes: {
      ...BASE_ROUTES,
      '/api/route-options': () => {
        calls += 1;
        if (calls === 1 || calls === 3) return jsonResponse(ROUTER_ANSWER);
        return jsonResponse({ trip: ROUTER_ANSWER.trip, alternates: malformedAlternates });
      }
    }
  });
  for (const point of ['42.7, 23.3', '43.2, 27.9']) {
    page.$('coords').value = point;
    await page.fire('coordsBtn');
  }
  for (const field of PROFILE_FIELDS) {
    page.$(field.inputId).value = field.kind === 'choice' ? 'no' : FORM_VALUES[field.key];
    await page.fire(field.inputId, field.kind === 'choice' ? 'change' : 'input');
  }

  if (kind === 'manual') {
    await page.fire('drawRoute');
    await page.fire('drawRoute');
  }
  await page.fire('routeOptions');
  assert.equal(page.boss.routeAlternatives.length, 1, 'valid setup response renders an option');
  if (kind === 'provider') {
    await page.fire('routeOptionsList', 'click', page.$('routeOptionsList').children[0]);
    assert.equal(page.boss.geomOrigin, 'provider');
    assert.equal(page.boss.geom.length, 3);
  } else {
    assert.equal(page.boss.geomOrigin, 'manual');
    assert.equal(page.boss.geom.length, 2);
  }
  return page;
}

test('boss.html (executed): a malformed stale response is ignored', async () => {
  let resolveResponse;
  const page = await loadBoss({
    storage: LOGGED_IN(),
    routes: {
      ...BASE_ROUTES,
      '/api/route-options': () => new Promise(resolve => { resolveResponse = resolve; })
    }
  });
  for (const point of ['42.7, 23.3', '43.2, 27.9']) {
    page.$('coords').value = point;
    await page.fire('coordsBtn');
  }
  for (const field of PROFILE_FIELDS) {
    page.$(field.inputId).value = field.kind === 'choice' ? 'no' : FORM_VALUES[field.key];
    await page.fire(field.inputId, field.kind === 'choice' ? 'change' : 'input');
  }

  const request = page.$('routeOptions').onclick();
  await settle();
  assert.equal(page.boss.ctl.getState().pending, true);
  page.$('coords').value = '42.5, 23.1';
  await page.fire('coordsBtn');
  assert.equal(page.$('routeOptionsList').textContent, '');
  resolveResponse(jsonResponse({ trip: ROUTER_ANSWER.trip, alternates: { privateMarker: 'secret' } }));
  await request;
  assert.equal(page.$('routeOptionsList').textContent, '');
  assert.equal(page.boss.routeAlternatives.length, 0);
  assert.equal(page.boss.ctl.getState().pending, false);
});

for (const [badAlternates, label] of [
  [{}, 'object alternates'],
  [[null], 'null alternate'],
  [[{ trip: DIRECT }, { trip: DIRECT }, { trip: DIRECT }], 'over-limit alternates']
]) {
  for (const kind of ['manual', 'provider']) {
    test(`boss.html (executed): malformed ${label} preserves prior ${kind} geometry and permits retry`, async () => {
      const page = await prepareBoss(kind, badAlternates);
      const previousGeometry = page.boss.geom;
      const previousOrigin = page.boss.geomOrigin;
      const previousStorage = [...page.storage.map.keys()].sort();
      const storageBefore = [...page.storage.map.entries()];
      const priorOption = page.$('routeOptionsList').children[0];
      const effects = page.instrumentRouteEffects();

      await page.fire('routeOptions');

      assert.equal(page.boss.ctl.getState().pending, false);
      assert.equal(page.boss.routeAlternatives.length, 0);
      assert.equal(page.$('routeOptionsList').textContent, ROUTE_OPTIONS_RESPONSE_ERROR_MESSAGE);
      assert.equal(page.$('routeOptionsList').children.length, 0, 'no old option remains selectable');
      assert.strictEqual(page.boss.geom, previousGeometry);
      assert.equal(page.boss.geomOrigin, previousOrigin);
      assert.deepEqual([...page.storage.map.keys()].sort(), previousStorage);
      assert.deepEqual([...page.storage.map.entries()], storageBefore);
      assert.deepEqual({ ...effects }, { saved: 0, drawn: 0, selected: 0 });

      await page.fire('routeOptions');
      assert.equal(page.boss.routeAlternatives.length, 1, 'valid retry renders a fresh option');
      assert.equal(page.$('routeOptionsList').children.length, 1);
      assert.notStrictEqual(page.$('routeOptionsList').children[0], priorOption);
      await page.fire('routeOptionsList', 'click', page.$('routeOptionsList').children[0]);
      assert.equal(page.boss.geomOrigin, 'provider');
      assert.equal(page.boss.geom.length, 3, 'valid retry remains selectable');
      assert.deepEqual({ ...effects }, { saved: 1, drawn: 1, selected: 1 });
      assert.equal(page.requests.filter(request => request.path === '/api/route-options').length, 3);
    });
  }
}
