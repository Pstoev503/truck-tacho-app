import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMapPlannerController, formatSofiaTime, formatViolation, sampleRoute } from './map-planner.mjs';
import { buildPlan } from '../engine/plan.js';
import { indexRoute, pointAtOffset } from '../engine/route-position.js';
import { createMapPlan } from '../engine/map-plan.js';
import { analyze } from '../engine/tacho-rules.js';
import { evaluateParkingCandidates } from '../engine/parking-candidates.js';
import { parseDraftText } from './planner-draft.mjs';

const fixedNow = Date.parse('2026-10-19T08:00:00Z');
const dependencies = { buildPlan, indexRoute, pointAtOffset };
const coordinateForMeters = meters => meters / 6_371_000 * 180 / Math.PI;
const makeController = overrides => {
  const controller = createMapPlannerController({
    now: () => fixedNow,
    ...overrides
  });
  controller.chooseNoHistory();
  return controller;
};
const echoed = (request, result = { state: 'needs-data' }) => ({
  requestId: request.requestId,
  routeRevision: request.routeRevision,
  inputRevision: request.inputRevision,
  ...result
});
const twoPoints = (controller, distanceM = 1_000) => {
  controller.addPoint({ lat: 0, lon: 0 });
  controller.addPoint({ lat: 0, lon: coordinateForMeters(distanceM) });
};
const readyController = (overrides = {}, distanceM = 1_000) => {
  const controller = makeController(overrides);
  twoPoints(controller, distanceM);
  controller.setRoadType(0, 'ordinary');
  return controller;
};

test('add, drag, remove-last and clear update ordered geometry and route revisions', () => {
  const controller = makeController();
  controller.addPoint({ lat: 1, lon: 2 });
  controller.addPoint({ lat: 3, lon: 4 });
  assert.deepEqual(controller.getState().points, [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }]);
  assert.equal(controller.getState().routeRevision, 2);
  controller.dragPoint(1, { lat: 5, lon: 6 });
  assert.equal(controller.getState().points[1].lat, 5);
  assert.equal(controller.getState().routeRevision, 3);
  assert.equal(controller.removeLastPoint(), true);
  assert.equal(controller.getState().points.length, 1);
  controller.clear();
  assert.equal(controller.getState().points.length, 0);
});

test('removing the final edge also removes its old section choices', () => {
  const controller = makeController();
  controller.addPoint({ lat: 0, lon: 0 });
  controller.addPoint({ lat: 0, lon: 0.01 });
  controller.addPoint({ lat: 0, lon: 0.02 });
  controller.setChoice('section-2', { useExtension: true, dailyRest: 'reduced' });
  controller.removeLastPoint();
  assert.deepEqual(controller.getState().choices, {});
});

test('invalid coordinate ranges are rejected', () => {
  const controller = makeController();
  assert.throws(() => controller.addPoint({ lat: 85, lon: 0 }), /поддържаните координати/);
  assert.throws(() => controller.addPoint({ lat: 0, lon: NaN }), /поддържаните координати/);
});

test('road type changes route and input revisions; choices and departure change input only', () => {
  const controller = makeController();
  twoPoints(controller);
  const initialRouteRevision = controller.getState().routeRevision;
  const initialInputRevision = controller.getState().inputRevision;
  controller.setRoadType(0, 'motorway');
  assert.equal(controller.getState().routeRevision, initialRouteRevision + 1);
  assert.equal(controller.getState().inputRevision, initialInputRevision + 1);
  const routeRevision = controller.getState().routeRevision;
  controller.setChoice('section-1', { useExtension: true, dailyRest: 'reduced' });
  controller.setDeparture({ mode: 'relative', hours: 2, minutes: 15 });
  assert.equal(controller.getState().routeRevision, routeRevision);
  assert.equal(controller.getState().inputRevision, initialInputRevision + 3);
});

test('planning requires an explicit road type and never defaults to motorway', async () => {
  const controller = makeController();
  twoPoints(controller);
  const result = await controller.plan();
  assert.equal(result.result, null);
  assert.match(result.error, /изричен тип път/);
  assert.deepEqual(controller.getState().roadTypes, [null]);
});

test('sections use indexed spherical distances, remain contiguous, and skip duplicate vertices', async () => {
  let received;
  const controller = makeController({ adapter: request => {
    received = request;
    return echoed(request);
  } });
  controller.addPoint({ lat: 0, lon: 0 });
  controller.addPoint({ lat: 0, lon: 0 });
  controller.addPoint({ lat: 0, lon: coordinateForMeters(1_000) });
  controller.setRoadType(1, 'ordinary');
  await controller.plan();
  assert.equal(received.route.roadSections.length, 1);
  assert.equal(received.route.roadSections[0].id, 'section-2');
  assert.equal(received.route.roadSections[0].fromM, 0);
  assert.ok(Math.abs(received.route.roadSections[0].toM - 1_000) < 0.01);
});

test('three-point plans keep mixed road types in ordered contiguous sections', async () => {
  let received;
  const controller = makeController({ adapter: request => {
    received = request;
    return echoed(request);
  } });
  controller.addPoint({ lat: 0, lon: 0 });
  controller.addPoint({ lat: 0, lon: coordinateForMeters(1_000) });
  controller.addPoint({ lat: coordinateForMeters(1_000), lon: coordinateForMeters(1_000) });
  controller.setRoadType(0, 'motorway');
  controller.setRoadType(1, 'ordinary');
  await controller.plan();
  const sections = received.route.roadSections;
  assert.deepEqual(sections.map(section => section.roadType), ['motorway', 'ordinary']);
  assert.equal(sections[0].fromM, 0);
  assert.equal(sections[0].toM, sections[1].fromM);
  assert.equal(sections[1].toM, indexRoute(received.route.geometry).totalLengthM);
});

test('choice requests are explicit for every positive section', async () => {
  let received;
  const controller = makeController({ adapter: request => {
    received = request;
    return echoed(request);
  } });
  twoPoints(controller);
  controller.setRoadType(0, 'motorway');
  controller.setChoice('section-1', { useExtension: true, dailyRest: 'reduced' });
  await controller.plan();
  assert.deepEqual(received.choices.bySection, [{
    sectionId: 'section-1', useExtension: true, dailyRest: 'reduced'
  }]);
});

test('relative departure samples the injected clock once and uses UTC arithmetic', async () => {
  let calls = 0, received;
  const controller = makeController({
    now: () => { calls++; return fixedNow; },
    adapter: request => { received = request; return echoed(request); }
  });
  twoPoints(controller);
  controller.setRoadType(0, 'ordinary');
  controller.setDeparture({ mode: 'relative', hours: 3, minutes: 25 });
  await controller.plan();
  assert.equal(calls, 1);
  assert.equal(received.nowUtcMs, fixedNow);
  assert.equal(received.departureUtcMs, fixedNow + 3 * 60 * 60_000 + 25 * 60_000);
});

test('clock and display time are independent of host timezone', () => {
  const originalTimezone = process.env.TZ;
  process.env.TZ = 'Pacific/Honolulu';
  try {
    assert.equal(formatSofiaTime(Date.parse('2026-01-15T12:00:00Z')), '15.01.2026 г., 14:00');
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  }
});

test('real map-plan adapter maps actual engine output into estimated events', async () => {
  const controller = readyController({ adapter: request => createMapPlan(request, dependencies) });
  const planned = await controller.plan();
  assert.equal(planned.result.state, 'estimated');
  assert.equal(planned.result.engineResult.departure, fixedNow);
  assert.ok(planned.result.events.length > 0);
});

test('the input geometry passed to planning is copied and not mutated', async () => {
  const original = [{ lat: 0, lon: 0 }, { lat: 0, lon: coordinateForMeters(1_000) }];
  const controller = makeController({ adapter: request => {
    request.route.geometry[0].lat = 10;
    return echoed(request);
  } });
  controller.addPoint(original[0]);
  controller.addPoint(original[1]);
  controller.setRoadType(0, 'ordinary');
  await controller.plan();
  assert.deepEqual(original, [{ lat: 0, lon: 0 }, { lat: 0, lon: coordinateForMeters(1_000) }]);
  assert.equal(controller.getState().points[0].lat, 0);
});

test('late plan is rejected after a route revision', async () => {
  let resolve;
  const controller = readyController({ adapter: request => new Promise(done => {
    resolve = result => done(echoed(request, result));
  }) });
  const pending = controller.plan();
  controller.dragPoint(1, { lat: 0, lon: 0.02 });
  resolve({ state: 'estimated', arrivalUtcMs: fixedNow });
  assert.equal((await pending).stale, true);
  assert.equal(controller.getState().result, null);
});

