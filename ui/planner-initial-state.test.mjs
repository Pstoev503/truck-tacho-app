import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPlannerInitialState } from './planner-initial-state.mjs';

const now = Date.parse('2026-10-19T08:00:00Z');
const drive = { type: 'drive', start: now - 60_000, end: now };
const load = (activities = [drive], weekly = null, options = {}) =>
  loadPlannerInitialState({
    readStorage: key => key === 'th_activities' ? JSON.stringify(activities) : weekly,
    now: () => now,
    ...options
  });

test('loads an independent copy while preserving order, overlaps, and supported flags', () => {
  const records = [
    { ...drive, end: now - 30_000, manual: true },
    { type: 'rest', start: now - 45_000, end: null, ferry: true }
  ];
  const loaded = load(records, String(now - 50_000));
  assert.deepEqual(loaded.initialState, {
    activities: records,
    lastWeeklyRestEnd: now - 50_000,
    source: 'local-device'
  });
  assert.deepEqual(loaded.summary, { activityCount: 2, latestBoundary: now - 30_000 });
  loaded.initialState.activities[0].start = 0;
  assert.equal(records[0].start, now - 60_000);
});

test('missing activity and weekly-rest keys represent an empty snapshot', () => {
  const result = loadPlannerInitialState({
    readStorage: () => null,
    now: () => now
  });
  assert.deepEqual(result.initialState, {
    activities: [],
    lastWeeklyRestEnd: null,
    source: 'local-device'
  });
  assert.deepEqual(result.summary, { activityCount: 0, latestBoundary: null });
});

test('reads only the two supported storage keys and samples the clock once', () => {
  const keys = [];
  let clockCalls = 0;
  loadPlannerInitialState({
    readStorage: key => {
      keys.push(key);
      return key === 'th_activities' ? '[]' : '';
    },
    now: () => { clockCalls++; return now; }
  });
  assert.deepEqual(keys, ['th_activities', 'th_weekly_rest_end']);
  assert.equal(clockCalls, 1);
});

test('a storage read denial is reported without exposing the thrown detail', () => {
  assert.throws(() => loadPlannerInitialState({
    readStorage: () => { throw new Error('private storage detail'); },
    now: () => now
  }), error => error.message.includes('не може да бъде прочетен') &&
    !error.message.includes('private'));
});

test('empty activity text is not silently treated as an empty history', () => {
  assert.throws(() => loadPlannerInitialState({
    readStorage: key => key === 'th_activities' ? '' : null,
    now: () => now
  }), /невалиден или непълен/);
});

test('malformed JSON and non-array activity JSON are rejected', () => {
  for (const raw of ['{', '{"type":"drive"}']) {
    assert.throws(() => loadPlannerInitialState({
      readStorage: key => key === 'th_activities' ? raw : null,
      now: () => now
    }), /невалиден или непълен/);
  }
});

test('unknown types, fields, and missing required activity properties are rejected', () => {
  const invalid = [
    { type: 'sleep', start: now - 1, end: now },
    { ...drive, identity: 'not-supported' },
    { type: 'drive', start: now - 1 },
    { type: 'drive', end: now }
  ];
  for (const activity of invalid) {
    assert.throws(() => load([activity]), /невалиден или непълен/);
  }
});

test('activity timestamps must be finite numbers and closed records must have positive duration', () => {
  const invalid = [
    { type: 'drive', start: '1', end: now },
    { type: 'drive', start: Infinity, end: now },
    { type: 'drive', start: now - 1, end: now - 1 },
    { type: 'drive', start: now - 1, end: 'not-a-number' }
  ];
  for (const activity of invalid) {
    assert.throws(() => load([activity]), /невалиден или непълен/);
  }
});

test('future starts, ends, and open records are rejected', () => {
  const invalid = [
    { type: 'drive', start: now + 1, end: null },
    { type: 'drive', start: now - 1, end: now + 1 },
    { type: 'drive', start: now + 1, end: null }
  ];
  for (const activity of invalid) {
    assert.throws(() => load([activity]), /невалиден или непълен/);
  }
});

test('open activities require exactly null and remain open in the snapshot', () => {
  const open = { type: 'drive', start: now - 1, end: null, manual: false };
  assert.deepEqual(load([open]).initialState.activities, [open]);
  for (const end of [undefined, 'null']) {
    const activity = { type: 'drive', start: now - 1, end };
    assert.throws(() => load([activity]), /невалиден или непълен/);
  }
});

test('flags must be booleans and ferry is restricted to rest activities', () => {
  const invalid = [
    { ...drive, manual: 1 },
    { ...drive, ferry: true },
    { ...drive, ferry: false },
    { ...drive, manual: null }
  ];
  for (const activity of invalid) {
    assert.throws(() => load([activity]), /невалиден или непълен/);
  }
});

test('missing or blank weekly-rest end is null; a valid explicit millisecond value is retained', () => {
  assert.equal(load([drive], null).initialState.lastWeeklyRestEnd, null);
  assert.equal(load([drive], '   ').initialState.lastWeeklyRestEnd, null);
  assert.equal(load([drive], String(now - 1)).initialState.lastWeeklyRestEnd, now - 1);
});

test('malformed, non-finite, and future weekly-rest ends fail without a fallback', () => {
  for (const value of ['yesterday', 'Infinity', String(now + 1)]) {
    assert.throws(() => load([drive], value), /седмичната почивка/);
  }
});

test('a non-finite injected cutoff is rejected', () => {
  assert.throws(() => loadPlannerInitialState({
    readStorage: () => null,
    now: () => NaN
  }), /текущият час/);
});
