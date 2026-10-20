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
  // the existing draft and link fields stay the same
  assert.match(BOSS, /function saveDraft\(\) \{ store\.set\('boss_route_draft', JSON\.stringify\(pts\)\); store\.set\('boss_route_geometry', JSON\.stringify\(geom\)\); store\.set\('boss_route_name', \$\('rName'\)\.value\); store\.set\('boss_route_notes', \$\('rNotes'\)\.value\); \}/);
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
  assert.match(BOSS, /drawing = true; routeOptionsCtl\.markManualGeometry\(\);/);
  assert.match(BOSS, /geom = shape; drawing = false; routeOptionsCtl\.markProviderSelected\(\);/);
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
