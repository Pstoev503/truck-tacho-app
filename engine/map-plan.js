import { PLANNER_SPEEDS } from './plan.js';

const ROAD_TYPES = new Set(['motorway', 'ordinary']);
const ACTIVITY_TYPES = new Set(['drive', 'work', 'avail', 'rest']);
const TOP_LEVEL_KEYS = new Set([
  'schemaVersion', 'requestId', 'routeRevision', 'inputRevision', 'nowUtcMs',
  'departureUtcMs', 'displayTimeZone', 'route', 'initialState', 'choices',
  'requirements', 'requestedStops'
]);
const REQUIREMENT_KEYS = [
  'truckValidatedRoute', 'liveTraffic', 'forecastTraffic', 'exactStops',
  'splitDailyRest3Plus9', 'weeklyRest', 'compensation', 'ferry',
  'derogation', 'legalCompliance'
];
const UNSUPPORTED_REQUIREMENT_CODES = {
  truckValidatedRoute: 'TRUCK_VALIDATED_ROUTE',
  liveTraffic: 'LIVE_TRAFFIC',
  forecastTraffic: 'FORECAST_TRAFFIC',
  exactStops: 'EXACT_STOPS',
  splitDailyRest3Plus9: 'SPLIT_DAILY_REST_3_PLUS_9',
  weeklyRest: 'WEEKLY_REST',
  compensation: 'COMPENSATION',
  ferry: 'FERRY',
  derogation: 'DEROGATION',
  legalCompliance: 'LEGAL_COMPLIANCE'
};
const SECTION_TOLERANCE_M = 0.05;
const HOUR_MS = 60 * 60 * 1000;
const SPEED_KMH = PLANNER_SPEEDS;

class InputProblem extends Error {
  constructor(code, field, details, state = 'invalid-input') {
    super(details || code);
    this.code = code;
    this.field = field;
    this.state = state;
  }
}

function fail(code, field, details, state) {
  throw new InputProblem(code, field, details, state);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknownKeys(value, allowed, field) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('UNKNOWN_FIELD', `${field}.${key}`, `Unknown field: ${field}.${key}`);
  }
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    fail('INVALID_STRING', field, `${field} must be a non-empty string`);
  }
}

function requireFinite(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('INVALID_NUMBER', field, `${field} must be a finite number`);
  }
}

function parseUtc(value, field) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' ||
      !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d|[+-]\d{4})$/i.test(value)) {
    fail('INVALID_UTC_TIME', field, `${field} must be UTC milliseconds or ISO time with an explicit timezone`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail('INVALID_UTC_TIME', field, `${field} is not a valid time`);
  return parsed;
}

function validateTimeZone(value) {
  requireString(value, 'displayTimeZone');
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
  } catch {
    fail('INVALID_TIME_ZONE', 'displayTimeZone', 'displayTimeZone must be a valid IANA time zone');
  }
}

function baseResult(request) {
  return {
    schemaVersion: 1,
    requestId: request?.requestId,
    routeRevision: request?.routeRevision,
    inputRevision: request?.inputRevision,
    state: 'invalid-input',
    arrivalUtcMs: null,
    events: [],
    engineResult: null,
    historyCoverage: null,
    capabilities: {},
    warnings: [],
    assumptions: [],
    error: null
  };
}

function refusal(request, state, code, field, details) {
  return {
    ...baseResult(request),
    state,
    error: { code, ...(field ? { field } : {}), ...(details ? { details } : {}) }
  };
}

