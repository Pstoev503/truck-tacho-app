// Local parking list for review on the drawn route. The file is chosen by the
// user and read in the browser only; nothing is fetched, stored or sent.
import { MAX_PARKING_CANDIDATES } from '../engine/parking-candidates.js';

export const MAX_PARKING_FILE_BYTES = 1024 * 1024;
export const DEFAULT_MAX_LATERAL_M = 500;
export const MAX_LATERAL_LIMIT_M = 5000;

export class ParkingFileError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const utf8Length = text => new TextEncoder().encode(text).length;

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

// Parses the file text exactly as JSON: no string-to-number or boolean coercion
// and no invented source, times, access or availability. Malformed records are
// kept as they are, so the evaluation can report each one as invalid.
export function parseParkingText(text, { byteLength } = {}) {
  if (typeof text !== 'string') {
    throw new ParkingFileError('NOT_TEXT', 'Файлът не може да бъде прочетен като текст.');
  }
  const size = byteLength ?? utf8Length(text);
  if (size > MAX_PARKING_FILE_BYTES) {
    throw new ParkingFileError('FILE_TOO_LARGE', 'Файлът е по-голям от 1 MiB; не е зареден.');
  }
  let parsed;
  try {
    parsed = JSON.parse(text.startsWith('﻿') ? text.slice(1) : text);
  } catch {
    throw new ParkingFileError('INVALID_JSON', 'Файлът не е валиден JSON; не е зареден.');
  }
  if (!Array.isArray(parsed)) {
    throw new ParkingFileError('NOT_ARRAY', 'Файлът трябва да съдържа JSON масив от паркинги; не е зареден.');
  }
  if (parsed.length > MAX_PARKING_CANDIDATES) {
    throw new ParkingFileError('TOO_MANY_CANDIDATES',
      `Файлът съдържа над ${MAX_PARKING_CANDIDATES} записа; не е зареден.`);
  }
  return deepFreeze(parsed);
}

export async function readParkingFile(file) {
  if (!file || typeof file.text !== 'function') {
    throw new ParkingFileError('NO_FILE', 'Не е избран файл.');
  }
  if (Number.isFinite(file.size) && file.size > MAX_PARKING_FILE_BYTES) {
    throw new ParkingFileError('FILE_TOO_LARGE', 'Файлът е по-голям от 1 MiB; не е зареден.');
  }
  let text;
  try {
    text = await file.text();
  } catch {
    throw new ParkingFileError('READ_FAILED', 'Файлът не може да бъде прочетен.');
  }
  return parseParkingText(text);
}

// Kilometres from the form become metres along the route. null means the start
// or the end of the route; strings are not accepted.
export function validateParkingWindow({ fromKm = null, toKm = null, maxLateralM = DEFAULT_MAX_LATERAL_M } = {}) {
  for (const [value, label] of [[fromKm, '„От км“'], [toKm, '„До км“']]) {
    if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
      throw new RangeError(`${label} трябва да е празно или число от 0 нагоре.`);
    }
  }
  if (fromKm !== null && toKm !== null && fromKm > toKm) {
    throw new RangeError('„От км“ не може да е след „До км“.');
  }
  if (typeof maxLateralM !== 'number' || !Number.isFinite(maxLateralM) ||
      maxLateralM < 0 || maxLateralM > MAX_LATERAL_LIMIT_M) {
    throw new RangeError(`„До метра от линията“ трябва да е число от 0 до ${MAX_LATERAL_LIMIT_M}.`);
  }
  return { fromKm, toKm, maxLateralM };
}

export function windowInMeters(window, routeLengthM) {
  const minOffsetM = window.fromKm === null ? 0 : window.fromKm * 1000;
  const maxOffsetM = window.toKm === null ? routeLengthM : window.toKm * 1000;
  if (minOffsetM > routeLengthM) {
    throw new RangeError(`„От км“ е след края на маршрута (${formatKm(routeLengthM)} км).`);
  }
  if (maxOffsetM > routeLengthM) {
    throw new RangeError(`„До км“ е след края на маршрута (${formatKm(routeLengthM)} км). Остави полето празно за целия маршрут.`);
  }
  return { minOffsetM, maxOffsetM, maxLateralDistanceM: window.maxLateralM };
}

export const formatKm = meters => (meters / 1000).toFixed(2);

