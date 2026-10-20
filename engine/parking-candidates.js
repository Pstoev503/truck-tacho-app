// Source-neutral evaluation of parking candidates along an already drawn route.
// It only measures where each reported parking lies on the route geometry and how
// old the reported data is. It never picks, reserves or certifies a parking.
import { indexRoute, projectToRoute } from './route-position.js';

export const MAX_PARKING_CANDIDATES = 1000;

const TOP_LEVEL_KEYS = new Set([
  'requestId', 'routeRevision', 'inputRevision', 'geometry', 'evaluatedAt', 'window', 'parkingCandidates'
]);
const WINDOW_KEYS = new Set(['minOffsetM', 'maxOffsetM', 'maxLateralDistanceM']);
const CANDIDATE_KEYS = new Set([
  'id', 'location', 'sourceId', 'observedAt', 'expiresAt', 'truckAccess', 'availability'
]);
const TRUCK_ACCESS = new Set(['allowed', 'prohibited', 'unknown']);
const AVAILABILITY = new Set(['available', 'full', 'unknown']);
const DISPOSITION_ORDER = ['geometric-candidate', 'needs-verification', 'excluded', 'invalid'];

const LIMITATIONS = Object.freeze([
  'Geometry only: no approach, direction, side of road, entrance or truck class is checked.',
  'Access and availability are as declared by the input source, not verified.',
  'No arrival time, legal rest or space on arrival is checked.',
  'No parking is selected or reserved.',
  'Route positions inherit the route-position limits: latitude within (-85, 85), no antimeridian crossing.'
]);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = value => typeof value === 'string' && value.trim() !== '';
const isTimestamp = value => Number.isSafeInteger(value) && value >= 0;
const isMissing = value => value === undefined || value === null;

function problem(code, field, details) {
  return { code, field, details };
}

function validateRequest(request) {
  const errors = [];
  if (!isObject(request)) return [problem('INVALID_REQUEST', 'request', 'request must be an object')];

  for (const key of Object.keys(request)) {
    if (!TOP_LEVEL_KEYS.has(key)) errors.push(problem('UNKNOWN_FIELD', `request.${key}`, `Unknown field: request.${key}`));
  }
  for (const key of ['requestId', 'routeRevision', 'inputRevision']) {
    if (!isNonEmptyString(request[key])) errors.push(problem('INVALID_STRING', key, `${key} must be a non-empty string`));
  }
  if (!isTimestamp(request.evaluatedAt)) {
    errors.push(problem('INVALID_TIME', 'evaluatedAt', 'evaluatedAt must be a non-negative integer of UTC milliseconds'));
  }

  let index = null;
  if (request.geometry === undefined) {
    errors.push(problem('ROUTE_GEOMETRY_REQUIRED', 'geometry', 'route geometry is required'));
  } else {
    try {
      index = indexRoute(request.geometry, { routeRevision: request.routeRevision });
    } catch (error) {
      errors.push(problem('INVALID_ROUTE_GEOMETRY', 'geometry', error.message));
    }
  }

  const window = request.window;
  if (!isObject(window)) {
    errors.push(problem('INVALID_WINDOW', 'window', 'window must be an object'));
  } else {
    for (const key of Object.keys(window)) {
      if (!WINDOW_KEYS.has(key)) errors.push(problem('UNKNOWN_FIELD', `window.${key}`, `Unknown field: window.${key}`));
    }
    let windowValid = true;
    for (const key of WINDOW_KEYS) {
      if (!Number.isFinite(window[key]) || window[key] < 0) {
        errors.push(problem('INVALID_WINDOW', `window.${key}`, `window.${key} must be a finite non-negative number of meters`));
        windowValid = false;
      }
    }
    if (windowValid && window.minOffsetM > window.maxOffsetM) {
      errors.push(problem('INVALID_WINDOW', 'window', 'window.minOffsetM must not exceed window.maxOffsetM'));
    }
    if (windowValid && index && window.maxOffsetM > index.totalLengthM) {
      errors.push(problem('WINDOW_OUTSIDE_ROUTE', 'window.maxOffsetM',
        `window.maxOffsetM must not exceed the route length ${index.totalLengthM} m`));
    }
  }

  if (!Array.isArray(request.parkingCandidates)) {
    errors.push(problem('INVALID_CANDIDATES', 'parkingCandidates', 'parkingCandidates must be an array'));
  } else if (request.parkingCandidates.length > MAX_PARKING_CANDIDATES) {
    errors.push(problem('TOO_MANY_CANDIDATES', 'parkingCandidates',
      `at most ${MAX_PARKING_CANDIDATES} parking candidates are accepted`));
  }

  return errors.length ? errors : index;
}