function validateRequest(request, dependencies) {
  if (!isObject(request)) fail('INVALID_REQUEST', 'request', 'request must be an object');
  rejectUnknownKeys(request, TOP_LEVEL_KEYS, 'request');
  if (request.schemaVersion !== 1) fail('UNSUPPORTED_SCHEMA_VERSION', 'schemaVersion', 'Only schemaVersion 1 is supported');
  for (const key of ['requestId', 'routeRevision', 'inputRevision']) requireString(request[key], key);
  requireFinite(request.nowUtcMs, 'nowUtcMs');
  requireFinite(request.departureUtcMs, 'departureUtcMs');
  if (request.departureUtcMs < request.nowUtcMs) {
    fail('DEPARTURE_IN_PAST', 'departureUtcMs', 'departureUtcMs must not be earlier than nowUtcMs');
  }
  validateTimeZone(request.displayTimeZone);
  if (!dependencies || typeof dependencies.buildPlan !== 'function' ||
      typeof dependencies.indexRoute !== 'function' ||
      typeof dependencies.pointAtOffset !== 'function') {
    fail('INVALID_DEPENDENCIES', 'dependencies', 'buildPlan, indexRoute, and pointAtOffset functions are required');
  }

  if (!isObject(request.route)) fail('MISSING_ROUTE', 'route', 'route data is required', 'needs-data');
  rejectUnknownKeys(request.route, new Set([
    'geometry', 'geometryKind', 'source', 'roadSections', 'vehicleProfileRef'
  ]), 'route');
  if (request.route.geometry === undefined) {
    fail('ROUTE_GEOMETRY_REQUIRED', 'route.geometry', 'route geometry is required', 'needs-data');
  }
  if (request.route.geometryKind !== 'road-routed' && request.route.geometryKind !== 'manual-sketch') {
    fail('INVALID_GEOMETRY_KIND', 'route.geometryKind', 'geometryKind must be road-routed or manual-sketch');
  }
  requireString(request.route.source, 'route.source');
  if (request.route.vehicleProfileRef !== null && request.route.vehicleProfileRef !== undefined) {
    requireString(request.route.vehicleProfileRef, 'route.vehicleProfileRef');
  }
  if (!Array.isArray(request.route.geometry) || request.route.geometry.length < 2) {
    fail('INVALID_ROUTE_GEOMETRY', 'route.geometry', 'route.geometry must contain at least two coordinates');
  }
  request.route.geometry.forEach((point, index) => {
    if (!isObject(point) || Object.keys(point).some(key => key !== 'lat' && key !== 'lon') ||
        !Number.isFinite(point.lat) || !Number.isFinite(point.lon) ||
        Math.abs(point.lat) > 90 || Math.abs(point.lon) > 180) {
      fail('INVALID_ROUTE_GEOMETRY', `route.geometry[${index}]`, 'coordinates must have finite WGS84 latitude and longitude');
    }
  });

  if (!Array.isArray(request.route.roadSections) || request.route.roadSections.length === 0) {
    fail('ROAD_SECTIONS_REQUIRED', 'route.roadSections', 'road sections are required', 'needs-data');
  }
  const sectionIds = new Set();
  request.route.roadSections.forEach((section, index) => {
    const field = `route.roadSections[${index}]`;
    if (!isObject(section)) fail('INVALID_ROAD_SECTION', field, 'road section must be an object');
    rejectUnknownKeys(section, new Set(['id', 'fromM', 'toM', 'roadType', 'source']), field);
    requireString(section.id, `${field}.id`);
    if (sectionIds.has(section.id)) fail('DUPLICATE_SECTION_ID', `${field}.id`, `Duplicate road section id: ${section.id}`);
    sectionIds.add(section.id);
    requireFinite(section.fromM, `${field}.fromM`);
    requireFinite(section.toM, `${field}.toM`);
    requireString(section.source, `${field}.source`);
    if (section.toM <= section.fromM) fail('INVALID_ROAD_SECTION_RANGE', field, 'road section length must be positive');
    if (section.roadType === undefined || section.roadType === null || section.roadType === '') {
      fail('ROAD_TYPE_REQUIRED', `${field}.roadType`, `road type is required for section ${section.id}`, 'needs-data');
    }
    if (!ROAD_TYPES.has(section.roadType)) {
      fail('INVALID_ROAD_TYPE', `${field}.roadType`, 'roadType must be motorway or ordinary');
    }
  });

  if (!isObject(request.initialState)) fail('INITIAL_STATE_REQUIRED', 'initialState', 'initial state is required', 'needs-data');
  rejectUnknownKeys(request.initialState, new Set(['activities', 'lastWeeklyRestEnd', 'source']), 'initialState');
  if (!Array.isArray(request.initialState.activities)) {
    fail('ACTIVITIES_REQUIRED', 'initialState.activities', 'initialState.activities must be an array', 'needs-data');
  }
  requireString(request.initialState.source, 'initialState.source');
  request.initialState.activities.forEach((activity, index) => {
    const field = `initialState.activities[${index}]`;
    if (!isObject(activity) || !ACTIVITY_TYPES.has(activity.type)) {
      fail('INVALID_ACTIVITY', field, 'activity type must be drive, work, avail, or rest');
    }
    rejectUnknownKeys(activity, new Set(['type', 'start', 'end', 'manual', 'ferry']), field);
    for (const flag of ['manual', 'ferry']) {
      if (activity[flag] !== undefined && typeof activity[flag] !== 'boolean') {
        fail('INVALID_ACTIVITY_FLAG', `${field}.${flag}`, `${field}.${flag} must be a boolean`);
      }
    }
    if (activity.ferry !== undefined && activity.type !== 'rest') {
      fail('FERRY_REQUIRES_REST', `${field}.ferry`, 'ferry is only valid for rest activities');
    }
    parseUtc(activity.start, `${field}.start`);
    if (activity.end !== null) {
      const start = parseUtc(activity.start, `${field}.start`);
      const end = parseUtc(activity.end, `${field}.end`);
      if (end <= start) fail('INVALID_ACTIVITY_RANGE', field, 'activity end must be after its start');
    }
  });
  if (request.initialState.lastWeeklyRestEnd !== null &&
      request.initialState.lastWeeklyRestEnd !== undefined) {
    requireFinite(request.initialState.lastWeeklyRestEnd, 'initialState.lastWeeklyRestEnd');
  }

  if (!isObject(request.choices)) fail('CHOICES_REQUIRED', 'choices', 'choices are required');
  rejectUnknownKeys(request.choices, new Set(['breakStyle', 'multiManning', 'bySection']), 'choices');
  if (request.choices.breakStyle !== '45' && request.choices.breakStyle !== '15+30') {
    fail('INVALID_BREAK_STYLE', 'choices.breakStyle', 'breakStyle must be 45 or 15+30');
  }
  if (typeof request.choices.multiManning !== 'boolean') {
    fail('INVALID_MULTI_MANNING', 'choices.multiManning', 'multiManning must be a boolean');
  }
  if (request.choices.bySection !== undefined && !Array.isArray(request.choices.bySection)) {
    fail('INVALID_SECTION_CHOICES', 'choices.bySection', 'bySection must be an array');
  }
  const choices = request.choices.bySection || [];
  const chosenIds = new Set();
  choices.forEach((choice, index) => {
    const field = `choices.bySection[${index}]`;
    if (!isObject(choice)) fail('INVALID_SECTION_CHOICE', field, 'section choice must be an object');
    rejectUnknownKeys(choice, new Set(['sectionId', 'useExtension', 'dailyRest']), field);
    requireString(choice.sectionId, `${field}.sectionId`);
    if (!sectionIds.has(choice.sectionId)) fail('UNKNOWN_SECTION_ID', `${field}.sectionId`, `Unknown section id: ${choice.sectionId}`);
    if (chosenIds.has(choice.sectionId)) fail('DUPLICATE_SECTION_CHOICE', `${field}.sectionId`, 'Each section may have at most one choice');
    chosenIds.add(choice.sectionId);
    if (choice.useExtension !== undefined && typeof choice.useExtension !== 'boolean') {
      fail('INVALID_EXTENSION_CHOICE', `${field}.useExtension`, 'useExtension must be a boolean');
    }
    if (choice.dailyRest !== undefined && choice.dailyRest !== 'regular' && choice.dailyRest !== 'reduced') {
      fail('INVALID_DAILY_REST', `${field}.dailyRest`, 'dailyRest must be regular or reduced');
    }
  });

  const requirements = request.requirements ?? {};
  if (!isObject(requirements)) fail('INVALID_REQUIREMENTS', 'requirements', 'requirements must be an object');
  rejectUnknownKeys(requirements, new Set(REQUIREMENT_KEYS), 'requirements');
  for (const [key, value] of Object.entries(requirements)) {
    if (typeof value !== 'boolean') fail('INVALID_REQUIREMENT', `requirements.${key}`, 'requirements must be boolean flags');
  }
  const requestedStops = request.requestedStops ?? [];
  if (!Array.isArray(requestedStops)) fail('INVALID_REQUESTED_STOPS', 'requestedStops', 'requestedStops must be an array');
  requestedStops.forEach((stop, index) => {
    const field = `requestedStops[${index}]`;
    if (!isObject(stop)) fail('INVALID_REQUESTED_STOP', field, 'requested stop must be an object');
    rejectUnknownKeys(stop, new Set(['id', 'routeOffsetM', 'kind', 'source']), field);
    requireString(stop.id, `${field}.id`);
    requireFinite(stop.routeOffsetM, `${field}.routeOffsetM`);
    requireString(stop.kind, `${field}.kind`);
    requireString(stop.source, `${field}.source`);
  });
  return { sectionIds, chosenIds, choices, requirements, requestedStops };
}

