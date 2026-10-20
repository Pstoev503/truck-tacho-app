import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, routeStageDistances } from './plan.js';
import { H, MIN } from './tacho-rules.js';

function completeHistoryBeforeWork(hours) {
  return [
    {type:'rest', start:now-192*H, end:now-hours*H},
    {type:'work', start:now-hours*H, end:now}
  ];
}
test('PLAN-04: six hours of prior work limit regular rest start to seven hours after departure', () => {
  const p=buildPlan({stages:[stage(760)],departure:now,now,activities:completeHistoryBeforeWork(6)});
  const r=p.events.find(e=>e.label==='Редовна дневна почивка 11 ч');
  assert.equal(r.start,now+7*H);
  assert.equal(r.end,now+18*H);
  assert(!p.violations.some(v=>v.code==='DAILY_REST'));
  assert.equal(p.drivingMs,9.5*H);
});
test('PLAN-04: regular selection does not silently consume a reduced rest after four hours of work', () => {
  const p=buildPlan({stages:[stage(960)],departure:now,now,activities:completeHistoryBeforeWork(4)});
  const r=p.events.find(e=>e.label==='Редовна дневна почивка 11 ч');
  assert.equal(r.start,now+9*H);
  assert.equal(p.status.daily.reducedRestsUsed,0);
  assert.equal(p.ignoredDailyRests.length,0);
});
test('PLAN-04: selected reduced rest uses its nine hour deadline and allowance once', () => {
  const p=buildPlan({stages:[stage(960,false,'reduced')],departure:now,now,activities:completeHistoryBeforeWork(6)});
  const r=p.events.find(e=>e.label==='Намалена дневна почивка 9 ч');
  assert.equal(r.start,now+9*H);
  assert.equal(r.end-r.start,9*H);
  assert.equal(p.status.daily.reducedRestsUsed,1);
  assert(!p.violations.some(v=>v.code==='DAILY_REST'));
});
test('PLAN-04: exhausted reduced allowance uses the regular deadline and explains fallback', () => {
  const h=historyWithReducedRests(3);
  const t=h.end+6*H;
  const activities=[...h.log,{type:'work',start:h.end,end:t}];
  const p=buildPlan({stages:[stage(760,false,'reduced')],departure:t,now:t,activities});
  const r=p.events.find(e=>e.label==='Редовна дневна почивка 11 ч');
  assert.equal(r.start,t+7*H);
  assert(p.ignoredDailyRests.some(v=>v.reason.includes('трите')));
  assert(!p.events.some(e=>e.label==='Намалена дневна почивка 9 ч'));
});
test('PLAN-04: daily rest replaces the redundant short break at the daily driving limit', () => {
  const p=buildPlan({stages:[stage(960)],departure:now,now,activities:completeHistoryBeforeWork(0)});
  const rests=p.events.filter(e=>e.type==='rest');
  assert.deepEqual(rests.map(e=>e.end-e.start),[45*MIN,11*H]);
  assert.equal(p.arrival,now+23.75*H);
});
test('PLAN-04: split break cannot push the chosen daily rest past its deadline', () => {
  const p=buildPlan({stages:[stage(720)],departure:now,now,activities:completeHistoryBeforeWork(8.75),breakStyle:'15+30'});
  const firstRest=p.events.find(e=>e.type==='rest');
  assert.equal(firstRest.start,now+4*H);
  assert.equal(firstRest.end-firstRest.start,11*H);
  assert(!p.violations.some(v=>v.code==='DAILY_REST'));
});
test('PLAN-04: adjacent road sections share the daily rest deadline', () => {
  const p=buildPlan({stages:[stage(240),stage(480)],departure:now,now,activities:completeHistoryBeforeWork(6)});
  const r=p.events.find(e=>e.label==='Редовна дневна почивка 11 ч');
  assert.equal(r.stageIndex,1);
  assert.equal(r.start,now+7*H);
  assert.equal(p.drivingMs,9*H);
});
test('PLAN-04: at the regular rest deadline, rest starts immediately before any drive', () => {
  const p=buildPlan({stages:[stage(80)],departure:now,now,activities:completeHistoryBeforeWork(13)});
  assert.equal(p.events[0].type,'rest');
  assert.equal(p.events[0].start,now);
  assert.equal(p.events[0].label,'Редовна дневна почивка 11 ч');
});
test('PLAN-04: one minute beyond the regular deadline is explicitly reported, never labelled regular', () => {
  const p=buildPlan({stages:[stage(80)],departure:now,now,activities:completeHistoryBeforeWork(13+1/60)});
  assert.equal(p.events[0].type,'rest');
  assert.equal(p.events[0].start,now);
  assert.notEqual(p.events[0].label,'Редовна дневна почивка 11 ч');
  assert(p.ignoredDailyRests.some(v=>v.code==='DAILY_REST_DEADLINE_MISSED'));
  assert.equal(p.confirmed,false);
});
test('PLAN-04: an already missed minimum rest window remains a violation after immediate rest', () => {
  const p=buildPlan({stages:[stage(80)],departure:now,now,activities:completeHistoryBeforeWork(16)});
  assert.equal(p.events[0].type,'rest');
  assert.equal(p.events[0].start,now);
  assert(p.violations.some(v=>v.code==='DAILY_REST'));
  assert.equal(p.confirmed,false);
});

