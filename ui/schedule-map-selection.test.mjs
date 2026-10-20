import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ScheduleSelectionError, describeSelection, formatDuration, formatSofiaWithOffset, scheduleSelection
} from './schedule-map-selection.mjs';
import { createMapPlan } from '../engine/map-plan.js';
import { buildPlan } from '../engine/plan.js';
import { indexRoute, pointAtOffset } from '../engine/route-position.js';

const T = Date.parse('2026-10-19T08:00:00Z');
const codeOf = fn => {
  try { fn(); } catch (caught) { assert.ok(caught instanceof ScheduleSelectionError, String(caught)); return caught.code; }
  return 'ok';
};
const L_ROUTE = [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }];
const L_TOTAL = indexRoute(L_ROUTE).totalLengthM;
const fakeResult = events => ({ state: 'estimated', events, engineResult: { events: events.map(e => ({ label: e.label })) } });
const drive = (fromM, toM, extra = {}) => ({ type: 'drive', fromM, toM, startUtcMs: T, endUtcMs: T + 3_600_000, label: 'Каране', ...extra });
const rest = (atM, extra = {}) => ({ type: 'rest', fromM: atM, toM: atM, startUtcMs: T, endUtcMs: T + 2_700_000, label: 'Пауза 45 мин', ...extra });

// A real plan through the accepted adapter: about 667 km on an ordinary road.
function realPlan() {
  const geometry = [{ lat: 0, lon: 0 }, { lat: 0, lon: 6 }];
  const total = indexRoute(geometry).totalLengthM;
  const result = createMapPlan({
    schemaVersion: 1, requestId: 'r1', routeRevision: 'route-1', inputRevision: 'input-1',
    nowUtcMs: T, departureUtcMs: T, displayTimeZone: 'Europe/Sofia',
    route: { geometry, geometryKind: 'manual-sketch', source: 'manual-map-sketch', vehicleProfileRef: null,
      roadSections: [{ id: 'section-1', fromM: 0, toM: total, roadType: 'ordinary', source: 'manual' }] },
    initialState: { activities: [], lastWeeklyRestEnd: null, source: 'none' },
    choices: { breakStyle: '45', multiManning: false, bySection: [{ sectionId: 'section-1', useExtension: false, dailyRest: 'regular' }] }
  }, { buildPlan, indexRoute, pointAtOffset });
  assert.equal(result.state, 'estimated');
  return { geometry, result };
}

test('a real drive stage covers exactly its stretch of the drawn line', () => {
  const { geometry, result } = realPlan();
  const index = result.events.findIndex(event => event.type === 'drive');
  const event = result.events[index];
  const selection = scheduleSelection({ points: geometry, result, eventIndex: index });
  assert.equal(selection.kind, 'drive');
  assert.equal(selection.result, result);
  const routeIndex = indexRoute(geometry);
  const start = pointAtOffset(routeIndex, event.fromM), end = pointAtOffset(routeIndex, event.toM);
  assert.deepEqual(selection.line[0], [start.lat, start.lon]);
  assert.deepEqual(selection.line.at(-1), [end.lat, end.lon]);
  assert.ok(selection.line.length > 2, 'long drives are sampled, not one straight segment');
  assert.equal(selection.label, 'Каране: section-1');
});

test('a real rest stage is one marker at the plan’s own rest position', () => {
  const { geometry, result } = realPlan();
  const index = result.events.findIndex(event => event.type === 'rest');
  const event = result.events[index];
  const selection = scheduleSelection({ points: geometry, result, eventIndex: index });
  assert.equal(selection.kind, 'rest');
  assert.equal(selection.line, undefined);
  assert.ok(Math.abs(selection.point.lat - event.fromPoint.lat) < 1e-9);
  assert.ok(Math.abs(selection.point.lon - event.fromPoint.lon) < 1e-9);
  assert.equal(selection.label, 'Пауза 45 мин');
});

test('a drive stage across a bend keeps the vertex; ends at the route start and end are exact', () => {
  const bendM = indexRoute(L_ROUTE).segments[0].endOffsetM;
  const across = scheduleSelection({ points: L_ROUTE, result: fakeResult([drive(bendM - 10_000, bendM + 10_000)]), eventIndex: 0 });
  assert.ok(across.line.some(([lat, lon]) => lat === 0 && lon === 1), 'bend vertex included');
  const whole = scheduleSelection({ points: L_ROUTE, result: fakeResult([drive(0, L_TOTAL)]), eventIndex: 0 });
  assert.deepEqual(whole.line[0], [0, 0]);
  assert.deepEqual(whole.line.at(-1), [1, 1]);
  const startRest = scheduleSelection({ points: L_ROUTE, result: fakeResult([rest(0)]), eventIndex: 0 });
  assert.deepEqual(startRest.point, { lat: 0, lon: 0 });
  const endRest = scheduleSelection({ points: L_ROUTE, result: fakeResult([rest(L_TOTAL)]), eventIndex: 0 });
  assert.deepEqual(endRest.point, { lat: 1, lon: 1 });
});