function normalizeSections(sections, totalLengthM) {
  let cursor = 0;
  const normalized = [];
  for (let index = 0; index < sections.length; index++) {
    const section = sections[index];
    if (Math.abs(section.fromM - cursor) > SECTION_TOLERANCE_M) {
      fail('ROAD_SECTIONS_INCONSISTENT', 'route.roadSections', 'road sections must be ordered and contiguous');
    }
    const toM = index === sections.length - 1 &&
      Math.abs(section.toM - totalLengthM) <= SECTION_TOLERANCE_M
      ? totalLengthM : section.toM;
    if (toM - cursor <= 0) fail('ROAD_SECTIONS_INCONSISTENT', 'route.roadSections', 'road sections must have positive contiguous lengths');
    normalized.push({ ...section, fromM: cursor, toM });
    cursor = toM;
  }
  if (Math.abs(cursor - totalLengthM) > SECTION_TOLERANCE_M) {
    fail('ROAD_SECTIONS_INCONSISTENT', 'route.roadSections', 'road sections must cover the complete route geometry');
  }
  return normalized;
}

function pointCoordinates(point) {
  if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) {
    throw new Error('pointAtOffset returned an invalid coordinate');
  }
  return { lat: point.lat, lon: point.lon };
}

function mapEngineEvents(engineResult, sections, routeIndex, pointAtOffset, departureUtcMs) {
  if (!engineResult || !Array.isArray(engineResult.events) ||
      !Array.isArray(engineResult.stages) || engineResult.stages.length !== sections.length ||
      !Number.isFinite(engineResult.arrival) || engineResult.departure !== departureUtcMs) {
    throw new Error('engine result is missing schedule data');
  }
  for (let index = 0; index < sections.length; index++) {
    const resultStage = engineResult.stages[index];
    if (!resultStage || !Number.isFinite(resultStage.distanceKm) ||
        Math.abs(resultStage.distanceKm * 1000 - (sections[index].toM - sections[index].fromM)) > SECTION_TOLERANCE_M) {
      throw new Error(`engine stage ${index} does not match its road section`);
    }
  }
  const totalLengthM = routeIndex.totalLengthM;
  let routeOffsetM = 0;
  let expectedTime = engineResult.departure;
  const events = [];
  for (let index = 0; index < engineResult.events.length; index++) {
    const event = engineResult.events[index];
    if (!event || !Number.isFinite(event.start) || !Number.isFinite(event.end) ||
        event.end <= event.start || event.start !== expectedTime ||
        !Number.isInteger(event.stageIndex) || event.stageIndex < 0 || event.stageIndex >= sections.length) {
      throw new Error(`engine event ${index} has invalid time or stage mapping`);
    }
    const section = sections[event.stageIndex];
    const fromM = routeOffsetM;
    let toM = fromM;
    if (event.type === 'drive') {
      const distanceM = (event.end - event.start) / HOUR_MS * SPEED_KMH[section.roadType] * 1000;
      if (!Number.isFinite(distanceM) || distanceM <= 0 ||
          fromM < section.fromM - SECTION_TOLERANCE_M ||
          fromM > section.toM + SECTION_TOLERANCE_M ||
          fromM + distanceM > section.toM + SECTION_TOLERANCE_M) {
        throw new Error(`engine event ${index} exceeds its road section`);
      }
      toM = fromM + distanceM;
      routeOffsetM = toM;
    } else if (event.type !== 'rest') {
      throw new Error(`engine event ${index} has unsupported type`);
    } else if (fromM < section.fromM - SECTION_TOLERANCE_M ||
        fromM > section.toM + SECTION_TOLERANCE_M) {
      throw new Error(`engine rest event ${index} is outside its road section`);
    }
    if (fromM < -SECTION_TOLERANCE_M || toM > totalLengthM + SECTION_TOLERANCE_M) {
      throw new Error(`engine event ${index} exceeds route geometry`);
    }
    const startOffset = Math.max(0, Math.min(totalLengthM, fromM));
    const endOffset = Math.max(0, Math.min(totalLengthM, toM));
    events.push({
      id: `event-${index + 1}`,
      type: event.type,
      startUtcMs: event.start,
      endUtcMs: event.end,
      stageIndex: event.stageIndex,
      sectionId: section.id,
      fromM,
      toM,
      fromPoint: pointCoordinates(pointAtOffset(routeIndex, startOffset)),
      toPoint: pointCoordinates(pointAtOffset(routeIndex, endOffset)),
      stopKind: event.type === 'rest' ? 'unassigned' : null
    });
    expectedTime = event.end;
  }
  if (Math.abs(routeOffsetM - totalLengthM) > SECTION_TOLERANCE_M ||
      expectedTime !== engineResult.arrival) {
    throw new Error('engine schedule does not cover route geometry and arrival');
  }
  return events;
}

