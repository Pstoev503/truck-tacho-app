import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DRAFT_FORMAT, DRAFT_VERSION, DraftFileError, MAX_DRAFT_FILE_BYTES, MAX_DRAFT_POINTS,
  createDraft, draftFileName, parseDraftText, readDraftFile, validateDraft
} from './planner-draft.mjs';

// Synthetic data only.
const T = Date.parse('2026-10-19T08:00:00Z');
const base = () => ({
  format: DRAFT_FORMAT,
  version: DRAFT_VERSION,
  exportedAtUtcMs: T,
  points: [{ lat: 42.7, lon: 23.3 }, { lat: 42.15, lon: 24.75 }, { lat: 43.2, lon: 27.9 }],
  roadTypes: ['motorway', null],
  choices: { 'section-1': { useExtension: true, dailyRest: 'reduced' } },
  departure: { mode: 'relative', hours: 2, minutes: 30 },
  breakStyle: '15+30'
});
const codeOf = value => {
  try {
    if (typeof value === 'string') parseDraftText(value); else validateDraft(value);
  } catch (caught) {
    assert.ok(caught instanceof DraftFileError, String(caught));
    return caught.code;
  }
  return 'ok';
};
const withChange = change => { const draft = base(); change(draft); return draft; };

test('a draft round-trips through text with exactly the documented fields', () => {
  const draft = base();
  const text = createDraft(draft, T);
  assert.deepEqual(Object.keys(JSON.parse(text)), [
    'format', 'version', 'exportedAtUtcMs', 'points', 'roadTypes', 'choices', 'departure', 'breakStyle'
  ]);
  const loaded = parseDraftText(text);
  assert.deepEqual(loaded, {
    exportedAtUtcMs: T,
    points: draft.points,
    roadTypes: draft.roadTypes,
    choices: draft.choices,
    departure: draft.departure,
    breakStyle: '15+30'
  });
  assert.ok(Object.isFrozen(loaded) && Object.isFrozen(loaded.points[0]) && Object.isFrozen(loaded.choices['section-1']));
  assert.equal(parseDraftText(`﻿${text}`).points.length, 3, 'a UTF-8 BOM is accepted');
});

test('an unfinished draft with 0 or 1 point and unselected road types is accepted', () => {
  for (const [points, roadTypes] of [[[], []], [[{ lat: 1, lon: 2 }], []], [[{ lat: 0, lon: 0 }, { lat: 0, lon: 0.1 }], [null]]]) {
    const loaded = validateDraft({ ...base(), points, roadTypes, choices: {} });
    assert.equal(loaded.points.length, points.length);
    assert.deepEqual(loaded.roadTypes, roadTypes);
  }
});

test('format, version and unknown or missing fields are refused', () => {
  assert.equal(codeOf(withChange(d => { d.format = 'other'; })), 'UNKNOWN_FORMAT');
  assert.equal(codeOf(withChange(d => { d.version = 2; })), 'UNSUPPORTED_VERSION');
  assert.equal(codeOf(withChange(d => { d.version = '1'; })), 'UNSUPPORTED_VERSION');
  for (const extra of ['activities', 'lastWeeklyRestEnd', 'token', 'parkingCandidates', 'result', 'requestId', 'routeRevision']) {
    assert.equal(codeOf(withChange(d => { d[extra] = 'x'; })), 'UNKNOWN_FIELD', extra);
  }
  assert.equal(codeOf(withChange(d => { delete d.breakStyle; })), 'MISSING_FIELD');
  assert.equal(codeOf(withChange(d => { d.points[0].name = 'Склад'; })), 'UNKNOWN_FIELD');
  assert.equal(codeOf(withChange(d => { d.departure.seconds = 0; })), 'UNKNOWN_FIELD');
  assert.equal(codeOf(withChange(d => { d.choices['section-1'].note = 'x'; })), 'UNKNOWN_FIELD');
  for (const notObject of [null, [], 'draft', 1]) {
    assert.throws(() => validateDraft(notObject), error => error.code === 'INVALID_FIELD');
  }
  assert.equal(codeOf('[]'), 'INVALID_FIELD');
});

test('types are exact: no string, boolean or number coercion', () => {
  assert.equal(codeOf(withChange(d => { d.points[0].lat = '42.7'; })), 'INVALID_POINT');
  assert.equal(codeOf(withChange(d => { d.exportedAtUtcMs = String(T); })), 'INVALID_EXPORTED_AT');
  assert.equal(codeOf(withChange(d => { d.exportedAtUtcMs = T + 0.5; })), 'INVALID_EXPORTED_AT');
  assert.equal(codeOf(withChange(d => { d.departure.hours = '2'; })), 'INVALID_DEPARTURE');
  assert.equal(codeOf(withChange(d => { d.departure.minutes = 1.5; })), 'INVALID_DEPARTURE');
  assert.equal(codeOf(withChange(d => { d.choices['section-1'].useExtension = 'true'; })), 'INVALID_CHOICE');
  assert.equal(codeOf(withChange(d => { d.breakStyle = 45; })), 'INVALID_BREAK_STYLE');
  assert.equal(codeOf(withChange(d => { d.roadTypes[1] = ''; })), 'INVALID_ROAD_TYPE');
});