test('no plan, a wrong index or an unsupported stage type gives no selection', () => {
  const result = fakeResult([drive(0, 1000), rest(1000)]);
  assert.equal(codeOf(() => scheduleSelection({ points: L_ROUTE, result: null, eventIndex: 0 })), 'NO_PLAN');
  assert.equal(codeOf(() => scheduleSelection({ points: L_ROUTE, result: { state: 'needs-data', events: [] }, eventIndex: 0 })), 'NO_PLAN');
  for (const eventIndex of [-1, 2, 1.5, '0', null, undefined, NaN]) {
    assert.equal(codeOf(() => scheduleSelection({ points: L_ROUTE, result, eventIndex })), 'INVALID_INDEX', String(eventIndex));
  }
  const odd = fakeResult([{ type: 'work', fromM: 0, toM: 0, startUtcMs: T, endUtcMs: T }]);
  assert.equal(codeOf(() => scheduleSelection({ points: L_ROUTE, result: odd, eventIndex: 0 })), 'UNSUPPORTED_STAGE');
});

test('offsets must be finite numbers inside the line; drive from < to, rest from = to', () => {
  const cases = [
    drive(NaN, 1000), drive(0, '1000'), drive('0', 1000), drive(-1, 1000), drive(0, L_TOTAL + 1),
    drive(500, 500), drive(600, 500), rest(1000, { toM: 1001 }), rest(Infinity), rest(L_TOTAL + 0.5)
  ];
  for (const event of cases) {
    assert.equal(codeOf(() => scheduleSelection({ points: L_ROUTE, result: fakeResult([event]), eventIndex: 0 })),
      'INVALID_OFFSETS', JSON.stringify(event));
  }
});

test('stage times must be finite and ordered', () => {
  for (const extra of [{ startUtcMs: NaN }, { endUtcMs: '1' }, { endUtcMs: T - 1 }]) {
    assert.equal(codeOf(() => scheduleSelection({ points: L_ROUTE, result: fakeResult([drive(0, 1000, extra)]), eventIndex: 0 })), 'INVALID_TIMES');
  }
});

test('an unsupported or changed line gives no invented coordinates', () => {
  const result = fakeResult([drive(0, 1000)]);
  for (const points of [[{ lat: 0, lon: 0 }], [{ lat: 0, lon: 179 }, { lat: 0, lon: -179 }], [{ lat: '0', lon: 0 }, { lat: 0, lon: 1 }], null]) {
    assert.equal(codeOf(() => scheduleSelection({ points, result, eventIndex: 0 })), 'INVALID_GEOMETRY', JSON.stringify(points));
  }
  // An offset beyond a now shorter line is refused instead of clamped.
  const shortLine = [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.001 }];
  assert.equal(codeOf(() => scheduleSelection({ points: shortLine, result: fakeResult([drive(0, 50_000)]), eventIndex: 0 })), 'INVALID_OFFSETS');
});

test('frozen inputs are accepted and unchanged; the selection is frozen', () => {
  const result = Object.freeze(fakeResult([Object.freeze(drive(1000, 60_000))]));
  const points = Object.freeze(L_ROUTE.map(point => Object.freeze({ ...point })));
  const snapshot = JSON.stringify([points, result]);
  const selection = scheduleSelection(Object.freeze({ points, result, eventIndex: 0 }));
  assert.equal(JSON.stringify([points, result]), snapshot);
  assert.ok(Object.isFrozen(selection) && Object.isFrozen(selection.line) && Object.isFrozen(selection.line[0]));
});

test('the two autumn 03:30 times are shown with different offsets', () => {
  assert.equal(formatSofiaWithOffset(Date.parse('2026-10-25T00:30:00Z')), '25.10.2026 г., 03:30 (UTC+03:00)');
  assert.equal(formatSofiaWithOffset(Date.parse('2026-10-25T01:30:00Z')), '25.10.2026 г., 03:30 (UTC+02:00)');
});

test('details come from the event as planned, with a geometric-only note', () => {
  const selection = scheduleSelection({ points: L_ROUTE, result: fakeResult([drive(12_345, 98_765)]), eventIndex: 0 });
  const lines = describeSelection(selection);
  assert.equal(lines[0], 'Избран етап: Каране.');
  assert.match(lines[1], /продължителност: 1 ч 0 мин/);
  assert.equal(lines[2], 'По линията: от 12.35 до 98.77 км (86.42 км).');
  assert.match(lines[3], /Само геометричен преглед/);
  const restLines = describeSelection(scheduleSelection({ points: L_ROUTE, result: fakeResult([rest(50_000)]), eventIndex: 0 }));
  assert.equal(restLines[0], 'Избран етап: Пауза 45 мин.');
  assert.equal(restLines[2], 'Място по линията: 50.00 км. Паркинг не е избран.');
  assert.equal(formatDuration(45 * 60_000), '45 мин');
  assert.equal(formatDuration(660 * 60_000), '11 ч 0 мин');
});
