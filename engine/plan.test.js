import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, routeStageDistances } from './plan.js';
import { H, MIN } from './tacho-rules.js';

const now = Date.parse('2026-10-12T00:00:00Z');
const departure = now + 7 * H;
const stage = (distanceKm, useExtension = false, dailyRest = 'regular') => ({
  label: 'Курс', distanceKm, roadType: 'motorway', useExtension, dailyRest
});
const plan = (distanceKm, useExtension = false, extra = {}) => buildPlan({
  stages: [stage(distanceKm, useExtension)], departure, now, ...extra
});

function historyWithExtendedDays(count) {
  const log = [];
  let t = Date.parse('2026-10-12T00:00:00Z');
  for (let day = 0; day < count; day++) {
    for (const [type, minutes] of [
      ['drive', 270], ['rest', 45], ['drive', 270], ['rest', 45],
      ['drive', 60], ['rest', 660]
    ]) {
      log.push({ type, start: t, end: t + minutes * MIN });
      t += minutes * MIN;
    }
  }
  return { log, end: t };
}

function historyWithReducedRests(count) {
  const log = [];
  let t = Date.parse('2026-10-12T00:00:00Z');
  for (let day = 0; day < count; day++) {
    for (const [type, minutes] of [
      ['drive', 270], ['rest', 45], ['drive', 270], ['rest', 540]
    ]) {
      log.push({ type, start: t, end: t + minutes * MIN });
      t += minutes * MIN;
    }
  }
  return { log, end: t };
}

test('9 часа се планират без удължение, а избраните 10 часа използват едно седмично удължение', () => {
  const nine = plan(720);
  assert.equal(nine.drivingMs, 9 * H);
  assert.equal(nine.stages[0].extensionUsed, false);
  assert.deepEqual(nine.violations, []);

  const ten = plan(800, true);
  assert.equal(ten.drivingMs, 10 * H);
  assert.equal(ten.stages[0].extensionUsed, true);
  assert.equal(ten.status.daily.extensionsUsed, 1);
  assert.deepEqual(ten.violations, []);
});

test('две използвани удължения за седмицата не позволяват трето', () => {
  const history = historyWithExtendedDays(2);
  const result = plan(800, true, { activities: history.log, departure: history.end + H });
  assert.equal(result.stages[0].extensionUsed, false);
  assert.equal(result.ignoredExtensions.length, 1);
  assert.equal(result.drivingMs, 10 * H);
  assert.deepEqual(result.violations, []);
});

test('един дълъг етап използва най-много едно удължение през няколко дневни дежурства', () => {
  const result = plan(1600, true);
  assert.equal(result.stages[0].extensionUsed, true);
  assert.equal(result.extendedDuties.length, 1);
  assert.equal(result.status.daily.extensionsUsed, 1);
  assert.ok(result.events.filter(event => event.label === 'Редовна дневна почивка 11 ч').length >= 2);
});

test('намалената 9-часова дневна почивка е етапен избор и се използва най-много веднъж на етап', () => {
  const result = plan(1600, true, { stages: [stage(1600, true, 'reduced')] });
  assert.equal(result.events.filter(event => event.label === 'Намалена дневна почивка 9 ч').length, 1);
  assert.equal(result.events.filter(event => event.label === 'Редовна дневна почивка 11 ч').length, 1);
  assert.equal(result.stages[0].reducedRestUsed, true);
  assert.deepEqual(result.violations, []);
});

test('след три намалени почивки от историята използва 11 ч и не надвишава лимита', () => {
  const history = historyWithReducedRests(3);
  const result = buildPlan({
    stages: [stage(1600, true, 'reduced')],
    departure: history.end + H, now, activities: history.log
  });
  assert.equal(result.stages[0].reducedRestUsed, false);
  assert.ok(result.ignoredDailyRests.some(item => item.reason.includes('трите')));
  assert.ok(result.events.every(event => event.label !== 'Намалена дневна почивка 9 ч'));
  assert.ok(!result.violations.some(item => item.code === 'REDUCED_DAILY_RESTS'));
});

