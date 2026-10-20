import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexRoute, pointAtOffset, projectToRoute } from './route-position.js';

const equatorDegreeM = 111_194.93;
const closeTo = (actual, expected, tolerance, message) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, message ?? `${actual} not within ${tolerance} of ${expected}`);

test('offset zero and total length return the route endpoints', () => {
  const index = indexRoute([{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }]);
  assert.deepEqual(pointAtOffset(index, 0), {
    lat: 0, lon: 0, routeOffsetM: 0, segmentIndex: 0
  });
  const end = pointAtOffset(index, index.totalLengthM);
  assert.equal(end.lat, 0);
  assert.equal(end.lon, 1);
  assert.equal(end.routeOffsetM, index.totalLengthM);
});

test('interpolates a point in the middle of a long segment', () => {
  const index = indexRoute([{ lat: 0, lon: 0 }, { lat: 0, lon: 2 }]);
  const middle = pointAtOffset(index, index.totalLengthM / 2);
  closeTo(middle.lon, 1, 1e-10);
  closeTo(middle.lat, 0, 1e-10);
});

test('consecutive duplicate vertices do not create zero-length divisions', () => {
  const index = indexRoute([
    { lat: 0, lon: 0 }, { lat: 0, lon: 0 }, { lat: 0, lon: 1 }
  ]);
  closeTo(index.totalLengthM, equatorDegreeM, 0.01);
  assert.equal(pointAtOffset(index, index.totalLengthM / 2).segmentIndex, 1);
});

test('rejects a route with zero total length', () => {
  assert.throws(
    () => indexRoute([{ lat: 1, lon: 2 }, { lat: 1, lon: 2 }, { lat: 1, lon: 2 }]),
    /non-zero total length/
  );
});

test('requires at least two valid coordinates', () => {
  assert.throws(() => indexRoute([{ lat: 0, lon: 0 }]), /at least two/);
  assert.throws(() => indexRoute('not geometry'), /at least two/);
});

test('rejects NaN, infinite, and out-of-range coordinates', () => {
  for (const badPoint of [
    { lat: NaN, lon: 0 },
    { lat: 0, lon: Infinity },
    { lat: 91, lon: 0 },
    { lat: 0, lon: -181 }
  ]) {
    assert.throws(
      () => indexRoute([{ lat: 0, lon: 0 }, badPoint]),
      /finite latitude/
    );
  }
});

test('pointAtOffset rejects NaN, negative, and beyond-end offsets without clamping', () => {
  const index = indexRoute([{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }]);
  for (const offset of [NaN, -1, index.totalLengthM + 1]) {
    assert.throws(() => pointAtOffset(index, offset), /offsetM must be finite/);
  }
});

test('projects to the middle of a segment and reports lateral distance', () => {
  const index = indexRoute([{ lat: 0, lon: 0 }, { lat: 0, lon: 2 }], {
    routeRevision: 'r1'
  });
  const result = projectToRoute(index, { lat: 0.01, lon: 1 }, { maxDistanceM: 2_000 });
  assert.equal(result.status, 'matched');
  closeTo(result.routeOffsetM, index.totalLengthM / 2, 1);
  closeTo(result.lateralDistanceM, equatorDegreeM / 100, 1);
  assert.equal(result.routeRevision, 'r1');
});

test('reports a point outside the corridor as off-route', () => {
  const index = indexRoute([{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }]);
  const result = projectToRoute(index, { lat: 1, lon: 0.5 }, { maxDistanceM: 1_000 });
  assert.equal(result.status, 'off-route');
  closeTo(result.lateralDistanceM, equatorDegreeM, 2);
  assert.ok(result.routeOffsetM !== null);
});

test('a candidate outside the corridor does not make an eligible match ambiguous', () => {
  const index = indexRoute([
    { lat: 0, lon: 0 }, { lat: 0, lon: 1 },
    { lat: 0.00003, lon: 1 }, { lat: 0.00003, lon: 0 }
  ]);
  const result = projectToRoute(index, { lat: 0, lon: 0.5 }, { maxDistanceM: 1 });

  assert.equal(result.status, 'matched');
  assert.equal(result.segmentIndex, 0);
  assert.equal(result.candidates.length, 1);
  closeTo(result.lateralDistanceM, 0, 0.01);
});

test('two distinct candidates inside the corridor and ambiguity tolerance are ambiguous', () => {
  const index = indexRoute([
    { lat: 0, lon: 0 }, { lat: 0, lon: 1 },
    { lat: 0.00003, lon: 1 }, { lat: 0.00003, lon: 0 }
  ]);
  const result = projectToRoute(index, { lat: 0, lon: 0.5 }, {
    maxDistanceM: 5,
    ambiguityToleranceM: 5
  });

  assert.equal(result.status, 'ambiguous');
  assert.equal(result.routeOffsetM, null);
  assert.equal(result.candidates.length, 2);
  assert.ok(result.candidates.every(candidate => candidate.lateralDistanceM <= 5));
});