function candidateProblems(candidate) {
  if (!isObject(candidate)) return ['invalid-record'];
  const reasons = [];
  for (const key of Object.keys(candidate)) {
    if (!CANDIDATE_KEYS.has(key)) reasons.push(`unknown-field:${key}`);
  }
  if (!isNonEmptyString(candidate.id)) reasons.push('invalid-id');
  if (!isObject(candidate.location) || !Number.isFinite(candidate.location.lat) || !Number.isFinite(candidate.location.lon) ||
      Math.abs(candidate.location.lat) > 90 || Math.abs(candidate.location.lon) > 180) {
    reasons.push('invalid-location');
  }
  if (!isMissing(candidate.sourceId) && !isNonEmptyString(candidate.sourceId)) reasons.push('invalid-source-id');
  for (const key of ['observedAt', 'expiresAt']) {
    if (!isMissing(candidate[key]) && !isTimestamp(candidate[key])) reasons.push(`invalid-${key}`);
  }
  if (candidate.truckAccess !== undefined && !TRUCK_ACCESS.has(candidate.truckAccess)) reasons.push('invalid-truck-access');
  if (candidate.availability !== undefined && !AVAILABILITY.has(candidate.availability)) reasons.push('invalid-availability');
  return reasons;
}

function evidenceOf(candidate, evaluatedAt) {
  const { observedAt, expiresAt } = candidate;
  if (isTimestamp(observedAt) && observedAt > evaluatedAt) return { invalid: 'observed-in-future' };
  if (isTimestamp(observedAt) && isTimestamp(expiresAt) && expiresAt < observedAt) {
    return { invalid: 'expires-before-observed' };
  }
  const reasons = [];
  if (isMissing(candidate.sourceId)) reasons.push('source-unknown');
  if (isMissing(observedAt)) reasons.push('observed-at-unknown');
  if (isMissing(expiresAt)) reasons.push('expires-at-unknown');
  if (isTimestamp(expiresAt) && evaluatedAt >= expiresAt) return { state: 'expired', reasons: ['expired', ...reasons] };
  return { state: reasons.length ? 'unknown' : 'fresh', reasons };
}

function baseResult(candidate, inputIndex) {
  return {
    id: isObject(candidate) && isNonEmptyString(candidate.id) ? candidate.id : null,
    inputIndex,
    projectionStatus: null,
    routeOffsetM: null,
    lateralDistanceM: null,
    withinWindow: null,
    evidenceState: null,
    truckAccess: null,
    availability: null,
    disposition: 'invalid',
    reasons: [],
    accessVerified: false,
    reservationConfirmed: false
  };
}

