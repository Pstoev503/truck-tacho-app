// One drive or rest stage of the shown plan, placed on the same drawn line for
// a visual check. It reads the plan as it is: no new ETA, rest or parking.
import { indexRoute, pointAtOffset } from '../engine/route-position.js';
import { routeWindowPoints } from './route-window-geometry.mjs';

export class ScheduleSelectionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const fail = (code, message) => { throw new ScheduleSelectionError(code, message); };
const isNumber = value => typeof value === 'number' && Number.isFinite(value);

// Returns a frozen selection:
// { kind: 'drive', eventIndex, result, fromM, toM, startUtcMs, endUtcMs, label, line: [[lat, lon], …] }
// { kind: 'rest',  eventIndex, result, fromM, toM, startUtcMs, endUtcMs, label, point: { lat, lon } }
// `result` is the plan object the stage came from, so a newer plan never reuses it.
export function scheduleSelection({ points, result, eventIndex } = {}) {
  if (!result || result.state !== 'estimated' || !Array.isArray(result.events)) {
    fail('NO_PLAN', 'Няма показан график; планирай отново.');
  }
  if (!Number.isInteger(eventIndex) || eventIndex < 0 || eventIndex >= result.events.length) {
    fail('INVALID_INDEX', 'Този етап не е в текущия график.');
  }
  const event = result.events[eventIndex];
  if (!event || (event.type !== 'drive' && event.type !== 'rest')) {
    fail('UNSUPPORTED_STAGE', 'Може да се покаже само каране или почивка.');
  }
  let index;
  try {
    if (!Array.isArray(points) || !points.every(point => point && isNumber(point.lat) && isNumber(point.lon))) {
      throw new Error('points');
    }
    index = indexRoute(points);
  } catch {
    fail('INVALID_GEOMETRY', 'Текущата линия не е поддържана; етапът не може да се покаже.');
  }
  const { fromM, toM, startUtcMs, endUtcMs } = event;
  if (!isNumber(fromM) || !isNumber(toM) || fromM < 0 || fromM > toM || toM > index.totalLengthM ||
      (event.type === 'drive' && !(fromM < toM)) || (event.type === 'rest' && fromM !== toM)) {
    fail('INVALID_OFFSETS', 'Позицията на етапа по линията е невалидна.');
  }
  if (!isNumber(startUtcMs) || !isNumber(endUtcMs) || endUtcMs < startUtcMs) {
    fail('INVALID_TIMES', 'Часовете на етапа са невалидни.');
  }
  const label = typeof result.engineResult?.events?.[eventIndex]?.label === 'string'
    ? result.engineResult.events[eventIndex].label : null;
  const base = { kind: event.type, eventIndex, result, fromM, toM, startUtcMs, endUtcMs, label };
  if (event.type === 'rest') {
    const { lat, lon } = pointAtOffset(index, fromM);
    return Object.freeze({ ...base, point: Object.freeze({ lat, lon }) });
  }
  let line;
  try {
    line = routeWindowPoints(points, { minOffsetM: fromM, maxOffsetM: toM });
  } catch (caught) {
    fail('INVALID_GEOMETRY', `Етапът не може да се покаже: ${caught.message}`);
  }
  return Object.freeze({ ...base, line: Object.freeze(line.map(point => Object.freeze([point.lat, point.lon]))) });
}

const localFormat = new Intl.DateTimeFormat('bg-BG', {
  timeZone: 'Europe/Sofia', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});
const offsetFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Sofia', timeZoneName: 'longOffset' });

// Local Sofia time with its UTC offset, so the two autumn 03:30s differ.
export function formatSofiaWithOffset(utcMs) {
  const zone = offsetFormat.formatToParts(new Date(utcMs)).find(part => part.type === 'timeZoneName').value;
  return `${localFormat.format(new Date(utcMs))} (${zone === 'GMT' ? 'UTC+00:00' : zone.replace('GMT', 'UTC')})`;
}

export function formatDuration(ms) {
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours} ч ${minutes % 60} мин` : `${minutes} мин`;
}

// Plain text lines for the detail panel, taken from the event as planned.
export function describeSelection(selection) {
  const km = metres => (metres / 1000).toFixed(2);
  const title = selection.kind === 'drive' ? 'Каране' : (selection.label ?? 'Почивка');
  return [
    `Избран етап: ${title}.`,
    `Начало: ${formatSofiaWithOffset(selection.startUtcMs)}; край: ${formatSofiaWithOffset(selection.endUtcMs)}; продължителност: ${formatDuration(selection.endUtcMs - selection.startUtcMs)}.`,
    selection.kind === 'drive'
      ? `По линията: от ${km(selection.fromM)} до ${km(selection.toM)} км (${km(selection.toM - selection.fromM)} км).`
      : `Място по линията: ${km(selection.fromM)} км. Паркинг не е избран.`,
    'Само геометричен преглед на ориентировъчния график: пътният достъп, паркингът и резервацията не са потвърдени.'
  ];
}
