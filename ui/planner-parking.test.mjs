import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAX_LATERAL_M, MAX_PARKING_FILE_BYTES, ParkingFileError, describeParkingResults, parkingItemNode,
  parkingTooltipNode, parseParkingText, readParkingFile, reasonText, validateParkingWindow, windowInMeters
} from './planner-parking.mjs';
import { evaluateParkingCandidates } from '../engine/parking-candidates.js';

// Synthetic data only.
const T = Date.parse('2026-10-19T08:00:00Z');
const record = (id, lon, extra = {}) => ({
  id,
  location: { lat: 0.001, lon },
  sourceId: 'synthetic-file',
  observedAt: T - 60_000,
  expiresAt: T + 3_600_000,
  truckAccess: 'allowed',
  availability: 'available',
  ...extra
});
const fileOf = (text, extra = {}) => ({ name: 'parkings.json', size: Buffer.byteLength(text), text: async () => text, ...extra });

// Minimal DOM: setting innerHTML fails, so only textContent can carry file text.
class FakeElement {
  constructor(tag) { this.tag = tag; this.children = []; this.textContent = ''; this.className = ''; }
  append(...nodes) { this.children.push(...nodes); }
  set innerHTML(_) { throw new Error('innerHTML must not be used'); }
  get allText() { return [this.textContent, ...this.children.map(child => child.allText)].join('\n'); }
}
const fakeDocument = { createElement: tag => new FakeElement(tag) };

test('a valid UTF-8 JSON array loads as a frozen list with values unchanged', () => {
  const text = JSON.stringify([record('П-1 Мусала', 0.5), { id: 'raw', observedAt: '1760860800000', truckAccess: 'true' }]);
  const list = parseParkingText(text);
  assert.equal(list.length, 2);
  assert.equal(list[0].id, 'П-1 Мусала');
  assert.equal(list[1].observedAt, '1760860800000', 'string numbers stay strings');
  assert.equal(list[1].truckAccess, 'true', 'string booleans stay strings');
  assert.equal(Object.hasOwn(list[1], 'sourceId'), false, 'nothing is invented');
  assert.ok(Object.isFrozen(list) && Object.isFrozen(list[0]) && Object.isFrozen(list[0].location));
  assert.equal(parseParkingText(`﻿${text}`).length, 2, 'a UTF-8 BOM is accepted');
});

test('invalid JSON, a non-array and too many records are clear structured errors', () => {
  const codeOf = text => {
    try { parseParkingText(text); } catch (caught) {
      assert.ok(caught instanceof ParkingFileError);
      assert.match(caught.message, /не е зареден|JSON масив/);
      return caught.code;
    }
    return 'loaded';
  };
  assert.equal(codeOf('{not json'), 'INVALID_JSON');
  assert.equal(codeOf(''), 'INVALID_JSON');
  assert.equal(codeOf('{"id":"p"}'), 'NOT_ARRAY');
  assert.equal(codeOf('null'), 'NOT_ARRAY');
  assert.equal(codeOf(JSON.stringify(Array.from({ length: 1001 }, (_, i) => ({ id: `p${i}` })))), 'TOO_MANY_CANDIDATES');
  assert.equal(codeOf(JSON.stringify(Array.from({ length: 1000 }, (_, i) => ({ id: `p${i}` })))), 'loaded');
});

test('files over 1 MiB are refused by size before and after reading', async () => {
  let read = false;
  await assert.rejects(readParkingFile({ size: MAX_PARKING_FILE_BYTES + 1, text: async () => { read = true; return '[]'; } }),
    error => error.code === 'FILE_TOO_LARGE');
  assert.equal(read, false, 'an oversized file is not read');
  // Multi-byte text: 600 000 Cyrillic letters are 1 200 000 UTF-8 bytes.
  const big = JSON.stringify(['ж'.repeat(600_000)]);
  assert.throws(() => parseParkingText(big), error => error.code === 'FILE_TOO_LARGE');
  await assert.rejects(readParkingFile({ text: async () => big }), error => error.code === 'FILE_TOO_LARGE');
  assert.equal((await readParkingFile(fileOf('[]'))).length, 0);
  await assert.rejects(readParkingFile(null), error => error.code === 'NO_FILE');
  await assert.rejects(readParkingFile({ text: async () => { throw new Error('io'); } }), error => error.code === 'READ_FAILED');
});

test('kilometres convert to metres along the route; empty fields mean the whole route', () => {
  const routeLengthM = 12_345;
  assert.deepEqual(windowInMeters(validateParkingWindow(), routeLengthM),
    { minOffsetM: 0, maxOffsetM: routeLengthM, maxLateralDistanceM: DEFAULT_MAX_LATERAL_M });
  assert.deepEqual(windowInMeters(validateParkingWindow({ fromKm: 1.5, toKm: 12.3, maxLateralM: 250 }), routeLengthM),
    { minOffsetM: 1500, maxOffsetM: 12_300, maxLateralDistanceM: 250 });
  assert.throws(() => windowInMeters(validateParkingWindow({ toKm: 12.4 }), routeLengthM), /След края на маршрута|след края/);
  assert.throws(() => windowInMeters(validateParkingWindow({ fromKm: 13 }), routeLengthM), /след края/);
});

