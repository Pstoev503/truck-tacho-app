import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from './plan.js';
import { indexRoute, pointAtOffset } from './route-position.js';
import { createMapPlan } from './map-plan.js';

const now = Date.parse('2026-10-18T12:00:00Z');
const degreeForMeters = meters => meters / 6_371_000 * 180 / Math.PI;
const dependencies = { buildPlan, indexRoute, pointAtOffset };
const geometryFor = meters => [
  { lat: 0, lon: 0 },
  { lat: 0, lon: degreeForMeters(meters) }
];
const routeLength = geometry => indexRoute(geometry).totalLengthM;

function request(overrides = {}) {
  const { route: routeOverrides = {}, ...topLevelOverrides } = overrides;
  const geometry = routeOverrides.geometry ?? geometryFor(1_000);
  let lengthM = 1_000;
  try {
    lengthM = routeLength(geometry);
  } catch {
    // Invalid fixtures still need a structurally complete request to test validation.
  }
  return {
    schemaVersion: 1,
    requestId: 'request-1',
    routeRevision: 'route-1',
    inputRevision: 'input-1',
    nowUtcMs: now,
    departureUtcMs: now,
    displayTimeZone: 'Europe/Sofia',
    route: {
      geometry,
      geometryKind: 'road-routed',
      source: 'test-route',
      vehicleProfileRef: null,
      roadSections: [{
        id: 'section-1', fromM: 0, toM: lengthM, roadType: 'ordinary', source: 'test'
      }],
      ...routeOverrides
    },
    initialState: { activities: [], lastWeeklyRestEnd: null, source: 'test-log' },
    choices: { breakStyle: '45', multiManning: false, bySection: [] },
    ...topLevelOverrides
  };
}

function fakeEngine(stages, events, extra = {}) {
  return {
    departure: now,
    arrival: events.at(-1)?.end ?? now,
    stages: stages.map(stage => ({ distanceKm: stage.distanceKm })),
    events,
    historyCoverage: { from: now - 1, to: now, observedUntil: now, complete: false, gaps: [] },
    violations: [],
    assumptions: [],
    ignoredExtensions: [],
    ignoredDailyRests: [],
    ...extra
  };
}

function drive(start, distanceM, roadType, stageIndex = 0) {
  return {
    type: 'drive',
    start,
    end: start + distanceM / (({ ordinary: 55, motorway: 80 }[roadType]) * 1000) * 3_600_000,
    stageIndex
  };
}

function execute(input, engineFactory, extraDependencies = {}) {
  let received;
  const result = createMapPlan(input, {
    indexRoute,
    pointAtOffset,
    buildPlan: options => {
      received = options;
      return typeof engineFactory === 'function' ? engineFactory(options) : engineFactory;
    },
    ...extraDependencies
  });
  return { result, received };
}

test('real planner output is estimated and echoes request revisions with route endpoints', () => {
  const input = request();
  const result = createMapPlan(input, dependencies);
  assert.equal(result.state, 'estimated');
  assert.equal(result.requestId, input.requestId);
  assert.equal(result.routeRevision, input.routeRevision);
  assert.equal(result.inputRevision, input.inputRevision);
  assert.equal(result.arrivalUtcMs, result.engineResult.arrival);
  assert.equal(result.events[0].fromPoint.lon, 0);
  assert.ok(Math.abs(result.events.at(-1).toPoint.lon - input.route.geometry.at(-1).lon) < 1e-10);
  assert.equal(result.events.at(-1).stopKind, null);
});

