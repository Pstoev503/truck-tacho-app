import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PROFILE_FIELDS, createRouteOptionsController, parseTruckProfile, routeOptionsBody
} from './truck-profile-input.mjs';

// Synthetic values only.
const FORM = Object.freeze({
  heightM: '4', widthM: '2.55', lengthM: '16,5', grossWeightT: '40', axleLoadT: '11.5', axleCount: '5', hazmat: 'no'
});
const PROFILE = { heightM: 4, widthM: 2.55, lengthM: 16.5, grossWeightT: 40, axleLoadT: 11.5, axleCount: 5, hazmat: false };
const POINTS = Object.freeze([
  Object.freeze({ lat: 42.7, lon: 23.3, label: 'Synthetic start' }),
  Object.freeze({ lat: 43.2, lon: 27.9, label: 'Synthetic end' })
]);
const codes = result => result.ok ? [] : result.errors.map(e => `${e.field}:${e.code}`);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const recorder = () => {
  const calls = [];
  const request = body => { const d = deferred(); calls.push({ body, ...d }); return d.promise; };
  return { calls, request };
};

test('a complete form maps to exactly the seven contract fields with JSON types and no unit conversion', () => {
  const result = parseTruckProfile(FORM);
  assert.equal(result.ok, true);
  assert.deepEqual(result.profile, PROFILE);
  assert.deepEqual(Object.keys(result.profile), ['heightM', 'widthM', 'lengthM', 'grossWeightT', 'axleLoadT', 'axleCount', 'hazmat']);
  assert.equal(JSON.stringify(result.profile),
    '{"heightM":4,"widthM":2.55,"lengthM":16.5,"grossWeightT":40,"axleLoadT":11.5,"axleCount":5,"hazmat":false}');
  assert.ok(Object.isFrozen(result.profile));
});

test('hazmat “Да” is true and “Не” is false; strings and booleans are not accepted as a choice', () => {
  assert.equal(parseTruckProfile({ ...FORM, hazmat: 'yes' }).profile.hazmat, true);
  assert.equal(parseTruckProfile({ ...FORM, hazmat: 'no' }).profile.hazmat, false);
  for (const hazmat of ['', 'false', 'true', '0', '1', 'Yes', 'да', true, false, 0, 1, null, undefined]) {
    assert.deepEqual(codes(parseTruckProfile({ ...FORM, hazmat })), ['hazmat:CHOOSE'], String(hazmat));
  }
});

test('measurements keep integer vs decimal values and metres / tonnes as typed', () => {
  const p = parseTruckProfile({ ...FORM, heightM: '3', widthM: '2.5', lengthM: '0.5', grossWeightT: '7.49', axleLoadT: '7.49' }).profile;
  assert.deepEqual([p.heightM, p.widthM, p.lengthM, p.grossWeightT, p.axleLoadT], [3, 2.5, 0.5, 7.49, 7.49]);
  assert.ok(Number.isInteger(p.heightM) && !Number.isInteger(p.widthM));
  // a comma is a decimal separator, the same as a point; surrounding spaces are trimmed
  assert.equal(parseTruckProfile({ ...FORM, heightM: ' 4,1 ' }).profile.heightM, 4.1);
  // large values are not capped: there are no invented legal maxima
  assert.equal(parseTruckProfile({ ...FORM, grossWeightT: '1000', axleLoadT: '999' }).profile.grossWeightT, 1000);
});

test('every missing or empty field is reported by name, in field order, and no profile is returned', () => {
  for (const field of PROFILE_FIELDS) {
    const withoutKey = { ...FORM };
    delete withoutKey[field.key];
    const expected = field.kind === 'choice' ? 'CHOOSE' : 'REQUIRED';
    assert.deepEqual(codes(parseTruckProfile(withoutKey)), [`${field.key}:${expected}`], `missing ${field.key}`);
    assert.deepEqual(codes(parseTruckProfile({ ...FORM, [field.key]: field.kind === 'choice' ? '' : '   ' })),
      [`${field.key}:${expected}`], `empty ${field.key}`);
  }
  const empty = parseTruckProfile({});
  assert.equal(empty.ok, false);
  assert.equal(empty.profile, undefined);
  assert.deepEqual(empty.errors.map(e => e.field), PROFILE_FIELDS.map(f => f.key));
  assert.ok(empty.errors.every(e => typeof e.message === 'string' && e.message.length > 0));
  for (const form of [null, undefined, 'x', 42]) assert.equal(parseTruckProfile(form).errors.length, 7);
});

test('a partial form is refused even when all filled fields are valid', () => {
  const partial = parseTruckProfile({ heightM: '4', widthM: '2.5', lengthM: '16' });
  assert.deepEqual(codes(partial), ['grossWeightT:REQUIRED', 'axleLoadT:REQUIRED', 'axleCount:REQUIRED', 'hazmat:CHOOSE']);
});

