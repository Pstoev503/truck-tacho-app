const EARTH_RADIUS_M = 6_371_000;
const MAX_SUPPORTED_LATITUDE = 85;
const ANGLE_EPSILON = 1e-12;
const ANTIPODAL_EPSILON = 1e-9;
const POSITION_EPSILON_M = 0.01;
const AMBIGUITY_MIN_OFFSET_SEPARATION_M = 5;
const INDEX_BRAND = Symbol('route-position-index');

const radians = degrees => degrees * Math.PI / 180;
const degrees = radiansValue => radiansValue * 180 / Math.PI;
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0]
];
const magnitude = vector => Math.hypot(...vector);
const scale = (vector, amount) => vector.map(value => value * amount);
const subtract = (a, b) => a.map((value, i) => value - b[i]);
const normalize = vector => {
  const length = magnitude(vector);
  return length === 0 ? null : scale(vector, 1 / length);
};
const angleBetween = (a, b) => Math.atan2(magnitude(cross(a, b)), dot(a, b));
const toVector = ({ lat, lon }) => {
  const latitude = radians(lat), longitude = radians(lon);
  return [
    Math.cos(latitude) * Math.cos(longitude),
    Math.cos(latitude) * Math.sin(longitude),
    Math.sin(latitude)
  ];
};
const toPoint = vector => {
  const unit = normalize(vector);
  return {
    lat: degrees(Math.atan2(unit[2], Math.hypot(unit[0], unit[1]))),
    lon: degrees(Math.atan2(unit[1], unit[0]))
  };
};
const pointOnArc = (start, end, fraction) => {
  if (fraction <= 0) return start.vector;
  if (fraction >= 1) return end.vector;
  const angle = angleBetween(start.vector, end.vector);
  const sine = Math.sin(angle);
  return normalize([
    ...start.vector.map((value, i) =>
      value * Math.sin((1 - fraction) * angle) / sine +
      end.vector[i] * Math.sin(fraction * angle) / sine)
  ]);
};

function validatePoint(point, label) {
  if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon) ||
      Math.abs(point.lat) > 90 || Math.abs(point.lon) > 180) {
    throw new TypeError(`${label} must have finite latitude in [-90, 90] and longitude in [-180, 180]`);
  }
  if (Math.abs(point.lat) >= MAX_SUPPORTED_LATITUDE) {
    throw new RangeError(`${label} is outside the supported latitude range (-85, 85)`);
  }
}

function validateIndex(index) {
  if (!index || index[INDEX_BRAND] !== true) {
    throw new TypeError('index must be created by indexRoute');
  }
}

function validateOffset(offsetM, totalLengthM) {
  if (!Number.isFinite(offsetM) || offsetM < 0 || offsetM > totalLengthM) {
    throw new RangeError(`offsetM must be finite and between 0 and ${totalLengthM}`);
  }
}

function projectToArc(point, start, end) {
  const arcAngle = angleBetween(start, end);
  const normal = normalize(cross(start, end));
  if (!normal || arcAngle >= Math.PI - ANTIPODAL_EPSILON) {
    throw new RangeError('Near-antipodal segments are not supported');
  }

  const projected = normalize(subtract(point, scale(normal, dot(point, normal))));
  const options = [
    { vector: start, fraction: 0 },
    { vector: end, fraction: 1 }
  ];

  if (projected) {
    for (const candidate of [projected, scale(projected, -1)]) {
      const fromStart = angleBetween(start, candidate);
      const toEnd = angleBetween(candidate, end);
      if (Math.abs(fromStart + toEnd - arcAngle) <= 1e-9) {
        options.push({ vector: candidate, fraction: fromStart / arcAngle });
      }
    }
  }

  return options.map(option => ({
    ...option,
    distanceM: angleBetween(point, option.vector) * EARTH_RADIUS_M
  })).sort((a, b) => a.distanceM - b.distanceM)[0];
}

