// Planner draft file: the drawn line and the choices only. It never carries the
// activity log, identity, tokens, parking lists, computed plans or request IDs.
import { indexRoute } from '../engine/route-position.js';
import { DEPARTURE_TIME_ZONE, resolveSofiaDeparture } from './planner-departure.mjs';

export const DRAFT_FORMAT = 'top10eu-planner-draft';
export const DRAFT_VERSION = 1;
// Version 2 is used only for a departure at a local date and time; drafts with
// "now" or a relative departure stay version 1 exactly as before.
export const DRAFT_VERSION_ABSOLUTE = 2;
export const MAX_DRAFT_FILE_BYTES = 1024 * 1024;
export const MAX_DRAFT_POINTS = 500;

const DRAFT_KEYS = ['format', 'version', 'exportedAtUtcMs', 'points', 'roadTypes', 'choices', 'departure', 'breakStyle'];
const ROAD_TYPES = new Set(['motorway', 'ordinary']);
const DAILY_RESTS = new Set(['regular', 'reduced']);
const BREAK_STYLES = new Set(['45', '15+30']);
const DEPARTURE_MODES = new Set(['now', 'relative']);

export class DraftFileError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, message) => { throw new DraftFileError(code, message); };

function requireExactKeys(value, keys, label) {
  if (!isObject(value)) fail('INVALID_FIELD', `${label} трябва да е обект.`);
  const actual = Object.keys(value);
  const unknown = actual.filter(key => !keys.includes(key));
  if (unknown.length) fail('UNKNOWN_FIELD', `Непознато поле в ${label}: „${unknown[0].slice(0, 60)}“.`);
  const missing = keys.filter(key => !Object.hasOwn(value, key));
  if (missing.length) fail('MISSING_FIELD', `Липсва поле в ${label}: „${missing[0]}“.`);
}

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function validatePoints(points) {
  if (!Array.isArray(points)) fail('INVALID_POINTS', 'points трябва да е масив.');
  if (points.length > MAX_DRAFT_POINTS) {
    fail('TOO_MANY_POINTS', `Подготовката има над ${MAX_DRAFT_POINTS} точки; не е заредена.`);
  }
  const copy = points.map((point, index) => {
    requireExactKeys(point, ['lat', 'lon'], `points[${index}]`);
    const { lat, lon } = point;
    if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon) ||
        Math.abs(lat) >= 85 || Math.abs(lon) > 180) {
      fail('INVALID_POINT', `Точка ${index + 1} е извън поддържаните координати.`);
    }
    return { lat, lon };
  });
  // Each non-zero segment must be one the route index accepts (antimeridian,
  // near-antipodal and polar arcs are refused there).
  for (let i = 0; i + 1 < copy.length; i++) {
    const [a, b] = [copy[i], copy[i + 1]];
    if (a.lat === b.lat && a.lon === b.lon) continue;
    try {
      indexRoute([a, b]);
    } catch {
      fail('INVALID_SEGMENT', `Участък ${i + 1} не е поддържана линия.`);
    }
  }
  return copy;
}

function validateRoadTypes(roadTypes, pointCount) {
  if (!Array.isArray(roadTypes)) fail('INVALID_ROAD_TYPES', 'roadTypes трябва да е масив.');
  const expected = Math.max(pointCount - 1, 0);
  if (roadTypes.length !== expected) {
    fail('INCONSISTENT_ROAD_TYPES', `roadTypes трябва да има точно ${expected} елемента за ${pointCount} точки.`);
  }
  return roadTypes.map((roadType, index) => {
    if (roadType !== null && !ROAD_TYPES.has(roadType)) fail('INVALID_ROAD_TYPE', `Невалиден тип път за участък ${index + 1}.`);
    return roadType;
  });
}

function validateChoices(choices, pointCount) {
  if (!isObject(choices)) fail('INVALID_CHOICES', 'choices трябва да е обект.');
  const copy = {};
  for (const [sectionId, choice] of Object.entries(choices)) {
    const match = /^section-([1-9]\d*)$/.exec(sectionId);
    if (!match || Number(match[1]) > pointCount - 1) {
      fail('INCONSISTENT_CHOICES', `Изборът „${sectionId.slice(0, 60)}“ не отговаря на участък от линията.`);
    }
    requireExactKeys(choice, ['useExtension', 'dailyRest'], sectionId);
    if (typeof choice.useExtension !== 'boolean' || !DAILY_RESTS.has(choice.dailyRest)) {
      fail('INVALID_CHOICE', `Невалиден избор за ${sectionId}.`);
    }
    copy[sectionId] = { useExtension: choice.useExtension, dailyRest: choice.dailyRest };
  }
  return copy;
}

