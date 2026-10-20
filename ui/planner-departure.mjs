// Departure at a local date and time in Europe/Sofia, resolved to UTC through
// the runtime's IANA data (Intl). The computer's own time zone is never used,
// and no fixed +02/+03 offset is assumed.
export const DEPARTURE_TIME_ZONE = 'Europe/Sofia';
export const MIN_DEPARTURE_YEAR = 2000;
export const MAX_DEPARTURE_YEAR = 2099;
export const FOLDS = Object.freeze(['earlier', 'later']);

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^(\d{2}):(\d{2})$/;

export class DepartureError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const fail = (code, message) => { throw new DepartureError(code, message); };

let wallFormat = null;
const sofiaWallClock = utcMs => {
  wallFormat ??= new Intl.DateTimeFormat('en-US', {
    timeZone: DEPARTURE_TIME_ZONE, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
  const parts = Object.fromEntries(wallFormat.formatToParts(new Date(utcMs)).map(part => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second));
};
const offsetAt = utcMs => sofiaWallClock(utcMs) - utcMs;

const isLeapYear = year => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
const daysInMonth = (year, month) => [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];

export function parseLocalDate(date) {
  const match = typeof date === 'string' ? DATE_PATTERN.exec(date) : null;
  if (!match) fail('INVALID_DATE', 'Въведи дата във формат ГГГГ-ММ-ДД.');
  const [year, month, day] = match.slice(1).map(Number);
  if (year < MIN_DEPARTURE_YEAR || year > MAX_DEPARTURE_YEAR) {
    fail('YEAR_OUT_OF_RANGE', `Годината трябва да е от ${MIN_DEPARTURE_YEAR} до ${MAX_DEPARTURE_YEAR}.`);
  }
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    fail('INVALID_DATE', 'Такава дата не съществува.');
  }
  return { year, month, day };
}

export function parseLocalTime(time) {
  const match = typeof time === 'string' ? TIME_PATTERN.exec(time) : null;
  if (!match) fail('INVALID_TIME', 'Въведи час във формат ЧЧ:ММ.');
  const [hour, minute] = match.slice(1).map(Number);
  if (hour > 23 || minute > 59) fail('INVALID_TIME', 'Такъв час не съществува.');
  return { hour, minute };
}

// All UTC instants that show this wall-clock time in Sofia, oldest first:
// none in a spring-forward gap, two in an autumn fold, otherwise one.
export function sofiaInstantsFor(date, time) {
  const { year, month, day } = parseLocalDate(date);
  const { hour, minute } = parseLocalTime(time);
  const wallMs = Date.UTC(year, month - 1, day, hour, minute);
  const offsets = new Set([offsetAt(wallMs - 36 * HOUR_MS), offsetAt(wallMs), offsetAt(wallMs + 36 * HOUR_MS)]);
  const instants = [...offsets]
    .map(offset => wallMs - offset)
    .filter(utcMs => sofiaWallClock(utcMs) === wallMs);
  return [...new Set(instants)].sort((a, b) => a - b);
}

// { date, time, fold } → { utcMs, offsetMinutes, ambiguous, candidates }.
// fold must be null for an ordinary time and 'earlier' or 'later' for a time
// that occurs twice; there is no silent default.
export function resolveSofiaDeparture({ date, time, fold = null } = {}) {
  if (fold !== null && !FOLDS.includes(fold)) fail('INVALID_FOLD', 'Невалиден избор на настъпване.');
  const instants = sofiaInstantsFor(date, time);
  const candidates = instants.map(utcMs => ({ utcMs, offsetMinutes: offsetAt(utcMs) / MINUTE_MS }));
  if (candidates.length === 0) {
    fail('NONEXISTENT_LOCAL_TIME', `${date} ${time} не съществува в Европа/София заради преминаване към лятно време. Избери друг час.`);
  }
  if (candidates.length === 1) {
    if (fold !== null) fail('FOLD_NOT_APPLICABLE', 'Този час не е двусмислен; изборът на настъпване не се прилага.');
    return { ...candidates[0], ambiguous: false, candidates };
  }
  if (fold === null) {
    fail('AMBIGUOUS_LOCAL_TIME', `${date} ${time} настъпва два пъти в Европа/София заради връщане към зимно време. Избери първото или второто настъпване.`);
  }
  return { ...candidates[fold === 'earlier' ? 0 : 1], ambiguous: true, candidates };
}

// Departure for planning: resolved and not in the past of the injected clock.
export function absoluteDepartureUtcMs(departure, nowUtcMs) {
  if (typeof nowUtcMs !== 'number' || !Number.isFinite(nowUtcMs)) fail('INVALID_CLOCK', 'Не може да се определи текущият час.');
  const { utcMs } = resolveSofiaDeparture(departure);
  if (utcMs < nowUtcMs) fail('DEPARTURE_IN_PAST', 'Избраните дата и час са в миналото. Избери бъдещ момент.');
  return utcMs;
}

export const formatUtcOffset = offsetMinutes => {
  const sign = offsetMinutes < 0 ? '−' : '+';
  const abs = Math.abs(offsetMinutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
};