function validateArcLatitude(start, end, arcAngle, segmentIndex) {
  if (arcAngle <= ANGLE_EPSILON) return;
  const normal = normalize(cross(start, end));
  const northPole = [0, 0, 1];
  const projectedPole = normalize(subtract(northPole, scale(normal, dot(northPole, normal))));
  if (!projectedPole) return;

  for (const candidate of [projectedPole, scale(projectedPole, -1)]) {
    if (Math.abs(angleBetween(start, candidate) + angleBetween(candidate, end) - arcAngle) <= 1e-9 &&
        Math.abs(degrees(Math.asin(candidate[2]))) >= MAX_SUPPORTED_LATITUDE) {
      throw new RangeError(`geometry segment ${segmentIndex} enters the unsupported polar region`);
    }
  }
}

function positionOnSegment(segment, fraction) {
  const vector = pointOnArc(segment.startPoint, segment.endPoint, fraction);
  return fraction === 0
    ? { lat: segment.startPoint.lat, lon: segment.startPoint.lon }
    : fraction === 1
      ? { lat: segment.endPoint.lat, lon: segment.endPoint.lon }
      : toPoint(vector);
}

export function indexRoute(geometry, { routeRevision } = {}) {
  if (!Array.isArray(geometry) || geometry.length < 2) {
    throw new TypeError('geometry must contain at least two coordinates');
  }

  const points = geometry.map((point, i) => {
    validatePoint(point, `geometry[${i}]`);
    return Object.freeze({
      lat: point.lat,
      lon: point.lon,
      vector: Object.freeze(toVector(point))
    });
  });
  const segments = [];
  const cumulativeMeters = [0];
  let totalLengthM = 0;

  for (let i = 0; i < points.length - 1; i++) {
    const start = points[i], end = points[i + 1];
    if (Math.abs(end.lon - start.lon) >= 180) {
      throw new RangeError(`geometry segment ${i} crosses or ambiguously spans the antimeridian`);
    }
    const angle = angleBetween(start.vector, end.vector);
    if (angle >= Math.PI - ANTIPODAL_EPSILON) {
      throw new RangeError(`geometry segment ${i} is near-antipodal`);
    }
    validateArcLatitude(start.vector, end.vector, angle, i);
    const lengthM = angle * EARTH_RADIUS_M;
    segments.push(Object.freeze({
      index: i,
      start: start.vector,
      end: end.vector,
      startPoint: start,
      endPoint: end,
      startOffsetM: totalLengthM,
      endOffsetM: totalLengthM + lengthM,
      lengthM
    }));
    totalLengthM += lengthM;
    cumulativeMeters.push(totalLengthM);
  }

  if (totalLengthM === 0) {
    throw new RangeError('geometry must have a non-zero total length');
  }

  return Object.freeze({
    [INDEX_BRAND]: true,
    routeRevision,
    totalLengthM,
    cumulativeMeters: Object.freeze(cumulativeMeters),
    segments: Object.freeze(segments)
  });
}

export function pointAtOffset(index, offsetM) {
  validateIndex(index);
  validateOffset(offsetM, index.totalLengthM);

  const segment = index.segments.find(candidate =>
    candidate.lengthM > 0 &&
    offsetM >= candidate.startOffsetM &&
    offsetM <= candidate.endOffsetM
  );
  if (!segment) {
    throw new RangeError('no route segment contains offsetM');
  }
  const fraction = (offsetM - segment.startOffsetM) / segment.lengthM;
  const point = positionOnSegment(segment, fraction);
  return {
    ...point,
    routeOffsetM: offsetM,
    segmentIndex: segment.index
  };
}

function validateRangeOption(value, name, totalLengthM, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 0 || value > totalLengthM) {
    throw new RangeError(`${name} must be finite and between 0 and ${totalLengthM}`);
  }
  return value;
}

function asCandidate(segment, fraction, distanceM) {
  const point = positionOnSegment(segment, fraction);
  return {
    ...point,
    routeOffsetM: segment.startOffsetM + fraction * segment.lengthM,
    segmentIndex: segment.index,
    lateralDistanceM: distanceM
  };
}

