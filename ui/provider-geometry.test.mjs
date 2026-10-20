import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { MAX_GEOMETRY_POINTS, decodePolyline6 } from '../engine/route.js';
import { ProviderGeometryError, providerGeometry } from './provider-geometry.mjs';
import { PROFILE_FIELDS } from './truck-profile-input.mjs';

const BOSS_URL = new URL('../boss.html', import.meta.url);
const BOSS_SOURCE = process.env.PROVIDER_GEOMETRY_BOSS_SOURCE
  ? readFileSync(process.env.PROVIDER_GEOMETRY_BOSS_SOURCE, 'utf8')
  : readFileSync(BOSS_URL, 'utf8');

function encodeLine(count, offset = 0) {
  let text = '', lastLat = 0, lastLon = 0;
  const encode = value => {
    let v = value < 0 ? ~(value << 1) : value << 1, out = '';
    while (v >= 0x20) { out += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return out + String.fromCharCode(v + 63);
  };
  for (let i = 0; i < count; i++) {
    const lat = offset + (i % 2 ? 1000 : 0), lon = i * 1000;
    text += encode(lat - lastLat) + encode(lon - lastLon);
    lastLat = lat; lastLon = lon;
  }
  return text;
}

const TWO_POINT_SHAPE = encodeLine(2);
const MAX_POINT_SHAPE = encodeLine(MAX_GEOMETRY_POINTS);
const coords = points => points.map(({ lat, lon }) => [lat, lon]);
const invalidCode = trip => {
  try { providerGeometry(trip); } catch (error) {
    assert.ok(error instanceof ProviderGeometryError);
    return error.code;
  }
  return 'accepted';
};

test('provider geometry uses the engine decoder and joins valid legs without duplicating a junction', () => {
  const first = [{ shape: TWO_POINT_SHAPE }, { shape: encodeLine(2, 1000) }];
  const line = providerGeometry({ legs: first });
  assert.deepEqual(line, [...decodePolyline6(first[0].shape), ...decodePolyline6(first[1].shape).slice(1)]);
  assert.equal(line.length, 3);
  assert.deepEqual(providerGeometry({ legs: [{ shape: MAX_POINT_SHAPE }] }).length, MAX_GEOMETRY_POINTS);
});

test('the whole trip is rejected for invalid trip and leg structures', () => {
  const cases = [
    null, undefined, [], {}, { legs: null }, { legs: {} }, { legs: [] },
    { legs: [null] }, { legs: [7] }, { legs: [{}] },
    { legs: [{ shape: '' }] }, { legs: [{ shape: 0 }] }, { legs: [{ shape: null }] },
    { legs: [{ shape: [] }] }, { legs: [{ shape: {} }] }, { legs: [{ shape: TWO_POINT_SHAPE }, {}] },
    { legs: [{ shape: TWO_POINT_SHAPE }, { shape: '' }] },
    { legs: [{ shape: TWO_POINT_SHAPE }, { shape: 0 }] },
    { legs: [{ shape: TWO_POINT_SHAPE }, { shape: null }] },
    { legs: [{ shape: TWO_POINT_SHAPE }, { shape: '?' }] },
    { legs: [{ shape: '?' }, {}] }
  ];
  for (let i = 0; i < cases.length; i++) assert.equal(invalidCode(cases[i]), 'INVALID_GEOMETRY', `invalid trip case ${i + 1}`);
});

test('all geometry failures have bounded errors and aggregate overflow is refused whole', () => {
  const malformed = invalidCode({ legs: [{ shape: '?' }] });
  assert.equal(malformed, 'INVALID_GEOMETRY');
  assert.throws(() => providerGeometry({ legs: [{ shape: '?' }] }), error => {
    assert.equal(error.message, 'Маршрутизаторът върна невалидна геометрия.');
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.throws(() => providerGeometry({ legs: [{ shape: MAX_POINT_SHAPE }, { shape: MAX_POINT_SHAPE }] }), error => {
    assert.equal(error.code, 'TOO_MANY_POINTS');
    assert.equal(error.message, `Маршрутът надхвърля лимита от ${MAX_GEOMETRY_POINTS} точки.`);
    assert.equal(error.cause, undefined);
    return true;
  });
});

class FakeElement {
  constructor(doc, id = '') {
    this.doc = doc; this.id = id; this.value = ''; this.placeholder = ''; this.innerHTML = ''; this.style = {};
    this.dataset = {}; this.attrs = {}; this.listeners = {}; this.children = []; this._text = '';
    const set = new Set();
    this.classList = { add: c => set.add(c), remove: c => set.delete(c), contains: c => set.has(c),
      toggle: (c, on = !set.has(c)) => { if (on) set.add(c); else set.delete(c); return on; } };
  }
  get textContent() { return this.children.length ? this.children.map(c => c.textContent).join('\n') : this._text; }
  set textContent(v) { this.children = []; this._text = String(v); }
  replaceChildren(...nodes) { this.children = nodes; this._text = ''; }
  appendChild(node) { this.children.push(node); return node; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  focus() { this.doc.activeElement = this; }
  closest(selector) {
    const match = selector.match(/\[data-([a-z-]+)\]/);
    if (!match) return null;
    const key = match[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
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
      const element = new FakeElement(doc, id);
      if (id === 'loginForm') { element.server = new FakeElement(doc); element.password = new FakeElement(doc); }
      doc.elements.set(id, element);
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

const jsonResponse = (data, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };

async function loadBoss({ storage, routes = {} }) {
  const script = BOSS_SOURCE.slice(BOSS_SOURCE.indexOf('<script type="module">') + '<script type="module">'.length,
    BOSS_SOURCE.lastIndexOf('</script>'));
  const bindings = {}, body = [];
  for (const line of script.split('\n')) {
    const match = line.match(/^import \{([^}]+)\} from '([^']+)';$/);
    if (!match) { body.push(line); continue; }
    const mod = await import(new URL(match[2], BOSS_URL));
    for (const part of match[1].split(',')) {
      const [name, alias] = part.trim().split(/\s+as\s+/);
      bindings[alias || name] = mod[name];
    }
  }
  const document = fakeDocument(), requests = [];
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    requests.push({ path, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    const handler = routes[path];
    return handler ? handler(init) : jsonResponse({ detail: 'not mocked' }, 404);
  };
  const timer = (fn, ms) => { const handle = setTimeout(fn, ms); handle.unref?.(); return handle; };
  const context = vm.createContext({
    ...bindings, document, window: { scrollTo() {}, open() {} }, localStorage: storage, fetch,
    navigator: {}, location: { protocol: 'http:', origin: 'http://boss.test', href: 'http://boss.test/boss.html' },
    confirm: () => true, prompt: () => null, setTimeout: timer, clearTimeout, setInterval: () => 0,
    console, URL, JSON, Promise, Date, Math, Object, Array, Number, String, Error, Set, Map
  });
  const probe = `
const __selectionMetrics = { saves: 0, draws: 0, marks: 0, manualMarks: 0 };
const __saveDraft = saveDraft;
saveDraft = (...args) => { __selectionMetrics.saves++; return __saveDraft(...args); };
const __drawRoute = drawRoute;
drawRoute = (...args) => { __selectionMetrics.draws++; return __drawRoute(...args); };
const __markProviderSelected = routeOptionsCtl.markProviderSelected.bind(routeOptionsCtl);
routeOptionsCtl.markProviderSelected = (...args) => { __selectionMetrics.marks++; return __markProviderSelected(...args); };
const __markManualGeometry = routeOptionsCtl.markManualGeometry.bind(routeOptionsCtl);
routeOptionsCtl.markManualGeometry = (...args) => { __selectionMetrics.manualMarks++; return __markManualGeometry(...args); };
globalThis.__boss = {
  S, store, get pts() { return pts; }, get geom() { return geom; },
  get geomOrigin() { return typeof geomOrigin === 'undefined' ? undefined : geomOrigin; },
  get routeAlternatives() { return routeAlternatives; }, ctl: routeOptionsCtl, metrics: __selectionMetrics
};`;
  vm.runInContext(body.join('\n') + probe, context, { filename: 'boss.html#inline' });
  await settle();
  const $ = id => document.getElementById(id);
  const fire = async (id, type = 'click', target) => {
    const element = $(id);
    const event = { target: target || element, preventDefault() {}, key: '' };
    const result = element['on' + type]?.(event);
    for (const listener of element.listeners[type] || []) listener(event);
    await settle();
    return result;
  };
  return { boss: context.__boss, $, fire, requests };
}

const BASE_ROUTES = {
  '/api/health': () => jsonResponse({ ok: true }),
  '/api/me': () => jsonResponse({ user: { id: 1, name: 'Synthetic owner', role: 'owner' }, company: { id: 1, name: 'Synthetic Co' } }),
  '/api/drivers': () => jsonResponse({ drivers: [] }),
  '/api/routes': () => jsonResponse({ routes: [] })
};
const loggedIn = () => memoryStorage({ boss_server: 'http://boss.test', boss_token: 'synthetic-token' });
const FORM = { heightM: '4,1', widthM: '2.55', lengthM: '16.5', grossWeightT: '40', axleLoadT: '11.5', axleCount: '5', hazmat: 'no' };
const FORM_VALUES = { heightM: '4,1', widthM: '2.55', lengthM: '16.5', grossWeightT: '40', axleLoadT: '11.5', axleCount: '5', hazmat: 'no' };
const formField = Object.fromEntries(PROFILE_FIELDS.map(field => [field.inputId, FORM_VALUES[field.key]]));

async function addTwoPoints(page) {
  for (const value of ['42.7, 23.3', '43.2, 27.9']) {
    page.$('coords').value = value;
    await page.fire('coordsBtn');
  }
}

async function fillProfile(page) {
  for (const field of PROFILE_FIELDS) {
    page.$(field.inputId).value = formField[field.inputId];
    await page.fire(field.inputId, field.kind === 'choice' ? 'change' : 'input');
  }
}

async function readyPage(answer) {
  const page = await loadBoss({
    storage: loggedIn(),
    routes: { ...BASE_ROUTES, '/api/route-options': () => jsonResponse(answer) }
  });
  await addTwoPoints(page);
  await fillProfile(page);
  return page;
}

async function makeManualLine(page) {
  await page.fire('drawRoute');
  await page.fire('drawRoute');
  assert.equal(page.boss.geom.length, 2);
  assert.equal(page.boss.geomOrigin, 'manual');
}

function assertFailedSelectionUnchanged(page, storageSnapshot, stateSnapshot, expectedMessage) {
  assert.equal(page.boss.geom.length, stateSnapshot.geometryValues.length, 'failed selection preserves geometry size');
  assert.match(page.$('routeErr').textContent, expectedMessage);
  assert.strictEqual(page.boss.geom, stateSnapshot.geometry, 'geometry array identity is preserved');
  assert.deepEqual(coords(page.boss.geom), stateSnapshot.geometryValues);
  assert.equal(page.boss.geomOrigin, stateSnapshot.origin);
  assert.equal(page.boss.ctl.getState().providerSelected, stateSnapshot.providerSelected);
  assert.equal(page.$('rKm').textContent, stateSnapshot.routeSummary);
  assert.equal(page.$('pts').innerHTML, stateSnapshot.waypoints);
  assert.equal(page.$('routeOptionsList').textContent, stateSnapshot.options);
  for (const [key, value] of Object.entries(storageSnapshot)) assert.equal(page.boss.store.get(key), value, key);
  assert.deepEqual({ ...page.boss.metrics }, { saves: 0, draws: 0, marks: 0, manualMarks: 0 });
}

const badLegs = [
  [{ shape: '????' }, {}],
  [{ shape: TWO_POINT_SHAPE }, { shape: '' }],
  [{ shape: TWO_POINT_SHAPE }, { shape: 0 }],
  [{ shape: TWO_POINT_SHAPE }, { shape: '?' }]
];

for (const prior of ['manual', 'provider']) {
  test(`boss selector rejects aggregate overflow atomically with a prior ${prior} line`, async () => {
    const overLimit = { legs: [{ shape: MAX_POINT_SHAPE }, { shape: MAX_POINT_SHAPE }] };
    const answer = prior === 'provider'
      ? { trip: { legs: [{ shape: TWO_POINT_SHAPE }] }, alternates: [{ trip: overLimit }] }
      : { trip: overLimit };
    const page = await readyPage(answer);
    if (prior === 'manual') await makeManualLine(page);
    else {
      await page.fire('routeOptions');
      await page.fire('routeOptionsList', 'click', page.$('routeOptionsList').children[0]);
      assert.equal(page.boss.geomOrigin, 'provider');
    }
    await page.fire('routeOptions');
    const optionIndex = prior === 'provider' ? 1 : 0;
    const storageSnapshot = Object.fromEntries(['boss_route_geometry', 'boss_route_draft', 'boss_route_name', 'boss_route_notes']
      .map(key => [key, page.boss.store.get(key)]));
    const stateSnapshot = {
      geometry: page.boss.geom, geometryValues: coords(page.boss.geom), origin: page.boss.geomOrigin,
      providerSelected: page.boss.ctl.getState().providerSelected,
      routeSummary: page.$('rKm').textContent, waypoints: page.$('pts').innerHTML,
      options: page.$('routeOptionsList').textContent
    };
    page.boss.metrics.saves = page.boss.metrics.draws = page.boss.metrics.marks = 0;
    page.boss.metrics.manualMarks = 0;
    await assert.doesNotReject(() => page.fire('routeOptionsList', 'click', page.$('routeOptionsList').children[optionIndex]));
    assertFailedSelectionUnchanged(page, storageSnapshot, stateSnapshot, /Вариантът не може да бъде избран: Маршрутът надхвърля лимита от 20000 точки\./);
  });
}

for (const prior of ['manual', 'provider']) {
  for (let i = 0; i < badLegs.length; i++) {
    const legs = badLegs[i];
    test(`boss selector rejects valid geometry followed by invalid leg ${i + 1} with a prior ${prior} line`, async () => {
    const badTrip = { legs };
    const answer = prior === 'provider'
      ? { trip: { legs: [{ shape: TWO_POINT_SHAPE }] }, alternates: [{ trip: badTrip }] }
      : { trip: badTrip };
    const page = await readyPage(answer);
    if (prior === 'manual') await makeManualLine(page);
    await page.fire('routeOptions');
    const optionIndex = prior === 'provider' ? 1 : 0;
    if (prior === 'provider') {
      await page.fire('routeOptionsList', 'click', page.$('routeOptionsList').children[0]);
      assert.equal(page.boss.geomOrigin, 'provider');
      await page.fire('routeOptions');
    }
    const storageSnapshot = Object.fromEntries(['boss_route_geometry', 'boss_route_draft', 'boss_route_name', 'boss_route_notes']
      .map(key => [key, page.boss.store.get(key)]));
    const stateSnapshot = {
      geometry: page.boss.geom, geometryValues: coords(page.boss.geom), origin: page.boss.geomOrigin,
      providerSelected: page.boss.ctl.getState().providerSelected,
      routeSummary: page.$('rKm').textContent, waypoints: page.$('pts').innerHTML,
      options: page.$('routeOptionsList').textContent
    };
    page.boss.metrics.saves = page.boss.metrics.draws = page.boss.metrics.marks = 0;
    page.boss.metrics.manualMarks = 0;
    await assert.doesNotReject(() => page.fire('routeOptionsList', 'click', page.$('routeOptionsList').children[optionIndex]));
    assertFailedSelectionUnchanged(page, storageSnapshot, stateSnapshot, /Вариантът не може да бъде избран: Маршрутизаторът върна невалидна геометрия\./);
    });
  }
}

test('boss selector never renders an unexpected error.message', () => {
  const selector = BOSS_SOURCE.slice(BOSS_SOURCE.indexOf("$('routeOptionsList').onclick"), BOSS_SOURCE.indexOf("$('shareRoute').onclick"));
  assert.match(selector, /error instanceof ProviderGeometryError/);
  assert.match(selector, /Геометрията на варианта не може да бъде избрана\./);
  assert.match(selector, /error\.message : 'Геометрията на варианта не може да бъде избрана\.'/);
});

test('boss selector still selects a valid multileg route', async () => {
  const answer = { trip: { legs: [{ shape: TWO_POINT_SHAPE }, { shape: encodeLine(2, 1000) }], summary: { length: 401, time: 18600 } } };
  const page = await readyPage(answer);
  await page.fire('routeOptions');
  page.boss.metrics.saves = page.boss.metrics.draws = page.boss.metrics.marks = 0;
  await page.fire('routeOptionsList', 'click', page.$('routeOptionsList').children[0]);
  assert.equal(page.boss.geom.length, 3);
  assert.equal(page.boss.geomOrigin, 'provider');
  assert.equal(page.boss.ctl.getState().providerSelected, true);
  assert.deepEqual({ ...page.boss.metrics }, { saves: 1, draws: 1, marks: 1, manualMarks: 0 });
  assert.match(page.$('routeErr').textContent, /Избран е вариант 1/);
});

test('boss selector accepts exactly the engine geometry limit', async () => {
  const page = await readyPage({ trip: { legs: [{ shape: MAX_POINT_SHAPE }] }, summary: { length: 401, time: 18600 } });
  await page.fire('routeOptions');
  await page.fire('routeOptionsList', 'click', page.$('routeOptionsList').children[0]);
  assert.equal(page.boss.geom.length, MAX_GEOMETRY_POINTS);
  assert.equal(page.boss.geomOrigin, 'provider');
  assert.equal(page.boss.ctl.getState().providerSelected, true);
});