test('invalid measurement text is refused without partial parsing', () => {
  const cases = {
    NOT_A_NUMBER: ['4m', '4 m', '4.1.2', '4,1,2', '1e3', '0x10', '+4', '-4', '.5', '5.', 'NaN', 'Infinity', '-Infinity',
      'true', 'false', '4 1', '٤', '4;1'],
    NOT_POSITIVE: ['0', '0.0', '000', '0,00'],
    TOO_PRECISE: ['1234567890123456', '4.0000000000000001', '9'.repeat(400)]
  };
  for (const [code, values] of Object.entries(cases)) {
    for (const heightM of values) {
      assert.deepEqual(codes(parseTruckProfile({ ...FORM, heightM })), [`heightM:${code}`], JSON.stringify(heightM));
    }
  }
  // non-string inputs are not coerced
  for (const heightM of [4, 4.1, true, null, {}, ['4']]) {
    assert.deepEqual(codes(parseTruckProfile({ ...FORM, heightM })), ['heightM:REQUIRED'], JSON.stringify(heightM));
  }
});

test('axle count must be a positive safe integer typed as digits only', () => {
  for (const axleCount of ['5.0', '5,0', '4.5', '1e1', '-5', '+5', '5 оси', 'true']) {
    assert.deepEqual(codes(parseTruckProfile({ ...FORM, axleCount })), ['axleCount:NOT_AN_INTEGER'], axleCount);
  }
  assert.deepEqual(codes(parseTruckProfile({ ...FORM, axleCount: '0' })), ['axleCount:NOT_POSITIVE']);
  assert.deepEqual(codes(parseTruckProfile({ ...FORM, axleCount: '9007199254740992' })), ['axleCount:NOT_SAFE_INTEGER']);
  assert.equal(parseTruckProfile({ ...FORM, axleCount: '9007199254740991' }).profile.axleCount, Number.MAX_SAFE_INTEGER);
  assert.equal(parseTruckProfile({ ...FORM, axleCount: ' 007 ' }).profile.axleCount, 7);
});

test('axle load above the gross weight is refused; equal is allowed; no cross error when one side is invalid', () => {
  assert.deepEqual(codes(parseTruckProfile({ ...FORM, grossWeightT: '10', axleLoadT: '10.01' })), ['axleLoadT:AXLE_OVER_GROSS']);
  assert.equal(parseTruckProfile({ ...FORM, grossWeightT: '10', axleLoadT: '10' }).ok, true);
  assert.deepEqual(codes(parseTruckProfile({ ...FORM, grossWeightT: '', axleLoadT: '50' })), ['grossWeightT:REQUIRED']);
  assert.deepEqual(codes(parseTruckProfile({ ...FORM, grossWeightT: '10', axleLoadT: 'x' })), ['axleLoadT:NOT_A_NUMBER']);
});

test('frozen input is accepted and unchanged; each call returns a new independent profile', () => {
  const snapshot = JSON.stringify(FORM);
  const a = parseTruckProfile(FORM), b = parseTruckProfile(FORM);
  assert.equal(JSON.stringify(FORM), snapshot);
  assert.notEqual(a.profile, b.profile);
  assert.deepEqual(a.profile, b.profile);
  // extra keys in the form are not copied into the profile
  const extra = parseTruckProfile({ ...FORM, provider: 'x', ignore_access: 'true', costing_options: '{}' });
  assert.deepEqual(Object.keys(extra.profile), PROFILE_FIELDS.map(f => f.key));
});

test('the request body has exactly origin, destination and truckProfile, all as copies', () => {
  const profile = parseTruckProfile(FORM).profile;
  const body = routeOptionsBody(POINTS, profile);
  assert.deepEqual(Object.keys(body), ['origin', 'destination', 'truckProfile']);
  assert.deepEqual(body, {
    origin: { lat: 42.7, lon: 23.3, label: 'Synthetic start' },
    destination: { lat: 43.2, lon: 27.9, label: 'Synthetic end' },
    truckProfile: PROFILE
  });
  assert.notEqual(body.origin, POINTS[0]);
  assert.notEqual(body.truckProfile, profile);
  body.origin.lat = 0;
  body.truckProfile.hazmat = true;
  assert.equal(POINTS[0].lat, 42.7);
  assert.equal(profile.hazmat, false);
  assert.equal(routeOptionsBody([{ lat: 1, lon: 2 }, { lat: 3, lon: 4, label: 7 }], profile).destination.label, '');
});