test('window fields reject strings, NaN, negatives, reversed ranges and huge corridors', () => {
  for (const bad of [
    { fromKm: '1' }, { toKm: NaN }, { fromKm: -0.1 }, { fromKm: 5, toKm: 4 },
    { maxLateralM: '500' }, { maxLateralM: NaN }, { maxLateralM: -1 }, { maxLateralM: 5001 }, { toKm: Infinity }
  ]) {
    assert.throws(() => validateParkingWindow(bad), RangeError, JSON.stringify(bad));
  }
  assert.deepEqual(validateParkingWindow({ fromKm: 0, toKm: 0, maxLateralM: 0 }), { fromKm: 0, toKm: 0, maxLateralM: 0 });
});

test('descriptions translate unknown, expired and ambiguous results and keep null positions null', () => {
  const geometry = [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 0, lon: 0 }];
  const candidates = [
    record('expired', 0.2, { expiresAt: T }),
    record('unknown', 0.5, { sourceId: undefined, truckAccess: 'unknown' }),
    record('loop', 0.5),
    record('far', 0.5, { location: { lat: 0.5, lon: 0.5 } })
  ];
  // Out-and-back route: every parking beside it is ambiguous.
  const ambiguous = evaluateParkingCandidates({
    requestId: 'r', routeRevision: 'route-1', inputRevision: 'input-1', geometry, evaluatedAt: T,
    window: { minOffsetM: 0, maxOffsetM: 1000, maxLateralDistanceM: 500 }, parkingCandidates: [candidates[2]]
  });
  const [loop] = describeParkingResults(ambiguous, [candidates[2]]);
  assert.match(loop.title, /Изключен/);
  assert.ok(loop.lines.includes('Позиция по линията: неясна — не е избрана.'));
  assert.equal(loop.marker, null);
  assert.ok(!loop.lines.some(line => /На 0\.00 км/.test(line)), 'no invented zero position');

  const straight = evaluateParkingCandidates({
    requestId: 'r', routeRevision: 'route-1', inputRevision: 'input-1',
    geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }], evaluatedAt: T,
    window: { minOffsetM: 0, maxOffsetM: 111_000, maxLateralDistanceM: 500 },
    parkingCandidates: [candidates[0], candidates[1], candidates[3]]
  });
  const items = describeParkingResults(straight, [candidates[0], candidates[1], candidates[3]]);
  const byTitle = prefix => items.find(item => item.title.startsWith(prefix));
  assert.match(byTitle('unknown').title, /Нужна е проверка/);
  assert.ok(byTitle('unknown').lines.some(line => /неизвестна актуалност/.test(line)));
  assert.ok(byTitle('unknown').lines.some(line => /източникът не е посочен; достъпът за камиони не е известен/.test(line)));
  assert.deepEqual(byTitle('unknown').marker, { lat: 0.001, lon: 0.5 });
  assert.match(byTitle('expired').title, /Изключен/);
  assert.ok(byTitle('expired').lines.some(line => /данните са изтекли/.test(line)));
  assert.equal(byTitle('expired').marker, null);
  assert.ok(byTitle('far').lines.includes('Позиция по линията: извън коридора.'));
  assert.equal(byTitle('far').marker, null);
});

test('a geometric candidate is labelled unconfirmed with its distance in kilometres and metres', () => {
  const candidates = [record('p1', 0.5)];
  const result = evaluateParkingCandidates({
    requestId: 'r', routeRevision: 'route-1', inputRevision: 'input-1',
    geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }], evaluatedAt: T,
    window: { minOffsetM: 0, maxOffsetM: 100_000, maxLateralDistanceM: 500 }, parkingCandidates: candidates
  });
  const [item] = describeParkingResults(result, candidates);
  assert.equal(item.title, 'p1 — Геометричен кандидат — непотвърден');
  assert.equal(item.lines[0], 'На 55.60 км по линията, 111 м встрани.');
  assert.ok(item.lines.includes('Източник по файла: synthetic-file (не е проверен).'));
  assert.deepEqual(item.marker, { lat: 0.001, lon: 0.5 });
  assert.match(parkingTooltipNode(fakeDocument, item).textContent, /Не е избран, резервиран или проверен/);
});

test('ids, sources and unknown field names from the file are shown only as text', () => {
  const evil = '<img src=x onerror="alert(1)">';
  const candidates = [record(evil, 0.5, { sourceId: '<script>bad()</script>' }), { id: 'x', location: { lat: 0, lon: 0.5 }, [evil]: 1 }];
  const result = evaluateParkingCandidates({
    requestId: 'r', routeRevision: 'route-1', inputRevision: 'input-1',
    geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }], evaluatedAt: T,
    window: { minOffsetM: 0, maxOffsetM: 100_000, maxLateralDistanceM: 500 }, parkingCandidates: candidates
  });
  const items = describeParkingResults(result, candidates);
  const nodes = items.map(item => parkingItemNode(fakeDocument, item));
  const text = nodes.map(node => node.allText).join('\n');
  assert.ok(text.includes(evil), 'the id is kept literally as text');
  assert.ok(text.includes('<script>bad()</script>'));
  assert.ok(text.includes(`непознато поле „${evil}“`));
  assert.equal(parkingTooltipNode(fakeDocument, items[0]).textContent.includes(evil), true);
});

test('reason codes have Bulgarian text and unknown codes stay generic', () => {
  assert.equal(reasonText('ambiguous-route-position'), 'неясна позиция — маршрутът минава близо повече от веднъж');
  assert.equal(reasonText('duplicate-id'), 'id се повтаря във файла');
  assert.equal(reasonText('something-new'), 'друга причина');
  assert.equal(reasonText(`unknown-field:${'x'.repeat(200)}`).length < 140, true, 'long field names are shortened');
});