test('maps each leg along a curved polyline rather than its endpoint chord', () => {
  const geometry = [
    { lat: 0, lon: 0 }, { lat: 0, lon: degreeForMeters(500) },
    { lat: degreeForMeters(500), lon: degreeForMeters(500) }
  ];
  const index = indexRoute(geometry);
  const firstLength = index.cumulativeMeters[1];
  const total = index.totalLengthM;
  const input = request({
    route: {
      geometry, roadSections: [{
        id: 'curve', fromM: 0, toM: total, roadType: 'motorway', source: 'test'
      }]
    }
  });
  const events = [
    drive(now, firstLength, 'motorway'),
    drive(now + firstLength / (80 * 1000) * 3_600_000, total - firstLength, 'motorway')
  ];
  const engine = options => fakeEngine(options.stages, events);
  const result = execute(input, engine).result;
  assert.equal(result.state, 'estimated');
  assert.ok(Math.abs(result.events[0].toPoint.lon - geometry[1].lon) < 1e-10);
  assert.ok(Math.abs(result.events[0].toPoint.lat - geometry[1].lat) < 1e-10);
});

test('translates mixed ordinary and motorway sections to exact stage distances and event offsets', () => {
  const geometry = geometryFor(2_000);
  const total = routeLength(geometry);
  const split = total / 2;
  const input = request({
    route: { geometry, roadSections: [
      { id: 'ordinary', fromM: 0, toM: split, roadType: 'ordinary', source: 'manual' },
      { id: 'motorway', fromM: split, toM: total, roadType: 'motorway', source: 'map' }
    ] }
  });
  const { result, received } = execute(input, options => fakeEngine(options.stages, [
    drive(now, split, 'ordinary', 0),
    drive(now + split / (55 * 1000) * 3_600_000, total - split, 'motorway', 1)
  ]));
  assert.equal(received.stages.length, 2);
  assert.ok(Math.abs(received.stages[0].distanceKm - split / 1000) < 1e-9);
  assert.ok(Math.abs(received.stages[1].distanceKm - (total - split) / 1000) < 1e-9);
  assert.deepEqual(result.events.map(event => event.sectionId), ['ordinary', 'motorway']);
  assert.ok(Math.abs(result.events[0].toM - split) < 0.01);
  assert.ok(Math.abs(result.events[1].toM - total) < 0.01);
});

test('a rest in the middle keeps its offset and is only an unassigned theoretical stop', () => {
  const length = routeLength(geometryFor(1_000));
  const firstDistance = length / 2;
  const first = drive(now, firstDistance, 'ordinary');
  const rest = { type: 'rest', start: first.end, end: first.end + 45 * 60_000, stageIndex: 0 };
  const last = drive(rest.end, length - firstDistance, 'ordinary');
  const { result } = execute(request(), options => fakeEngine(options.stages, [first, rest, last]));
  assert.equal(result.events[1].fromM, result.events[1].toM);
  assert.deepEqual(result.events[1].fromPoint, result.events[1].toPoint);
  assert.equal(result.events[1].stopKind, 'unassigned');
});

test('a rest at a section boundary stays at that position and keeps its reported stage', () => {
  const geometry = geometryFor(2_000);
  const total = routeLength(geometry);
  const boundary = total / 2;
  const input = request({ route: { geometry, roadSections: [
    { id: 'first', fromM: 0, toM: boundary, roadType: 'ordinary', source: 'test' },
    { id: 'second', fromM: boundary, toM: total, roadType: 'motorway', source: 'test' }
  ] } });
  const first = drive(now, boundary, 'ordinary');
  const rest = { type: 'rest', start: first.end, end: first.end + 45 * 60_000, stageIndex: 1 };
  const second = drive(rest.end, total - boundary, 'motorway', 1);
  const { result } = execute(input, options => fakeEngine(options.stages, [first, rest, second]));
  assert.equal(result.events[1].sectionId, 'second');
  assert.equal(result.events[1].stageIndex, 1);
  assert.ok(Math.abs(result.events[1].fromM - boundary) <= 0.05);
});

test('duplicate geometry vertices are accepted when route length is positive', () => {
  const geometry = [
    { lat: 0, lon: 0 }, { lat: 0, lon: 0 },
    { lat: 0, lon: degreeForMeters(1_000) }
  ];
  assert.equal(createMapPlan(request({ route: { geometry } }), dependencies).state, 'estimated');
});