test('candidates all outside the corridor remain off-route diagnostics', () => {
  const index = indexRoute([
    { lat: 0, lon: 0 }, { lat: 0, lon: 1 },
    { lat: 0.00003, lon: 1 }, { lat: 0.00003, lon: 0 }
  ]);
  const result = projectToRoute(index, { lat: 0.0001, lon: 0.5 }, {
    maxDistanceM: 1
  });

  assert.equal(result.status, 'off-route');
  assert.equal(result.reason, 'outside-corridor');
  assert.ok(result.candidates.length >= 2);
  assert.ok(result.candidates.every(candidate => candidate.lateralDistanceM > 1));
  assert.ok(result.lateralDistanceM > 1);
  assert.ok(result.routeOffsetM !== null);
});

test('a shared vertex on adjacent segments is one matched position', () => {
  const index = indexRoute([
    { lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }
  ]);
  const result = projectToRoute(index, { lat: 0, lon: 1 }, { maxDistanceM: 1 });
  assert.equal(result.status, 'matched');
  assert.equal(result.candidates.length, 1);
  closeTo(result.routeOffsetM, equatorDegreeM, 0.01);
});

test('reports a self-crossing as ambiguous instead of choosing a visit', () => {
  const index = indexRoute([
    { lat: -1, lon: -1 }, { lat: 1, lon: 1 },
    { lat: -1, lon: 1 }, { lat: 1, lon: -1 }
  ]);
  const result = projectToRoute(index, { lat: 0, lon: 0 }, { maxDistanceM: 10 });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.routeOffsetM, null);
  assert.ok(result.candidates.length >= 2);
  closeTo(result.candidates[0].lateralDistanceM, 0, 0.01);
  closeTo(result.candidates[1].lateralDistanceM, 0, 0.01);
});

test('reports a repeated traversal of the same line as ambiguous', () => {
  const index = indexRoute([
    { lat: 0, lon: 0 }, { lat: 0, lon: 1 },
    { lat: 0, lon: 0 }
  ]);
  const result = projectToRoute(index, { lat: 0, lon: 0.5 }, { maxDistanceM: 1 });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.candidates.length, 2);
  assert.ok(result.candidates[1].routeOffsetM - result.candidates[0].routeOffsetM > 100_000);
});

test('offset bounds select one specific visit', () => {
  const index = indexRoute([
    { lat: 0, lon: 0 }, { lat: 0, lon: 1 },
    { lat: 0, lon: 0 }
  ]);
  const secondStart = equatorDegreeM;
  const result = projectToRoute(index, { lat: 0, lon: 0.5 }, {
    maxDistanceM: 1,
    minOffsetM: secondStart,
    maxOffsetM: index.totalLengthM
  });
  assert.equal(result.status, 'matched');
  closeTo(result.routeOffsetM, secondStart + equatorDegreeM / 2, 1);
});

test('does not match a route position outside the selected offset range', () => {
  const index = indexRoute([
    { lat: 0, lon: 0 }, { lat: 0, lon: 1 },
    { lat: 0, lon: 0 }
  ]);
  const result = projectToRoute(index, { lat: 0, lon: 0.5 }, {
    maxDistanceM: 1,
    minOffsetM: 0,
    maxOffsetM: equatorDegreeM / 4
  });
  assert.equal(result.status, 'off-route');
  assert.equal(result.reason, 'outside-corridor');
  closeTo(result.routeOffsetM, equatorDegreeM / 4, 0.01);
});

test('preserves the exact route revision on index and projection results', () => {
  const revision = { id: 'revision-7' };
  const index = indexRoute([{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }], {
    routeRevision: revision
  });
  assert.equal(index.routeRevision, revision);
  assert.equal(projectToRoute(index, { lat: 0, lon: 0.5 }, {
    maxDistanceM: 1
  }).routeRevision, revision);
});

test('rejects antimeridian, polar, and near-antipodal geometry explicitly', () => {
  assert.throws(
    () => indexRoute([{ lat: 0, lon: 179 }, { lat: 0, lon: -179 }]),
    /antimeridian/
  );
  assert.throws(
    () => indexRoute([{ lat: 85, lon: 0 }, { lat: 84, lon: 0 }]),
    /supported latitude/
  );
  assert.throws(
    () => indexRoute([{ lat: 80, lon: -80 }, { lat: 80, lon: 80 }]),
    /polar region/
  );
  assert.throws(
    () => indexRoute([{ lat: 0, lon: 0 }, { lat: 0.000000001, lon: 179.99999999 }]),
    /near-antipodal/
  );
});

test('projection option values and out-of-range bounds are validated', () => {
  const index = indexRoute([{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }]);
  for (const maxDistanceM of [NaN, -1, Infinity]) {
    assert.throws(
      () => projectToRoute(index, { lat: 0, lon: 0 }, { maxDistanceM }),
      /maxDistanceM must be finite/
    );
  }
  assert.throws(
    () => projectToRoute(index, { lat: 0, lon: 0 }, {
      maxDistanceM: 1,
      minOffsetM: index.totalLengthM,
      maxOffsetM: 0
    }),
    /must not exceed/
  );
});