test('late plan is rejected after input change and after a newer request', async () => {
  const resolvers = [];
  const controller = readyController({ adapter: request => new Promise(resolve =>
    resolvers.push(result => resolve(echoed(request, result)))) });
  const first = controller.plan();
  controller.setDeparture({ mode: 'relative', hours: 1, minutes: 0 });
  const second = controller.plan();
  resolvers[0]({ state: 'estimated', id: 'old-input' });
  assert.equal((await first).stale, true);
  resolvers[1]({ state: 'estimated', id: 'current' });
  assert.equal((await second).result.id, 'current');
  const third = controller.plan();
  const fourth = controller.plan();
  resolvers[2]({ state: 'estimated', id: 'old-request' });
  assert.equal((await third).stale, true);
  resolvers[3]({ state: 'estimated', id: 'latest-request' });
  assert.equal((await fourth).result.id, 'latest-request');
});

test('real long-route plan includes rest events mapped to unassigned route markers', async () => {
  const controller = readyController({ adapter: request => createMapPlan(request, dependencies) }, 1_300_000);
  const planned = await controller.plan();
  assert.equal(planned.result.state, 'estimated');
  const rest = planned.result.events.find(event => event.type === 'rest');
  assert.ok(rest);
  assert.equal(rest.stopKind, 'unassigned');
  assert.ok(Number.isFinite(rest.fromPoint.lat));
});

test('warnings, violations, and ignored choices remain available from the engine result', async () => {
  const controller = readyController({
    adapter: request => createMapPlan(request, {
      ...dependencies,
      buildPlan: options => {
        const result = buildPlan(options);
        result.violations = analyze([{
          type: 'drive',
          start: fixedNow - 271 * 60_000,
          end: fixedNow
        }], { now: fixedNow }).violations;
        result.ignoredExtensions = [{ stageIndex: 0, reason: 'Изчерпани удължения.' }];
        return result;
      }
    })
  });
  controller.setChoice('section-1', { useExtension: true, dailyRest: 'regular' });
  const planned = await controller.plan();
  assert.ok(planned.result.warnings.some(warning => warning.code === 'ENGINE_VIOLATIONS'));
  assert.equal(planned.result.engineResult.violations[0].code, 'CONTINUOUS_DRIVE');
  assert.equal(formatViolation(planned.result.engineResult.violations[0]),
    'Време за непрекъснато управление: Над 4 ч 30 мин каране без пауза 45 мин (или 15 + 30 мин)');
  assert.equal(planned.result.engineResult.ignoredExtensions[0].reason, 'Изчерпани удължения.');
});

async function assertEchoRejected(id) {
  let received;
  const controller = readyController({ adapter: request => {
    received = request;
    return echoed(request, {
      state: 'estimated',
      arrivalUtcMs: fixedNow + 1_000,
      [id]: 'wrong-echo'
    });
  } });
  const planned = await controller.plan();
  assert.equal(planned.accepted, false);
  assert.equal(planned.result, null);
  assert.match(planned.error, /Не получих актуален план/);
  assert.equal(controller.getState().result, null);
  assert.notEqual(received[id], 'wrong-echo');
}

test('rejects a result with a mismatched requestId echo', async () => {
  await assertEchoRejected('requestId');
});

test('rejects a result with a mismatched routeRevision echo', async () => {
  await assertEchoRejected('routeRevision');
});

test('rejects a result with a mismatched inputRevision echo', async () => {
  await assertEchoRejected('inputRevision');
});

test('display route uses spherical indexed points including original endpoints', () => {
  const geometry = [
    { lat: 0, lon: 0 }, { lat: 0, lon: coordinateForMeters(60_000) },
    { lat: coordinateForMeters(60_000), lon: coordinateForMeters(60_000) }
  ];
  const index = indexRoute(geometry);
  const samples = sampleRoute(index, 10_000);
  assert.ok(samples.length >= 13);
  assert.deepEqual(samples[0], [geometry[0].lat, geometry[0].lon]);
  assert.deepEqual(samples.at(-1), [geometry.at(-1).lat, geometry.at(-1).lon]);
});

test('clear removes old result and all route geometry', async () => {
  const controller = readyController({ adapter: request => createMapPlan(request, dependencies) });
  await controller.plan();
  assert.ok(controller.getState().result);
  controller.clear();
  assert.equal(controller.getState().result, null);
  assert.deepEqual(controller.getState().points, []);
  assert.deepEqual(controller.getState().roadTypes, []);
});

const historyReader = (activities, weeklyRestEnd = null) => key =>
  key === 'th_activities' ? JSON.stringify(activities)
    : weeklyRestEnd == null || typeof weeklyRestEnd === 'string'
      ? weeklyRestEnd : String(weeklyRestEnd);

test('planning requires an explicit choice of local history or no history', async () => {
  let called = false;
  const controller = createMapPlannerController({
    now: () => fixedNow,
    adapter: request => { called = true; return echoed(request); }
  });
  twoPoints(controller);
  controller.setRoadType(0, 'ordinary');
  const blocked = await controller.plan();
  assert.equal(blocked.result, null);
  assert.match(blocked.error, /избери изрично/);
  assert.equal(called, false);
  controller.chooseNoHistory();
  const selected = await controller.plan();
  assert.equal(selected.result.state, 'needs-data');
  assert.equal(called, true);
});

test('loading an explicit snapshot changes only input revision and copies it into the request', async () => {
  let received;
  const controller = makeController({ adapter: request => {
    received = request;
    return echoed(request);
  } });
  const activities = [{ type: 'drive', start: fixedNow - 4 * 60 * 60_000, end: fixedNow }];
  const routeRevision = controller.getState().routeRevision;
  const inputRevision = controller.getState().inputRevision;
  const loaded = controller.loadInitialHistory(historyReader(activities, fixedNow - 2 * 60_000));
  assert.equal(loaded.loaded, true);
  assert.equal(controller.getState().inputRevision, inputRevision + 1);
  assert.equal(controller.getState().routeRevision, routeRevision);
  twoPoints(controller);
  controller.setRoadType(0, 'ordinary');
  await controller.plan();
  assert.deepEqual(received.initialState, {
    activities,
    lastWeeklyRestEnd: fixedNow - 2 * 60_000,
    source: 'local-device'
  });
  received.initialState.activities[0].start = 0;
  assert.equal(controller.getState().history.snapshot.activities[0].start, activities[0].start);
});

test('a corrupt refresh clears the previous snapshot and result instead of retaining stale data', async () => {
  const controller = readyController({ adapter: request => createMapPlan(request, dependencies) });
  const activities = [{ type: 'drive', start: fixedNow - 60_000, end: fixedNow }];
  controller.loadInitialHistory(historyReader(activities));
  await controller.plan();
  assert.ok(controller.getState().result);
  const routeRevision = controller.getState().routeRevision;
  const inputRevision = controller.getState().inputRevision;
  const failed = controller.loadInitialHistory(key => key === 'th_activities' ? '[broken' : null);
  assert.equal(failed.loaded, false);
  assert.equal(controller.getState().history.mode, 'error');
  assert.equal(controller.getState().history.snapshot, null);
  assert.equal(controller.getState().result, null);
  assert.equal(controller.getState().inputRevision, inputRevision + 1);
  assert.equal(controller.getState().routeRevision, routeRevision);
  const blocked = await controller.plan();
  assert.equal(blocked.result, null);
});

test('choosing no history invalidates the loaded result and sends an empty explicit state', async () => {
  let received;
  const controller = makeController({ adapter: request => {
    received = request;
    return echoed(request);
  } });
  controller.loadInitialHistory(historyReader([{ type: 'drive', start: fixedNow - 1, end: fixedNow }]));
  twoPoints(controller);
  controller.setRoadType(0, 'ordinary');
  await controller.plan();
  assert.equal(received.initialState.source, 'local-device');
  const routeRevision = controller.getState().routeRevision;
  const inputRevision = controller.getState().inputRevision;
  controller.chooseNoHistory();
  assert.equal(controller.getState().result, null);
  assert.equal(controller.getState().inputRevision, inputRevision + 1);
  assert.equal(controller.getState().routeRevision, routeRevision);
  await controller.plan();
  assert.deepEqual(received.initialState, {
    activities: [], lastWeeklyRestEnd: null, source: 'none'
  });
});

test('a storage event for either history key invalidates active history and requires refresh', async () => {
  const requests = [];
  const controller = makeController({ adapter: request => {
    requests.push(request);
    return echoed(request);
  } });
  const activity = { type: 'drive', start: fixedNow - 60_000, end: fixedNow };
  controller.loadInitialHistory(historyReader([activity]));
  twoPoints(controller);
  controller.setRoadType(0, 'ordinary');
  await controller.plan();
  const routeRevision = controller.getState().routeRevision;
  const inputRevision = controller.getState().inputRevision;
  assert.equal(controller.storageChanged('th_jokers'), false);
  assert.equal(controller.storageChanged('th_activities'), true);
  assert.equal(controller.getState().history.mode, 'stale');
  assert.equal(controller.getState().history.snapshot, null);
  assert.equal(controller.getState().result, null);
  assert.equal(controller.getState().inputRevision, inputRevision + 1);
  assert.equal(controller.getState().routeRevision, routeRevision);
  assert.equal((await controller.plan()).result, null);
  assert.equal(requests.length, 1);
  controller.loadInitialHistory(historyReader([{ ...activity, start: fixedNow - 120_000 }]));
  await controller.plan();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].initialState.activities[0].start, fixedNow - 120_000);
  const weeklyInputRevision = controller.getState().inputRevision;
  const weeklyRouteRevision = controller.getState().routeRevision;
  assert.equal(controller.storageChanged('th_weekly_rest_end'), true);
  assert.equal(controller.getState().history.mode, 'stale');
  assert.equal(controller.getState().history.snapshot, null);
  assert.equal(controller.getState().result, null);
  assert.equal(controller.getState().inputRevision, weeklyInputRevision + 1);
  assert.equal(controller.getState().routeRevision, weeklyRouteRevision);
});

