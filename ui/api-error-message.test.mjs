import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { apiErrorMessage } from './api-error-message.mjs';

const error = (...loc) => ({ loc: ['body', ...loc], msg: 'synthetic validation error' });
const payload = (...errors) => ({ detail: errors });

test('route-options errors direct the owner to the truck profile and route coordinates', () => {
  for (const item of [
    error('truckProfile'),
    error('truckProfile', 'heightM'),
    error('truckProfile', 'axleCount'),
    error('origin', 'lat'),
    error('destination', 'lon')
  ]) {
    const message = apiErrorMessage('/api/route-options', 'POST', payload(item));
    assert.match(message, /камиона/);
    assert.match(message, /координата/);
    assert.doesNotMatch(message, /парол|имейл/i);
  }
});

test('owner registration and login point to their own input fields', () => {
  assert.match(apiErrorMessage('/api/owner/register', 'POST', payload(error('company'))), /фирмата/);
  assert.match(apiErrorMessage('/api/owner/register', 'POST', payload(error('name'))), /имейла/);
  assert.match(apiErrorMessage('/api/owner/register', 'POST', payload(error('email'))), /имейла/);
  assert.match(apiErrorMessage('/api/owner/register', 'POST', payload(error('password'))), /паролата/);
  assert.match(apiErrorMessage('/api/owner/register', 'POST', payload(error('registration_code'))), /регистрация/);
  assert.match(apiErrorMessage('/api/owner/login', 'POST', payload(error('email'))), /имейла и паролата/);
  assert.match(apiErrorMessage('/api/owner/login', 'POST', payload(error('password'))), /имейла и паролата/);
});

test('driver and saved-route errors refer to driver, waypoint and route fields', () => {
  assert.match(apiErrorMessage('/api/drivers', 'POST', payload(error('name'))), /името на шофьора/);
  assert.match(apiErrorMessage('/api/drivers/42', 'PATCH', payload(error('active'))), /шофьора/);
  assert.match(apiErrorMessage('/api/drivers/42', 'PATCH', payload(error('name'))), /шофьора/);
  assert.match(apiErrorMessage('/api/routes', 'POST', payload(error('name'))), /името на маршрута/);
  assert.match(apiErrorMessage('/api/routes', 'POST', payload(error('waypoints', 0, 'lat'))), /координатите/);
  assert.match(apiErrorMessage('/api/routes', 'POST', payload(error('driver_id'))), /шофьор/);
});

test('unknown contexts and malformed or unexpected validation payloads stay generic', () => {
  for (const [path, method, value] of [
    ['/api/unknown', 'POST', payload(error('password'))],
    ['/api/route-options', 'GET', payload(error('truckProfile'))],
    ['/api/route-options', 'POST', null],
    ['/api/route-options', 'POST', 'hostile payload'],
    ['/api/route-options', 'POST', { detail: [] }],
    ['/api/route-options', 'POST', { detail: 'hostile text' }],
    ['/api/route-options', 'POST', { detail: [null] }],
    ['/api/route-options', 'POST', { detail: [{ loc: 'truckProfile' }] }],
    ['/api/route-options', 'POST', payload(error('unknownField'))],
    ['/api/drivers/not-a-number', 'PATCH', payload(error('name'))]
  ]) {
    assert.equal(apiErrorMessage(path, method, value), 'Провери въведените полета.');
  }
});

test('untrusted message, input and context values are never reflected', () => {
  const hostile = {
    detail: [{
      loc: ['body', 'truckProfile', 'heightM'],
      msg: '<script>secret</script>',
      input: 'synthetic-password',
      ctx: { error: 'hostile-context' }
    }]
  };
  const message = apiErrorMessage('/api/route-options', 'POST', hostile);
  assert.equal(message, 'Провери профила на камиона и началната/крайната координата.');
  for (const input of ['<script>', 'synthetic-password', 'hostile-context', 'alert(1)']) {
    assert.equal(message.includes(input), false);
  }
  assert.equal(apiErrorMessage('/api/route-options', 'POST', {
    detail: [{ loc: ['body', 'truckProfile', '<img src=x onerror=alert(1)>'], msg: 'hostile' }]
  }), 'Провери въведените полета.');
});

test('executed boss api keeps route-options 422 contextual and safely displays the message', async () => {
  const boss = readFileSync(fileURLToPath(new URL('../boss.html', import.meta.url)), 'utf8');
  assert.match(boss, /\$\('routeOptionsList'\)\.textContent = out\.error\.message;/);
  const start = boss.indexOf('async function api(');
  const end = boss.indexOf('\n}\n\n// ───────── навигация', start) + 2;
  assert.ok(start >= 0 && end > start, 'locate the actual boss api() function');
  const requests = [];
  const toast = { textContent: '' };
  const state = { server: 'https://boss.test', token: 'synthetic-token' };
  let response = { status: 422, ok: false, json: async () => ({
    detail: [{ loc: ['body', 'truckProfile'], msg: 'password email secret', input: 'synthetic-password', ctx: { value: 'synthetic-email' } }]
  }) };
  let logoutCalls = 0;
  const storage = new Map([['boss_token', state.token]]);
  const sandbox = {
    S: state,
    apiErrorMessage,
    fetch: async (url, init) => { requests.push({ url, init }); return response; },
    logoutLocal: () => {
      logoutCalls++;
      state.token = '';
      storage.delete('boss_token');
    }
  };
  vm.runInNewContext(`${boss.slice(start, end)}; globalThis.callBossApi = api;`, sandbox);

  try {
    await sandbox.callBossApi('/api/route-options', {
      method: 'POST',
      body: { origin: { lat: 42.7, lon: 23.3 }, destination: { lat: 43.2, lon: 27.9 }, truckProfile: { heightM: 4 } }
    });
    assert.fail('route-options 422 must reject');
  } catch (error) {
    toast.textContent = error.message;
  }
  assert.match(toast.textContent, /камиона/);
  assert.match(toast.textContent, /координата/);
  assert.doesNotMatch(toast.textContent, /парол|имейл|synthetic|password/i);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://boss.test/api/route-options');
  assert.equal(requests[0].init.headers.Authorization, 'Bearer ' + state.token);
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    origin: { lat: 42.7, lon: 23.3 },
    destination: { lat: 43.2, lon: 27.9 },
    truckProfile: { heightM: 4 }
  });

  response = { status: 401, ok: false, json: async () => ({ detail: 'Сесията изтече' }) };
  await assert.rejects(sandbox.callBossApi('/api/route-options'), /Сесията изтече/);
  assert.equal(logoutCalls, 1);
  assert.equal(state.token, '');
  assert.equal(storage.has('boss_token'), false);

  const success = { ok: true, result: 'synthetic response' };
  response = { status: 200, ok: true, json: async () => success };
  assert.deepEqual(await sandbox.callBossApi('/api/routes'), success);
  assert.equal(requests.length, 3);
});
