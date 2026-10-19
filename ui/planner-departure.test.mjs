import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEPARTURE_TIME_ZONE, DepartureError, MAX_DEPARTURE_YEAR, MIN_DEPARTURE_YEAR, absoluteDepartureUtcMs,
  formatUtcOffset, parseLocalDate, parseLocalTime, resolveSofiaDeparture, sofiaInstantsFor
} from './planner-departure.mjs';

const iso = utcMs => new Date(utcMs).toISOString();
const codeOf = fn => {
  try { fn(); } catch (caught) { assert.ok(caught instanceof DepartureError, String(caught)); return caught.code; }
  return 'ok';
};
// Independent check through the runtime's IANA data: the wall clock in Sofia at an instant.
const sofiaWall = utcMs => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Sofia', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
}).format(new Date(utcMs));

test('an ordinary winter date resolves with the winter offset from the runtime', () => {
  const resolved = resolveSofiaDeparture({ date: '2026-01-15', time: '08:30', fold: null });
  assert.equal(iso(resolved.utcMs), '2026-01-15T06:30:00.000Z');
  assert.equal(resolved.offsetMinutes, 120);
  assert.equal(resolved.ambiguous, false);
  assert.equal(sofiaWall(resolved.utcMs), '2026-01-15 08:30');
});

test('an ordinary summer date resolves with the summer offset from the runtime', () => {
  const resolved = resolveSofiaDeparture({ date: '2026-07-15', time: '08:30' });
  assert.equal(iso(resolved.utcMs), '2026-07-15T05:30:00.000Z');
  assert.equal(resolved.offsetMinutes, 180);
  assert.equal(sofiaWall(resolved.utcMs), '2026-07-15 08:30');
});

test('spring-forward gap: 03:00–03:59 on 29 March 2026 does not exist and is refused', () => {
  for (const time of ['03:00', '03:30', '03:59']) {
    assert.equal(sofiaInstantsFor('2026-03-29', time).length, 0, time);
    assert.equal(codeOf(() => resolveSofiaDeparture({ date: '2026-03-29', time })), 'NONEXISTENT_LOCAL_TIME', time);
  }
  assert.equal(iso(resolveSofiaDeparture({ date: '2026-03-29', time: '02:59' }).utcMs), '2026-03-29T00:59:00.000Z');
  assert.equal(iso(resolveSofiaDeparture({ date: '2026-03-29', time: '04:00' }).utcMs), '2026-03-29T01:00:00.000Z');
  assert.match((() => { try { resolveSofiaDeparture({ date: '2026-03-29', time: '03:30' }); } catch (e) { return e.message; } })(),
    /не съществува/);
});

test('autumn fold: 03:30 on 25 October 2026 needs an explicit earlier or later choice', () => {
  assert.equal(codeOf(() => resolveSofiaDeparture({ date: '2026-10-25', time: '03:30', fold: null })), 'AMBIGUOUS_LOCAL_TIME');
  const earlier = resolveSofiaDeparture({ date: '2026-10-25', time: '03:30', fold: 'earlier' });
  const later = resolveSofiaDeparture({ date: '2026-10-25', time: '03:30', fold: 'later' });
  assert.equal(iso(earlier.utcMs), '2026-10-25T00:30:00.000Z');
  assert.equal(iso(later.utcMs), '2026-10-25T01:30:00.000Z');
  assert.deepEqual([earlier.offsetMinutes, later.offsetMinutes], [180, 120]);
  assert.equal(sofiaWall(earlier.utcMs), '2026-10-25 03:30');
  assert.equal(sofiaWall(later.utcMs), '2026-10-25 03:30');
  assert.equal(earlier.ambiguous, true);
  assert.deepEqual(earlier.candidates.map(c => c.utcMs), [earlier.utcMs, later.utcMs]);
  // Just outside the fold the time is unique.
  assert.equal(resolveSofiaDeparture({ date: '2026-10-25', time: '02:59' }).ambiguous, false);
  assert.equal(resolveSofiaDeparture({ date: '2026-10-25', time: '04:00' }).ambiguous, false);
});

test('other years come from the runtime rules, not a fixed table', () => {
  assert.equal(sofiaInstantsFor('2027-03-28', '03:30').length, 0);
  assert.equal(sofiaInstantsFor('2027-10-31', '03:00').length, 2);
  assert.equal(sofiaInstantsFor('2027-10-24', '03:00').length, 1);
});