test('an invalid or missing profile, wrong points or no login make no request', async () => {
  let calls = 0;
  const ctl = createRouteOptionsController({ request: async () => { calls += 1; return {}; } });
  const cases = [
    [{ points: POINTS, form: {}, loggedIn: true }, 'PROFILE'],
    [{ points: POINTS, form: { ...FORM, hazmat: '' }, loggedIn: true }, 'PROFILE'],
    [{ points: POINTS, form: { ...FORM, axleLoadT: '41' }, loggedIn: true }, 'PROFILE'],
    [{ points: POINTS, form: undefined, loggedIn: true }, 'PROFILE'],
    [{ points: [POINTS[0]], form: FORM, loggedIn: true }, 'POINTS'],
    [{ points: [...POINTS, POINTS[0]], form: FORM, loggedIn: true }, 'POINTS'],
    [{ points: [POINTS[0], { lat: NaN, lon: 1 }], form: FORM, loggedIn: true }, 'POINTS'],
    [{ points: POINTS, form: FORM, loggedIn: false }, 'LOGIN'],
    [{ points: POINTS, form: FORM }, 'LOGIN']
  ];
  for (const [input, reason] of cases) {
    const outcome = await ctl.requestOptions(input);
    assert.equal(outcome.status, 'invalid');
    assert.equal(outcome.reason, reason);
  }
  assert.equal(calls, 0);
  assert.equal(ctl.getState().generation, 0);
  const profileOutcome = await ctl.requestOptions({ points: POINTS, form: { ...FORM, widthM: '' }, loggedIn: true });
  assert.deepEqual(profileOutcome.errors.map(e => e.field), ['widthM']);
});

test('a valid request sends the exact body once and applies the answer', async () => {
  const { calls, request } = recorder();
  const ctl = createRouteOptionsController({ request });
  const pending = ctl.requestOptions({ points: POINTS, form: FORM, loggedIn: true });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body, { origin: { ...POINTS[0] }, destination: { ...POINTS[1] }, truckProfile: PROFILE });
  assert.equal(ctl.getState().pending, true);
  const data = { trip: { legs: [{}] } };
  calls[0].resolve(data);
  assert.deepEqual(await pending, { status: 'applied', data });
  assert.equal(ctl.getState().pending, false);
});

test('two different profiles produce two different bodies', async () => {
  const { calls, request } = recorder();
  const ctl = createRouteOptionsController({ request });
  ctl.requestOptions({ points: POINTS, form: FORM, loggedIn: true });
  ctl.requestOptions({ points: POINTS, form: { ...FORM, heightM: '3.8', hazmat: 'yes' }, loggedIn: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body.truckProfile.heightM, 4);
  assert.equal(calls[1].body.truckProfile.heightM, 3.8);
  assert.equal(calls[0].body.truckProfile.hazmat, false);
  assert.equal(calls[1].body.truckProfile.hazmat, true);
  assert.notDeepEqual(calls[0].body, calls[1].body);
});

test('an answer that arrives after invalidate() (profile, point, clear, logout) is stale', async () => {
  for (const reason of ['profile', 'points', 'clear', 'open-saved-route', 'logout']) {
    const { calls, request } = recorder();
    const ctl = createRouteOptionsController({ request });
    const pending = ctl.requestOptions({ points: POINTS, form: FORM, loggedIn: true });
    ctl.invalidate();
    assert.equal(ctl.getState().pending, false, reason);
    calls[0].resolve({ trip: { legs: [{}] } });
    assert.deepEqual(await pending, { status: 'stale' }, reason);
  }
});

test('an error that arrives after invalidate() is stale, and a current error is reported', async () => {
  const { calls, request } = recorder();
  const ctl = createRouteOptionsController({ request });
  const old = ctl.requestOptions({ points: POINTS, form: FORM, loggedIn: true });
  ctl.invalidate();
  calls[0].reject(new Error('old failure'));
  assert.deepEqual(await old, { status: 'stale' });
  const current = ctl.requestOptions({ points: POINTS, form: FORM, loggedIn: true });
  const failure = new Error('Маршрутизаторът временно не отговаря');
  calls[1].reject(failure);
  assert.deepEqual(await current, { status: 'error', error: failure });
});

test('a newer request makes the older answer stale even if the older one finishes last', async () => {
  const { calls, request } = recorder();
  const ctl = createRouteOptionsController({ request });
  const first = ctl.requestOptions({ points: POINTS, form: FORM, loggedIn: true });
  const second = ctl.requestOptions({ points: POINTS, form: { ...FORM, widthM: '2.5' }, loggedIn: true });
  calls[1].resolve({ which: 'second' });
  calls[0].resolve({ which: 'first' });
  assert.deepEqual(await second, { status: 'applied', data: { which: 'second' } });
  assert.deepEqual(await first, { status: 'stale' });
});

test('an invalid attempt does not cancel a request that is already running', async () => {
  const { calls, request } = recorder();
  const ctl = createRouteOptionsController({ request });
  const running = ctl.requestOptions({ points: POINTS, form: FORM, loggedIn: true });
  assert.equal((await ctl.requestOptions({ points: POINTS, form: {}, loggedIn: true })).status, 'invalid');
  calls[0].resolve({ ok: 1 });
  assert.equal((await running).status, 'applied');
});

test('a selected provider line is reported once on invalidate; manual geometry is kept', async () => {
  const { calls, request } = recorder();
  const ctl = createRouteOptionsController({ request });
  const pending = ctl.requestOptions({ points: POINTS, form: FORM, loggedIn: true });
  calls[0].resolve({});
  await pending;
  ctl.markProviderSelected();
  // a further request for the same inputs does not forget that a provider line is shown
  ctl.requestOptions({ points: POINTS, form: FORM, loggedIn: true });
  assert.equal(ctl.getState().providerSelected, true);
  assert.deepEqual(ctl.invalidate(), { hadProviderSelection: true });
  assert.deepEqual(ctl.invalidate(), { hadProviderSelection: false });
  ctl.markProviderSelected();
  ctl.markManualGeometry();
  assert.deepEqual(ctl.invalidate(), { hadProviderSelection: false });
});

test('the request keeps copies: changing the original points or form after the call does not change the body', async () => {
  const { calls, request } = recorder();
  const ctl = createRouteOptionsController({ request });
  const points = POINTS.map(p => ({ ...p }));
  const form = { ...FORM };
  ctl.requestOptions({ points, form, loggedIn: true });
  points[0].lat = 1;
  form.heightM = '9';
  assert.equal(calls[0].body.origin.lat, 42.7);
  assert.equal(calls[0].body.truckProfile.heightM, 4);
  assert.throws(() => createRouteOptionsController({}), TypeError);
});

test('the module has no storage, credential, URL or network side effects', async () => {
  const source = readFileSync(fileURLToPath(new URL('./truck-profile-input.mjs', import.meta.url)), 'utf8');
  for (const word of ['localStorage', 'sessionStorage', 'indexedDB', 'document', 'window', 'fetch(', 'XMLHttpRequest',
    'console.', 'location', 'token', 'Authorization', 'http://', 'https://', 'import ']) {
    assert.equal(source.includes(word), false, word);
  }
  const touched = [];
  const trap = name => new Proxy({}, { get: (_t, key) => { touched.push(`${name}.${String(key)}`); return undefined; } });
  const saved = {};
  for (const name of ['localStorage', 'sessionStorage', 'fetch']) { saved[name] = globalThis[name]; globalThis[name] = trap(name); }
  try {
    const ctl = createRouteOptionsController({ request: async () => ({}) });
    await ctl.requestOptions({ points: POINTS, form: FORM, loggedIn: true });
    parseTruckProfile(FORM);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[name]; else globalThis[name] = value;
    }
  }
  assert.deepEqual(touched, []);
});

