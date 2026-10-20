// INT-01: PLAN-05 daily-rest behaviour through the real map adapter.
// Real createMapPlan, buildPlan, indexRoute and pointAtOffset; no planner mocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan } from '../engine/plan.js';
import { indexRoute, pointAtOffset } from '../engine/route-position.js';
import { createMapPlan } from '../engine/map-plan.js';

const MIN = 60_000;
const H = 60 * MIN;
const now = Date.parse('2026-10-12T00:00:00Z');
const dependencies = { buildPlan, indexRoute, pointAtOffset };
const degreeForMeters = meters => meters / 6_371_000 * 180 / Math.PI;
const MISSED = 'DAILY_REST_DEADLINE_MISSED';
const MISSED_ASSUMPTION = 'Избраният вид дневна почивка вече е извън срока; незабавната почивка не променя миналата история.';

// Synthetic equator route. Section lengths are derived from the indexed length,
// so the last section always ends exactly at the route end.
function route(sectionKm) {
  const totalM = sectionKm.reduce((sum, [km]) => sum + km * 1000, 0);
  const geometry = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: degreeForMeters(totalM / 2) },
    { lat: 0, lon: degreeForMeters(totalM) }
  ];
  const lengthM = indexRoute(geometry).totalLengthM;
  let fromM = 0;
  const roadSections = sectionKm.map(([km, roadType], index) => {
    const toM = index === sectionKm.length - 1 ? lengthM : fromM + km * 1000;
    const section = { id: `s${index + 1}`, fromM, toM, roadType, source: 'test' };
    fromM = toM;
    return section;
  });
  return { geometry, geometryKind: 'road-routed', source: 'int-01-synthetic', vehicleProfileRef: null, roadSections };
}

function request({ sections = [[400, 'motorway']], activities, at = now, departure = at, bySection = [], multiManning = false, ids = {} }) {
  return {
    schemaVersion: 1,
    requestId: ids.requestId ?? 'int-01-request',
    routeRevision: ids.routeRevision ?? 'int-01-route',
    inputRevision: ids.inputRevision ?? 'int-01-input',
    nowUtcMs: at,
    departureUtcMs: departure,
    displayTimeZone: 'Europe/Sofia',
    route: route(sections),
    initialState: { activities, lastWeeklyRestEnd: null, source: 'int-01-synthetic-log' },
    choices: { breakStyle: '45', multiManning, bySection }
  };
}

// Complete history (rest from now-8d) to the start of the duty, then work, then
// an optional recorded rest that runs up to `now`.
function history(workHours, restHours = 0) {
  const dutyStart = now - (workHours + restHours) * H;
  const log = [{ type: 'rest', start: now - 192 * H, end: dutyStart }];
  if (workHours > 0) log.push({ type: 'work', start: dutyStart, end: now - restHours * H });
  if (restHours > 0) log.push({ type: 'rest', start: now - restHours * H, end: now });
  return log;
}

const missed = result => result.engineResult.ignoredDailyRests.some(item => item.code === MISSED);
const warningCodes = result => result.warnings.map(w => w.code);

function assertContiguousOnRoute(result, input) {
  const total = indexRoute(input.route.geometry).totalLengthM;
  let time = input.departureUtcMs;
  let offset = 0;
  for (const event of result.events) {
    assert.equal(event.startUtcMs, time, `${event.id} starts where the previous event ends`);
    assert.ok(event.endUtcMs > event.startUtcMs);
    assert.ok(Math.abs(event.fromM - offset) < 1e-6, `${event.id} starts at the previous offset`);
    assert.ok(event.toM >= event.fromM);
    if (event.type === 'rest') {
      assert.equal(event.toM, event.fromM);
      assert.equal(event.stopKind, 'unassigned');
    } else {
      assert.equal(event.stopKind, null);
    }
    const section = input.route.roadSections[event.stageIndex];
    assert.equal(event.sectionId, section.id);
    assert.ok(event.fromM >= section.fromM - 0.05 && event.toM <= section.toM + 0.05);
    const expected = pointAtOffset(indexRoute(input.route.geometry), Math.min(total, event.fromM));
    assert.equal(event.fromPoint.lat, expected.lat);
    assert.equal(event.fromPoint.lon, expected.lon);
    time = event.endUtcMs;
    offset = event.toM;
  }
  assert.equal(time, result.arrivalUtcMs);
  assert.ok(Math.abs(offset - total) <= 0.05);
  assert.deepEqual(result.events[0].fromPoint, input.route.geometry[0]);
  assert.ok(Math.abs(result.events.at(-1).toPoint.lon - input.route.geometry.at(-1).lon) < 1e-12);
}

