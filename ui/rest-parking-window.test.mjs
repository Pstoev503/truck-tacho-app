import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_LOOKBACK_KM, MAX_LOOKBACK_KM, RestWindowError, restParkingWindow, validateLookbackKm
} from './rest-parking-window.mjs';

const rest = (fromM, extra = {}) => ({ type: 'rest', fromM, toM: fromM, startUtcMs: 0, endUtcMs: 1, ...extra });
const codeOf = fn => {
  try { fn(); } catch (caught) { assert.ok(caught instanceof RestWindowError, String(caught)); return caught.code; }
  return 'ok';
};

test('default 20 km window ends exactly at the pause and has nothing after it', () => {
  assert.equal(DEFAULT_LOOKBACK_KM, 20);
  assert.deepEqual(restParkingWindow({ event: rest(150_000), totalLengthM: 400_000 }), {
    restOffsetM: 150_000, minOffsetM: 130_000, maxOffsetM: 150_000, lookbackKm: 20, clamped: false
  });
});

test('near the start the window is clamped to 0 and marked; exactly 20 km is not clamped', () => {
  assert.deepEqual(restParkingWindow({ event: rest(5_000), totalLengthM: 400_000 }), {
    restOffsetM: 5_000, minOffsetM: 0, maxOffsetM: 5_000, lookbackKm: 20, clamped: true
  });
  assert.equal(restParkingWindow({ event: rest(20_000), totalLengthM: 400_000 }).clamped, false);
  assert.equal(restParkingWindow({ event: rest(0.001), totalLengthM: 400_000 }).maxOffsetM, 0.001);
});

test('a pause at the end of the route uses the full length as the window end', () => {
  const total = 403_296.123456789;
  const window = restParkingWindow({ event: rest(total), totalLengthM: total, lookbackKm: 50 });
  assert.equal(window.maxOffsetM, total);
  assert.equal(window.minOffsetM, total - 50_000);
});

test('a pause at the very start has no stretch before it and gives no zero-length window', () => {
  assert.equal(codeOf(() => restParkingWindow({ event: rest(0), totalLengthM: 1000 })), 'REST_AT_START');
});

test('the pause offset is kept with full precision, without kilometre rounding', () => {
  const fromM = 123_456.789012345;
  const window = restParkingWindow({ event: rest(fromM), totalLengthM: 500_000, lookbackKm: 7.5 });
  assert.equal(window.maxOffsetM, fromM);
  assert.equal(window.restOffsetM, fromM);
  assert.equal(window.minOffsetM, fromM - 7_500);
});

test('lookback must be a real number above 0 and at most 200 km, without coercion', () => {
  for (const bad of ['20', NaN, 0, -1, 200.0001, Infinity, null, undefined, true, [20]]) {
    assert.equal(codeOf(() => validateLookbackKm(bad)), 'INVALID_LOOKBACK', String(bad));
    assert.equal(codeOf(() => restParkingWindow({ event: rest(50_000), totalLengthM: 100_000, lookbackKm: bad })),
      bad === undefined ? 'ok' : 'INVALID_LOOKBACK', String(bad));
  }
  assert.equal(validateLookbackKm(MAX_LOOKBACK_KM), 200);
  assert.equal(validateLookbackKm(0.001), 0.001);
});

test('only a positioned rest event on the route is accepted', () => {
  const total = 100_000;
  const cases = [
    [{ type: 'drive', fromM: 10, toM: 500 }, 'NOT_A_REST'],
    [null, 'NOT_A_REST'],
    [undefined, 'NOT_A_REST'],
    [rest(1000, { toM: 1001 }), 'INVALID_REST_POSITION'],
    [rest(NaN), 'INVALID_REST_POSITION'],
    [rest('1000'), 'INVALID_REST_POSITION'],
    [rest(-1), 'INVALID_REST_POSITION'],
    [rest(total + 0.001), 'INVALID_REST_POSITION'],
    [{ type: 'rest' }, 'INVALID_REST_POSITION']
  ];
  for (const [event, code] of cases) {
    assert.equal(codeOf(() => restParkingWindow({ event, totalLengthM: total })), code, JSON.stringify(event));
  }
  for (const totalLengthM of [0, -5, NaN, '100000', undefined]) {
    assert.equal(codeOf(() => restParkingWindow({ event: rest(10), totalLengthM })), 'INVALID_ROUTE_LENGTH');
  }
});

test('frozen input is accepted, not changed, and a new object is returned', () => {
  const input = Object.freeze({ event: Object.freeze(rest(60_000)), totalLengthM: 100_000, lookbackKm: 20 });
  const snapshot = structuredClone(input);
  const window = restParkingWindow(input);
  assert.deepEqual(input, snapshot);
  assert.notEqual(window, input.event);
  window.minOffsetM = 1;
  assert.equal(restParkingWindow(input).minOffsetM, 40_000, 'each call returns its own object');
});