test('не приписва вече използваното историческо удължение на избрания етап', () => {
  const start = Date.parse('2026-10-11T00:00:00Z');
  const fortnightStart = Date.parse('2026-10-05T00:00:00Z');
  const restEnd = Date.parse('2026-10-12T21:00:00Z');
  const driveStart = restEnd;
  const log = [
    { type: 'rest', start: fortnightStart, end: start },
    { type: 'rest', start, end: restEnd },
    { type: 'drive', start: driveStart, end: driveStart + 270 * MIN },
    { type: 'rest', start: driveStart + 270 * MIN, end: driveStart + 315 * MIN },
    { type: 'drive', start: driveStart + 315 * MIN, end: driveStart + 585 * MIN },
    { type: 'rest', start: driveStart + 585 * MIN, end: driveStart + 630 * MIN },
    { type: 'drive', start: driveStart + 630 * MIN, end: driveStart + 660 * MIN }
  ];
  const current = driveStart + 660 * MIN;
  const result = buildPlan({
    stages: [stage(40, true)], departure: current, now: current, activities: log,
    lastWeeklyRestEnd: restEnd
  });
  assert.equal(result.status.daily.driven, 10 * H);
  assert.equal(result.stages[0].extensionUsed, false);
  assert.ok(result.ignoredExtensions.some(item => item.reason.includes('вече е използвано')));
  assert.equal(result.confirmed, true);
});

test('планира стандартна пауза 45 мин и разделена пауза 15 + 30 мин', () => {
  const standard = plan(600);
  assert.ok(standard.events.some(event => event.label === 'Пауза 45 мин'));
  assert.deepEqual(standard.violations, []);

  const split = plan(600, false, { breakStyle: '15+30' });
  assert.ok(split.events.some(event => event.label === 'Пауза 15 мин'));
  assert.ok(split.events.some(event => event.label === 'Пауза 30 мин (15 + 30)'));
  assert.deepEqual(split.violations, []);
});

test('отхвърля липсващи, отрицателни и невалидни етапи и часове', () => {
  assert.throws(() => buildPlan({ stages: [], departure, now }), /поне един/);
  assert.throws(() => plan(-1), /положително число/);
  assert.throws(() => buildPlan({ stages: [stage(10)], departure: 'невалидно', now }), /валиден час/);
  assert.throws(() => buildPlan({ stages: [stage(10)], departure: now - MIN, now }), /миналото/);
  assert.throws(() => buildPlan({ stages: [{ ...stage(10), roadType: 'unknown' }], departure, now }), /тип път/);
  assert.throws(() => buildPlan({ stages: [{ ...stage(10), dailyRest: '2h' }], departure, now }), /дневна почивка/);
});

test('изчислява ETA по заявената скорост и показва неподдържаните допускания', () => {
  const result = plan(120);
  assert.equal(result.drivingMs, 90 * MIN);
  assert.equal(result.arrival, departure + 90 * MIN);
  assert.equal(result.confirmed, false);
  assert.match(result.confidence, /непотвърдено/);
  assert.ok(result.assumptions.some(text => text.includes('трафик')));
});

test('не маркира плана потвърден при непълна начална история', () => {
  const result = buildPlan({ stages: [stage(120)], departure: now, now, activities: [] });
  assert.equal(result.confirmed, false);
  assert.match(result.confidence, /непотвърдено/);
});

test('бъдещото потегляне не добавя изкуствена почивка след началото на курса', () => {
  const result = plan(120);
  assert.equal(result.events[0].type, 'drive');
  assert.equal(result.events[0].start, departure);
  assert.equal(result.activities[0].start, departure);
  assert.equal(result.arrival, departure + 90 * MIN);
  assert.ok(result.assumptions.some(text => text.includes('неизвестна')));
});

test('неизвестният интервал преди тръгване не нулира натрупаните 4 часа управление', () => {
  const activities = [{ type: 'drive', start: now - 4 * H, end: now }];
  const result = buildPlan({ stages: [stage(80)], activities, now, departure: now + 2 * H });
  const drives = result.events.filter(event => event.type === 'drive');
  assert.equal(drives[0].start, now + 2 * H);
  assert.equal(drives[0].end - drives[0].start, 30 * MIN);
  assert.ok(result.events.some(event => event.label === 'Пауза 45 мин'));
  assert.equal(result.arrival, now + 3 * H + 45 * MIN);
  assert.equal(result.confirmed, false);
});