export function projectToRoute(index, point, {
  maxDistanceM,
  minOffsetM,
  maxOffsetM,
  ambiguityToleranceM = 5
} = {}) {
  validateIndex(index);
  validatePoint(point, 'point');
  if (!Number.isFinite(maxDistanceM) || maxDistanceM < 0) {
    throw new RangeError('maxDistanceM must be finite and non-negative');
  }
  if (!Number.isFinite(ambiguityToleranceM) || ambiguityToleranceM < 0) {
    throw new RangeError('ambiguityToleranceM must be finite and non-negative');
  }

  const minOffset = validateRangeOption(minOffsetM, 'minOffsetM', index.totalLengthM, 0);
  const maxOffset = validateRangeOption(maxOffsetM, 'maxOffsetM', index.totalLengthM, index.totalLengthM);
  if (minOffset > maxOffset) {
    throw new RangeError('minOffsetM must not exceed maxOffsetM');
  }

  const queryVector = toVector(point);
  const candidates = [];
  for (const segment of index.segments) {
    if (segment.lengthM === 0 ||
        segment.endOffsetM < minOffset ||
        segment.startOffsetM > maxOffset) continue;

    const lower = Math.max(0, (minOffset - segment.startOffsetM) / segment.lengthM);
    const upper = Math.min(1, (maxOffset - segment.startOffsetM) / segment.lengthM);
    const lowerVector = pointOnArc(segment.startPoint, segment.endPoint, lower);
    const upperVector = pointOnArc(segment.startPoint, segment.endPoint, upper);
    const projection = upper - lower <= ANGLE_EPSILON
      ? { fraction: 0, distanceM: angleBetween(queryVector, lowerVector) * EARTH_RADIUS_M }
      : projectToArc(queryVector, lowerVector, upperVector);
    const fraction = lower + (upper - lower) * projection.fraction;
    candidates.push(asCandidate(segment, fraction, projection.distanceM));
  }

  candidates.sort((a, b) =>
    a.lateralDistanceM - b.lateralDistanceM ||
    a.routeOffsetM - b.routeOffsetM ||
    a.segmentIndex - b.segmentIndex
  );

  const uniqueCandidates = [];
  for (const candidate of candidates) {
    const duplicate = uniqueCandidates.find(existing =>
      Math.abs(existing.routeOffsetM - candidate.routeOffsetM) <= POSITION_EPSILON_M
    );
    if (!duplicate) uniqueCandidates.push(candidate);
  }

  const corridorCandidates = uniqueCandidates.filter(candidate =>
    candidate.lateralDistanceM <= maxDistanceM
  );
  const best = uniqueCandidates[0];
  const routeRevision = index.routeRevision;
  const result = {
    lat: null,
    lon: null,
    routeOffsetM: null,
    segmentIndex: null,
    lateralDistanceM: null,
    routeRevision,
    status: 'off-route',
    reason: uniqueCandidates.length === 0 ? 'no-candidate-in-offset-range' : 'outside-corridor',
    candidates: uniqueCandidates
  };
  if (!best) return result;

  result.lat = best.lat;
  result.lon = best.lon;
  result.routeOffsetM = best.routeOffsetM;
  result.segmentIndex = best.segmentIndex;
  result.lateralDistanceM = best.lateralDistanceM;
  if (corridorCandidates.length === 0) return result;

  const bestMatch = corridorCandidates[0];
  const tied = corridorCandidates.filter(candidate =>
    candidate.lateralDistanceM - bestMatch.lateralDistanceM <= ambiguityToleranceM &&
    (candidate === bestMatch ||
      Math.abs(candidate.routeOffsetM - bestMatch.routeOffsetM) > AMBIGUITY_MIN_OFFSET_SEPARATION_M)
  );
  if (tied.length > 1) {
    result.status = 'ambiguous';
    result.reason = 'multiple-route-positions';
    result.candidates = tied;
    result.lat = null;
    result.lon = null;
    result.routeOffsetM = null;
    result.segmentIndex = null;
    return result;
  }

  return {
    ...bestMatch,
    routeRevision,
    status: 'matched',
    reason: null,
    candidates: corridorCandidates
  };
}