function unsupportedCodes(requirements, requestedStops) {
  const codes = Object.entries(requirements)
    .filter(([, required]) => required)
    .map(([key]) => UNSUPPORTED_REQUIREMENT_CODES[key]);
  if (requestedStops.length && !codes.includes('EXACT_STOPS')) codes.push('EXACT_STOPS');
  return codes;
}

export function createMapPlan(request, dependencies) {
  let parsed;
  try {
    parsed = validateRequest(request, dependencies);
  } catch (error) {
    if (error instanceof InputProblem) {
      return refusal(request, error.state, error.code, error.field, error.message);
    }
    return refusal(request, 'invalid-input', 'INVALID_INPUT', 'request', error.message);
  }

  const base = baseResult(request);
  const unsupported = unsupportedCodes(parsed.requirements, parsed.requestedStops);
  if (unsupported.length) {
    return {
      ...base,
      state: 'unsupported',
      capabilities: { unsupported: false },
      warnings: unsupported.map(code => ({ code, text: `Unsupported v1 requirement: ${code}` })),
      error: { code: 'UNSUPPORTED_REQUIREMENT', details: unsupported.join(', ') }
    };
  }

  let routeIndex;
  try {
    routeIndex = dependencies.indexRoute(request.route.geometry, {
      routeRevision: request.routeRevision
    });
    if (!routeIndex || !Number.isFinite(routeIndex.totalLengthM) || routeIndex.totalLengthM <= 0) {
      throw new Error('route index must have a positive finite totalLengthM');
    }
  } catch (error) {
    return refusal(request, 'invalid-input', 'INVALID_ROUTE_GEOMETRY', 'route.geometry', error.message);
  }

  let sections;
  try {
    sections = normalizeSections(request.route.roadSections, routeIndex.totalLengthM);
  } catch (error) {
    if (error instanceof InputProblem) return refusal(request, error.state, error.code, error.field, error.message);
    return refusal(request, 'invalid-input', 'ROAD_SECTIONS_INCONSISTENT', 'route.roadSections', error.message);
  }

  const choicesById = new Map(parsed.choices.map(choice => [choice.sectionId, choice]));
  const stages = sections.map(section => {
    const choice = choicesById.get(section.id);
    return {
      label: section.id,
      distanceKm: (section.toM - section.fromM) / 1000,
      roadType: section.roadType,
      useExtension: choice?.useExtension === true,
      dailyRest: choice?.dailyRest ?? 'regular'
    };
  });
  let engineResult;
  try {
    engineResult = dependencies.buildPlan({
      stages,
      departure: request.departureUtcMs,
      activities: request.initialState.activities.map(activity => ({
        ...activity,
        start: parseUtc(activity.start, 'initialState.activities.start'),
        end: activity.end === null ? null : parseUtc(activity.end, 'initialState.activities.end')
      })),
      now: request.nowUtcMs,
      breakStyle: request.choices.breakStyle,
      multiManning: request.choices.multiManning,
      ...(request.initialState.lastWeeklyRestEnd == null
        ? {} : { lastWeeklyRestEnd: request.initialState.lastWeeklyRestEnd })
    });
    if (!engineResult || typeof engineResult.then === 'function') {
      throw new Error('buildPlan must return a synchronous result');
    }
  } catch (error) {
    return {
      ...base,
      state: 'error',
      error: { code: 'ENGINE_ERROR', details: error.message }
    };
  }

  let events;
  try {
    events = mapEngineEvents(
      engineResult, sections, routeIndex, dependencies.pointAtOffset, request.departureUtcMs
    );
  } catch (error) {
    return {
      ...base,
      state: 'error',
      engineResult,
      error: { code: 'MAPPING_INCONSISTENT', details: error.message }
    };
  }
  if (engineResult.historyCoverage == null) {
    return {
      ...base,
      state: 'needs-data',
      engineResult,
      events: [],
      error: { code: 'ENGINE_VERSION_MISMATCH', field: 'engineResult.historyCoverage' }
    };
  }

  const warnings = [];
  const assumptions = [...(Array.isArray(engineResult.assumptions) ? engineResult.assumptions : [])];
  warnings.push({
    code: 'ESTIMATE_ONLY',
    text: 'Estimated schedule only; traffic, truck restrictions, road passability, and stop availability are not validated. No legal approval.'
  });
  if (engineResult.historyCoverage.complete !== true ||
      (Array.isArray(engineResult.historyCoverage.gaps) && engineResult.historyCoverage.gaps.length > 0)) {
    warnings.push({
      code: 'HISTORY_INCOMPLETE',
      text: 'Activity history coverage is incomplete or unverified.',
      historyCoverage: engineResult.historyCoverage
    });
  }
  if (request.route.geometryKind === 'manual-sketch') {
    warnings.push({ code: 'MANUAL_SKETCH', text: 'Route geometry is a manual sketch, not a verified road route.' });
    assumptions.push('Маршрутът е ръчна геометрична скица, не проверен път.');
  }
  const manualSections = sections.filter(section => section.source === 'manual');
  if (manualSections.length) {
    warnings.push({
      code: 'MANUAL_ROAD_TYPE',
      sectionIds: manualSections.map(section => section.id),
      text: 'Manually classified road sections are assumptions, not verified road types.'
    });
    assumptions.push('Типът път на ръчно класифицираните участъци е допускане.');
  }
  if (request.initialState.activities.length === 0) {
    warnings.push({ code: 'HISTORY_UNVERIFIED', text: 'No activity history was supplied.' });
  }
  if (request.choices.multiManning) {
    warnings.push({ code: 'MULTI_MANNING_UNVERIFIED', text: 'Multi-manning assumptions are not independently verified.' });
    assumptions.push('Предпоставките за многочленен екипаж не са потвърдени от адаптера.');
  }
  if (Array.isArray(engineResult.violations) && engineResult.violations.length) {
    warnings.push({
      code: 'ENGINE_VIOLATIONS',
      text: 'The engine reported violations; this estimated schedule is not a legal approval.',
      violations: engineResult.violations
    });
  }
  return {
    ...base,
    state: 'estimated',
    arrivalUtcMs: engineResult.arrival,
    events,
    engineResult,
    historyCoverage: engineResult.historyCoverage,
    capabilities: {
      routeGeometry: true,
      roadSections: true,
      traffic: false,
      truckRestrictions: false,
      exactStops: false,
      legalApproval: false
    },
    warnings,
    assumptions,
    error: null
  };
}