test('invalid, zero-length, and unsupported route geometries are refused', () => {
  for (const geometry of [
    [{ lat: 0, lon: 0 }, { lat: 0, lon: 0 }],
    [{ lat: NaN, lon: 0 }, { lat: 0, lon: 1 }],
    [{ lat: 0, lon: 0 }, { lat: 0, lon: 181 }],
    [{ lat: 85, lon: 0 }, { lat: 84, lon: 0 }],
    [{ lat: 0, lon: 179 }, { lat: 0, lon: -179 }]
  ]) {
    assert.equal(createMapPlan(request({ route: { geometry } }), dependencies).state, 'invalid-input');
  }
});

test('road-section gaps are rejected', () => {
  const total = routeLength(geometryFor(2_000));
  const result = createMapPlan(request({ route: { geometry: geometryFor(2_000), roadSections: [
    { id: 'a', fromM: 0, toM: total / 2 - 1, roadType: 'ordinary', source: 'test' },
    { id: 'b', fromM: total / 2, toM: total, roadType: 'ordinary', source: 'test' }
  ] } }), dependencies);
  assert.equal(result.error.code, 'ROAD_SECTIONS_INCONSISTENT');
});

test('road-section overlaps are rejected', () => {
  const total = routeLength(geometryFor(2_000));
  const result = createMapPlan(request({ route: { geometry: geometryFor(2_000), roadSections: [
    { id: 'a', fromM: 0, toM: total / 2, roadType: 'ordinary', source: 'test' },
    { id: 'b', fromM: total / 2 - 1, toM: total, roadType: 'ordinary', source: 'test' }
  ] } }), dependencies);
  assert.equal(result.error.code, 'ROAD_SECTIONS_INCONSISTENT');
});

test('road sections must be in route order', () => {
  const total = routeLength(geometryFor(2_000));
  const result = createMapPlan(request({ route: { geometry: geometryFor(2_000), roadSections: [
    { id: 'b', fromM: total / 2, toM: total, roadType: 'ordinary', source: 'test' },
    { id: 'a', fromM: 0, toM: total / 2, roadType: 'ordinary', source: 'test' }
  ] } }), dependencies);
  assert.equal(result.error.code, 'ROAD_SECTIONS_INCONSISTENT');
});

test('a missing road type needs data and never defaults to motorway', () => {
  const input = request();
  delete input.route.roadSections[0].roadType;
  let called = false;
  const result = createMapPlan(input, { ...dependencies, buildPlan: () => { called = true; } });
  assert.equal(result.state, 'needs-data');
  assert.equal(result.error.code, 'ROAD_TYPE_REQUIRED');
  assert.equal(called, false);
});

test('section boundaries within the numeric tolerance are accepted', () => {
  const total = routeLength(geometryFor(2_000));
  const result = createMapPlan(request({ route: { geometry: geometryFor(2_000), roadSections: [
    { id: 'a', fromM: 0, toM: total / 2 + 0.02, roadType: 'ordinary', source: 'test' },
    { id: 'b', fromM: total / 2 + 0.04, toM: total, roadType: 'motorway', source: 'test' }
  ] } }), dependencies);
  assert.equal(result.state, 'estimated');
});

test('section boundary differences beyond the numeric tolerance are rejected', () => {
  const total = routeLength(geometryFor(2_000));
  const result = createMapPlan(request({ route: { geometry: geometryFor(2_000), roadSections: [
    { id: 'a', fromM: 0, toM: total / 2, roadType: 'ordinary', source: 'test' },
    { id: 'b', fromM: total / 2 + 0.06, toM: total, roadType: 'motorway', source: 'test' }
  ] } }), dependencies);
  assert.equal(result.error.code, 'ROAD_SECTIONS_INCONSISTENT');
});