test('storage clear invalidates loaded history and a shown result', async () => {
  const controller = makeController({ adapter: request => createMapPlan(request, dependencies) });
  controller.loadInitialHistory(historyReader([
    { type: 'rest', start: fixedNow - 14 * 24 * 60 * 60_000, end: fixedNow }
  ], fixedNow));
  twoPoints(controller);
  controller.setRoadType(0, 'ordinary');
  const planned = await controller.plan();
  assert.equal(planned.result.engineResult.confirmed, true);
  const routeRevision = controller.getState().routeRevision;
  const inputRevision = controller.getState().inputRevision;
  assert.equal(controller.storageChanged(null), true);
  assert.equal(controller.getState().history.mode, 'stale');
  assert.equal(controller.getState().history.snapshot, null);
  assert.equal(controller.getState().result, null);
  assert.equal(controller.getState().inputRevision, inputRevision + 1);
  assert.equal(controller.getState().routeRevision, routeRevision);
  assert.equal((await controller.plan()).result, null);
});

test('storage clear invalidates pending history plans and rejects their late result', async () => {
  let resolve;
  const controller = makeController({ adapter: request => new Promise(done => {
    resolve = result => done(echoed(request, result));
  }) });
  controller.loadInitialHistory(historyReader([{ type: 'rest', start: fixedNow - 24 * 60 * 60_000, end: fixedNow }]));
  twoPoints(controller);
  controller.setRoadType(0, 'ordinary');
  const pending = controller.plan();
  const routeRevision = controller.getState().routeRevision;
  const inputRevision = controller.getState().inputRevision;
  assert.equal(controller.storageChanged(null), true);
  assert.equal(controller.getState().history.mode, 'stale');
  assert.equal(controller.getState().history.snapshot, null);
  assert.equal(controller.getState().result, null);
  assert.equal(controller.getState().inputRevision, inputRevision + 1);
  assert.equal(controller.getState().routeRevision, routeRevision);
  resolve({ state: 'estimated', id: 'late-cleared-history' });
  assert.equal((await pending).stale, true);
  assert.equal(controller.getState().result, null);
});

test('storage clear does not alter explicit no-history mode or unrelated-key behavior', async () => {
  const controller = readyController({ adapter: request => echoed(request) });
  twoPoints(controller);
  controller.setRoadType(0, 'ordinary');
  await controller.plan();
  const before = controller.getState();
  assert.equal(controller.storageChanged(null), false);
  assert.equal(controller.storageChanged('th_jokers'), false);
  const after = controller.getState();
  assert.equal(after.history.mode, 'none');
  assert.equal(after.inputRevision, before.inputRevision);
  assert.equal(after.routeRevision, before.routeRevision);
  assert.equal(after.result, before.result);
});

test('a late plan is rejected when history is loaded or disabled', async () => {
  let resolve;
  const controller = makeController({ adapter: request => new Promise(done => {
    resolve = result => done(echoed(request, result));
  }) });
  twoPoints(controller);
  controller.setRoadType(0, 'ordinary');
  const pending = controller.plan();
  const routeRevision = controller.getState().routeRevision;
  controller.loadInitialHistory(historyReader([]));
  assert.equal(controller.getState().routeRevision, routeRevision);
  resolve({ state: 'estimated' });
  assert.equal((await pending).stale, true);
  assert.equal(controller.getState().result, null);
});

test('four hours of recorded driving followed by a 30-minute rest still requires a 45-minute pause', async () => {
  const activities = [
    { type: 'drive', start: fixedNow - 4.5 * 60 * 60_000, end: fixedNow - 30 * 60_000 },
    { type: 'rest', start: fixedNow - 30 * 60_000, end: null }
  ];
  const controller = readyController({ adapter: request => createMapPlan(request, dependencies) }, 600_000);
  controller.loadInitialHistory(historyReader(activities));
  controller.setRoadType(0, 'ordinary');
  const result = await controller.plan();
  const [drive, pause] = result.result.engineResult.events;
  assert.equal(drive.type, 'drive');
  assert.equal(drive.end - drive.start, 30 * 60_000);
  assert.equal(pause.label, 'Пауза 45 мин');
  assert.equal(pause.end - pause.start, 45 * 60_000);
});

function historyCycles(cycles, restMinutes, includeTenHourDay, referenceNow = fixedNow) {
  const day = includeTenHourDay
    ? [['drive', 270], ['rest', 45], ['drive', 270], ['rest', 45], ['drive', 60], ['rest', 660]]
    : [['drive', 270], ['rest', 45], ['drive', 270], ['rest', restMinutes]];
  const elapsed = day.reduce((total, [, minutes]) => total + minutes * 60_000, 0) * cycles;
  let cursor = referenceNow - elapsed;
  const activities = [];
  for (let cycle = 0; cycle < cycles; cycle++) {
    for (const [type, minutes] of day) {
      const end = cursor + minutes * 60_000;
      activities.push({ type, start: cursor, end });
      cursor = end;
    }
  }
  activities.at(-1).end = null;
  return activities;
}

test('real planner reports an ignored third extension after two recorded extensions', async () => {
  const planningNow = Date.parse('2026-10-18T08:00:00Z');
  const activities = historyCycles(2, 660, true, planningNow);
  const controller = makeController({
    now: () => planningNow,
    adapter: request => createMapPlan(request, dependencies)
  });
  controller.loadInitialHistory(historyReader(activities));
  twoPoints(controller, 800_000);
  controller.setRoadType(0, 'motorway');
  controller.setChoice('section-1', { useExtension: true, dailyRest: 'regular' });
  const planned = await controller.plan();
  assert.ok(planned.result.engineResult.ignoredExtensions.some(item =>
    item.reason.includes('двете седмични удължения')));
});

test('real planner reports a reduced-rest choice ignored after three recorded reduced rests', async () => {
  const planningNow = Date.parse('2026-10-18T08:00:00Z');
  const activities = historyCycles(3, 540, false, planningNow);
  const controller = makeController({
    now: () => planningNow,
    adapter: request => createMapPlan(request, dependencies)
  });
  controller.loadInitialHistory(historyReader(activities));
  twoPoints(controller, 800_000);
  controller.setRoadType(0, 'motorway');
  controller.setChoice('section-1', { useExtension: false, dailyRest: 'reduced' });
  const planned = await controller.plan();
  assert.ok(planned.result.engineResult.ignoredDailyRests.some(item =>
    item.reason.includes('трите намалени дневни почивки')));
});

test('a future departure gap does not create history or clear continuous driving', async () => {
  const activities = [{ type: 'drive', start: fixedNow - 4 * 60 * 60_000, end: fixedNow }];
  const controller = makeController({ adapter: request => createMapPlan(request, dependencies) });
  controller.loadInitialHistory(historyReader(activities));
  controller.addPoint({ lat: 0, lon: 0 });
  controller.addPoint({ lat: 0, lon: coordinateForMeters(80_000) });
  controller.setRoadType(0, 'ordinary');
  controller.setDeparture({ mode: 'relative', hours: 2, minutes: 0 });
  const planned = await controller.plan();
  assert.equal(planned.result.engineResult.events[0].type, 'drive');
  assert.equal(planned.result.engineResult.events[0].end - planned.result.engineResult.events[0].start, 30 * 60_000);
  assert.equal(planned.result.historyCoverage.complete, false);
  assert.ok(planned.result.warnings.some(warning => warning.code === 'HISTORY_INCOMPLETE'));
});

// UI-03: local parking list on the drawn route. Synthetic data only.
const parkingRecord = (id, lon, extra = {}) => ({
  id,
  location: { lat: 0.001, lon },
  sourceId: 'synthetic-file',
  observedAt: fixedNow - 60_000,
  expiresAt: fixedNow + 3_600_000,
  truckAccess: 'allowed',
  availability: 'available',
  ...extra
});
const parkingRoute = controller => {
  controller.addPoint({ lat: 0, lon: 0 });
  controller.addPoint({ lat: 0, lon: 1 });
};
const parkingText = (...records) => JSON.stringify(records);
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const pendingFile = (text, name = 'late.json') => {
  const gate = deferred();
  return { file: { name, size: text.length, text: () => gate.promise.then(() => text) }, release: gate.resolve };
};