// Version 2: a local Sofia date and time. A past date is allowed in the file
// (it can be corrected before planning); a time that does not exist or that
// occurs twice without an explicit fold is refused.
function validateAbsoluteDeparture(departure) {
  if (isObject(departure) && departure.mode !== 'absolute') {
    fail('VERSION_MISMATCH', 'Версия 2 на файла е само за потегляне на дата и час.');
  }
  requireExactKeys(departure, ['mode', 'date', 'time', 'timeZone', 'fold'], 'departure');
  const { mode, date, time, timeZone, fold } = departure;
  if (mode !== 'absolute' || timeZone !== DEPARTURE_TIME_ZONE) {
    fail('INVALID_DEPARTURE', 'Невалидно потегляне във файла.');
  }
  try {
    resolveSofiaDeparture({ date, time, fold });
  } catch (caught) {
    fail('INVALID_DEPARTURE', `Невалидно потегляне във файла: ${caught.message}`);
  }
  return { mode, date, time, timeZone, fold };
}

function validateDeparture(departure) {
  if (isObject(departure) && departure.mode === 'absolute') {
    fail('VERSION_MISMATCH', 'Потегляне на дата и час изисква версия 2 на файла.');
  }
  requireExactKeys(departure, ['mode', 'hours', 'minutes'], 'departure');
  const { mode, hours, minutes } = departure;
  if (!DEPARTURE_MODES.has(mode) || !Number.isInteger(hours) || hours < 0 || hours > 720 ||
      !Number.isInteger(minutes) || minutes < 0 || minutes > 59) {
    fail('INVALID_DEPARTURE', 'Невалидно потегляне във файла.');
  }
  return { mode, hours, minutes };
}

// Strict check of a whole draft object; nothing is coerced, filtered or cut.
export function validateDraft(draft) {
  requireExactKeys(draft, DRAFT_KEYS, 'подготовката');
  if (draft.format !== DRAFT_FORMAT) fail('UNKNOWN_FORMAT', 'Файлът не е подготовка на курс от Top10EU.');
  if (draft.version !== DRAFT_VERSION && draft.version !== DRAFT_VERSION_ABSOLUTE) {
    fail('UNSUPPORTED_VERSION', 'Версията на файла не се поддържа.');
  }
  if (!Number.isSafeInteger(draft.exportedAtUtcMs) || draft.exportedAtUtcMs < 0) {
    fail('INVALID_EXPORTED_AT', 'exportedAtUtcMs трябва да е цяло число UTC милисекунди.');
  }
  if (!BREAK_STYLES.has(draft.breakStyle)) fail('INVALID_BREAK_STYLE', 'Невалиден избор на пауза във файла.');
  const points = validatePoints(draft.points);
  return deepFreeze({
    exportedAtUtcMs: draft.exportedAtUtcMs,
    points,
    roadTypes: validateRoadTypes(draft.roadTypes, points.length),
    choices: validateChoices(draft.choices, points.length),
    departure: draft.version === DRAFT_VERSION_ABSOLUTE
      ? validateAbsoluteDeparture(draft.departure)
      : validateDeparture(draft.departure),
    breakStyle: draft.breakStyle
  });
}

export function createDraft({ points, roadTypes, choices, departure, breakStyle }, exportedAtUtcMs) {
  const version = departure?.mode === 'absolute' ? DRAFT_VERSION_ABSOLUTE : DRAFT_VERSION;
  const draft = { format: DRAFT_FORMAT, version, exportedAtUtcMs, points, roadTypes, choices, departure, breakStyle };
  validateDraft(draft);
  return JSON.stringify(draft, null, 2);
}

export function parseDraftText(text, { byteLength } = {}) {
  if (typeof text !== 'string') fail('NOT_TEXT', 'Файлът не може да бъде прочетен като текст.');
  const size = byteLength ?? new TextEncoder().encode(text).length;
  if (size > MAX_DRAFT_FILE_BYTES) fail('FILE_TOO_LARGE', 'Файлът е по-голям от 1 MiB; не е зареден.');
  let parsed;
  try {
    parsed = JSON.parse(text.startsWith('﻿') ? text.slice(1) : text);
  } catch {
    fail('INVALID_JSON', 'Файлът не е валиден JSON; подготовката не е заредена.');
  }
  return validateDraft(parsed);
}

export async function readDraftFile(file) {
  if (!file || typeof file.text !== 'function') fail('NO_FILE', 'Не е избран файл.');
  if (Number.isFinite(file.size) && file.size > MAX_DRAFT_FILE_BYTES) {
    fail('FILE_TOO_LARGE', 'Файлът е по-голям от 1 MiB; не е зареден.');
  }
  let text;
  try {
    text = await file.text();
  } catch {
    fail('READ_FAILED', 'Файлът не може да бъде прочетен.');
  }
  return parseDraftText(text);
}

export function draftFileName(exportedAtUtcMs) {
  const stamp = new Date(exportedAtUtcMs).toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  return `top10eu-podgotovka-${stamp}Z.json`;
}