test('enums and ranges are checked for every field', () => {
  assert.equal(codeOf(withChange(d => { d.roadTypes[0] = 'highway'; })), 'INVALID_ROAD_TYPE');
  assert.equal(codeOf(withChange(d => { d.choices['section-1'].dailyRest = '9h'; })), 'INVALID_CHOICE');
  assert.equal(codeOf(withChange(d => { d.departure.mode = 'tomorrow'; })), 'INVALID_DEPARTURE');
  assert.equal(codeOf(withChange(d => { d.departure.hours = 721; })), 'INVALID_DEPARTURE');
  assert.equal(codeOf(withChange(d => { d.departure.minutes = 60; })), 'INVALID_DEPARTURE');
  assert.equal(codeOf(withChange(d => { d.departure.minutes = -1; })), 'INVALID_DEPARTURE');
  assert.equal(codeOf(withChange(d => { d.breakStyle = '15 + 30'; })), 'INVALID_BREAK_STYLE');
});

test('NaN, Infinity and out-of-range or unsupported coordinates are refused, never dropped', () => {
  for (const point of [{ lat: NaN, lon: 1 }, { lat: 1, lon: Infinity }, { lat: 85, lon: 0 }, { lat: -85.5, lon: 0 }, { lat: 0, lon: 180.1 }]) {
    assert.equal(codeOf(withChange(d => { d.points[1] = point; })), 'INVALID_POINT', JSON.stringify(point));
  }
  // Segments the route index refuses: antimeridian crossing and a polar arc.
  assert.equal(codeOf({ ...base(), points: [{ lat: 0, lon: 179 }, { lat: 0, lon: -179 }], roadTypes: [null], choices: {} }), 'INVALID_SEGMENT');
  assert.equal(codeOf({ ...base(), points: [{ lat: 80, lon: 0 }, { lat: 80, lon: 179 }], roadTypes: [null], choices: {} }), 'INVALID_SEGMENT');
  // A repeated point is a zero-length segment the planner itself allows while drawing.
  assert.equal(codeOf({ ...base(), points: [{ lat: 1, lon: 1 }, { lat: 1, lon: 1 }], roadTypes: [null], choices: {} }), 'ok');
});

test('road types and section choices must match the number of points', () => {
  assert.equal(codeOf(withChange(d => { d.roadTypes = ['motorway']; })), 'INCONSISTENT_ROAD_TYPES');
  assert.equal(codeOf(withChange(d => { d.roadTypes = ['motorway', null, null]; })), 'INCONSISTENT_ROAD_TYPES');
  assert.equal(codeOf(withChange(d => { d.choices['section-3'] = { useExtension: false, dailyRest: 'regular' }; })), 'INCONSISTENT_CHOICES');
  assert.equal(codeOf(withChange(d => { d.choices['section-0'] = { useExtension: false, dailyRest: 'regular' }; })), 'INCONSISTENT_CHOICES');
  assert.equal(codeOf(withChange(d => { d.choices.extra = { useExtension: false, dailyRest: 'regular' }; })), 'INCONSISTENT_CHOICES');
  assert.equal(codeOf({ ...base(), points: [], roadTypes: [], choices: { 'section-1': { useExtension: false, dailyRest: 'regular' } } }), 'INCONSISTENT_CHOICES');
});

test('size, point count and corrupted JSON are clear errors', async () => {
  const many = n => JSON.stringify({ ...base(), points: Array.from({ length: n }, (_, i) => ({ lat: 0, lon: i * 0.001 })),
    roadTypes: Array.from({ length: n - 1 }, () => null), choices: {} });
  assert.equal(codeOf(many(MAX_DRAFT_POINTS)), 'ok');
  assert.equal(codeOf(many(MAX_DRAFT_POINTS + 1)), 'TOO_MANY_POINTS');
  assert.equal(codeOf('{"format":'), 'INVALID_JSON');
  assert.equal(codeOf(''), 'INVALID_JSON');
  assert.equal(codeOf(`${createDraft(base(), T)}x`), 'INVALID_JSON');
  assert.throws(() => parseDraftText(' '.repeat(MAX_DRAFT_FILE_BYTES + 1)), error => error.code === 'FILE_TOO_LARGE');
  let read = false;
  await assert.rejects(readDraftFile({ size: MAX_DRAFT_FILE_BYTES + 1, text: async () => { read = true; return '{}'; } }),
    error => error.code === 'FILE_TOO_LARGE');
  assert.equal(read, false);
  await assert.rejects(readDraftFile(null), error => error.code === 'NO_FILE');
  await assert.rejects(readDraftFile({ text: async () => { throw new Error('io'); } }), error => error.code === 'READ_FAILED');
});

test('a frozen input object is accepted and not changed', () => {
  const draft = base();
  const snapshot = structuredClone(draft);
  const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
  const loaded = validateDraft(freeze(draft));
  assert.deepEqual(draft, snapshot);
  assert.notEqual(loaded.points, draft.points, 'the result is a copy');
});

test('export is refused for a state that is not a valid draft', () => {
  assert.throws(() => createDraft({ ...base(), breakStyle: '30' }, T), DraftFileError);
  assert.throws(() => createDraft(base(), NaN), DraftFileError);
  assert.equal(draftFileName(T), 'top10eu-podgotovka-20261019-0800Z.json');
});