// boss.html is part of this package; these checks read its markup and script as text.
const BOSS = readFileSync(fileURLToPath(new URL('../boss.html', import.meta.url)), 'utf8');

test('boss.html has seven labelled, empty profile controls with visible units and an explicit hazmat choice', () => {
  for (const field of PROFILE_FIELDS) {
    const tag = BOSS.match(new RegExp(`<(input|select)[^>]*id="${field.inputId}"[^>]*>`));
    assert.ok(tag, field.inputId);
    assert.doesNotMatch(tag[0], /\svalue=/, `${field.inputId} has no preset value`);
    assert.match(tag[0], /autocomplete="off"/, `${field.inputId} is not restored by the browser`);
    assert.match(BOSS, new RegExp(`<label[^>]*for="${field.inputId}"[^>]*>${field.label}[^<]*${field.unit ? `\\(${field.unit.replace('.', '\\.')}\\)` : ''}`),
      `${field.inputId} label with unit`);
  }
  const hazmat = BOSS.match(/<select[^>]*id="tpHazmat"[^>]*>([\s\S]*?)<\/select>/)[1];
  assert.deepEqual([...hazmat.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)</g)].map(m => [m[1], m[2]]),
    [['', 'Избери'], ['no', 'Не'], ['yes', 'Да']]);
  assert.doesNotMatch(hazmat, /selected/);
  for (const field of PROFILE_FIELDS.filter(f => f.kind !== 'choice')) {
    assert.match(BOSS, new RegExp(`id="${field.inputId}"[^>]*type="text"[^>]*inputmode="${field.kind === 'count' ? 'numeric' : 'decimal'}"`));
  }
});