test('празнина в историята не създава седмична почивка и нови намалени дневни почивки', () => {
  const history = historyWithReducedRests(3);
  const result = buildPlan({
    stages: [stage(1600, false, 'reduced')], now: history.end,
    departure: history.end + 48 * H, activities: history.log
  });
  assert.equal(result.stages[0].reducedRestUsed, false);
  assert.ok(result.events.every(event => event.label !== 'Намалена дневна почивка 9 ч'));
  assert.equal(result.confirmed, false);
});

test('планираните дейности не променят тахографския дневник', () => {
  const log = [{ type: 'rest', start: now - H, end: null }];
  const before = JSON.stringify(log);
  buildPlan({ stages: [stage(120)], departure, now, activities: log });
  assert.equal(JSON.stringify(log), before);
});

test('геометрията се разпределя между точките; без геометрия се иска ръчно разстояние', () => {
  const route = {
    waypoints: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 0, lon: 2 }],
    geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: 0.5 }, { lat: 0, lon: 1 },
      { lat: 0, lon: 1.5 }, { lat: 0, lon: 2 }]
  };
  const distances = routeStageDistances(route);
  assert.equal(distances.length, 2);
  assert.ok(Math.abs(distances[0] - distances[1]) < 0.01);
  assert.equal(routeStageDistances({ waypoints: route.waypoints }), null);
});

test('стар начален запис не потвърждава история с вътрешна празнина', () => {
  const from = Date.parse('2026-10-05T00:00:00Z');
  const gapStart = from + 48 * H;
  const gapEnd = gapStart + 24 * H;
  const current = Date.parse('2026-10-12T09:00:00Z');
  const result = buildPlan({
    stages: [stage(80)], now: current, departure: current, lastWeeklyRestEnd: current,
    activities: [{ type: 'rest', start: from, end: gapStart },
      { type: 'rest', start: gapEnd, end: current }]
  });
  assert.equal(result.confirmed, false);
  assert.equal(result.historyCoverage.complete, false);
  assert.deepEqual(result.historyCoverage.gaps, [{ start: gapStart, end: gapEnd }]);
});

test('пълната история с пресичащи се записи се проверява като обединение на интервали', () => {
  const from = Date.parse('2026-10-05T00:00:00Z');
  const current = Date.parse('2026-10-12T09:00:00Z');
  const result = buildPlan({
    stages: [stage(80)], now: current, departure: current, lastWeeklyRestEnd: current,
    activities: [{ type: 'rest', start: from, end: from + 72 * H },
      { type: 'rest', start: from + 48 * H, end: null }]
  });
  assert.equal(result.historyCoverage.complete, true);
  assert.deepEqual(result.historyCoverage.gaps, []);
});

test('известен краен запис не прикрива липсващото начало на историята', () => {
  const from = Date.parse('2026-10-05T00:00:00Z');
  const current = Date.parse('2026-10-12T09:00:00Z');
  const result = buildPlan({
    stages: [stage(80)], now: current, departure: current, lastWeeklyRestEnd: current,
    activities: [{ type: 'rest', start: from + H, end: current }]
  });
  assert.equal(result.confirmed, false);
  assert.deepEqual(result.historyCoverage.gaps, [{ start: from, end: from + H }]);
});

test('бъдещ запис не се зачита като наблюдавана история', () => {
  const from = Date.parse('2026-10-05T00:00:00Z');
  const current = Date.parse('2026-10-12T09:00:00Z');
  const result = buildPlan({
    stages: [stage(80)], now: current, departure: current + H, lastWeeklyRestEnd: current,
    activities: [{ type: 'rest', start: from, end: current + H }]
  });
  assert.equal(result.confirmed, false);
  assert.deepEqual(result.historyCoverage.gaps, [{ start: current, end: current + H }]);
});