const DISPOSITION_TEXT = {
  'geometric-candidate': 'Геометричен кандидат — непотвърден',
  'needs-verification': 'Нужна е проверка',
  excluded: 'Изключен',
  invalid: 'Невалиден запис'
};
const EVIDENCE_TEXT = {
  fresh: 'данните са в срока, посочен от източника',
  unknown: 'неизвестна актуалност',
  expired: 'данните са изтекли'
};
const ACCESS_TEXT = {
  allowed: 'източникът посочва достъп за камиони',
  prohibited: 'източникът посочва забрана за камиони',
  unknown: 'достъпът за камиони не е известен'
};
const AVAILABILITY_TEXT = {
  available: 'източникът посочва свободни места',
  full: 'източникът посочва, че е пълен',
  unknown: 'наличността не е известна'
};
const REASON_TEXT = {
  'outside-window': 'извън избрания участък по маршрута',
  'ambiguous-route-position': 'неясна позиция — маршрутът минава близо повече от веднъж',
  'outside-corridor': 'по-далеч от линията от избраното разстояние',
  expired: 'данните са изтекли',
  'source-unknown': 'източникът не е посочен',
  'observed-at-unknown': 'не е посочено кога е наблюдаван',
  'expires-at-unknown': 'не е посочен срок на валидност',
  'truck-access-prohibited': 'източникът посочва забрана за камиони',
  'truck-access-unknown': 'достъпът за камиони не е известен',
  'reported-full': 'източникът посочва, че е пълен',
  'availability-unknown': 'наличността не е известна',
  'invalid-record': 'записът не е обект',
  'invalid-id': 'липсва валиден id',
  'invalid-location': 'невалидни координати',
  'invalid-source-id': 'невалиден sourceId',
  'invalid-observedAt': 'невалидно observedAt',
  'invalid-expiresAt': 'невалидно expiresAt',
  'invalid-truck-access': 'невалидно truckAccess',
  'invalid-availability': 'невалидно availability',
  'duplicate-id': 'id се повтаря във файла',
  'observed-in-future': 'наблюдението е в бъдещето',
  'expires-before-observed': 'срокът изтича преди наблюдението',
  'unsupported-location': 'координатите са извън поддържания обхват'
};
const MAX_SHOWN_TEXT = 120;
const shown = value => (value.length > MAX_SHOWN_TEXT ? `${value.slice(0, MAX_SHOWN_TEXT)}…` : value);

export function reasonText(code) {
  if (typeof code === 'string' && code.startsWith('unknown-field:')) {
    return `непознато поле „${shown(code.slice('unknown-field:'.length))}“`;
  }
  return REASON_TEXT[code] ?? 'друга причина';
}

// Plain data for the list and the map. Only matched candidates and matched
// records that need verification get a marker, at the location the file gave.
export function describeParkingResults(result, candidates) {
  return result.results.map(item => {
    const record = candidates[item.inputIndex];
    const lines = [];
    if (item.routeOffsetM !== null) {
      lines.push(`На ${formatKm(item.routeOffsetM)} км по линията, ${Math.round(item.lateralDistanceM)} м встрани.`);
    } else if (item.projectionStatus === 'ambiguous') {
      lines.push('Позиция по линията: неясна — не е избрана.');
    } else if (item.projectionStatus === 'off-route') {
      lines.push('Позиция по линията: извън коридора.');
    }
    if (item.evidenceState) lines.push(`Актуалност: ${EVIDENCE_TEXT[item.evidenceState]}.`);
    if (item.truckAccess) lines.push(`Достъп: ${ACCESS_TEXT[item.truckAccess]}; места: ${AVAILABILITY_TEXT[item.availability]}.`);
    const sourceId = record && typeof record === 'object' && typeof record.sourceId === 'string' ? record.sourceId : null;
    if (sourceId) lines.push(`Източник по файла: ${shown(sourceId)} (не е проверен).`);
    if (item.reasons.length) lines.push(`Причини: ${item.reasons.map(reasonText).join('; ')}.`);
    const marked = item.projectionStatus === 'matched' &&
      (item.disposition === 'geometric-candidate' || item.disposition === 'needs-verification');
    return {
      key: `${item.inputIndex}`,
      title: `${item.id === null ? `Запис ${item.inputIndex + 1} без валиден id` : shown(item.id)} — ${DISPOSITION_TEXT[item.disposition]}`,
      disposition: item.disposition,
      lines,
      marker: marked ? { lat: record.location.lat, lon: record.location.lon } : null
    };
  });
}

export function parkingSummaryText(summary) {
  return `Оценени ${summary.total}: ${summary.geometricCandidates} геометрични кандидата, ` +
    `${summary.needsVerification} за проверка, ${summary.excluded} изключени, ${summary.invalid} невалидни.`;
}

// DOM only through createElement and textContent: names and ids from the file
// are never parsed as HTML.
export function parkingItemNode(doc, item) {
  const node = doc.createElement('li');
  node.className = `parking-item parking-${item.disposition}`;
  const title = doc.createElement('strong');
  title.textContent = item.title;
  node.append(title);
  for (const line of item.lines) {
    const p = doc.createElement('p');
    p.textContent = line;
    node.append(p);
  }
  return node;
}

export function parkingTooltipNode(doc, item) {
  const node = doc.createElement('div');
  node.textContent = `${item.title}. Не е избран, резервиран или проверен.`;
  return node;
}