test('a loaded list is evaluated on the drawn geometry with echoed IDs and the injected time', async () => {
  const seen = [];
  const controller = makeController({
    evaluateParking: request => { seen.push(structuredClone(request)); return evaluateParkingCandidates(request); }
  });
  parkingRoute(controller);
  controller.loadParkingText(parkingText(parkingRecord('p1', 0.5), parkingRecord('p2', 0.7, { truckAccess: 'unknown' })), 'list.json');
  assert.equal(controller.getState().parking.mode, 'loaded');
  assert.equal(controller.getState().parking.count, 2);
  const outcome = await controller.evaluateParking();
  assert.equal(outcome.accepted, true);
  const [request] = seen;
  assert.deepEqual(request.geometry, controller.getState().points);
  assert.equal(request.evaluatedAt, fixedNow);
  assert.equal(request.routeRevision, `route-${controller.getState().routeRevision}`);
  assert.match(request.inputRevision, new RegExp(`^input-${controller.getState().inputRevision}\\.parking-\\d+$`));
  assert.deepEqual(request.window, { minOffsetM: 0, maxOffsetM: indexRoute(request.geometry).totalLengthM, maxLateralDistanceM: 500 });
  const parking = controller.getState().parking;
  assert.equal(parking.mode, 'evaluated');
  assert.deepEqual(parking.result.candidateIds, ['p1']);
  assert.deepEqual(parking.result.needsVerificationIds, ['p2']);
  assert.equal(parking.result.selectedParkingId, null);
  assert.equal(parking.items.filter(item => item.marker).length, 2);
});

test('each evaluation uses a fresh request ID and a result with wrong echo IDs is not shown', async () => {
  const ids = [];
  let tamper = false;
  const controller = makeController({
    evaluateParking: request => {
      ids.push(request.requestId);
      const result = evaluateParkingCandidates(request);
      return tamper ? { ...result, inputRevision: 'input-0.parking-0' } : result;
    }
  });
  parkingRoute(controller);
  controller.loadParkingText(parkingText(parkingRecord('p1', 0.5)));
  await controller.evaluateParking();
  await controller.evaluateParking();
  assert.equal(new Set(ids).size, 2);
  tamper = true;
  const outcome = await controller.evaluateParking();
  assert.equal(outcome.accepted, false);
  assert.equal(controller.getState().parking.result, null);
  assert.equal(controller.getState().parking.items, null);
  assert.match(controller.getState().parking.error, /не е за текущия маршрут/);
});

test('route, road type, departure, choice, history and clear changes drop the parking result but keep the list', async () => {
  const controller = makeController();
  parkingRoute(controller);
  controller.loadParkingText(parkingText(parkingRecord('p1', 0.5)));
  const changes = [
    () => controller.dragPoint(1, { lat: 0, lon: 1.01 }),
    () => controller.addPoint({ lat: 0, lon: 1.02 }),
    () => controller.removeLastPoint(),
    () => controller.setRoadType(0, 'motorway'),
    () => controller.setDeparture({ mode: 'relative', hours: 1, minutes: 0 }),
    () => controller.setChoice('section-1', { useExtension: true, dailyRest: 'reduced' }),
    () => controller.chooseNoHistory(),
    () => controller.loadInitialHistory(() => null),
    () => controller.storageChanged(null)
  ];
  for (const change of changes) {
    await controller.evaluateParking();
    assert.equal(controller.getState().parking.mode, 'evaluated');
    change();
    const parking = controller.getState().parking;
    assert.equal(parking.result, null, String(change));
    assert.equal(parking.items, null);
    assert.equal(parking.mode, 'loaded');
    assert.equal(parking.count, 1, 'the imported list stays for an explicit new evaluation');
  }
  await controller.evaluateParking();
  controller.clear();
  assert.equal(controller.getState().parking.result, null);
  assert.equal(controller.getState().parking.count, 1);
  const missing = await controller.evaluateParking();
  assert.equal(missing.accepted, false);
  assert.match(missing.error, /поне две точки/);
});

test('window changes drop the result, use km to metres and reject values past the route end', async () => {
  const seen = [];
  const controller = makeController({ evaluateParking: request => { seen.push(request.window); return evaluateParkingCandidates(request); } });
  parkingRoute(controller);
  controller.loadParkingText(parkingText(parkingRecord('p1', 0.5)));
  await controller.evaluateParking();
  assert.equal(controller.setParkingWindow({ fromKm: 50, toKm: 60.5, maxLateralM: 200 }), true);
  assert.equal(controller.getState().parking.result, null);
  await controller.evaluateParking();
  assert.deepEqual(seen.at(-1), { minOffsetM: 50_000, maxOffsetM: 60_500, maxLateralDistanceM: 200 });
  assert.deepEqual(controller.getState().parking.result.candidateIds, ['p1']);

  controller.setParkingWindow({ fromKm: 0, toKm: 200, maxLateralM: 200 });
  const pastEnd = await controller.evaluateParking();
  assert.equal(pastEnd.accepted, false);
  assert.match(pastEnd.error, /след края на маршрута/);
  assert.equal(controller.getState().parking.result, null);

  controller.setParkingWindow({ fromKm: 50, toKm: 60.5, maxLateralM: 200 });
  await controller.evaluateParking();
  assert.equal(seen.length, 3);
  assert.equal(controller.setParkingWindow({ fromKm: '1', toKm: null, maxLateralM: 500 }), false);
  assert.match(controller.getState().parking.windowError, /„От км“/);
  assert.equal(controller.getState().parking.result, null);
  const blocked = await controller.evaluateParking();
  assert.equal(blocked.accepted, false);
  assert.match(blocked.error, /„От км“/);
  assert.equal(seen.length, 3, 'an invalid window is never evaluated with the previous window');
});

test('an invalid, non-array or oversized file replaces the list and removes shown results', async () => {
  const controller = makeController();
  parkingRoute(controller);
  controller.loadParkingText(parkingText(parkingRecord('p1', 0.5)), 'good.json');
  await controller.evaluateParking();
  for (const [text, message] of [['{oops', /не е валиден JSON/], ['{"id":"p"}', /JSON масив/]]) {
    controller.loadParkingText(text, 'bad.json');
    const parking = controller.getState().parking;
    assert.equal(parking.mode, 'error');
    assert.match(parking.error, message);
    assert.equal(parking.count, 0);
    assert.equal(parking.result, null);
    assert.equal(parking.items, null);
    assert.equal(parking.fileName, null);
  }
  const oversized = await controller.loadParkingFile({ name: 'huge.json', size: 2 * 1024 * 1024, text: async () => '[]' });
  assert.equal(oversized.loaded, false);
  assert.match(controller.getState().parking.error, /1 MiB/);
  const blocked = await controller.evaluateParking();
  assert.equal(blocked.accepted, false);
});

test('malformed records stay visible as invalid next to valid ones', async () => {
  const controller = makeController();
  parkingRoute(controller);
  controller.loadParkingText(JSON.stringify([parkingRecord('ok', 0.5), { id: 'bad', location: { lat: '0', lon: 0.5 } }, null]));
  await controller.evaluateParking();
  const { result, items } = controller.getState().parking;
  assert.equal(result.summary.invalid, 2);
  assert.deepEqual(result.candidateIds, ['ok']);
  assert.ok(items.some(item => item.title === 'bad — Невалиден запис' && item.marker === null));
  assert.ok(items.some(item => item.title === 'Запис 3 без валиден id — Невалиден запис'));
});

test('an old pending file cannot replace a newer load or come back after clear', async () => {
  const controller = makeController();
  parkingRoute(controller);
  const old = pendingFile(parkingText(parkingRecord('old', 0.5)), 'old.json');
  const firstLoad = controller.loadParkingFile(old.file);
  assert.equal(controller.getState().parking.mode, 'loading');
  controller.loadParkingText(parkingText(parkingRecord('new', 0.6)), 'new.json');
  old.release();
  assert.deepEqual(await firstLoad, { loaded: false, stale: true });
  assert.equal(controller.getState().parking.fileName, 'new.json');
  await controller.evaluateParking();
  assert.deepEqual(controller.getState().parking.result.candidateIds, ['new']);

  const late = pendingFile(parkingText(parkingRecord('late', 0.5)));
  const lateLoad = controller.loadParkingFile(late.file);
  controller.clearParking();
  late.release();
  assert.deepEqual(await lateLoad, { loaded: false, stale: true });
  assert.equal(controller.getState().parking.mode, 'empty');
  assert.equal(controller.getState().parking.items, null);
});