test('INT-01: a recorded rest continuing at departure reaches the map without a missed-deadline signal', () => {
  const input = request({ activities: history(12, 2) });
  const result = createMapPlan(input, dependencies);
  assert.equal(result.state, 'estimated');
  assert.equal(missed(result), false);
  assert.equal(result.assumptions.includes(MISSED_ASSUMPTION), false);
  assert.equal(result.engineResult.confirmed, true);
  assert.deepEqual(result.engineResult.violations, []);
  assert.equal(warningCodes(result).includes('ENGINE_VIOLATIONS'), false);
  assert.equal(warningCodes(result).includes('HISTORY_INCOMPLETE'), false);
  const first = result.events[0];
  assert.equal(first.type, 'rest');
  assert.equal(first.startUtcMs, now);
  assert.equal(first.endUtcMs - first.startUtcMs, 11 * H);
  assert.equal(result.engineResult.events[0].label, 'Редовна дневна почивка 11 ч');
  assertContiguousOnRoute(result, input);
});

test('INT-01: a rest begun exactly at the deadline is credited, one minute later the warning reaches the map', () => {
  const exact = createMapPlan(request({ activities: history(13, 2) }), dependencies);
  assert.equal(missed(exact), false);
  assert.equal(exact.engineResult.confirmed, true);
  assert.equal(exact.assumptions.includes(MISSED_ASSUMPTION), false);

  const late = createMapPlan(request({ activities: history(13 + 1 / 60, 2 - 1 / 60) }), dependencies);
  assert.equal(late.state, 'estimated');
  assert.equal(missed(late), true);
  assert.equal(late.assumptions.includes(MISSED_ASSUMPTION), true);
  assert.equal(late.engineResult.confirmed, false);
  assert.notEqual(late.engineResult.events[0].label, 'Редовна дневна почивка 11 ч');
  assert.equal(late.events[0].type, 'rest');
  assert.equal(late.events[0].startUtcMs, now);
});

test('INT-01: recorded work or driving after the rest breaks continuity and keeps the warning', () => {
  for (const type of ['work', 'drive']) {
    const activities = history(12, 2);
    activities[2].end = now - MIN;
    activities.push({ type, start: now - MIN, end: now });
    const result = createMapPlan(request({ activities }), dependencies);
    assert.equal(result.state, 'estimated', type);
    assert.equal(missed(result), true, type);
    assert.equal(result.assumptions.includes(MISSED_ASSUMPTION), true, type);
    assert.equal(result.engineResult.confirmed, false, type);
  }
});

test('INT-01: an unrecorded interval before a future departure is neither rest nor confirmed history', () => {
  const activities = history(12, 2);
  activities[2].end = null; // the rest is open at now; nothing is known until departure
  const departure = now + 3 * H;
  const input = request({ activities, departure });
  const result = createMapPlan(input, dependencies);
  assert.equal(result.state, 'estimated');
  assert.equal(missed(result), true);
  assert.equal(result.engineResult.confirmed, false);
  assert.deepEqual(result.historyCoverage.gaps, [{ start: now, end: departure }]);
  assert.ok(warningCodes(result).includes('HISTORY_INCOMPLETE'));
  assert.equal(result.events[0].startUtcMs, departure);
  assert.ok(result.events.every(event => event.startUtcMs >= departure));
  assertContiguousOnRoute(result, input);
});

test('INT-01: adjacent road sections share one duty deadline and stay contiguous on the same line', () => {
  const input = request({ sections: [[240, 'motorway'], [440, 'ordinary']], activities: history(6) });
  const result = createMapPlan(input, dependencies);
  assert.equal(result.state, 'estimated');
  assert.equal(missed(result), false);
  assert.deepEqual(result.engineResult.violations, []);
  const dailyRests = result.events.filter(e => e.type === 'rest' && e.endUtcMs - e.startUtcMs >= 9 * H);
  assert.equal(dailyRests.length, 1);
  assert.equal(dailyRests[0].startUtcMs, now + 7 * H);
  assert.equal(dailyRests[0].sectionId, 's2');
  assert.deepEqual(result.events.map(e => e.sectionId).filter((id, i, all) => id !== all[i - 1]), ['s1', 's2']);
  const boundary = input.route.roadSections[0].toM;
  const firstOnS2 = result.events.find(e => e.sectionId === 's2');
  assert.ok(Math.abs(firstOnS2.fromM - boundary) < 1e-6);
  assertContiguousOnRoute(result, input);
  for (const event of result.events) {
    assert.deepEqual(Object.keys(event).sort(),
      ['endUtcMs', 'fromM', 'fromPoint', 'id', 'sectionId', 'stageIndex', 'startUtcMs', 'stopKind', 'toM', 'toPoint', 'type']);
  }
});

