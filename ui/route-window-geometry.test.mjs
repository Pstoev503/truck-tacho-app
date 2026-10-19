import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_WINDOW_POINTS, MAX_WINDOW_STEP_M, RouteWindowError, routeWindowPoints } from './route-window-geometry.mjs';
import { indexRoute, pointAtOffset } from '../engine/route-position.js';

const codeOf = fn => {
  try { fn(); } catch (caught) { assert.ok(caught instanceof RouteWindowError, String(caught)); return caught.code; }
  return 'ok';
};
const offsets = points => points.map(point => point.routeOffsetM);
const ascending = values => values.every((value, i) => i === 0 || value > values[i - 1]);
const L_ROUTE = [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }];

test('a window inside one segment starts and ends exactly at the requested offsets', () => {
  const geometry = [{ lat: 0, lon: 0 }, { lat: 0, lon: 2 }];
  const index = indexRoute(geometry);
  const points = routeWindowPoints(geometry, { minOffsetM: 40_000, maxOffsetM: 100_000 });
  assert.equal(points[0].routeOffsetM, 40_000);
  assert.equal(points.at(-1).routeOffsetM, 100_000);
  const start = pointAtOffset(index, 40_000), end = pointAtOffset(index, 100_000);
  assert.deepEqual([points[0].lat, points[0].lon], [start.lat, start.lon]);
  assert.deepEqual([points.at(-1).lat, points.at(-1).lon], [end.lat, end.lon]);
  assert.equal(points.length, 1 + Math.ceil(60_000 / MAX_WINDOW_STEP_M));
  assert.ok(ascending(offsets(points)));
});

test('a window across a bend keeps the vertex and does not cut the corner', () => {
  const index = indexRoute(L_ROUTE);
  const bendM = index.segments[0].endOffsetM;
  const points = routeWindowPoints(L_ROUTE, { minOffsetM: bendM - 20_000, maxOffsetM: bendM + 20_000 });
  const bend = points.find(point => point.routeOffsetM === bendM);
  assert.ok(bend, 'the bend offset is one of the points');
  assert.deepEqual([bend.lat, bend.lon], [0, 1], 'exactly the drawn vertex');
  // A straight line from start to end would pass ~14 km from the bend; every point here is on the line.
  for (const point of points) {
    const onRoute = pointAtOffset(index, point.routeOffsetM);
    assert.deepEqual([point.lat, point.lon], [onRoute.lat, onRoute.lon]);
  }
});

test('several segments: every inside vertex is kept and nothing outside the window is added', () => {
  const geometry = [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.5 }, { lat: 0.3, lon: 0.6 }, { lat: 0.3, lon: 1.2 }, { lat: 0, lon: 1.5 }];
  const index = indexRoute(geometry);
  const min = 30_000, max = index.cumulativeMeters[4] - 10_000;
  const points = routeWindowPoints(geometry, { minOffsetM: min, maxOffsetM: max });
  for (const vertexOffset of index.cumulativeMeters.slice(1, 4)) {
    assert.ok(offsets(points).includes(vertexOffset), `vertex at ${vertexOffset}`);
  }
  assert.ok(points.every(point => point.routeOffsetM >= min && point.routeOffsetM <= max));
  assert.ok(ascending(offsets(points)));
});

test('the whole route returns the drawn start and end points exactly', () => {
  const index = indexRoute(L_ROUTE);
  const points = routeWindowPoints(L_ROUTE, { minOffsetM: 0, maxOffsetM: index.totalLengthM });
  assert.deepEqual([points[0].lat, points[0].lon], [0, 0]);
  assert.deepEqual([points.at(-1).lat, points.at(-1).lon], [1, 1]);
  assert.equal(points.at(-1).routeOffsetM, index.totalLengthM);
});