test('a pending evaluation cannot show old markers after a route change, a new load or clear', async () => {
  for (const change of [
    controller => controller.dragPoint(1, { lat: 0, lon: 0.9 }),
    controller => controller.loadParkingText(parkingText(parkingRecord('other', 0.4))),
    controller => controller.clearParking(),
    controller => controller.setParkingWindow({ fromKm: null, toKm: null, maxLateralM: 100 })
  ]) {
    const gate = deferred();
    const controller = makeController({ evaluateParking: async request => { await gate.promise; return evaluateParkingCandidates(request); } });
    parkingRoute(controller);
    controller.loadParkingText(parkingText(parkingRecord('p1', 0.5)));
    const pending = controller.evaluateParking();
    assert.equal(controller.getState().parking.evaluating, true);
    change(controller);
    gate.resolve();
    assert.deepEqual(await pending, { accepted: false, stale: true });
    assert.equal(controller.getState().parking.result, null, String(change));
    assert.equal(controller.getState().parking.items, null);
    assert.equal(controller.getState().parking.evaluating, false);
  }
});

test('clearing the parking list does not touch the loaded history or the tacho plan result', async () => {
  const activities = JSON.stringify([{ type: 'rest', start: fixedNow - 12 * 3_600_000, end: fixedNow - 3_600_000 }]);
  const controller = createMapPlannerController({ now: () => fixedNow });
  controller.loadInitialHistory(key => (key === 'th_activities' ? activities : null));
  parkingRoute(controller);
  controller.setRoadType(0, 'motorway');
  await controller.plan();
  const planned = controller.getState().result;
  assert.equal(planned.state, 'estimated');
  controller.loadParkingText(parkingText(parkingRecord('p1', 0.5)));
  await controller.evaluateParking();
  const before = controller.getState();
  controller.clearParking();
  const after = controller.getState();
  assert.equal(after.history.mode, 'loaded');
  assert.deepEqual(after.history, before.history);
  assert.equal(after.result, planned, 'the plan, its ETA and rests are unchanged');
  assert.equal(after.inputRevision, before.inputRevision);
  assert.equal(after.parking.mode, 'empty');
});

test('the parking evaluation never changes the plan, its rest places or the history', async () => {
  const controller = readyController({}, 400_000);
  await controller.plan();
  const before = controller.getState();
  assert.equal(before.result.state, 'estimated');
  const restEvents = JSON.stringify(before.result.events.filter(event => event.type === 'rest'));
  controller.loadParkingText(parkingText(parkingRecord('p1', 1)));
  await controller.evaluateParking();
  const after = controller.getState();
  assert.equal(after.result, before.result);
  assert.equal(JSON.stringify(after.result.events.filter(event => event.type === 'rest')), restEvents);
  assert.equal(after.routeRevision, before.routeRevision);
  assert.equal(after.inputRevision, before.inputRevision);
});

test('the imported list and the evaluation request are frozen and not mutated', async () => {
  let received;
  const controller = makeController({ evaluateParking: request => { received = request; return evaluateParkingCandidates(request); } });
  parkingRoute(controller);
  const text = parkingText(parkingRecord('p1', 0.5), parkingRecord('p2', 0.6, { expiresAt: fixedNow }));
  controller.loadParkingText(text);
  await controller.evaluateParking();
  assert.ok(Object.isFrozen(received.parkingCandidates));
  assert.ok(Object.isFrozen(received.parkingCandidates[0].location));
  assert.equal(JSON.stringify(received.parkingCandidates), text);
});

test('loading and evaluating parkings use no storage, network or timers', async () => {
  const touched = [];
  const saved = {};
  const trap = name => (...args) => { touched.push(name); throw new Error(`${name} must not be used`); };
  for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'setTimeout', 'setInterval']) {
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value: trap(name), configurable: true, writable: true });
  }
  const storage = new Proxy({}, { get: (_, key) => { touched.push(`localStorage.${String(key)}`); return trap('localStorage'); } });
  saved.localStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  try {
    const controller = makeController();
    parkingRoute(controller);
    await controller.loadParkingFile({ name: 'list.json', size: 10, text: async () => parkingText(parkingRecord('p1', 0.5)) });
    await controller.evaluateParking();
    controller.clearParking();
    assert.deepEqual(touched, []);
  } finally {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

// UI-04: break during driving, 45 min at once or 15 + 30 min (both already
// supported by buildPlan and validated by createMapPlan).
const minutes = ms => Math.round(ms / 60_000);
const restSummary = result => result.engineResult.events
  .filter(event => event.type === 'rest')
  .map(event => [minutes(event.end - event.start), event.label]);
const longRoute = controller => {
  controller.addPoint({ lat: 0, lon: 0 });
  controller.addPoint({ lat: 0, lon: 6 });
  controller.setRoadType(0, 'ordinary');
};

test('break style defaults to 45 and is sent as choices.breakStyle', async () => {
  const requests = [];
  const controller = readyController({ adapter: async request => { requests.push(request); return echoed(request); } });
  assert.equal(controller.getState().breakStyle, '45');
  await controller.plan();
  assert.equal(requests[0].choices.breakStyle, '45');
  controller.setBreakStyle('15+30');
  assert.equal(controller.getState().breakStyle, '15+30');
  await controller.plan();
  assert.equal(requests[1].choices.breakStyle, '15+30');
  assert.deepEqual(requests[1].choices.bySection, requests[0].choices.bySection,
    'daily rest and 10 h choices are separate and unchanged');
});

test('break style setter accepts only the exact strings 45 and 15+30', () => {
  const controller = readyController();
  const before = controller.getState();
  for (const bad of [45, '45 ', '15 + 30', '15+30 ', '30', '', null, undefined, {}, ['45'], true]) {
    assert.throws(() => controller.setBreakStyle(bad), TypeError, String(bad));
  }
  const after = controller.getState();
  assert.equal(after.breakStyle, '45');
  assert.equal(after.inputRevision, before.inputRevision);
  assert.equal(after.routeRevision, before.routeRevision);
});

test('changing the break style is an input revision only; the same value changes nothing', () => {
  const controller = readyController();
  const before = controller.getState();
  controller.setBreakStyle('15+30');
  const changed = controller.getState();
  assert.equal(changed.routeRevision, before.routeRevision);
  assert.equal(changed.inputRevision, before.inputRevision + 1);
  controller.setBreakStyle('15+30');
  assert.equal(controller.getState().inputRevision, changed.inputRevision);
  controller.setBreakStyle('45');
  assert.equal(controller.getState().inputRevision, changed.inputRevision + 1);
  assert.equal(controller.getState().routeRevision, before.routeRevision);
});

test('a shown plan is removed when the break style changes and nothing is replanned automatically', async () => {
  let calls = 0;
  const controller = readyController({ adapter: async request => { calls++; return echoed(request, { state: 'estimated', events: [] }); } });
  await controller.plan();
  assert.equal(controller.getState().result.state, 'estimated');
  controller.setBreakStyle('15+30');
  assert.equal(controller.getState().result, null);
  assert.equal(controller.getState().error, null);
  assert.equal(calls, 1, 'no automatic replan');
});

test('a pending plan with the old break style is rejected when it finishes late', async () => {
  const gate = deferred();
  const controller = readyController({ adapter: async request => { await gate.promise; return echoed(request); } });
  const pending = controller.plan();
  controller.setBreakStyle('15+30');
  gate.resolve();
  const outcome = await pending;
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.stale, true);
  assert.equal(controller.getState().result, null);
});

test('a new plan does not accept a result echoing the old input revision', async () => {
  let oldRequest = null;
  const controller = readyController({
    adapter: async request => {
      if (!oldRequest) { oldRequest = request; return echoed(request); }
      return echoed({ ...request, inputRevision: oldRequest.inputRevision });
    }
  });
  await controller.plan();
  controller.setBreakStyle('15+30');
  const outcome = await controller.plan();
  assert.equal(outcome.accepted, false);
  assert.equal(controller.getState().result, null);
  assert.match(controller.getState().error, /актуален план/);
});

test('changing the break style drops parking results but keeps route, road types, history, choices and the parking list', async () => {
  const activities = JSON.stringify([{ type: 'rest', start: fixedNow - 12 * 3_600_000, end: fixedNow - 3_600_000 }]);
  const controller = createMapPlannerController({ now: () => fixedNow });
  controller.loadInitialHistory(key => (key === 'th_activities' ? activities : null));
  parkingRoute(controller);
  controller.setRoadType(0, 'motorway');
  controller.setChoice('section-1', { useExtension: true, dailyRest: 'reduced' });
  controller.setDeparture({ mode: 'relative', hours: 1, minutes: 30 });
  controller.loadParkingText(parkingText(parkingRecord('p1', 0.5)), 'list.json');
  await controller.evaluateParking();
  assert.equal(controller.getState().parking.mode, 'evaluated');
  const before = controller.getState();
  controller.setBreakStyle('15+30');
  const after = controller.getState();
  assert.equal(after.parking.result, null);
  assert.equal(after.parking.items, null);
  assert.equal(after.parking.mode, 'loaded');
  assert.equal(after.parking.count, 1);
  assert.equal(after.parking.fileName, 'list.json');
  assert.deepEqual(after.points, before.points);
  assert.deepEqual(after.roadTypes, before.roadTypes);
  assert.deepEqual(after.choices, before.choices);
  assert.deepEqual(after.departure, before.departure);
  assert.deepEqual(after.history, before.history);
});