test('unknown and duplicate section choices are rejected', () => {
  const unknown = request({ choices: {
    breakStyle: '45', multiManning: false,
    bySection: [{ sectionId: 'missing', useExtension: true, dailyRest: 'regular' }]
  } });
  assert.equal(createMapPlan(unknown, dependencies).error.code, 'UNKNOWN_SECTION_ID');
  const duplicate = request({ choices: {
    breakStyle: '45', multiManning: false,
    bySection: [
      { sectionId: 'section-1', useExtension: true, dailyRest: 'regular' },
      { sectionId: 'section-1', useExtension: false, dailyRest: 'reduced' }
    ]
  } });
  assert.equal(createMapPlan(duplicate, dependencies).error.code, 'DUPLICATE_SECTION_CHOICE');
});

test('unknown fields and invalid enum values are rejected rather than discarded', () => {
  assert.equal(createMapPlan(request({ staleOption: true }), dependencies).error.code, 'UNKNOWN_FIELD');
  const invalidRoadType = request();
  invalidRoadType.route.roadSections[0].roadType = 'fast-road';
  assert.equal(createMapPlan(invalidRoadType, dependencies).error.code, 'INVALID_ROAD_TYPE');
  const invalidRequirement = request({ requirements: { newerFeature: true } });
  assert.equal(createMapPlan(invalidRequirement, dependencies).error.code, 'UNKNOWN_FIELD');
});

test('non-finite times and departures before now are rejected', () => {
  assert.equal(createMapPlan(request({ nowUtcMs: Infinity }), dependencies).error.code, 'INVALID_NUMBER');
  assert.equal(createMapPlan(request({ departureUtcMs: now - 1 }), dependencies).error.code, 'DEPARTURE_IN_PAST');
  const invalidActivity = request({
    initialState: { activities: [{ type: 'rest', start: '2026-10-18T12:00:00', end: null }], source: 'test' }
  });
  assert.equal(createMapPlan(invalidActivity, dependencies).error.code, 'INVALID_UTC_TIME');
});

test('invalid IANA display time zones are rejected', () => {
  assert.equal(createMapPlan(request({ displayTimeZone: 'Mars/Olympus' }), dependencies).error.code, 'INVALID_TIME_ZONE');
});

test('history gaps and future departure remain engine data without fabricated rest', () => {
  const input = request({ departureUtcMs: now + 2 * 60 * 60 * 1000 });
  const result = createMapPlan(input, dependencies);
  assert.equal(result.state, 'estimated');
  assert.equal(result.historyCoverage, result.engineResult.historyCoverage);
  assert.equal(result.historyCoverage.complete, false);
  assert.ok(result.historyCoverage.gaps.length > 0);
  assert.equal(result.events[0].startUtcMs, input.departureUtcMs);
  assert.ok(result.events.every(event => event.startUtcMs >= input.departureUtcMs));
  assert.ok(!result.events.some(event =>
    event.type === 'rest' && event.startUtcMs < input.departureUtcMs
  ));
});

test('engine extension and reduced-rest diagnostics pass through unchanged', () => {
  const ignoredExtensions = [{ stageIndex: 0, reason: 'extension exhausted' }];
  const ignoredDailyRests = [{ stageIndex: 0, reason: 'rest limit' }];
  const result = execute(request(), options => fakeEngine(options.stages, [
    drive(now, routeLength(geometryFor(1_000)), 'ordinary')
  ], { ignoredExtensions, ignoredDailyRests })).result;
  assert.equal(result.engineResult.ignoredExtensions, ignoredExtensions);
  assert.equal(result.engineResult.ignoredDailyRests, ignoredDailyRests);
});

test('unsupported requirements and requested stops return no fabricated ETA', () => {
  for (const input of [
    request({ requirements: { liveTraffic: true } }),
    request({ requestedStops: [{ id: 'stop-1', routeOffsetM: 10, kind: 'parking', source: 'user' }] })
  ]) {
    let called = false;
    const result = createMapPlan(input, { ...dependencies, buildPlan: () => { called = true; } });
    assert.equal(result.state, 'unsupported');
    assert.equal(result.arrivalUtcMs, null);
    assert.equal(result.engineResult, null);
    assert.equal(called, false);
  }
});