function evaluateCandidate(candidate, inputIndex, index, window, evaluatedAt, duplicateIds) {
  const result = baseResult(candidate, inputIndex);
  const invalid = candidateProblems(candidate);
  if (result.id !== null && duplicateIds.has(result.id)) invalid.push('duplicate-id');
  if (invalid.length) {
    result.reasons = invalid;
    return result;
  }

  const evidence = evidenceOf(candidate, evaluatedAt);
  if (evidence.invalid) {
    result.reasons = [evidence.invalid];
    return result;
  }

  let projection;
  try {
    projection = projectToRoute(index, candidate.location, { maxDistanceM: window.maxLateralDistanceM });
  } catch (error) {
    result.reasons = ['unsupported-location'];
    return result;
  }

  const reasons = [];
  result.projectionStatus = projection.status;
  if (projection.status === 'matched') {
    result.routeOffsetM = projection.routeOffsetM;
    result.lateralDistanceM = projection.lateralDistanceM;
    result.withinWindow = projection.routeOffsetM >= window.minOffsetM && projection.routeOffsetM <= window.maxOffsetM;
    if (!result.withinWindow) reasons.push('outside-window');
  } else if (projection.status === 'ambiguous') {
    reasons.push('ambiguous-route-position');
  } else {
    reasons.push('outside-corridor');
  }

  result.evidenceState = evidence.state;
  result.truckAccess = candidate.truckAccess ?? 'unknown';
  result.availability = candidate.availability ?? 'unknown';
  reasons.push(...evidence.reasons);
  if (result.truckAccess === 'prohibited') reasons.push('truck-access-prohibited');
  if (result.truckAccess === 'unknown') reasons.push('truck-access-unknown');
  if (result.availability === 'full') reasons.push('reported-full');
  if (result.availability === 'unknown') reasons.push('availability-unknown');
  result.reasons = reasons;

  const excluded = projection.status !== 'matched' || !result.withinWindow || evidence.state === 'expired' ||
    result.truckAccess === 'prohibited' || result.availability === 'full';
  if (excluded) {
    result.disposition = 'excluded';
  } else if (evidence.state === 'fresh' && result.truckAccess === 'allowed' && result.availability === 'available') {
    result.disposition = 'geometric-candidate';
  } else {
    result.disposition = 'needs-verification';
  }
  return result;
}

function compareText(a, b) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a < b ? -1 : 1;
}

function compareNullableNumber(a, b) {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

// Sort: disposition (candidate, needs-verification, excluded, invalid), then route
// offset ascending (unknown last), then lateral distance, then id, then input order.
function compareResults(a, b) {
  return DISPOSITION_ORDER.indexOf(a.disposition) - DISPOSITION_ORDER.indexOf(b.disposition) ||
    compareNullableNumber(a.routeOffsetM, b.routeOffsetM) ||
    compareNullableNumber(a.lateralDistanceM, b.lateralDistanceM) ||
    compareText(a.id, b.id) ||
    a.inputIndex - b.inputIndex;
}

export function evaluateParkingCandidates(request) {
  const echo = key => (isObject(request) && isNonEmptyString(request[key]) ? request[key] : null);
  const base = {
    requestId: echo('requestId'),
    routeRevision: echo('routeRevision'),
    inputRevision: echo('inputRevision'),
    selectedParkingId: null,
    accessVerified: false,
    reservationConfirmed: false,
    limitations: LIMITATIONS
  };

  const validated = validateRequest(request);
  if (Array.isArray(validated)) {
    return { ...base, status: 'invalid-input', errors: validated, results: [], candidateIds: [], needsVerificationIds: [] };
  }
  const index = validated;
  const { window, evaluatedAt, parkingCandidates } = request;

  const seen = new Set();
  const duplicateIds = new Set();
  for (const candidate of parkingCandidates) {
    if (isObject(candidate) && isNonEmptyString(candidate.id)) {
      if (seen.has(candidate.id)) duplicateIds.add(candidate.id);
      seen.add(candidate.id);
    }
  }

  const results = parkingCandidates
    .map((candidate, i) => evaluateCandidate(candidate, i, index, window, evaluatedAt, duplicateIds))
    .sort(compareResults);
  const count = disposition => results.filter(result => result.disposition === disposition).length;

  return {
    ...base,
    status: 'evaluated',
    errors: [],
    evaluatedAt,
    routeLengthM: index.totalLengthM,
    window: { minOffsetM: window.minOffsetM, maxOffsetM: window.maxOffsetM, maxLateralDistanceM: window.maxLateralDistanceM },
    duplicateIds: [...duplicateIds].sort(compareText),
    summary: {
      total: results.length,
      geometricCandidates: count('geometric-candidate'),
      needsVerification: count('needs-verification'),
      excluded: count('excluded'),
      invalid: count('invalid')
    },
    results,
    candidateIds: results.filter(r => r.disposition === 'geometric-candidate').map(r => r.id),
    needsVerificationIds: results.filter(r => r.disposition === 'needs-verification').map(r => r.id)
  };
}