test('long arcs are sampled at most 25 km apart', () => {
  const geometry = [{ lat: 10, lon: 0 }, { lat: 40, lon: 30 }];
  const index = indexRoute(geometry);
  const points = routeWindowPoints(geometry, { minOffsetM: 1_000, maxOffsetM: index.totalLengthM - 1_000 });
  for (let i = 1; i < points.length; i++) {
    assert.ok(points[i].routeOffsetM - points[i - 1].routeOffsetM <= MAX_WINDOW_STEP_M + 1e-6);
  }
  assert.ok(points.length > 100, `${points.length} points for ~4400 km`);
});

test('zero-length segments are skipped without duplicate points', () => {
  const plain = [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }];
  const repeated = [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }];
  const total = indexRoute(plain).totalLengthM;
  const window = { minOffsetM: 50_000, maxOffsetM: total - 50_000 };
  assert.deepEqual(routeWindowPoints(repeated, window), routeWindowPoints(plain, window));
});

test('offsets must be numbers with 0 <= min < max <= total, without coercion', () => {
  const total = indexRoute(L_ROUTE).totalLengthM;
  for (const window of [
    { minOffsetM: NaN, maxOffsetM: 1000 }, { minOffsetM: '0', maxOffsetM: 1000 }, { minOffsetM: 0, maxOffsetM: '1000' },
    { minOffsetM: 500, maxOffsetM: 500 }, { minOffsetM: 600, maxOffsetM: 500 }, { minOffsetM: -1, maxOffsetM: 500 },
    { minOffsetM: 0, maxOffsetM: total + 0.001 }, { minOffsetM: 0, maxOffsetM: Infinity }, {}, { minOffsetM: 0 }
  ]) {
    assert.equal(codeOf(() => routeWindowPoints(L_ROUTE, window)), 'INVALID_OFFSETS', JSON.stringify(window));
  }
  assert.equal(codeOf(() => routeWindowPoints(L_ROUTE, { minOffsetM: 0, maxOffsetM: total })), 'ok');
});

test('geometry must be numeric and inside the route-position limits', () => {
  const window = { minOffsetM: 0, maxOffsetM: 1000 };
  for (const geometry of [
    null, 'line', [{ lat: 0, lon: 0 }], [{ lat: '0', lon: 0 }, { lat: 0, lon: 1 }], [{ lat: NaN, lon: 0 }, { lat: 0, lon: 1 }],
    [{ lat: 86, lon: 0 }, { lat: 86, lon: 1 }], [{ lat: 0, lon: 179 }, { lat: 0, lon: -179 }],
    [{ lat: 1, lon: 1 }, { lat: 1, lon: 1 }], [null, { lat: 0, lon: 1 }]
  ]) {
    assert.equal(codeOf(() => routeWindowPoints(geometry, window)), 'INVALID_GEOMETRY', JSON.stringify(geometry));
  }
});

test('more than the point limit is refused, not cut; exactly the limit is accepted', () => {
  const zigzag = n => Array.from({ length: n }, (_, i) => ({ lat: (i % 2) * 0.001, lon: i * 0.001 }));
  const fits = zigzag(MAX_WINDOW_POINTS);
  const fitsTotal = indexRoute(fits).totalLengthM;
  assert.equal(routeWindowPoints(fits, { minOffsetM: 0, maxOffsetM: fitsTotal }).length, MAX_WINDOW_POINTS);
  const tooMany = zigzag(MAX_WINDOW_POINTS + 1);
  const total = indexRoute(tooMany).totalLengthM;
  assert.equal(codeOf(() => routeWindowPoints(tooMany, { minOffsetM: 0, maxOffsetM: total })), 'TOO_MANY_POINTS');
});

test('frozen input is accepted and unchanged; the result is frozen', () => {
  const geometry = Object.freeze(L_ROUTE.map(point => Object.freeze({ ...point })));
  const window = Object.freeze({ minOffsetM: 10_000, maxOffsetM: 150_000 });
  const snapshot = structuredClone([geometry, window]);
  const points = routeWindowPoints(geometry, window);
  assert.deepEqual([geometry, window], snapshot);
  assert.ok(Object.isFrozen(points) && Object.isFrozen(points[0]));
});