test('INT-01: 10h and 9h section choices pass through with their allowances and without legal claims', () => {
  // Available rights: a 9h choice gives a 9h rest, a 10h choice gives one extended duty.
  const fresh = request({ sections: [[800, 'motorway'], [800, 'motorway']], activities: history(0),
    bySection: [{ sectionId: 's1', useExtension: true }, { sectionId: 's2', dailyRest: 'reduced' }] });
  const ok = createMapPlan(fresh, dependencies);
  assert.equal(ok.state, 'estimated');
  assert.equal(ok.engineResult.extendedDuties.length, 1);
  assert.equal(ok.engineResult.stages[0].extensionUsed, true);
  assert.ok(ok.events.some(e => e.type === 'rest' && e.endUtcMs - e.startUtcMs === 9 * H));
  assert.equal(ok.capabilities.legalApproval, false);
  assert.ok(warningCodes(ok).includes('ESTIMATE_ONLY'));

  // Exhausted rights from real history in the same UTC week (weekly rest ends Monday 00:00):
  // two 10h duties and three 9h rests; departure right after the last reduced rest.
  const log = [{ type: 'rest', start: now - 192 * H, end: now }];
  let t = now;
  const add = (type, minutes) => { log.push({ type, start: t, end: t + minutes * MIN }); t += minutes * MIN; };
  for (let day = 0; day < 2; day++) { add('drive', 270); add('rest', 45); add('drive', 270); add('rest', 45); add('drive', 60); add('rest', 660); }
  for (let day = 0; day < 3; day++) { add('drive', 270); add('rest', 45); add('drive', 270); add('rest', 540); }
  const exhausted = createMapPlan(request({ sections: [[1600, 'motorway']], activities: log, at: t,
    bySection: [{ sectionId: 's1', useExtension: true, dailyRest: 'reduced' }] }), dependencies);
  assert.equal(exhausted.state, 'estimated');
  assert.equal(exhausted.engineResult.status.daily.extensionsUsed, 2);
  assert.ok(exhausted.engineResult.ignoredExtensions.length > 0);
  assert.ok(exhausted.engineResult.ignoredDailyRests.some(item => item.reason.includes('трите')));
  assert.equal(exhausted.engineResult.extendedDuties.filter(start => start >= t).length, 0);
  assert.ok(!exhausted.events.some(e => e.type === 'rest' && e.endUtcMs - e.startUtcMs === 9 * H));
  assert.equal(exhausted.capabilities.legalApproval, false);
});

test('INT-01: a boolean manual rest over later automatic work is credited and the request is not mutated', () => {
  // An automatic `work` record starts after the manual rest and overlaps its last hour.
  // Manual records win overlaps, so only the flag keeps the rest continuous to departure.
  const activities = [
    { type: 'rest', start: new Date(now - 192 * H).toISOString(), end: new Date(now - 14 * H).toISOString() },
    { type: 'work', start: now - 14 * H, end: now - 2 * H },
    { type: 'rest', start: now - 2 * H, end: now, manual: true },
    { type: 'work', start: now - H, end: now }
  ];
  const input = request({ activities });
  const before = structuredClone(input);
  const result = createMapPlan(input, dependencies);
  assert.deepEqual(input, before);
  assert.equal(result.state, 'estimated');
  assert.equal(missed(result), false);
  assert.deepEqual(result.engineResult.violations, []);

  const unflagged = structuredClone(input);
  delete unflagged.initialState.activities[2].manual;
  const automatic = createMapPlan(unflagged, dependencies);
  assert.equal(missed(automatic), true);
  assert.equal(automatic.engineResult.confirmed, false);
});

test('INT-01: echoed revisions stay exactly those of the request on every result with warnings', () => {
  const ids = { requestId: 'req-Ä-1', routeRevision: 'route-rev-7', inputRevision: 'input-rev-42' };
  const cases = [
    request({ activities: history(13 + 1 / 60, 2 - 1 / 60), ids }),             // missed deadline
    request({ activities: history(16), ids }),                                   // engine violation
    request({ activities: history(12, 2), departure: now + H, multiManning: true, ids }), // gap + crew warning
    { ...request({ activities: history(12, 2), ids }), requirements: { ferry: true } }   // unsupported
  ];
  const states = [];
  for (const input of cases) {
    const result = createMapPlan(input, dependencies);
    states.push(result.state);
    assert.equal(result.requestId, ids.requestId);
    assert.equal(result.routeRevision, ids.routeRevision);
    assert.equal(result.inputRevision, ids.inputRevision);
    assert.ok(result.warnings.length > 0);
  }
  assert.deepEqual(states, ['estimated', 'estimated', 'estimated', 'unsupported']);
});