test('real planner: 45 gives one 45 min pause, 15+30 gives 15 at 4 h and 30 at 4 h 30 min', async () => {
  const planWith = async style => {
    const controller = makeController();
    longRoute(controller);
    if (style !== '45') controller.setBreakStyle(style);
    await controller.plan();
    const { result } = controller.getState();
    assert.equal(result.state, 'estimated', style);
    return result;
  };
  const full = await planWith('45');
  const split = await planWith('15+30');
  assert.deepEqual(restSummary(full), [[45, 'Пауза 45 мин'], [660, 'Редовна дневна почивка 11 ч']]);
  assert.deepEqual(restSummary(split), [
    [15, 'Пауза 15 мин'], [30, 'Пауза 30 мин (15 + 30)'],
    [15, 'Пауза 15 мин'], [660, 'Редовна дневна почивка 11 ч']
  ]);
  const [firstDrive, firstPause] = split.engineResult.events;
  assert.equal(minutes(firstDrive.end - firstDrive.start), 240);
  assert.equal(firstPause.start, firstDrive.end);
  const secondPause = split.engineResult.events[3];
  assert.equal(minutes(secondPause.start - fixedNow), 285, '4 h 30 min driving plus the 15 min pause');
  // Map rest events come from the actual result, one per engine rest, on the route.
  for (const result of [full, split]) {
    const mapRests = result.events.filter(event => event.type === 'rest');
    assert.equal(mapRests.length, restSummary(result).length);
    assert.ok(mapRests.every(event => event.fromPoint && Number.isFinite(event.fromPoint.lat)));
  }
  assert.notEqual(split.arrivalUtcMs, full.arrivalUtcMs);
});

test('real planner: a 15 min part already in the history is not taken again', async () => {
  const activities = JSON.stringify([
    { type: 'rest', start: fixedNow - 13 * 3_600_000, end: fixedNow - 3 * 3_600_000 },
    { type: 'drive', start: fixedNow - 3 * 3_600_000, end: fixedNow - 75 * 60_000 },
    { type: 'rest', start: fixedNow - 75 * 60_000, end: fixedNow - 60 * 60_000 },
    { type: 'drive', start: fixedNow - 60 * 60_000, end: fixedNow }
  ]);
  const controller = createMapPlannerController({ now: () => fixedNow });
  controller.loadInitialHistory(key => (key === 'th_activities' ? activities : null));
  longRoute(controller);
  controller.setBreakStyle('15+30');
  await controller.plan();
  const { result } = controller.getState();
  assert.equal(result.state, 'estimated');
  const [drive, pause] = result.engineResult.events;
  assert.equal(drive.type, 'drive');
  assert.equal(minutes(drive.end - drive.start), 105, '2 h 45 min recorded + 1 h 45 min planned = 4 h 30 min');
  assert.equal(pause.label, 'Пауза 30 мин (15 + 30)');
  assert.equal(minutes(pause.end - pause.start), 30);
});

test('switching back to 45 and planning again restores the 45 min schedule', async () => {
  const controller = makeController();
  longRoute(controller);
  await controller.plan();
  const first = controller.getState().result;
  controller.setBreakStyle('15+30');
  await controller.plan();
  assert.ok(restSummary(controller.getState().result).some(([length]) => length === 15));
  controller.setBreakStyle('45');
  assert.equal(controller.getState().result, null);
  await controller.plan();
  const again = controller.getState().result;
  assert.deepEqual(restSummary(again), restSummary(first));
  assert.equal(again.arrivalUtcMs, first.arrivalUtcMs);
  assert.notEqual(again.requestId, first.requestId);
});

// UI-05: planner draft in a local file (line and choices only).
const draftController = (overrides = {}) => {
  let clock = fixedNow;
  const controller = createMapPlannerController({ now: () => clock, ...overrides });
  return { controller, setNow: value => { clock = value; } };
};
const prepared = controller => {
  controller.addPoint({ lat: 0, lon: 0 });
  controller.addPoint({ lat: 0, lon: 2 });
  controller.addPoint({ lat: 0.5, lon: 3 });
  controller.setRoadType(0, 'motorway');
  controller.setChoice('section-2', { useExtension: true, dailyRest: 'reduced' });
  controller.setDeparture({ mode: 'relative', hours: 2, minutes: 30 });
  controller.setBreakStyle('15+30');
};
const draftOf = state => ({
  points: state.points, roadTypes: state.roadTypes, choices: state.choices,
  departure: state.departure, breakStyle: state.breakStyle
});

test('export holds only the line and choices, uses the injected clock and changes nothing', async () => {
  const activities = JSON.stringify([{ type: 'rest', start: fixedNow - 12 * 3_600_000, end: fixedNow - 3_600_000 }]);
  const { controller } = draftController();
  controller.loadInitialHistory(key => (key === 'th_activities' ? activities : key === 'th_weekly_rest_end' ? String(fixedNow - 86_400_000) : null));
  prepared(controller);
  controller.setRoadType(1, 'ordinary');
  await controller.plan();
  controller.loadParkingText(parkingText(parkingRecord('parking-zz-unique', 1)));
  await controller.evaluateParking();
  const before = controller.getState();
  assert.equal(before.result.state, 'estimated');
  const { text, fileName } = controller.exportDraft();
  const parsed = JSON.parse(text);
  assert.deepEqual(Object.keys(parsed), ['format', 'version', 'exportedAtUtcMs', 'points', 'roadTypes', 'choices', 'departure', 'breakStyle']);
  assert.equal(parsed.exportedAtUtcMs, fixedNow);
  assert.equal(fileName, 'top10eu-podgotovka-20261019-0800Z.json');
  for (const secret of ['rest', 'th_activities', String(fixedNow - 86_400_000), 'parking-zz-unique', 'synthetic-file', 'request-', 'route-', 'input-', 'arrival']) {
    assert.ok(!text.includes(secret), `export must not contain ${secret}`);
  }
  const after = controller.getState();
  assert.equal(after.result, before.result);
  assert.equal(after.parking.result, before.parking.result);
  assert.equal(after.inputRevision, before.inputRevision);
  assert.deepEqual(after.history, before.history);
});

test('a saved draft loads into another planner with the same line and choices', () => {
  const source = draftController().controller;
  prepared(source);
  const { text } = source.exportDraft();
  const target = draftController().controller;
  const outcome = target.importDraftText(text, 'kurs.json');
  assert.deepEqual(outcome, { loaded: true });
  assert.deepEqual(draftOf(target.getState()), draftOf(source.getState()));
  assert.equal(target.getState().draft.mode, 'loaded');
  assert.equal(target.getState().draft.fileName, 'kurs.json');
});

test('an invalid file changes nothing in the current preparation, plan or parking result', async () => {
  const { controller } = draftController();
  controller.chooseNoHistory();
  prepared(controller);
  controller.setRoadType(1, 'ordinary');
  await controller.plan();
  controller.loadParkingText(parkingText(parkingRecord('p1', 1)));
  await controller.evaluateParking();
  const before = controller.getState();
  const good = JSON.parse(controller.exportDraft().text);
  const badLastPoint = { ...good, points: [{ lat: 1, lon: 1 }, { lat: 1, lon: 2 }, { lat: 1, lon: 'x' }], roadTypes: [null, null], choices: {} };
  for (const text of ['{oops', JSON.stringify(badLastPoint), JSON.stringify({ ...good, version: 2 }), JSON.stringify({ ...good, activities: [] })]) {
    const outcome = controller.importDraftText(text);
    assert.equal(outcome.loaded, false);
    const after = controller.getState();
    assert.deepEqual(draftOf(after), draftOf(before));
    assert.equal(after.routeRevision, before.routeRevision);
    assert.equal(after.inputRevision, before.inputRevision);
    assert.equal(after.result, before.result);
    assert.equal(after.parking.result, before.parking.result);
    assert.deepEqual(after.history, before.history);
    assert.equal(after.draft.mode, 'error');
    assert.ok(after.draft.error.length > 0);
  }
});

