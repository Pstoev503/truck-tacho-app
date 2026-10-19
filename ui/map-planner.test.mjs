import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMapPlannerController, formatSofiaTime, formatViolation, sampleRoute } from './map-planner.mjs';
import { buildPlan } from '../engine/plan.js';
import { indexRoute, pointAtOffset } from '../engine/route-position.js';
import { createMapPlan } from '../engine/map-plan.js';
import { analyze } from '../engine/tacho-rules.js';

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