test('a fold choice is refused for an unambiguous time and must be earlier or later', () => {
  assert.equal(codeOf(() => resolveSofiaDeparture({ date: '2026-01-15', time: '08:30', fold: 'earlier' })), 'FOLD_NOT_APPLICABLE');
  for (const fold of ['first', '', 1, true, 'EARLIER']) {
    assert.equal(codeOf(() => resolveSofiaDeparture({ date: '2026-10-25', time: '03:30', fold })), 'INVALID_FOLD', String(fold));
  }
});

test('dates must be exact YYYY-MM-DD calendar days, without rollover or coercion', () => {
  for (const date of ['2026-02-30', '2026-04-31', '2026-13-01', '2026-00-10', '2026-01-00', '2026-1-5', '26-01-05',
    '2026/01/05', '', ' 2026-01-05', '2026-01-05T00:00', 20260105, null, undefined, new Date(0)]) {
    assert.equal(codeOf(() => parseLocalDate(date)), 'INVALID_DATE', String(date));
  }
  assert.deepEqual(parseLocalDate('2026-12-31'), { year: 2026, month: 12, day: 31 });
});

test('leap years follow the Gregorian rules', () => {
  assert.equal(codeOf(() => parseLocalDate('2028-02-29')), 'ok');
  assert.equal(codeOf(() => parseLocalDate('2000-02-29')), 'ok', 'divisible by 400');
  assert.equal(codeOf(() => parseLocalDate('2026-02-29')), 'INVALID_DATE');
  assert.equal(codeOf(() => parseLocalDate('2028-02-30')), 'INVALID_DATE');
});

test('supported years are documented limits and enforced', () => {
  assert.equal(MIN_DEPARTURE_YEAR, 2000);
  assert.equal(MAX_DEPARTURE_YEAR, 2099);
  assert.equal(codeOf(() => parseLocalDate('1999-12-31')), 'YEAR_OUT_OF_RANGE');
  assert.equal(codeOf(() => parseLocalDate('2100-01-01')), 'YEAR_OUT_OF_RANGE');
  assert.equal(codeOf(() => parseLocalDate('2000-01-01')), 'ok');
  assert.equal(codeOf(() => parseLocalDate('2099-12-31')), 'ok');
});

test('times must be exact HH:mm', () => {
  for (const time of ['24:00', '23:60', '8:30', '08:30:00', '0830', '', ' 08:30', '08.30', null, 830, undefined]) {
    assert.equal(codeOf(() => parseLocalTime(time)), 'INVALID_TIME', String(time));
  }
  assert.deepEqual(parseLocalTime('00:00'), { hour: 0, minute: 0 });
  assert.deepEqual(parseLocalTime('23:59'), { hour: 23, minute: 59 });
});

test('past, exact boundary and future against the injected clock', () => {
  const departure = { date: '2026-11-02', time: '08:00', fold: null };
  const utc = Date.parse('2026-11-02T06:00:00Z');
  assert.equal(absoluteDepartureUtcMs(departure, utc), utc, 'exactly now is allowed');
  assert.equal(absoluteDepartureUtcMs(departure, utc - 1), utc);
  assert.equal(codeOf(() => absoluteDepartureUtcMs(departure, utc + 1)), 'DEPARTURE_IN_PAST');
  for (const clock of [NaN, Infinity, '1760860800000', undefined, null]) {
    assert.equal(codeOf(() => absoluteDepartureUtcMs(departure, clock)), 'INVALID_CLOCK', String(clock));
  }
});

test('the result does not depend on the host time zone or the wall clock', () => {
  const realNow = Date.now;
  const realTz = process.env.TZ;
  try {
    Date.now = () => { throw new Error('Date.now must not be used'); };
    const results = [];
    for (const tz of ['UTC', 'America/New_York', 'Asia/Tokyo']) {
      process.env.TZ = tz;
      results.push(resolveSofiaDeparture({ date: '2026-10-25', time: '03:30', fold: 'later' }).utcMs,
        absoluteDepartureUtcMs({ date: '2026-07-15', time: '08:30' }, 0));
    }
    assert.deepEqual(new Set(results).size, 2);
  } finally {
    Date.now = realNow;
    if (realTz === undefined) delete process.env.TZ; else process.env.TZ = realTz;
  }
});

test('frozen input is accepted and not changed; the time zone constant is Europe/Sofia', () => {
  const input = Object.freeze({ date: '2026-10-25', time: '03:30', fold: 'earlier' });
  resolveSofiaDeparture(input);
  assert.deepEqual(input, { date: '2026-10-25', time: '03:30', fold: 'earlier' });
  assert.equal(DEPARTURE_TIME_ZONE, 'Europe/Sofia');
  assert.equal(formatUtcOffset(180), 'UTC+03:00');
  assert.equal(formatUtcOffset(120), 'UTC+02:00');
  assert.equal(formatUtcOffset(-330), 'UTC−05:30');
});
