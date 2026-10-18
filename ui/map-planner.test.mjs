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
const makeController = overrides => createMapPlannerController({
  now: () => fixedNow,
  ...overrides
});
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