test('a successful import gives new revisions, drops old results, keeps the parking list and needs a new history choice', async () => {
  const activities = JSON.stringify([{ type: 'rest', start: fixedNow - 12 * 3_600_000, end: fixedNow - 3_600_000 }]);
  let storageReads = 0;
  const source = draftController().controller;
  prepared(source);
  const { text } = source.exportDraft();
  let adapterCalls = 0;
  const { controller } = draftController({
    adapter: request => { adapterCalls++; return createMapPlan(request, dependencies); }
  });
  controller.loadInitialHistory(key => { storageReads++; return key === 'th_activities' ? activities : null; });
  parkingRoute(controller);
  controller.setRoadType(0, 'motorway');
  await controller.plan();
  controller.loadParkingText(parkingText(parkingRecord('p1', 0.5)), 'list.json');
  await controller.evaluateParking();
  const before = controller.getState();
  const readsBefore = storageReads;
  controller.importDraftText(text);
  const after = controller.getState();
  assert.ok(after.routeRevision > before.routeRevision);
  assert.ok(after.inputRevision > before.inputRevision);
  assert.equal(after.result, null);
  assert.equal(after.parking.result, null);
  assert.equal(after.parking.count, 1);
  assert.equal(after.parking.fileName, 'list.json');
  assert.equal(after.history.mode, 'unselected');
  assert.equal(after.history.snapshot, null);
  assert.equal(storageReads, readsBefore, 'storage is neither read nor cleared');
  assert.equal(adapterCalls, 1, 'no automatic replan');
  const blocked = await controller.plan();
  assert.equal(blocked.result, null);
  assert.match(blocked.error, /Използвай дневника/);
});

test('a pending plan and a pending parking evaluation are stale after an import', async () => {
  const source = draftController().controller;
  prepared(source);
  const { text } = source.exportDraft();
  const planGate = deferred();
  const parkingGate = deferred();
  let firstRequest;
  const { controller } = draftController({
    adapter: async request => { firstRequest ??= request; await planGate.promise; return echoed(request); },
    evaluateParking: async request => { await parkingGate.promise; return evaluateParkingCandidates(request); }
  });
  controller.chooseNoHistory();
  parkingRoute(controller);
  controller.setRoadType(0, 'ordinary');
  controller.loadParkingText(parkingText(parkingRecord('p1', 0.5)));
  const pendingPlan = controller.plan();
  const pendingParking = controller.evaluateParking();
  controller.importDraftText(text);
  planGate.resolve();
  parkingGate.resolve();
  assert.deepEqual(await pendingPlan, { accepted: false, stale: true, result: echoed(firstRequest) });
  assert.deepEqual(await pendingParking, { accepted: false, stale: true });
  assert.equal(controller.getState().result, null);
  assert.equal(controller.getState().parking.items, null);
  assert.notEqual(`route-${controller.getState().routeRevision}`, firstRequest.routeRevision);
});

test('an old pending draft file cannot overwrite a newer import, a clear or a route edit', async () => {
  const source = draftController().controller;
  prepared(source);
  const { text } = source.exportDraft();
  const other = draftController().controller;
  other.addPoint({ lat: 1, lon: 1 });
  const { text: newer } = other.exportDraft();
  const slowFile = () => {
    const gate = deferred();
    return { file: { name: 'old.json', size: text.length, text: () => gate.promise.then(() => text) }, release: gate.resolve };
  };
  for (const change of [
    controller => controller.importDraftText(newer, 'new.json'),
    controller => controller.clear(),
    controller => controller.addPoint({ lat: 2, lon: 2 })
  ]) {
    const { controller } = draftController();
    const slow = slowFile();
    const pending = controller.importDraftFile(slow.file);
    assert.equal(controller.getState().draft.mode, 'loading');
    change(controller);
    const expected = draftOf(controller.getState());
    slow.release();
    assert.deepEqual(await pending, { loaded: false, stale: true });
    assert.deepEqual(draftOf(controller.getState()), expected, String(change));
    assert.notEqual(controller.getState().draft.fileName, 'old.json');
  }
});

test('a file read through File.text is validated before anything is applied', async () => {
  const { controller } = draftController();
  controller.addPoint({ lat: 0, lon: 0 });
  const before = controller.getState();
  const huge = await controller.importDraftFile({ name: 'big.json', size: 2 * 1024 * 1024, text: async () => '{}' });
  assert.equal(huge.loaded, false);
  assert.match(controller.getState().draft.error, /1 MiB/);
  const bad = await controller.importDraftFile({ name: 'bad.json', size: 10, text: async () => '{"format":"top10eu-planner-draft"}' });
  assert.equal(bad.loaded, false);
  assert.deepEqual(controller.getState().points, before.points);
  assert.equal(controller.getState().routeRevision, before.routeRevision);
});

test('after a valid import and an explicit history choice the real planner uses the imported choices', async () => {
  const source = draftController().controller;
  source.addPoint({ lat: 0, lon: 0 });
  source.addPoint({ lat: 0, lon: 6 });
  source.setRoadType(0, 'ordinary');
  source.setDeparture({ mode: 'relative', hours: 2, minutes: 30 });
  source.setBreakStyle('15+30');
  const { text } = source.exportDraft();
  const { controller, setNow } = draftController();
  controller.importDraftText(text);
  const later = fixedNow + 5 * 3_600_000;
  setNow(later);
  controller.chooseNoHistory();
  await controller.plan();
  const { result } = controller.getState();
  assert.equal(result.state, 'estimated');
  assert.equal(result.engineResult.departure, later + 2.5 * 3_600_000, 'relative departure counts from the new planning time');
  assert.equal(result.engineResult.events.find(event => event.type === 'rest').label, 'Пауза 15 мин');
});

test('an unfinished imported draft does not become a plan', async () => {
  const { controller } = draftController();
  const text = JSON.stringify({ format: 'top10eu-planner-draft', version: 1, exportedAtUtcMs: fixedNow,
    points: [{ lat: 1, lon: 1 }], roadTypes: [], choices: {}, departure: { mode: 'now', hours: 0, minutes: 0 }, breakStyle: '45' });
  assert.deepEqual(controller.importDraftText(text), { loaded: true });
  controller.chooseNoHistory();
  const outcome = await controller.plan();
  assert.equal(outcome.result, null);
  assert.match(outcome.error, /поне две точки/);
  const twoPointsNoType = JSON.parse(text);
  twoPointsNoType.points.push({ lat: 1, lon: 2 });
  twoPointsNoType.roadTypes = [null];
  controller.importDraftText(JSON.stringify(twoPointsNoType));
  controller.chooseNoHistory();
  const untyped = await controller.plan();
  assert.match(untyped.error, /тип път/);
});

test('export and import use no storage, network or timers', () => {
  const touched = [];
  const saved = {};
  for (const name of ['fetch', 'XMLHttpRequest', 'setTimeout', 'localStorage', 'sessionStorage']) {
    saved[name] = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, get: () => { touched.push(name); throw new Error(name); } });
  }
  try {
    const { controller } = draftController();
    prepared(controller);
    const { text } = controller.exportDraft();
    const loaded = parseDraftText(text);
    controller.importDraftText(text);
    assert.equal(loaded.points.length, 3);
    assert.deepEqual(touched, []);
  } finally {
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
});

// UI-06: parking review before one planned pause.
const plannedLongRoute = async (overrides = {}) => {
  const controller = makeController(overrides);
  longRoute(controller);
  await controller.plan();
  const { result } = controller.getState();
  assert.equal(result.state, 'estimated');
  const restIndex = result.events.findIndex(event => event.type === 'rest');
  return { controller, result, restIndex, rest: result.events[restIndex] };
};

test('choosing a pause sets the window from its map-plan offset and leaves the plan untouched', async () => {
  const { controller, result, restIndex, rest } = await plannedLongRoute();
  const before = controller.getState();
  const outcome = controller.selectRestForParking(restIndex, 20);
  assert.equal(outcome.selected, true);
  const after = controller.getState();
  assert.equal(rest.fromM, rest.toM);
  assert.equal(after.parking.restWindow.maxOffsetM, rest.fromM, 'exact fromM, no km rounding');
  assert.equal(after.parking.restWindow.minOffsetM, rest.fromM - 20_000);
  assert.equal(after.parking.restWindow.eventIndex, restIndex);
  assert.equal(after.parking.restWindow.label, 'Пауза 45 мин');
  assert.equal(after.result, result, 'same plan object, ETA and pauses');
  assert.equal(after.result.arrivalUtcMs, before.result.arrivalUtcMs);
  assert.equal(after.routeRevision, before.routeRevision);
  assert.equal(after.inputRevision, before.inputRevision);
  assert.deepEqual(after.points, before.points);
  assert.equal(after.parking.mode, 'empty', 'nothing is evaluated or loaded by the choice');
});

test('the explicit evaluation sends exactly the pause window and the separate corridor setting', async () => {
  const seen = [];
  const { controller, restIndex, rest } = await plannedLongRoute({
    evaluateParking: request => { seen.push(request); return evaluateParkingCandidates(request); }
  });
  controller.setParkingWindow({ fromKm: null, toKm: null, maxLateralM: 300 });
  const kmBefore = rest.fromM / 1000;
  controller.loadParkingText(parkingText(
    parkingRecord('before-pause', kmBefore / 111.19492664455873 - 0.05),
    parkingRecord('after-pause', kmBefore / 111.19492664455873 + 0.05),
    parkingRecord('far-before', kmBefore / 111.19492664455873 - 0.5)
  ));
  controller.selectRestForParking(restIndex, 20);
  assert.equal(seen.length, 0, 'no automatic evaluation');
  await controller.evaluateParking();
  assert.deepEqual(seen[0].window, { minOffsetM: rest.fromM - 20_000, maxOffsetM: rest.fromM, maxLateralDistanceM: 300 });
  const { result } = controller.getState().parking;
  assert.deepEqual(result.candidateIds, ['before-pause']);
  const after = result.results.find(item => item.id === 'after-pause');
  assert.ok(after.reasons.includes('outside-window'), 'nothing after the pause is offered');
  assert.ok(result.results.find(item => item.id === 'far-before').reasons.includes('outside-window'));
});

