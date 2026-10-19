import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateParkingCandidates, MAX_PARKING_CANDIDATES } from './parking-candidates.js';
import { indexRoute, projectToRoute } from './route-position.js';

// Synthetic data only. T is 2026-10-19T00:00:00Z; one degree on the equator is ~111.2 km.
const T = Date.UTC(2026, 9, 19);
const MIN = 60 * 1000;
const STRAIGHT = [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 0, lon: 2 }];
const STRAIGHT_LENGTH_M = indexRoute(STRAIGHT).totalLengthM;
const closeTo = (actual, expected, tolerance) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} not within ${tolerance} of ${expected}`);

function parking(id, lon, extra = {}) {
  return {
    id,
    location: { lat: 0.001, lon },
    sourceId: 'synthetic-feed',
    observedAt: T - 10 * MIN,
    expiresAt: T + 50 * MIN,
    truckAccess: 'allowed',
    availability: 'available',
    ...extra
  };
}

function request(parkingCandidates, overrides = {}) {
  return {
    requestId: 'req-1',
    routeRevision: 'route-7',
    inputRevision: 'input-3',
    geometry: STRAIGHT,
    evaluatedAt: T,
    window: { minOffsetM: 0, maxOffsetM: STRAIGHT_LENGTH_M, maxLateralDistanceM: 500 },
    parkingCandidates,
    ...overrides
  };
}

const byId = (result, id) => {
  const found = result.results.filter(r => r.id === id);
  assert.equal(found.length, 1, `expected exactly one result for ${id}`);
  return found[0];
};

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

test('fresh, allowed, available parking near the route is a geometric candidate with offsets in meters', () => {
  const result = evaluateParkingCandidates(request([parking('p1', 0.5)]));
  assert.equal(result.status, 'evaluated');
  assert.deepEqual(result.errors, []);
  const p1 = byId(result, 'p1');
  assert.equal(p1.projectionStatus, 'matched');
  assert.equal(p1.disposition, 'geometric-candidate');
  assert.equal(p1.evidenceState, 'fresh');
  assert.equal(p1.withinWindow, true);
  assert.deepEqual(p1.reasons, []);
  closeTo(p1.routeOffsetM, 55_597.5, 1);
  closeTo(p1.lateralDistanceM, 111.2, 0.1);
  closeTo(result.routeLengthM, 222_389.9, 1);
  assert.deepEqual(result.candidateIds, ['p1']);
  assert.deepEqual(result.summary, { total: 1, geometricCandidates: 1, needsVerification: 0, excluded: 0, invalid: 0 });
});

test('a geometric candidate stays unverified, unreserved and unselected', () => {
  const result = evaluateParkingCandidates(request([parking('p1', 0.5), parking('p2', 1.5)]));
  assert.equal(result.selectedParkingId, null);
  assert.equal(result.accessVerified, false);
  assert.equal(result.reservationConfirmed, false);
  for (const r of result.results) {
    assert.equal(r.disposition, 'geometric-candidate');
    assert.equal(r.accessVerified, false);
    assert.equal(r.reservationConfirmed, false);
  }
  assert.ok(result.limitations.some(text => /not verified/.test(text)));
  assert.ok(result.limitations.some(text => /No parking is selected or reserved/.test(text)));
});

test('window is measured along the route: before, after and inside', () => {
  const window = { minOffsetM: 60_000, maxOffsetM: 160_000, maxLateralDistanceM: 500 };
  const result = evaluateParkingCandidates(request(
    [parking('before', 0.5), parking('inside', 1.0), parking('after', 1.5)], { window }));
  assert.equal(byId(result, 'inside').disposition, 'geometric-candidate');
  for (const id of ['before', 'after']) {
    const r = byId(result, id);
    assert.equal(r.projectionStatus, 'matched');
    assert.equal(r.withinWindow, false);
    assert.equal(r.disposition, 'excluded');
    assert.deepEqual(r.reasons, ['outside-window']);
    assert.equal(typeof r.routeOffsetM, 'number');
  }
});

test('window boundaries are inclusive and one millimetre outside is excluded', () => {
  const offset = projectToRoute(indexRoute(STRAIGHT), { lat: 0.001, lon: 0.5 }, { maxDistanceM: 500 }).routeOffsetM;
  const at = (minOffsetM, maxOffsetM) => byId(evaluateParkingCandidates(request([parking('p', 0.5)], {
    window: { minOffsetM, maxOffsetM, maxLateralDistanceM: 500 }
  })), 'p');
  assert.equal(at(offset, STRAIGHT_LENGTH_M).disposition, 'geometric-candidate');
  assert.equal(at(0, offset).disposition, 'geometric-candidate');
  assert.equal(at(offset, offset).disposition, 'geometric-candidate');
  assert.equal(at(offset + 0.001, STRAIGHT_LENGTH_M).disposition, 'excluded');
  assert.equal(at(0, offset - 0.001).disposition, 'excluded');
});

test('corridor boundary is inclusive; beyond it the parking is off-route with null offsets', () => {
  const lateral = projectToRoute(indexRoute(STRAIGHT), { lat: 0.001, lon: 0.5 }, { maxDistanceM: 500 }).lateralDistanceM;
  const at = maxLateralDistanceM => byId(evaluateParkingCandidates(request([parking('p', 0.5)], {
    window: { minOffsetM: 0, maxOffsetM: STRAIGHT_LENGTH_M, maxLateralDistanceM }
  })), 'p');
  const inside = at(lateral);
  assert.equal(inside.projectionStatus, 'matched');
  assert.equal(inside.disposition, 'geometric-candidate');
  assert.equal(inside.lateralDistanceM, lateral);

  const outside = at(lateral - 0.001);
  assert.equal(outside.projectionStatus, 'off-route');
  assert.equal(outside.disposition, 'excluded');
  assert.deepEqual(outside.reasons, ['outside-corridor']);
  assert.equal(outside.routeOffsetM, null);
  assert.equal(outside.lateralDistanceM, null);
  assert.equal(outside.withinWindow, null);
});

test('a far parking is not snapped to the window edge', () => {
  // The parking is next to the route at ~167 km, the window ends at 60 km.
  const result = evaluateParkingCandidates(request([parking('far', 1.5)], {
    window: { minOffsetM: 0, maxOffsetM: 60_000, maxLateralDistanceM: 500 }
  }));
  const far = byId(result, 'far');
  assert.equal(far.projectionStatus, 'matched');
  closeTo(far.routeOffsetM, 166_792, 2);
  assert.equal(far.disposition, 'excluded');
  assert.deepEqual(far.reasons, ['outside-window']);
});

test('curved route: the window uses distance along the route, not the straight line from the start', () => {
  const curved = [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }];
  const index = indexRoute(curved);
  // A parking beside the second leg at lat 0.5: ~1.5 degrees along the route,
  // but only ~1.12 degrees in a straight line from the start.
  const location = { lat: 0.5, lon: 1.001 };
  const projected = projectToRoute(index, location, { maxDistanceM: 500 });
  const along = projected.routeOffsetM;
  const straight = projectToRoute(indexRoute([{ lat: 0, lon: 0 }, location]), location, { maxDistanceM: 1 }).routeOffsetM;
  assert.ok(along - straight > 40_000, 'the two distances must differ clearly');

  const evaluate = window => byId(evaluateParkingCandidates(request(
    [parking('bend', 1, { location })], { geometry: curved, window: { ...window, maxLateralDistanceM: 500 } })), 'bend');
  const alongWindow = evaluate({ minOffsetM: along - 1_000, maxOffsetM: along + 1_000 });
  assert.equal(alongWindow.disposition, 'geometric-candidate');
  assert.equal(alongWindow.routeOffsetM, along);
  const straightWindow = evaluate({ minOffsetM: straight - 1_000, maxOffsetM: straight + 1_000 });
  assert.equal(straightWindow.disposition, 'excluded');
  assert.deepEqual(straightWindow.reasons, ['outside-window']);
});

test('out-and-back loop: a parking beside both legs stays ambiguous and is not assigned to either side', () => {
  const loop = [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 0, lon: 0 }];
  const total = indexRoute(loop).totalLengthM;
  for (const window of [
    { minOffsetM: 0, maxOffsetM: total, maxLateralDistanceM: 500 },
    { minOffsetM: 0, maxOffsetM: total / 2, maxLateralDistanceM: 500 }
  ]) {
    const r = byId(evaluateParkingCandidates(request([parking('loop', 0.5)], { geometry: loop, window })), 'loop');
    assert.equal(r.projectionStatus, 'ambiguous');
    assert.equal(r.disposition, 'excluded');
    assert.deepEqual(r.reasons, ['ambiguous-route-position']);
    assert.equal(r.routeOffsetM, null);
    assert.equal(r.lateralDistanceM, null);
    assert.equal(r.withinWindow, null);
  }
});

test('self-crossing route: a parking at the crossing is ambiguous', () => {
  const crossing = [{ lat: 0, lon: 0 }, { lat: 0, lon: 2 }, { lat: 1, lon: 2 }, { lat: 1, lon: 1 }, { lat: -1, lon: 1 }];
  const r = byId(evaluateParkingCandidates(request([parking('x', 1, { location: { lat: 0.0005, lon: 1.0005 } })], {
    geometry: crossing,
    window: { minOffsetM: 0, maxOffsetM: indexRoute(crossing).totalLengthM, maxLateralDistanceM: 500 }
  })), 'x');
  assert.equal(r.projectionStatus, 'ambiguous');
  assert.equal(r.disposition, 'excluded');
  assert.equal(r.routeOffsetM, null);
});

test('expiry boundary: evaluatedAt equal to expiresAt is expired, one millisecond before is fresh', () => {
  const result = evaluateParkingCandidates(request([
    parking('exact', 0.5, { expiresAt: T }),
    parking('before', 1.5, { expiresAt: T + 1 })
  ]));
  const exact = byId(result, 'exact');
  assert.equal(exact.evidenceState, 'expired');
  assert.equal(exact.disposition, 'excluded');
  assert.deepEqual(exact.reasons, ['expired']);
  const before = byId(result, 'before');
  assert.equal(before.evidenceState, 'fresh');
  assert.equal(before.disposition, 'geometric-candidate');
});

test('missing source or times make evidence unknown, never fresh, and no default TTL is invented', () => {
  const result = evaluateParkingCandidates(request([
    parking('no-source', 0.2, { sourceId: undefined }),
    parking('no-observed', 0.4, { observedAt: undefined }),
    parking('no-expiry', 0.6, { expiresAt: undefined }),
    parking('null-times', 0.8, { observedAt: null, expiresAt: null }),
    parking('old-no-expiry', 1.0, { observedAt: 0, expiresAt: undefined })
  ]));
  const expected = {
    'no-source': ['source-unknown'],
    'no-observed': ['observed-at-unknown'],
    'no-expiry': ['expires-at-unknown'],
    'null-times': ['observed-at-unknown', 'expires-at-unknown'],
    'old-no-expiry': ['expires-at-unknown']
  };
  for (const [id, reasons] of Object.entries(expected)) {
    const r = byId(result, id);
    assert.equal(r.evidenceState, 'unknown', id);
    assert.equal(r.disposition, 'needs-verification', id);
    assert.deepEqual(r.reasons, reasons, id);
  }
  assert.deepEqual(result.candidateIds, []);
  assert.equal(result.needsVerificationIds.length, 5);
});

test('unknown or missing access and availability need verification', () => {
  const result = evaluateParkingCandidates(request([
    parking('access-unknown', 0.2, { truckAccess: 'unknown' }),
    parking('availability-unknown', 0.4, { availability: 'unknown' }),
    parking('both-missing', 0.6, { truckAccess: undefined, availability: undefined })
  ]));
  assert.deepEqual(byId(result, 'access-unknown').reasons, ['truck-access-unknown']);
  assert.deepEqual(byId(result, 'availability-unknown').reasons, ['availability-unknown']);
  const missing = byId(result, 'both-missing');
  assert.equal(missing.truckAccess, 'unknown');
  assert.equal(missing.availability, 'unknown');
  assert.deepEqual(missing.reasons, ['truck-access-unknown', 'availability-unknown']);
  for (const r of result.results) assert.equal(r.disposition, 'needs-verification');
});

test('reported prohibited or full parking is excluded even with fresh evidence', () => {
  const result = evaluateParkingCandidates(request([
    parking('prohibited', 0.5, { truckAccess: 'prohibited' }),
    parking('full', 1.5, { availability: 'full' }),
    parking('full-unknown-source', 1.0, { availability: 'full', sourceId: undefined })
  ]));
  assert.deepEqual(byId(result, 'prohibited').reasons, ['truck-access-prohibited']);
  assert.deepEqual(byId(result, 'full').reasons, ['reported-full']);
  assert.deepEqual(byId(result, 'full-unknown-source').reasons, ['source-unknown', 'reported-full']);
  for (const r of result.results) assert.equal(r.disposition, 'excluded');
});

test('observation in the future and expiry before observation are invalid records', () => {
  const result = evaluateParkingCandidates(request([
    parking('future', 0.5, { observedAt: T + 1, expiresAt: T + 60 * MIN }),
    parking('reversed', 1.0, { observedAt: T - 10 * MIN, expiresAt: T - 20 * MIN }),
    parking('ok', 1.5)
  ]));
  assert.deepEqual(byId(result, 'future').reasons, ['observed-in-future']);
  assert.deepEqual(byId(result, 'reversed').reasons, ['expires-before-observed']);
  for (const id of ['future', 'reversed']) {
    const r = byId(result, id);
    assert.equal(r.disposition, 'invalid');
    assert.equal(r.evidenceState, null);
    assert.equal(r.routeOffsetM, null);
  }
  assert.equal(byId(result, 'ok').disposition, 'geometric-candidate');
});

test('non-numeric, fractional, negative and non-finite record times are invalid', () => {
  const bad = [['string', '1760832000000'], ['fraction', T - 0.5], ['negative', -1], ['nan', NaN], ['infinity', Infinity]];
  const result = evaluateParkingCandidates(request([
    ...bad.map(([id, value], i) => parking(`observed-${id}`, 0.1 + i * 0.1, { observedAt: value })),
    ...bad.map(([id, value], i) => parking(`expires-${id}`, 1.1 + i * 0.1, { expiresAt: value }))
  ]));
  for (const [id] of bad) {
    assert.deepEqual(byId(result, `observed-${id}`).reasons, ['invalid-observedAt']);
    assert.deepEqual(byId(result, `expires-${id}`).reasons, ['invalid-expiresAt']);
  }
  assert.equal(result.summary.invalid, 10);
});

test('malformed records are invalid on their own and valid records are kept', () => {
  const result = evaluateParkingCandidates(request([
    null,
    'p',
    { ...parking('', 0.2) },
    parking('bad-location', 0.3, { location: { lat: NaN, lon: 0.3 } }),
    parking('bad-lon', 0.4, { location: { lat: 0, lon: 181 } }),
    parking('bad-access', 0.5, { truckAccess: 'yes' }),
    parking('bad-availability', 0.6, { availability: 3 }),
    parking('bad-source', 0.7, { sourceId: '' }),
    parking('extra', 0.8, { spaces: 12 }),
    parking('polar', 0.9, { location: { lat: 89, lon: 0 } }),
    parking('good', 1.5)
  ]));
  assert.equal(result.status, 'evaluated');
  assert.equal(result.summary.total, 11);
  assert.equal(result.summary.invalid, 10);
  assert.deepEqual(result.candidateIds, ['good']);
  const reasons = Object.fromEntries(result.results.filter(r => r.id).map(r => [r.id, r.reasons]));
  assert.deepEqual(reasons['bad-location'], ['invalid-location']);
  assert.deepEqual(reasons['bad-lon'], ['invalid-location']);
  assert.deepEqual(reasons['bad-access'], ['invalid-truck-access']);
  assert.deepEqual(reasons['bad-availability'], ['invalid-availability']);
  assert.deepEqual(reasons['bad-source'], ['invalid-source-id']);
  assert.deepEqual(reasons.extra, ['unknown-field:spaces']);
  assert.deepEqual(reasons.polar, ['unsupported-location']);
  const anonymous = result.results.filter(r => r.id === null).map(r => [r.inputIndex, r.reasons]);
  assert.deepEqual(anonymous, [[0, ['invalid-record']], [1, ['invalid-record']], [2, ['invalid-id']]]);
});

test('duplicate IDs are reported and none of the duplicates becomes a candidate', () => {
  const result = evaluateParkingCandidates(request([
    parking('dup', 0.5), parking('unique', 1.0), parking('dup', 1.5), parking('dup', 1.7)
  ]));
  assert.deepEqual(result.duplicateIds, ['dup']);
  const dups = result.results.filter(r => r.id === 'dup');
  assert.equal(dups.length, 3);
  for (const r of dups) {
    assert.equal(r.disposition, 'invalid');
    assert.deepEqual(r.reasons, ['duplicate-id']);
  }
  assert.deepEqual(dups.map(r => r.inputIndex), [0, 2, 3]);
  assert.deepEqual(result.candidateIds, ['unique']);
});

test('missing or invalid geometry is a structured top-level error with the echo IDs', () => {
  const missing = evaluateParkingCandidates(request([parking('p', 0.5)], { geometry: undefined }));
  assert.equal(missing.status, 'invalid-input');
  assert.deepEqual(missing.errors.map(e => [e.code, e.field]), [['ROUTE_GEOMETRY_REQUIRED', 'geometry']]);
  assert.deepEqual(missing.results, []);
  assert.equal(missing.requestId, 'req-1');
  assert.equal(missing.selectedParkingId, null);

  for (const geometry of [[{ lat: 0, lon: 0 }], [{ lat: 0, lon: 179 }, { lat: 0, lon: -179 }],
    [{ lat: 0, lon: 0 }, { lat: 0, lon: 0 }], [{ lat: 86, lon: 0 }, { lat: 86, lon: 1 }]]) {
    const result = evaluateParkingCandidates(request([parking('p', 0.5)], { geometry }));
    assert.equal(result.status, 'invalid-input');
    assert.equal(result.errors[0].code, 'INVALID_ROUTE_GEOMETRY');
    assert.equal(result.errors[0].field, 'geometry');
  }
});

test('invalid echo IDs, request shape and evaluatedAt are reported together', () => {
  const result = evaluateParkingCandidates(request([], {
    requestId: '', routeRevision: 7, inputRevision: '  ', evaluatedAt: T + 0.5, extra: true
  }));
  assert.equal(result.status, 'invalid-input');
  assert.deepEqual(result.errors.map(e => e.field).sort(),
    ['evaluatedAt', 'inputRevision', 'request.extra', 'requestId', 'routeRevision']);
  assert.equal(result.requestId, null);
  assert.equal(result.routeRevision, null);
  assert.equal(result.inputRevision, null);

  for (const bad of [null, [], 'request']) {
    const r = evaluateParkingCandidates(bad);
    assert.equal(r.status, 'invalid-input');
    assert.deepEqual(r.errors.map(e => e.code), ['INVALID_REQUEST']);
  }
});

test('NaN, negative, reversed and too long windows are rejected without guessing', () => {
  const cases = [
    [{ minOffsetM: NaN, maxOffsetM: 1000, maxLateralDistanceM: 500 }, 'window.minOffsetM'],
    [{ minOffsetM: 0, maxOffsetM: 1000, maxLateralDistanceM: -1 }, 'window.maxLateralDistanceM'],
    [{ minOffsetM: 0, maxOffsetM: '1000', maxLateralDistanceM: 500 }, 'window.maxOffsetM'],
    [{ minOffsetM: 2000, maxOffsetM: 1000, maxLateralDistanceM: 500 }, 'window'],
    [{ minOffsetM: 0, maxOffsetM: STRAIGHT_LENGTH_M + 1, maxLateralDistanceM: 500 }, 'window.maxOffsetM'],
    [{ minOffsetM: 0, maxOffsetM: 1000 }, 'window.maxLateralDistanceM'],
    [{ minOffsetM: 0, maxOffsetM: 1000, maxLateralDistanceM: 500, widthKm: 1 }, 'window.widthKm'],
    [undefined, 'window']
  ];
  for (const [window, field] of cases) {
    const result = evaluateParkingCandidates(request([parking('p', 0.5)], { window }));
    assert.equal(result.status, 'invalid-input', field);
    assert.deepEqual(result.errors.map(e => e.field), [field]);
  }
});

test('candidate list must be an array of at most the top limit', () => {
  const atLimit = Array.from({ length: MAX_PARKING_CANDIDATES }, (_, i) => parking(`p${i}`, 0.001 * (i + 1)));
  assert.equal(MAX_PARKING_CANDIDATES, 1000);
  const ok = evaluateParkingCandidates(request(atLimit));
  assert.equal(ok.status, 'evaluated');
  assert.equal(ok.summary.total, 1000);
  assert.equal(ok.summary.geometricCandidates, 1000);

  const over = evaluateParkingCandidates(request([...atLimit, parking('one-more', 1.5)]));
  assert.equal(over.status, 'invalid-input');
  assert.deepEqual(over.errors.map(e => e.code), ['TOO_MANY_CANDIDATES']);

  for (const parkingCandidates of [undefined, {}, 'p']) {
    const r = evaluateParkingCandidates(request(parkingCandidates));
    assert.deepEqual(r.errors.map(e => e.code), ['INVALID_CANDIDATES']);
  }
  const empty = evaluateParkingCandidates(request([]));
  assert.equal(empty.status, 'evaluated');
  assert.deepEqual(empty.results, []);
});

test('deep-frozen input is accepted and left unchanged', () => {
  const input = request([parking('p1', 0.5), parking('p2', 1.5, { truckAccess: 'unknown' }), parking('p3', 1.0, { expiresAt: T })]);
  const snapshot = structuredClone(input);
  deepFreeze(input);
  const result = evaluateParkingCandidates(input);
  assert.equal(result.status, 'evaluated');
  assert.deepEqual(input, snapshot);
  assert.notEqual(result.results[0], input.parkingCandidates[0]);
  assert.notEqual(result.window, input.window);
});

test('same geometry with a different revision echoes the new IDs and gives the same evaluation', () => {
  const candidates = [parking('p1', 0.5), parking('p2', 1.5, { availability: 'unknown' })];
  const a = evaluateParkingCandidates(request(candidates));
  const b = evaluateParkingCandidates(request(candidates, { requestId: 'req-2', routeRevision: 'route-8', inputRevision: 'input-4' }));
  assert.deepEqual([a.requestId, a.routeRevision, a.inputRevision], ['req-1', 'route-7', 'input-3']);
  assert.deepEqual([b.requestId, b.routeRevision, b.inputRevision], ['req-2', 'route-8', 'input-4']);
  assert.deepEqual(b.results, a.results);
});

test('output order is deterministic and independent of input order', () => {
  const candidates = [
    parking('c-late', 1.5),
    parking('a-unknown', 0.3, { sourceId: undefined }),
    parking('b-off', 1.0, { location: { lat: 0.5, lon: 1.0 } }),
    parking('d-early', 0.5),
    { id: 'e-bad' },
    parking('f-same-offset-farther', 0.5, { location: { lat: 0.002, lon: 0.5 } }),
    parking('g-unknown', 0.1, { truckAccess: 'unknown' })
  ];
  const expected = ['d-early', 'f-same-offset-farther', 'c-late', 'g-unknown', 'a-unknown', 'b-off', 'e-bad'];
  const forward = evaluateParkingCandidates(request(candidates));
  const reversed = evaluateParkingCandidates(request([...candidates].reverse()));
  assert.deepEqual(forward.results.map(r => r.id), expected);
  assert.deepEqual(reversed.results.map(r => r.id), expected);
  assert.deepEqual(forward.candidateIds, ['d-early', 'f-same-offset-farther', 'c-late']);
  assert.deepEqual(forward.needsVerificationIds, ['g-unknown', 'a-unknown']);
  const strip = result => result.results.map(({ inputIndex, ...rest }) => rest);
  assert.deepEqual(strip(reversed), strip(forward));
});

test('null offsets stay null and are never reported as zero', () => {
  const result = evaluateParkingCandidates(request([
    parking('off', 1.0, { location: { lat: 0.5, lon: 1.0 } }),
    parking('start', 0, { location: { lat: 0.001, lon: 0 } })
  ]));
  const off = byId(result, 'off');
  assert.equal(off.routeOffsetM, null);
  assert.equal(off.lateralDistanceM, null);
  const start = byId(result, 'start');
  assert.equal(start.routeOffsetM, 0);
  assert.equal(start.disposition, 'geometric-candidate');
  assert.deepEqual(result.candidateIds, ['start']);
});

test('evaluation does not depend on the wall clock', () => {
  const input = request([parking('p1', 0.5, { observedAt: 1000, expiresAt: 2000 })], { evaluatedAt: 1500 });
  const realNow = Date.now;
  try {
    Date.now = () => { throw new Error('Date.now must not be used'); };
    const result = evaluateParkingCandidates(input);
    assert.equal(byId(result, 'p1').evidenceState, 'fresh');
    assert.equal(result.evaluatedAt, 1500);
  } finally {
    Date.now = realNow;
  }
});