test('input objects and nested activity records are not mutated', () => {
  const input = request({
    initialState: {
      activities: [{ type: 'rest', start: now - 60_000, end: now }],
      lastWeeklyRestEnd: now - 60_000, source: 'test-log'
    }
  });
  const before = structuredClone(input);
  createMapPlan(input, dependencies);
  assert.deepEqual(input, before);
});

test('each call uses and echoes its own revisions without caching', () => {
  const firstInput = request();
  const secondInput = request({ requestId: 'request-2', routeRevision: 'route-2', inputRevision: 'input-2' });
  const first = createMapPlan(firstInput, dependencies);
  const second = createMapPlan(secondInput, dependencies);
  assert.equal(first.requestId, 'request-1');
  assert.equal(second.requestId, 'request-2');
  assert.equal(second.routeRevision, 'route-2');
  assert.equal(second.inputRevision, 'input-2');
  assert.notEqual(first.engineResult, second.engineResult);
});

test('invalid engine stage indexes return mapping-inconsistent without events or ETA', () => {
  const length = routeLength(geometryFor(1_000));
  const { result } = execute(request(), options => fakeEngine(options.stages, [
    drive(now, length, 'ordinary', 1)
  ]));
  assert.equal(result.state, 'error');
  assert.equal(result.error.code, 'MAPPING_INCONSISTENT');
  assert.deepEqual(result.events, []);
  assert.equal(result.arrivalUtcMs, null);
});

test('engine event distance beyond its road section is rejected without clamping', () => {
  const length = routeLength(geometryFor(1_000));
  const { result } = execute(request(), options => fakeEngine(options.stages, [
    drive(now, length + 1, 'ordinary')
  ]));
  assert.equal(result.state, 'error');
  assert.equal(result.error.code, 'MAPPING_INCONSISTENT');
  assert.deepEqual(result.events, []);
});

test('missing engine history coverage becomes needs-data and is not inferred', () => {
  const length = routeLength(geometryFor(1_000));
  const { result } = execute(request(), options => fakeEngine(options.stages, [
    drive(now, length, 'ordinary')
  ], { historyCoverage: undefined }));
  assert.equal(result.state, 'needs-data');
  assert.equal(result.error.code, 'ENGINE_VERSION_MISMATCH');
  assert.equal(result.historyCoverage, null);
  assert.deepEqual(result.events, []);
});

test('engine violations remain visible and never change estimated to legal approval', () => {
  const length = routeLength(geometryFor(1_000));
  const violations = [{ code: 'LIMIT_EXCEEDED' }];
  const result = execute(request(), options => fakeEngine(options.stages, [
    drive(now, length, 'ordinary')
  ], { violations })).result;
  assert.equal(result.state, 'estimated');
  assert.equal(result.capabilities.legalApproval, false);
  const warning = result.warnings.find(item => item.code === 'ENGINE_VIOLATIONS');
  assert.ok(warning);
  assert.equal(warning.violations, violations);
});

test('manual route and multi-manning assumptions remain explicit', () => {
  const input = request({
    route: {
      geometryKind: 'manual-sketch',
      roadSections: [{
        id: 'section-1', fromM: 0, toM: routeLength(geometryFor(1_000)),
        roadType: 'ordinary', source: 'manual'
      }]
    },
    choices: { breakStyle: '45', multiManning: true, bySection: [] }
  });
  const length = routeLength(geometryFor(1_000));
  const result = execute(input, options => fakeEngine(options.stages, [
    drive(now, length, 'ordinary')
  ])).result;
  assert.ok(result.warnings.some(warning => warning.code === 'MANUAL_SKETCH'));
  assert.ok(result.warnings.some(warning => warning.code === 'MULTI_MANNING_UNVERIFIED'));
  assert.equal(result.capabilities.legalApproval, false);
});

test('engine failures are reported without an estimated arrival', () => {
  const result = execute(request(), () => { throw new Error('engine failed'); }).result;
  assert.equal(result.state, 'error');
  assert.equal(result.error.code, 'ENGINE_ERROR');
  assert.equal(result.arrivalUtcMs, null);
  assert.equal(result.engineResult, null);
});