test('boss.html sends truckProfile only through the controller and never stores or links the profile', () => {
  assert.match(BOSS, /import \{[^}]*createRouteOptionsController[^}]*\} from '\.\/ui\/truck-profile-input\.mjs'/);
  assert.equal((BOSS.match(/'\/api\/route-options'/g) || []).length, 1);
  assert.match(BOSS, /api\('\/api\/route-options', \{ method: 'POST', body \}\)/);
  assert.doesNotMatch(BOSS, /origin: pts\[0\], destination: pts\[1\]/);
  for (const field of PROFILE_FIELDS) {
    assert.doesNotMatch(BOSS, new RegExp(`store\\.set\\([^)]*${field.key}`));
    assert.doesNotMatch(BOSS, new RegExp(`store\\.set\\([^)]*${field.inputId}`));
  }
  // storage keys are exactly the ones the page had before; the only direct localStorage use is the store wrapper
  assert.deepEqual([...new Set([...BOSS.matchAll(/store\.(?:set|get)\(([^,)]*)/g)].map(m => m[1]))].sort(),
    ["'boss_app_url'", "'boss_route_draft'", "'boss_route_geometry'", "'boss_route_name'", "'boss_route_notes'", "'boss_server'", "'boss_token'"]);
  assert.equal((BOSS.match(/localStorage/g) || []).length, 3);
  assert.doesNotMatch(BOSS, /sessionStorage|indexedDB|document\.cookie|history\.(?:push|replace)State/);
  // the two existing console.error(e) calls in the driver views stay; nothing logs the profile or the request
  assert.deepEqual(BOSS.match(/console\.[a-z]+\([^)]*\)/g), ['console.error(e)', 'console.error(e)']);
  assert.doesNotMatch(BOSS, /ignore_access|costing_options|VALHALLA_URL|valhalla\.|:8002/);
  // the draft and link keep the same fields; a provider line is written to the draft as []
  assert.match(BOSS, /function saveDraft\(\) \{ store\.set\('boss_route_draft', JSON\.stringify\(pts\)\); store\.set\('boss_route_geometry', JSON\.stringify\(geomOrigin === 'provider' \? \[\] : geom\)\); store\.set\('boss_route_name', \$\('rName'\)\.value\); store\.set\('boss_route_notes', \$\('rNotes'\)\.value\); \}/);
  assert.match(BOSS, /function currentRoute\(\) \{ return cleanRoute\(\{ name: \$\('rName'\)\.value\.trim\(\), notes: \$\('rNotes'\)\.value\.trim\(\), waypoints: pts, geometry: geom \}\); \}/);
});

test('the field list is frozen, in contract order, with metres, tonnes and a count', () => {
  assert.ok(Object.isFrozen(PROFILE_FIELDS) && PROFILE_FIELDS.every(Object.isFrozen));
  assert.deepEqual(PROFILE_FIELDS.map(f => [f.key, f.unit, f.kind]), [
    ['heightM', 'm', 'measure'], ['widthM', 'm', 'measure'], ['lengthM', 'm', 'measure'],
    ['grossWeightT', 't', 'measure'], ['axleLoadT', 't', 'measure'], ['axleCount', 'бр.', 'count'], ['hazmat', '', 'choice']
  ]);
  assert.equal(new Set(PROFILE_FIELDS.map(f => f.inputId)).size, 7);
});

test('every refusal has a plain-language message; several errors are reported together in field order', () => {
  const result = parseTruckProfile({ heightM: 'x', widthM: '0', lengthM: '', grossWeightT: '10', axleLoadT: '12', axleCount: '2.5', hazmat: 'maybe' });
  assert.deepEqual(codes(result), ['heightM:NOT_A_NUMBER', 'widthM:NOT_POSITIVE', 'lengthM:REQUIRED', 'axleCount:NOT_AN_INTEGER',
    'hazmat:CHOOSE', 'axleLoadT:AXLE_OVER_GROSS']);
  for (const error of result.errors) assert.match(error.message, /[А-Яа-я]/);
  assert.equal(new Set(result.errors.map(e => e.message)).size, result.errors.length);
});

test('the pending flag clears on a current answer or error and on invalidate, not on a stale one', async () => {
  const { calls, request } = recorder();
  const ctl = createRouteOptionsController({ request });
  const first = ctl.requestOptions({ points: POINTS, form: FORM, loggedIn: true });
  const second = ctl.requestOptions({ points: POINTS, form: FORM, loggedIn: true });
  calls[0].resolve({});
  await first;
  assert.equal(ctl.getState().pending, true, 'the newer request is still running');
  calls[1].reject(new Error('x'));
  assert.equal((await second).status, 'error');
  assert.equal(ctl.getState().pending, false);
  ctl.requestOptions({ points: POINTS, form: FORM, loggedIn: true });
  ctl.invalidate();
  assert.equal(ctl.getState().pending, false);
});