test('PLAN-04: one minute before the regular deadline permits only one minute of driving', () => {
  const p=buildPlan({stages:[stage(80)],departure:now,now,activities:completeHistoryBeforeWork(13-1/60)});
  assert.equal(p.events[0].type,'drive');
  assert.equal(p.events[0].end-p.events[0].start,MIN);
  assert.equal(p.events[1].start,now+MIN);
  assert.equal(p.events[1].end-p.events[1].start,11*H);
});
test('PLAN-04: crew option uses the existing 30 hour window while respecting regular choice', () => {
  const p=buildPlan({stages:[stage(720)],departure:now,now,activities:completeHistoryBeforeWork(16),multiManning:true});
  const r=p.events.find(e=>e.label==='Редовна дневна почивка 11 ч');
  assert.equal(r.start,now+3*H);
  assert(!p.violations.some(v=>v.code==='DAILY_REST'));
});
test('PLAN-04: route finishing exactly at rest deadline adds no fictional post-arrival rest', () => {
  const p=buildPlan({stages:[stage(80)],departure:now,now,activities:completeHistoryBeforeWork(12)});
  assert.equal(p.arrival,now+H);
  assert.equal(p.events.length,1);
  assert.equal(p.events[0].type,'drive');
});

test('PLAN-04: an unused extension is not consumed when daily rest takes precedence over the break', () => {
  const p=buildPlan({stages:[stage(800,true)],departure:now,now,activities:completeHistoryBeforeWork(2.5)});
  assert.equal(p.extendedDuties.length,0);
  assert.equal(p.stages[0].extensionUsed,false);
  assert.equal(p.drivingMs,10*H);
});


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

// PLAN-05: a recorded rest that is still running at departure is one
// continuous rest with the planned fragment; only a real interruption or an
// unrecorded interval moves its start to the planned fragment.
function historyWithRestBeforeDeparture(workHours, restHours, extra = []) {
  const dutyStart = now - (workHours + restHours) * H;
  return [
    {type:'rest', start:now-192*H, end:dutyStart},
    {type:'work', start:dutyStart, end:now-restHours*H},
    {type:'rest', start:now-restHours*H, end:now},
    ...extra
  ];
}
const missedRest = p => p.ignoredDailyRests.some(v => v.code === 'DAILY_REST_DEADLINE_MISSED');

test('PLAN-05: a recorded rest begun before the deadline is continued without a missed-deadline warning', () => {
  const p=buildPlan({stages:[stage(400)],departure:now,now,activities:historyWithRestBeforeDeparture(12,2)});
  assert.equal(p.events[0].type,'rest');
  assert.equal(p.events[0].start,now);
  assert.equal(p.events[0].label,'Редовна дневна почивка 11 ч');
  assert.equal(missedRest(p),false);
  assert.deepEqual(p.violations,[]);
  assert.equal(p.confirmed,true);
});
test('PLAN-05: a recorded rest begun exactly at the deadline counts, one minute later it is still reported', () => {
  const exact=buildPlan({stages:[stage(400)],departure:now,now,activities:historyWithRestBeforeDeparture(13,2)});
  assert.equal(missedRest(exact),false);
  assert.equal(exact.confirmed,true);
  const late=buildPlan({stages:[stage(400)],departure:now,now,activities:historyWithRestBeforeDeparture(13+1/60,2-1/60)});
  assert.equal(missedRest(late),true);
  assert.notEqual(late.events[0].label,'Редовна дневна почивка 11 ч');
  assert.equal(late.confirmed,false);
});
test('PLAN-05: work recorded after the rest breaks its continuity and keeps the warning', () => {
  const history=historyWithRestBeforeDeparture(12,2);
  history[2].end=now-MIN;
  history.push({type:'work', start:now-MIN, end:now});
  const p=buildPlan({stages:[stage(400)],departure:now,now,activities:history});
  assert.equal(missedRest(p),true);
  assert.equal(p.confirmed,false);
});
test('PLAN-05: an unrecorded interval before a future departure is not credited as the same rest', () => {
  const history=historyWithRestBeforeDeparture(12,2);
  history[2].end=null; // still resting at now, unknown until departure
  const p=buildPlan({stages:[stage(400)],departure:now+3*H,now,activities:history});
  assert.equal(missedRest(p),true);
  assert.equal(p.confirmed,false);
  assert.equal(p.events[0].start,now+3*H);
});
test('PLAN-05: a manual rest over automatic work counts as recorded rest and the log is not mutated', () => {
  const history=[
    {type:'rest', start:now-192*H, end:now-14*H},
    {type:'work', start:now-14*H, end:now},
    {type:'rest', start:now-2*H, end:now, manual:true}
  ];
  const before=structuredClone(history);
  const p=buildPlan({stages:[stage(400)],departure:now,now,activities:history});
  assert.equal(missedRest(p),false);
  assert.deepEqual(p.violations,[]);
  assert.deepEqual(history,before);
});
test('PLAN-05: switching from a reduced to a regular section still reports the missed regular deadline', () => {
  const p=buildPlan({stages:[stage(680,false,'reduced'),stage(400)],departure:now,now,activities:completeHistoryBeforeWork(4)});
  assert.equal(missedRest(p),true);
  assert.equal(p.confirmed,false);
});
test('PLAN-05: a ferry rest interrupted after the deadline is not credited from before the interruption', () => {
  const history=historyWithRestBeforeDeparture(12,2);
  history[2]={type:'rest', start:now-2*H, end:now-30*MIN, ferry:true};
  history.push({type:'drive', start:now-30*MIN, end:now-20*MIN},
    {type:'rest', start:now-20*MIN, end:now, ferry:true});
  const p=buildPlan({stages:[stage(400)],departure:now,now,activities:history});
  assert.equal(missedRest(p),true);
  assert.equal(p.confirmed,false);
});