test('a drive event, a missing event, a stale index or no plan cannot be chosen', async () => {
  const { controller, result } = await plannedLongRoute();
  const driveIndex = result.events.findIndex(event => event.type === 'drive');
  for (const index of [driveIndex, result.events.length, -1, 1.5, '1', null]) {
    const outcome = controller.selectRestForParking(index, 20);
    assert.equal(outcome.selected, false, String(index));
    assert.equal(controller.getState().parking.restWindow, null);
  }
  const fresh = makeController();
  longRoute(fresh);
  const noPlan = fresh.selectRestForParking(0, 20);
  assert.equal(noPlan.selected, false);
  assert.match(noPlan.error, /актуален график/);
});

test('lookback is validated without coercion and a custom value is used', async () => {
  const { controller, restIndex, rest } = await plannedLongRoute();
  for (const bad of ['20', NaN, 0, 201, Infinity]) {
    const outcome = controller.selectRestForParking(restIndex, bad);
    assert.equal(outcome.selected, false, String(bad));
    assert.match(outcome.error, /Преглед назад/);
  }
  controller.selectRestForParking(restIndex, 5);
  assert.equal(controller.getState().parking.restWindow.minOffsetM, rest.fromM - 5_000);
  assert.equal(controller.getState().parking.lookbackKm, 5);
});

test('choosing a pause without a parking list explains the next step and evaluates nothing', async () => {
  let calls = 0;
  const { controller, restIndex } = await plannedLongRoute({ evaluateParking: request => { calls++; return evaluateParkingCandidates(request); } });
  assert.equal(controller.selectRestForParking(restIndex, 20).selected, true);
  assert.equal(controller.getState().parking.error, null);
  const outcome = await controller.evaluateParking();
  assert.equal(outcome.accepted, false);
  assert.match(outcome.error, /зареди файл/i);
  assert.equal(calls, 0);
});

test('choosing a pause drops shown parking results and a pending evaluation but keeps the list', async () => {
  const gate = deferred();
  let slow = false;
  const { controller, restIndex } = await plannedLongRoute({
    evaluateParking: async request => { if (slow) await gate.promise; return evaluateParkingCandidates(request); }
  });
  controller.loadParkingText(parkingText(parkingRecord('p1', 1)), 'list.json');
  await controller.evaluateParking();
  assert.equal(controller.getState().parking.mode, 'evaluated');
  controller.selectRestForParking(restIndex, 20);
  assert.equal(controller.getState().parking.result, null);
  assert.equal(controller.getState().parking.items, null);
  assert.equal(controller.getState().parking.count, 1);
  slow = true;
  const pending = controller.evaluateParking();
  controller.selectRestForParking(restIndex, 10);
  gate.resolve();
  assert.deepEqual(await pending, { accepted: false, stale: true });
  assert.equal(controller.getState().parking.items, null);
});

test('any input change, import, clear or a new plan drops the link to the old pause', async () => {
  const source = makeController();
  longRoute(source);
  const { text: draftText } = source.exportDraft();
  const changes = [
    controller => controller.setBreakStyle('15+30'),
    controller => controller.dragPoint(1, { lat: 0, lon: 5.9 }),
    controller => controller.setRoadType(0, 'motorway'),
    controller => controller.setDeparture({ mode: 'relative', hours: 1, minutes: 0 }),
    controller => controller.setChoice('section-1', { useExtension: true, dailyRest: 'reduced' }),
    controller => controller.chooseNoHistory(),
    controller => controller.importDraftText(draftText),
    controller => controller.clear(),
    controller => controller.plan()
  ];
  for (const change of changes) {
    const { controller, restIndex } = await plannedLongRoute();
    controller.setParkingWindow({ fromKm: null, toKm: null, maxLateralM: 250 });
    controller.selectRestForParking(restIndex, 20);
    assert.ok(controller.getState().parking.restWindow);
    await change(controller);
    const { parking } = controller.getState();
    assert.equal(parking.restWindow, null, String(change));
    assert.deepEqual(parking.window, { fromKm: null, toKm: null, maxLateralM: 250 }, 'back to the whole route');
  }
});

test('a replan needs a new explicit pause choice; the old index is not reused silently', async () => {
  const seen = [];
  const { controller, restIndex, rest } = await plannedLongRoute({
    evaluateParking: request => { seen.push(request.window); return evaluateParkingCandidates(request); }
  });
  controller.loadParkingText(parkingText(parkingRecord('p1', 1)));
  controller.selectRestForParking(restIndex, 20);
  await controller.plan();
  await controller.evaluateParking();
  assert.equal(seen.at(-1).maxOffsetM, indexRoute(controller.getState().points).totalLengthM, 'whole route after replan');
  controller.selectRestForParking(restIndex, 20);
  await controller.evaluateParking();
  assert.equal(seen.at(-1).maxOffsetM, controller.getState().result.events[restIndex].fromM);
  assert.equal(seen.at(-1).maxOffsetM, rest.fromM, 'same inputs give the same pause offset');
});

test('editing the km fields by hand replaces the pause choice', async () => {
  const { controller, restIndex } = await plannedLongRoute();
  controller.selectRestForParking(restIndex, 20);
  controller.setParkingWindow({ fromKm: 10, toKm: 30, maxLateralM: 500 });
  assert.equal(controller.getState().parking.restWindow, null);
  assert.deepEqual(controller.getState().parking.window, { fromKm: 10, toKm: 30, maxLateralM: 500 });
});

test('a pause at the very start is refused and no zero-length window reaches the evaluator', async () => {
  let calls = 0;
  const controller = readyController({
    adapter: async request => echoed(request, {
      state: 'estimated',
      events: [{ type: 'rest', fromM: 0, toM: 0, startUtcMs: fixedNow, endUtcMs: fixedNow + 2_700_000 }],
      engineResult: { events: [{ label: 'Пауза 45 мин' }] }
    }),
    evaluateParking: request => { calls++; return evaluateParkingCandidates(request); }
  });
  await controller.plan();
  controller.loadParkingText(parkingText(parkingRecord('p1', 0.001)));
  const outcome = controller.selectRestForParking(0, 20);
  assert.equal(outcome.selected, false);
  assert.match(outcome.error, /началото на маршрута/);
  assert.equal(controller.getState().parking.restWindow, null);
  await controller.evaluateParking();
  assert.equal(calls, 1);
  assert.equal(controller.getState().parking.result.window.maxOffsetM > 0, true, 'whole route, not a zero window');
});

test('the draft export stays the 8 v1 fields and holds no pause or parking window', async () => {
  const { controller, restIndex } = await plannedLongRoute();
  controller.selectRestForParking(restIndex, 7);
  const text = controller.exportDraft().text;
  assert.deepEqual(Object.keys(JSON.parse(text)), ['format', 'version', 'exportedAtUtcMs', 'points', 'roadTypes', 'choices', 'departure', 'breakStyle']);
  for (const word of ['restWindow', 'lookback', 'minOffsetM', 'maxOffsetM', 'eventIndex', 'Пауза']) {
    assert.ok(!text.includes(word), word);
  }
});

test('the evaluator gets the pause offset in metres, not a value rounded through kilometres', async () => {
  const fromM = 1000.0001;
  assert.notEqual((fromM / 1000) * 1000, fromM, 'this offset changes in a km round trip');
  const seen = [];
  const controller = readyController({
    adapter: async request => echoed(request, {
      state: 'estimated',
      events: [
        { type: 'drive', fromM: 0, toM: fromM, startUtcMs: fixedNow, endUtcMs: fixedNow + 60_000 },
        { type: 'rest', fromM, toM: fromM, startUtcMs: fixedNow + 60_000, endUtcMs: fixedNow + 2_760_000 }
      ],
      engineResult: { events: [{ label: 'Каране' }, { label: 'Пауза 45 мин' }] }
    }),
    evaluateParking: request => { seen.push(request.window); return evaluateParkingCandidates(request); }
  }, 2_000);
  await controller.plan();
  controller.loadParkingText(parkingText(parkingRecord('p1', 0.005)));
  assert.equal(controller.selectRestForParking(1, 0.5).selected, true);
  await controller.evaluateParking();
  assert.equal(seen[0].maxOffsetM, fromM);
  assert.equal(seen[0].minOffsetM, fromM - 500);
});