test('boss.html drops old options on every point change, clear, saved-route load and logout', () => {
  const fn = name => BOSS.slice(BOSS.indexOf(name), BOSS.indexOf('\n', BOSS.indexOf(name)));
  assert.match(BOSS.slice(BOSS.indexOf('function addPoint('), BOSS.indexOf("$('pts').oninput")), /geom = \[\]; dropRouteOptions\(\);/);
  assert.match(BOSS, /m\.on\('dragend', [^\n]*geom = \[\]; dropRouteOptions\(\);/);
  assert.match(BOSS, /else return;\n  geom = \[\]; dropRouteOptions\(\);/);
  assert.match(fn("$('clearRoute').onclick"), /dropRouteOptions\(\)/);
  assert.match(fn('if (e.target.dataset.load)'), /dropRouteOptions\(\)/);
  assert.match(fn('function logoutLocal()'), /clearTruckProfile\(\)/);
  assert.match(BOSS, /function clearTruckProfile\(\) \{ PROFILE_FIELDS\.forEach\(f => \{ \$\(f\.inputId\)\.value = ''; \}\); onProfileChange\(\); \}/);
  // a profile change removes a provider line but keeps manual geometry
  assert.match(BOSS, /if \(dropRouteOptions\(\)\) \{ geom = \[\]; saveDraft\(\); drawRoute\(\);/);
  assert.match(BOSS, /drawing = true; geomOrigin = 'manual'; routeOptionsCtl\.markManualGeometry\(\);/);
  assert.match(BOSS, /geom = shape; drawing = false; geomOrigin = 'provider'; routeOptionsCtl\.markProviderSelected\(\);/);
});

test('boss.html renders options, errors and messages as text and DOM nodes, not raw HTML', () => {
  const block = BOSS.slice(BOSS.indexOf('// ───────── параметри на камиона'), BOSS.indexOf("$('shareRoute').onclick"));
  assert.ok(block.length > 1000);
  assert.doesNotMatch(block, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.match(block, /b\.textContent = `Вариант/);
  assert.match(block, /replaceChildren/);
  // no option is selected automatically
  assert.doesNotMatch(block, /routeAlternatives\[0\]|markProviderSelected\(\);\s*\n\s*renderRouteAlternatives/);
});

// ───────── executable boss.html: the real inline script in a Node vm ─────────
// Minimal DOM, storage and fetch fixtures; no browser, network or Leaflet (window.L is absent).
import vm from 'node:vm';

const BOSS_URL = new URL('../boss.html', import.meta.url);

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
    const m = selector.match(/\[data-([a-z-]+)\]/);
    if (!m) return null;
    const key = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
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
  return { map, getItem: k => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: k => map.delete(k) };
}

const jsonResponse = (data, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => data });

// One page load of boss.html. `routes` answers the API by path; a function may return a promise to defer it.
async function loadBoss({ storage, routes = {}, source }) {
  const html = source ?? readFileSync(BOSS_URL, 'utf8');
  const script = html.slice(html.indexOf('<script type="module">') + '<script type="module">'.length, html.lastIndexOf('</script>'));
  const bindings = {};
  const body = [];
  for (const line of script.split('\n')) {
    const m = line.match(/^import \{([^}]+)\} from '([^']+)';$/);
    if (!m) { body.push(line); continue; }
    const mod = await import(new URL(m[2], BOSS_URL));
    for (const part of m[1].split(',')) {
      const [name, alias] = part.trim().split(/\s+as\s+/);
      bindings[alias || name] = mod[name];
    }
  }
  const document = fakeDocument();
  const requests = [];
  const fetch = async (url, init = {}) => {
    const path = new URL(url).pathname;
    requests.push({ path, method: init.method || 'GET', authorization: init.headers?.Authorization ?? null,
      body: init.body ? JSON.parse(init.body) : undefined });
    const handler = routes[path];
    if (!handler) return jsonResponse({ detail: 'not mocked' }, 404);
    return handler(init);
  };
  const timer = (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; };
  const context = vm.createContext({
    ...bindings, document, window: { scrollTo() {}, open() {} }, localStorage: storage, fetch,
    navigator: {}, location: { protocol: 'http:', origin: 'http://boss.test', href: 'http://boss.test/boss.html' },
    confirm: () => true, prompt: () => null, setTimeout: timer, clearTimeout, setInterval: () => 0,
    console, URL, JSON, Promise, Date, Math, Object, Array, Number, String, Error, Set, Map
  });
  const probe = `
globalThis.__boss = {
  S, store, get pts() { return pts; }, get geom() { return geom; }, get geomOrigin() { return typeof geomOrigin === 'undefined' ? undefined : geomOrigin; },
  get routeAlternatives() { return routeAlternatives; }, ctl: routeOptionsCtl
};`;
  vm.runInContext(body.join('\n') + probe, context, { filename: 'boss.html#inline' });
  await settle();
  const $ = id => document.getElementById(id);
  const fire = async (id, type = 'click', target) => {
    const el = $(id);
    const event = { target: target || el, preventDefault() {}, key: '' };
    const result = el['on' + type]?.(event);
    for (const fn of el.listeners[type] || []) fn(event);
    await settle();
    return result;
  };
  return { boss: context.__boss, $, fire, document, requests };
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

const SHAPE = (() => {
  // polyline6 of three synthetic points
  const enc = points => {
    let out = '', pl = 0, pn = 0;
    const one = v => { v = v < 0 ? ~(v << 1) : v << 1; let s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
    for (const [lat, lon] of points) { const a = Math.round(lat * 1e6), b = Math.round(lon * 1e6); out += one(a - pl) + one(b - pn); pl = a; pn = b; }
    return out;
  };
  return enc([[42.7, 23.3], [43, 25], [43.2, 27.9]]);
})();
const ROUTER_ANSWER = { trip: { legs: [{ shape: SHAPE }], summary: { length: 401, time: 18600 } } };
const BASE_ROUTES = {
  '/api/health': () => jsonResponse({ ok: true }),
  '/api/me': () => jsonResponse({ user: { id: 1, name: 'Synthetic owner', role: 'owner' }, company: { id: 1, name: 'Synthetic Co' } }),
  '/api/drivers': () => jsonResponse({ drivers: [] }),
  '/api/routes': () => jsonResponse({ routes: [] })
};
const loggedIn = () => memoryStorage({ boss_server: 'http://boss.test', boss_token: 'synthetic-token' });
const FORM_IDS = { heightM: '4,1', widthM: '2.55', lengthM: '16.5', grossWeightT: '40', axleLoadT: '11.5', axleCount: '5' };
async function fillProfile(page, overrides = {}) {
  for (const field of PROFILE_FIELDS) {
    const value = overrides[field.key] ?? (field.kind === 'choice' ? 'no' : FORM_IDS[field.key]);
    page.$(field.inputId).value = value;
    await page.fire(field.inputId, field.kind === 'choice' ? 'change' : 'input');
  }
}
async function addTwoPoints(page) {
  for (const c of ['42.7, 23.3', '43.2, 27.9']) { page.$('coords').value = c; await page.fire('coordsBtn'); }
}

test('boss.html (executed): a provider line is not restored from the draft and never meets a different profile', async () => {
  const storage = loggedIn();
  const page = await loadBoss({ storage, routes: { ...BASE_ROUTES, '/api/route-options': () => jsonResponse(ROUTER_ANSWER) } });
  await addTwoPoints(page);
  await fillProfile(page);
  await page.fire('routeOptions');
  assert.equal(page.boss.routeAlternatives.length, 1);
  const option = page.$('routeOptionsList').children[0];
  await page.fire('routeOptionsList', 'click', option);
  // the line stays in memory for this session's share/send, but not in the draft
  assert.equal(page.boss.geom.length, 3);
  assert.equal(storage.getItem('boss_route_geometry'), '[]');
  assert.equal(JSON.parse(storage.getItem('boss_route_draft')).length, 2, 'the points are still saved');
  // a new page context with the same storage, then a different profile
  const reloaded = await loadBoss({ storage, routes: BASE_ROUTES });
  assert.equal(reloaded.boss.geom.length, 0);
  assert.equal(reloaded.boss.pts.length, 2);
  await fillProfile(reloaded, { heightM: '3.9', hazmat: 'yes' });
  assert.equal(reloaded.boss.geom.length, 0);
  assert.match(reloaded.$('rKm').textContent, /няма избрана пътна геометрия/);
  assert.equal(PROFILE_FIELDS.every(f => reloaded.$(f.inputId).value !== ''), true);
  assert.ok(![...storage.map.values()].some(v => /4,1|2\.55|16\.5|heightM|truckProfile/.test(v)), 'no profile in storage');
  // the original page labels the in-memory line as the router's
  assert.equal(page.boss.geomOrigin, 'provider');
  assert.match(page.$('rKm').textContent, /линията от маршрутизатора/);
});

test('boss.html (executed, positive control): a manual line is saved, restored and kept on a profile change', async () => {
  const storage = loggedIn();
  const page = await loadBoss({ storage, routes: BASE_ROUTES });
  await addTwoPoints(page);
  await page.fire('drawRoute');
  await page.fire('drawRoute');
  assert.equal(page.boss.geom.length, 2);
  assert.equal(JSON.parse(storage.getItem('boss_route_geometry')).length, 2);
  await fillProfile(page);
  await fillProfile(page, { heightM: '3' });
  assert.equal(page.boss.geom.length, 2, 'a profile change keeps the manual line');
  const reloaded = await loadBoss({ storage, routes: BASE_ROUTES });
  assert.equal(reloaded.boss.geom.length, 2);
  await fillProfile(reloaded);
  await fillProfile(reloaded, { heightM: '3.5' });
  assert.equal(reloaded.boss.geom.length, 2, 'a restored line is not removed');
});

test('boss.html (executed): line origin labels: manual in the session, unconfirmed after a reload', async () => {
  const storage = loggedIn();
  const page = await loadBoss({ storage, routes: BASE_ROUTES });
  await addTwoPoints(page);
  await page.fire('drawRoute');
  await page.fire('drawRoute');
  assert.equal(page.boss.geomOrigin, 'manual');
  assert.match(page.$('rKm').textContent, /ръчно начертаната линия/);
  const reloaded = await loadBoss({ storage, routes: BASE_ROUTES });
  assert.equal(reloaded.boss.geomOrigin, 'unconfirmed');
  assert.match(reloaded.$('rKm').textContent, /непотвърден произход/);
});

test('boss.html (executed): a legacy draft line and a saved server route are shown with unconfirmed origin', async () => {
  const legacy = memoryStorage({
    boss_server: 'http://boss.test', boss_token: 'synthetic-token',
    boss_route_draft: JSON.stringify([{ lat: 42.7, lon: 23.3, label: '' }, { lat: 43.2, lon: 27.9, label: '' }]),
    boss_route_geometry: JSON.stringify([{ lat: 42.7, lon: 23.3 }, { lat: 43, lon: 25 }, { lat: 43.2, lon: 27.9 }])
  });
  const saved = { id: 7, name: 'Synthetic saved', notes: '', status: 'new', driver_id: null, created_at: Date.now(),
    waypoints: [{ lat: 42, lon: 23, label: '' }, { lat: 43, lon: 24, label: '' }], geometry: [{ lat: 42, lon: 23 }, { lat: 42.5, lon: 23.5 }, { lat: 43, lon: 24 }] };
  const page = await loadBoss({ storage: legacy, routes: { ...BASE_ROUTES, '/api/routes': () => jsonResponse({ routes: [saved] }) } });
  assert.equal(page.boss.geomOrigin, 'unconfirmed');
  assert.match(page.$('rKm').textContent, /3 точки по запазена линия с непотвърден произход/);
  // a manual line drawn in this session, then a saved route is opened: its line is not called manual
  await page.fire('drawRoute');
  await page.fire('drawRoute');
  assert.equal(page.boss.geomOrigin, 'manual');
  const loadButton = new FakeElement(page.document);
  loadButton.dataset.load = '7';
  await page.fire('sentRoutes', 'click', loadButton);
  assert.equal(page.boss.geom.length, 3);
  assert.equal(page.boss.geomOrigin, 'unconfirmed');
  assert.equal(JSON.parse(legacy.getItem('boss_route_geometry')).length, 3, 'unknown-origin lines keep the existing draft behaviour');
});

for (const outcome of ['response', 'error']) {
  test(`boss.html (executed): logout ends the local session at once while the server logout is pending (deferred ${outcome})`, async () => {
    const storage = loggedIn();
    const options = [], logouts = [];
    const page = await loadBoss({ storage, routes: { ...BASE_ROUTES,
      '/api/route-options': () => { const d = deferred(); options.push(d); return d.promise; },
      '/api/logout': () => { const d = deferred(); logouts.push(d); return d.promise; } } });
    await addTwoPoints(page);
    await fillProfile(page);
    // first request answered and its line selected, a second request still pending
    page.fire('routeOptions');
    await settle();
    options[0].resolve(jsonResponse(ROUTER_ANSWER));
    await settle();
    await page.fire('routeOptionsList', 'click', page.$('routeOptionsList').children[0]);
    assert.equal(page.boss.geom.length, 3, 'a provider line is selected');
    page.fire('routeOptions');
    await settle();
    const generation = page.boss.ctl.getState().generation;
    page.fire('logout');
    // before the server answers: logged out locally, everything cleared, old request stale
    assert.equal(logouts.length, 1);
    assert.equal(page.requests.find(r => r.path === '/api/logout').authorization, 'Bearer synthetic-token');
    assert.equal(page.boss.S.token, '');
    assert.equal(storage.getItem('boss_token'), null);
    assert.ok(PROFILE_FIELDS.every(f => page.$(f.inputId).value === ''));
    assert.ok(page.boss.ctl.getState().generation > generation);
    assert.equal(page.boss.routeAlternatives.length, 0);
    assert.equal(page.$('routeOptionsList').children.length, 0);
    assert.equal(page.boss.geom.length, 0, 'the provider line for the old truck is gone');
    if (outcome === 'response') options[1].resolve(jsonResponse(ROUTER_ANSWER));
    else options[1].reject(new Error('Маршрутизаторът временно не отговаря'));
    await settle();
    assert.equal(page.boss.routeAlternatives.length, 0, 'the old answer is stale');
    assert.equal(page.$('routeOptionsList').textContent, '', 'no old variant or error is shown');
    if (outcome === 'response') logouts[0].resolve(jsonResponse({ ok: true }));
    else logouts[0].reject(new TypeError('network down'));
    await settle();
    assert.equal(page.boss.S.token, '');
    assert.ok(PROFILE_FIELDS.every(f => page.$(f.inputId).value === ''));
    assert.equal(page.requests.filter(r => r.path === '/api/route-options').length, 2);
  });
}
