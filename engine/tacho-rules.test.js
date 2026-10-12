// Тестове за броячите. Пускат се с: node --test engine/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, describe as say, weekStart, H, MIN } from './tacho-rules.js';

const T = iso => Date.parse(iso);
const KIND = { D: 'drive', W: 'work', A: 'avail', R: 'rest' };

// seq('2026-10-12T05:00Z', ['D', 270], ['R', 45]) — поредица дейности в минути
function seq(start, ...steps) {
  let t = typeof start === 'number' ? start : T(start);
  const acts = [];
  for (const [k, minutes, extra] of steps) {
    acts.push({ type: KIND[k], start: t, end: t + minutes * MIN, ...extra });
    t += minutes * MIN;
  }
  return { acts, end: t };
}

// Ден от точно 24 ч: каране на парчета по 4:30 с паузи 45 мин, после почивка.
function day(driveMin) {
  const steps = [];
  let left = driveMin, used = 0;
  while (left > 0) {
    const d = Math.min(270, left);
    steps.push(['D', d]); used += d; left -= d;
    if (left > 0) { steps.push(['R', 45]); used += 45; }
  }
  steps.push(['R', 1440 - used]);
  return steps;
}
const days = hours => hours.flatMap(h => day(h * 60));
const codes = r => r.violations.map(v => v.code);
const run = (s, opts = {}) => analyze(s.acts, { now: s.end, ...opts });

// ── чл. 7: паузи

test('4:30 каране и пауза 45 мин — без нарушение, броячът се нулира', () => {
  const r = run(seq('2026-10-12T05:00Z', ['D', 270], ['R', 45], ['D', 60]));
  assert.deepEqual(codes(r), []);
  assert.equal(r.status.continuous.driven, 60 * MIN);
});

test('4:31 без пауза — нарушение по чл. 7', () => {
  const r = run(seq('2026-10-12T05:00Z', ['D', 271]));
  assert.deepEqual(codes(r), ['CONTINUOUS_DRIVE']);
  assert.equal(r.violations[0].at, T('2026-10-12T09:30Z'));
});

test('разделена пауза 15 + 30 мин нулира 4:30 (старата грешка №1)', () => {
  const r = run(seq('2026-10-12T05:00Z', ['D', 120], ['R', 15], ['D', 120], ['R', 30], ['D', 240]));
  assert.deepEqual(codes(r), []);
  assert.equal(r.status.continuous.driven, 240 * MIN);
});

test('30 + 15 мин в обратен ред не е валидна пауза', () => {
  const r = run(seq('2026-10-12T05:00Z', ['D', 120], ['R', 30], ['D', 120], ['R', 15], ['D', 60]));
  assert.deepEqual(codes(r), ['CONTINUOUS_DRIVE']);
});

test('работата не е пауза', () => {
  const r = run(seq('2026-10-12T05:00Z', ['D', 200], ['W', 60], ['D', 80]));
  assert.deepEqual(codes(r), ['CONTINUOUS_DRIVE']);
});

test('„на разположение“ не е пауза, освен ако не е включено изрично', () => {
  const s = seq('2026-10-12T05:00Z', ['D', 200], ['A', 60], ['D', 80]);
  assert.deepEqual(codes(run(s)), ['CONTINUOUS_DRIVE']);
  assert.deepEqual(codes(run(s, { availabilityCountsAsBreak: true })), []);
});

// ── чл. 6: дневно, седмично, двуседмично каране

const tenHourDay = [['D', 270], ['R', 45], ['D', 270], ['R', 45], ['D', 60], ['R', 660]];

test('10 ч каране два пъти седмично е позволено, третият път е нарушение', () => {
  const r = run(seq('2026-10-12T05:00Z', ...tenHourDay, ...tenHourDay, ...tenHourDay, ['D', 10]));
  assert.deepEqual(codes(r), ['DAILY_DRIVE_EXT']);
  assert.equal(r.duties.filter(d => d.extended).length, 3);
});

test('след две удължения дневният лимит става 9 ч', () => {
  const r = run(seq('2026-10-12T05:00Z', ...tenHourDay, ...tenHourDay, ['D', 10]));
  assert.equal(r.status.daily.extensionsUsed, 2);
  assert.equal(r.status.daily.limit, 9 * H);
});

test('над 10 ч каране за ден — нарушение', () => {
  const r = run(seq('2026-10-12T05:00Z', ['D', 270], ['R', 45], ['D', 270], ['R', 45], ['D', 61], ['R', 660]));
  assert.ok(codes(r).includes('DAILY_DRIVE'));
});

test('над 56 ч за седмица — нарушение', () => {
  const r = run(seq('2026-10-12T00:30Z', ...days([9, 9, 9, 9, 9, 9, 9])));
  assert.ok(codes(r).includes('WEEKLY_DRIVE'));
});

test('90 ч за две седмици се броят само за съседни седмици (старата грешка №2)', () => {
  // 50 + 30 + 30: двойките са 80 и 60, няма нарушение
  const ok = run(seq('2026-10-12T00:00Z', ...days([9, 9, 9, 9, 9, 5, 0, 9, 9, 9, 3, 0, 0, 0, 9, 9, 9, 3, 0, 0, 0])));
  assert.ok(!codes(ok).includes('FORTNIGHT_DRIVE'));
  assert.ok(!codes(ok).includes('WEEKLY_DRIVE'));
  // 56 + 36 = 92 ч — нарушение
  const bad = run(seq('2026-10-12T00:00Z', ...days([9, 9, 10, 10, 9, 9, 0, 9, 9, 9, 9, 0, 0, 0])));
  assert.ok(codes(bad).includes('FORTNIGHT_DRIVE'));
  assert.ok(!codes(bad).includes('WEEKLY_DRIVE'));
});

test('каране през полунощ в неделя се разделя между двете седмици', () => {
  const r = run(seq('2026-10-18T23:00Z', ['D', 120]));
  assert.equal(r.status.weekly.previousWeek, 1 * H);
  assert.equal(r.status.weekly.driven, 1 * H);
});

test('седмицата започва в понеделник 00:00', () => {
  assert.equal(weekStart(T('2026-10-14T12:00Z')), T('2026-10-12T00:00Z'));
  assert.equal(weekStart(T('2026-10-18T23:59Z')), T('2026-10-12T00:00Z'));
  assert.equal(weekStart(T('2026-10-19T00:00Z')), T('2026-10-19T00:00Z'));
});

// ── чл. 8: дневни почивки

const reducedDay = [['D', 270], ['R', 45], ['D', 270], ['W', 60], ['R', 540]];

test('9 ч почивка е намалена; четвъртата намалена между две седмични е нарушение (старата грешка №3)', () => {
  const r = run(seq('2026-10-12T05:00Z', ...reducedDay, ...reducedDay, ...reducedDay, ...reducedDay, ['D', 30]));
  assert.deepEqual(r.duties.slice(0, 4).map(d => d.rest.kind), ['reduced', 'reduced', 'reduced', 'reduced']);
  assert.deepEqual(codes(r), ['REDUCED_DAILY_RESTS']);
});

test('намалените почивки се нулират след седмична почивка', () => {
  const r = run(seq('2026-10-12T05:00Z', ...reducedDay, ...reducedDay, ...reducedDay, ['D', 60], ['R', 45 * 60], ...reducedDay, ['D', 30]));
  assert.ok(!codes(r).includes('REDUCED_DAILY_RESTS'));
  assert.equal(r.status.daily.reducedRestsUsed, 1);
});

test('разделена дневна почивка 3 + 9 ч е редовна, не намалена', () => {
  const r = run(seq('2026-10-12T05:00Z', ['D', 270], ['R', 180], ['D', 240], ['R', 540], ['D', 30]));
  assert.equal(r.duties[0].rest.kind, 'split');
  assert.equal(r.status.daily.reducedRestsUsed, 0);
  assert.deepEqual(codes(r), []);
});

test('почивка, започнала след 16 ч, не е дневна почивка в рамките на 24 ч', () => {
  const r = run(seq('2026-10-12T06:00Z', ['D', 270], ['R', 45], ['D', 270], ['R', 45], ['W', 330], ['R', 660], ['D', 10]));
  assert.equal(r.duties[0].rest.kind, 'insufficient');
  assert.ok(codes(r).includes('DAILY_REST'));
});

test('11 ч почивка, започнала на 14-ия час, се брои за намалена (в 24-те часа влизат 10 ч)', () => {
  const r = run(seq('2026-10-12T06:00Z', ['D', 270], ['R', 45], ['D', 270], ['W', 255], ['R', 660], ['D', 10]));
  assert.equal(r.duties[0].rest.kind, 'reduced');
});

test('текуща почивка, която още може да стане 11 ч, не се брои за намалена', () => {
  const r = run(seq('2026-10-12T05:00Z', ['D', 270], ['R', 45], ['D', 270], ['R', 570]));
  assert.equal(r.duties[0].rest.kind, 'pending');
  assert.equal(r.status.daily.reducedRestsUsed, 0);
});

test('празнина в дневника се брои за почивка', () => {
  const a = seq('2026-10-12T05:00Z', ['D', 240]);
  const b = seq('2026-10-12T20:00Z', ['D', 60]);
  const r = analyze([...a.acts, ...b.acts], { now: b.end });
  assert.equal(r.duties.length, 2);
  assert.equal(r.duties[0].rest.kind, 'regular');
});

// ── чл. 8(5): двойка

test('двойка: 9 ч почивка в рамките на 30 ч е редовна; сам шофьор — нарушение', () => {
  const s = seq('2026-10-12T05:00Z', ['D', 270], ['R', 45], ['D', 270], ['R', 45], ['W', 450], ['R', 540], ['D', 10]);
  assert.ok(codes(run(s)).includes('DAILY_REST'));
  const m = run(s, { multiManning: true });
  assert.equal(m.duties[0].rest.kind, 'multi');
  assert.deepEqual(codes(m), []);
});

test('двойка: всеки водач има свой дневник и данните не се губят при смяна (старата грешка №4)', () => {
  const start = T('2026-10-12T05:00Z');
  const d1 = seq(start, ['D', 240], ['A', 180]);
  const d2 = seq(start, ['A', 240], ['D', 180]);
  const r1 = analyze(d1.acts, { now: d1.end, multiManning: true });
  const r2 = analyze(d2.acts, { now: d2.end, multiManning: true });
  assert.equal(r1.status.daily.driven, 240 * MIN);
  assert.equal(r2.status.daily.driven, 180 * MIN);
});

// ── чл. 8(6): седмична почивка

test('седмичната почивка след повече от 144 ч — нарушение', () => {
  const r = run(seq('2026-10-12T00:00Z', ...days([9, 9, 9, 9, 9, 9, 9])), { lastWeeklyRestEnd: T('2026-10-12T00:00Z') });
  assert.ok(codes(r).includes('WEEKLY_REST_LATE'));
});

test('предупреждения 24, 12 и 4 ч преди седмичната почивка', () => {
  const s = seq('2026-10-17T10:00Z', ['D', 60]);
  const deadlineIn = h => s.end + h * H - 144 * H;
  const warn = h => run(s, { lastWeeklyRestEnd: deadlineIn(h) }).status.warnings.map(w => w.code);
  assert.ok(warn(20).includes('WEEKLY_REST_24H'));
  assert.ok(warn(10).includes('WEEKLY_REST_12H'));
  assert.ok(warn(3).includes('WEEKLY_REST_4H'));
  assert.deepEqual(warn(30).filter(c => c.startsWith('WEEKLY_REST')), []);
});

test('намалена седмична почивка 40 ч: 5 ч компенсация, платени с 16 ч почивка (11 + 5)', () => {
  const r = run(seq('2026-10-12T05:00Z', ['D', 270], ['R', 40 * 60], ['D', 270], ['R', 16 * 60], ['D', 60]));
  assert.equal(r.compensation.length, 1);
  assert.equal(r.compensation[0].hours, 5);
  assert.equal(r.compensation[0].due, T('2026-11-09T00:00Z'));
  assert.equal(r.compensation[0].paid, true);
  assert.deepEqual(r.status.compensation, []);
});

test('14 ч почивка не плаща 5 ч компенсация: едно и също време не се брои два пъти', () => {
  const r = run(seq('2026-10-12T05:00Z', ['D', 270], ['R', 40 * 60], ['D', 270], ['R', 14 * 60], ['D', 60]));
  assert.equal(r.compensation[0].paid, false);
  assert.equal(r.status.compensation.length, 1);
});

test('неплатена компенсация след края на третата седмица — нарушение', () => {
  const daily = Array(27).fill(9);
  const r = run(seq('2026-10-12T05:00Z', ['D', 270], ['R', 24 * 60], ...days(daily)));
  assert.ok(codes(r).includes('COMPENSATION'));
});

// ── чл. 9: ферибот

test('почивка на ферибот, прекъсната веднъж за 20 мин, е редовна дневна почивка', () => {
  const steps = [['D', 270], ['R', 45], ['D', 270], ['R', 360, { ferry: true }], ['D', 20], ['R', 300, { ferry: true }], ['D', 30]];
  const r = run(seq('2026-10-12T05:00Z', ...steps));
  assert.equal(r.duties[0].rest.kind, 'regular');
  assert.ok(!codes(r).includes('DAILY_REST'));
  // без отметка за ферибот същото е нарушение
  const plain = steps.map(([k, m]) => [k, m]);
  assert.ok(codes(run(seq('2026-10-12T05:00Z', ...plain))).includes('DAILY_REST'));
});

test('ферибот: сливат се най-много две прекъсвания', () => {
  const f = { ferry: true };
  const r = run(seq('2026-10-12T05:00Z', ['D', 270], ['R', 45], ['D', 270],
    ['R', 360, f], ['W', 10], ['R', 180, f], ['W', 10], ['R', 180, f], ['W', 10], ['R', 100, f], ['D', 30]));
  // 6 + 3 + 3 ч = 12 ч с две прекъсвания; третото не влиза
  assert.equal(r.duties[0].rest.kind, 'regular');
  assert.equal(r.duties[0].rest.len, 720 * MIN);
});

test('ферибот: прекъсване над 1 ч общо не се слива', () => {
  const f = { ferry: true };
  const r = run(seq('2026-10-12T05:00Z', ['D', 270], ['R', 45], ['D', 270], ['R', 360, f], ['W', 61], ['R', 300, f], ['D', 30]));
  assert.equal(r.duties[0].rest, null);
});

test('ферибот: прекъсната почивка под 11 ч не е позволена (чл. 9 важи за редовна дневна)', () => {
  const f = { ferry: true };
  const r = run(seq('2026-10-12T05:00Z', ['D', 270], ['R', 45], ['D', 270], ['R', 300, f], ['D', 20], ['R', 300, f], ['D', 30]));
  assert.ok(codes(r).includes('DAILY_REST'));
});

test('ферибот: в 24-те часа се броят само частите почивка, не прекъсването', () => {
  const f = { ferry: true };
  // почивката започва на 13-ия час: 6 ч + 4 ч от втората част влизат в прозореца = 10 ч
  const r = run(seq('2026-10-12T05:00Z', ['D', 270], ['R', 45], ['D', 270], ['W', 195], ['R', 360, f], ['D', 60], ['R', 300, f], ['D', 30]));
  assert.equal(r.duties[0].rest.inWindow, 600 * MIN);
  assert.equal(r.duties[0].rest.kind, 'reduced');
});

test('почивка на кея плюс почивка на ферибота е една непрекъсната почивка', () => {
  const f = { ferry: true };
  const r = run(seq('2026-10-12T05:00Z', ['D', 270], ['R', 45], ['D', 270], ['R', 120], ['R', 540, f], ['D', 30]));
  assert.equal(r.duties[0].rest.kind, 'regular');
  // и празнина след почивката на ферибота се слива с нея
  const a = seq('2026-10-12T05:00Z', ['D', 270], ['R', 45], ['D', 270], ['R', 360, f]);
  const b = seq(a.end + 5 * H, ['D', 30]);
  const r2 = analyze([...a.acts, ...b.acts], { now: b.end });
  assert.equal(r2.duties[0].rest.kind, 'regular');
  assert.ok(!codes(r2).includes('DAILY_REST'));
});

// ── текущо състояние и изречения

test('15 мин преди 4:30 идва предупреждение и гласът казва колко остава', () => {
  const start = T('2026-10-12T05:00Z');
  const acts = [{ type: 'drive', start, end: null }];
  const r = analyze(acts, { now: start + 260 * MIN });
  assert.ok(r.status.warnings.some(w => w.code === 'BREAK_SOON'));
  assert.match(say(r), /Можеш да караш още 10 мин, после пауза 45 мин/);
});

test('по време на пауза се вижда какво вече покрива и кога е следващата граница', () => {
  const start = T('2026-10-12T05:00Z');
  const r = analyze([{ type: 'drive', start, end: start + 270 * MIN }, { type: 'rest', start: start + 270 * MIN, end: null }],
    { now: start + 290 * MIN });
  assert.equal(r.status.currentRest.qualifies, 'първата част от паузата (15 мин)');
  // една непрекъсната пауза става валидна при 45 мин, не при 30
  assert.equal(r.status.currentRest.next.name, 'пауза 45 мин');
  assert.equal(r.status.currentRest.next.at, start + 315 * MIN);
  assert.equal(r.status.continuous.nextBreak, 45 * MIN);
  assert.equal(r.status.driveRemaining, 0);
  assert.equal(r.status.resumeAt, start + 315 * MIN);
  assert.match(say(r), /Можеш да тръгнеш в понеделник 13:15/);
  assert.doesNotMatch(say(r), /пауза 30 мин/);
});

test('след взети 15 мин следващата пауза се изпълва на 30-ата минута', () => {
  const start = T('2026-10-12T05:00Z');
  const s = seq(start, ['D', 120], ['R', 15], ['D', 150]);
  const acts = [...s.acts, { type: 'rest', start: s.end, end: null }];
  const r = analyze(acts, { now: s.end + 10 * MIN });
  assert.equal(r.status.currentRest.next.name, 'втората част от паузата (30 мин)');
  assert.equal(r.status.currentRest.next.at, s.end + 30 * MIN);
});

test('изречението за гласа е на български, с часа в българско време', () => {
  const s = T('2026-10-12T03:00Z'); // 06:00 в София
  const r = analyze([{ type: 'drive', start: s, end: s + 200 * MIN }, { type: 'rest', start: s + 200 * MIN, end: s + 245 * MIN },
    { type: 'drive', start: s + 245 * MIN, end: null }],
  { now: s + 400 * MIN, lastRestEnd: s, lastWeeklyRestEnd: T('2026-10-11T08:00Z') });
  assert.equal(say(r), 'Можеш да караш още 1 ч 55 мин, после пауза 45 мин. Днес си карал 5 ч 55 мин от 9 ч ' +
    '(до 10 ч още 2 пъти тази седмица). Дневната почивка трябва да започне до понеделник 21:00. ' +
    'Седмичната почивка трябва да започне до събота 11:00.');
  // без известна история срокът е „най-късно“ и гласът го казва
  const u = analyze([{ type: 'drive', start: s, end: null }], { now: s + 60 * MIN });
  assert.match(say(u), /най-късно, не знам кога е свършила предишната/);
  assert.match(say(u), /кажи ми кога е свършила последната/);
});

// ── находки от независимия преглед

test('„колко ми остава“ спира при срока за дневна почивка, не само при 4:30', () => {
  const s = seq('2026-10-12T04:00Z', ['D', 120], ['W', 600], ['R', 45], ['D', 60], ['W', 60]); // сега 18:45, почивка до 19:00
  const r = run(s);
  assert.equal(r.status.driveRemaining, 15 * MIN);
  assert.equal(r.status.binding, 'dailyRest');
  assert.match(say(r), /Можеш да караш още 15 мин, после трябва да започнеш дневна почивка/);
  const late = run(seq('2026-10-12T04:00Z', ['D', 120], ['W', 600], ['R', 45], ['D', 60], ['W', 180]));
  assert.equal(late.status.driveRemaining, 0);
  assert.ok(codes(late).includes('DAILY_REST'));
});

test('„колко ми остава“ спира при срока за седмична почивка', () => {
  const s = seq('2026-10-12T05:00Z', ['D', 60]);
  const r = run(s, { lastWeeklyRestEnd: s.end + 30 * MIN - 144 * H });
  assert.equal(r.status.driveRemaining, 30 * MIN);
  assert.equal(r.status.binding, 'weeklyRest');
});

test('времето след последния запис е почивка от края му, не от началото', () => {
  const s = seq('2026-10-12T04:00Z', ['D', 270], ['W', 600]);
  const r = analyze(s.acts, { now: s.end + 5 * MIN });
  assert.equal(r.status.currentRest.length, 5 * MIN);
  assert.equal(r.status.currentRest.fromGap, true);
  assert.equal(r.status.driveRemaining, 0); // 4:30 вече са изкарани без пауза
  const late = analyze(seq('2026-10-12T04:00Z', ['W', 930]).acts, { now: T('2026-10-12T20:00Z') });
  assert.ok(codes(late).includes('DAILY_REST')); // почивката започва 19:30, а трябваше до 19:00
});

test('без останали намалени почивки 9 ч не стигат — трябват 11 ч', () => {
  const r = run(seq('2026-10-12T05:00Z', ...reducedDay, ...reducedDay, ...reducedDay, ['D', 270], ['R', 45], ['D', 270], ['W', 60], ['R', 545]));
  assert.equal(r.status.driveRemaining, 0);
  assert.equal(r.status.binding, 'dailyRest');
  assert.equal(r.status.resumeAt, r.status.currentRest.since + 11 * H);
});

test('удълженията се броят в седмицата, в която е започнало дежурството', () => {
  const a = seq('2026-10-12T05:00Z', ...tenHourDay, ...tenHourDay);
  const b = seq('2026-10-18T22:00Z', ['D', 270], ['R', 45], ['D', 270]); // неделя вечер → понеделник
  const r = analyze([...a.acts, ...b.acts], { now: b.end });
  assert.equal(r.status.daily.extensionsUsed, 2);
  assert.equal(r.status.daily.limit, 9 * H);
});

test('при равни лимити гласът казва по-тежкото: дневна почивка, не пауза', () => {
  const r = run(seq('2026-10-12T05:00Z', ...tenHourDay, ...tenHourDay, ['D', 270], ['R', 45], ['D', 210]));
  assert.equal(r.status.driveRemaining, 60 * MIN);
  assert.equal(r.status.binding, 'daily');
  assert.match(say(r), /Можеш да караш още 1 ч, после дневна почивка/);
});

test('ден над 10 ч също изразходва удължение', () => {
  const day105 = [['D', 270], ['R', 45], ['D', 270], ['R', 45], ['D', 90], ['R', 660]];
  const r = run(seq('2026-10-12T05:00Z', ...day105, ...tenHourDay, ...tenHourDay, ['D', 10]));
  assert.deepEqual(codes(r).sort(), ['DAILY_DRIVE', 'DAILY_DRIVE_EXT']);
});

test('седмичната почивка се следи и без въведена предишна (най-късният възможен срок)', () => {
  const nine = Array(9).fill([['D', 270], ['R', 45], ['D', 270], ['W', 120], ['R', 735]]).flat();
  const r = run(seq('2026-10-12T05:00Z', ...nine));
  assert.ok(codes(r).includes('WEEKLY_REST_LATE'));
  assert.equal(r.status.weeklyRest.estimated, true);
});

test('две поредни намалени седмични почивки — нарушение, освен при международен превоз', () => {
  const s = seq('2026-10-12T05:00Z', ['D', 270], ['R', 30 * 60], ...days([9, 9, 9, 9]), ['D', 270], ['R', 30 * 60], ['D', 60]);
  assert.ok(codes(run(s)).includes('CONSECUTIVE_REDUCED_WEEKLY'));
  assert.ok(!codes(run(s, { international: true })).includes('CONSECUTIVE_REDUCED_WEEKLY'));
});

test('„на разположение“ като пауза не става дневна почивка', () => {
  const r = run(seq('2026-10-12T05:00Z', ['D', 270], ['R', 45], ['D', 270], ['A', 540], ['D', 60]),
    { availabilityCountsAsBreak: true, multiManning: true });
  assert.equal(r.duties[0].rest, null);
});

test('отворен запис свършва там, където започва следващият', () => {
  const s = T('2026-10-12T05:00Z');
  const r = analyze([{ type: 'drive', start: s, end: null }, { type: 'rest', start: s + 270 * MIN, end: null }], { now: s + 300 * MIN });
  assert.equal(r.status.activity, 'rest');
  assert.deepEqual(codes(r), []);
});

test('пауза, въведена вътре в дълъг запис за каране, го разделя', () => {
  const s = T('2026-10-12T05:00Z');
  const r = analyze([{ type: 'drive', start: s, end: s + 300 * MIN }, { type: 'rest', start: s + 120 * MIN, end: s + 165 * MIN, manual: true }],
    { now: s + 300 * MIN });
  assert.deepEqual(codes(r), []);
  assert.equal(r.status.continuous.driven, 135 * MIN);
});

test('почивка, започнала преди срока за седмична, не дава предупреждение „закъснява“', () => {
  const s = seq('2026-10-12T05:00Z', ['D', 60], ['R', 20 * 60]);
  const r = run(s, { lastWeeklyRestEnd: s.end - 10 * H - 144 * H });
  assert.ok(!r.status.warnings.some(w => w.code === 'WEEKLY_REST_LATE'));
});

test('оставащото време се закръгля надолу', async () => {
  const { fmt } = await import('./tacho-rules.js');
  assert.equal(fmt(9.5 * MIN), '9 мин');
  assert.equal(fmt(59.9 * MIN), '59 мин');
});

test('часът за тръгване отчита и срока за дневна почивка, не само паузата', () => {
  // 4:30 каране, 10 ч работа до 18:30; почивката трябва да започне до 19:00;
  // след пауза до 19:15 вече е късно — трябва дневна почивка до 03:30 (06:30 в София)
  const s = seq('2026-10-12T04:00Z', ['D', 270], ['W', 600]);
  const r = analyze(s.acts, { now: s.end + 5 * MIN });
  assert.equal(r.status.resumeAt, s.end + 9 * H);
  assert.match(say(r), /Можеш да тръгнеш във вторник 06:30/);
});

test('по време на почивка гласът казва „продължи почивката“, не „започни почивка“', () => {
  const s = seq('2026-10-12T04:00Z', ['D', 120], ['W', 780], ['R', 60]); // почива от 19:00, срокът е 19:00
  const r = run(s);
  assert.equal(r.status.binding, 'dailyRest');
  assert.match(say(r), /Продължи почивката\. Можеш да тръгнеш във вторник 07:00/);
  assert.doesNotMatch(say(r), /Трябва да започнеш/);
});

test('под минута оставащо каране — спри сега', () => {
  const start = T('2026-10-12T05:00Z');
  const r = analyze([{ type: 'drive', start, end: null }], { now: start + 270 * MIN - 29_000 });
  assert.equal(r.status.driveRemaining, 0);
  assert.ok(r.status.warnings.some(w => w.code === 'BREAK_NOW'));
  assert.doesNotMatch(say(r), /0 мин/);
});

test('след намалена седмична почивка следващата седмична трябва да стигне 45 ч', () => {
  const r = run(seq('2026-10-12T05:00Z', ['D', 270], ['R', 30 * 60], ...days([9, 9, 9]), ['D', 270], ['R', 24 * 60 + 5]));
  assert.equal(r.status.driveRemaining, 0);
  assert.equal(r.status.binding, 'weeklyRest');
  assert.ok(r.status.warnings.some(w => w.code === 'WEEKLY_REST_MUST_BE_REGULAR'));
  assert.equal(r.status.resumeAt, r.status.currentRest.since + 45 * H);
});

test('при изчерпано дневно каране по време на каране идва „свърши“', () => {
  const start = T('2026-10-12T05:00Z');
  const s = seq(start, ...tenHourDay, ...tenHourDay, ['D', 270], ['R', 45]);
  const r = analyze([...s.acts, { type: 'drive', start: s.end, end: null }], { now: s.end + 270 * MIN });
  assert.ok(r.status.warnings.some(w => w.code === 'DAILY_DRIVE_NOW'));
});

test('„колко ми остава“ е най-малкото от 4:30, дневното, седмичното и двуседмичното', () => {
  const r = run(seq('2026-10-12T05:00Z', ['D', 270], ['R', 45], ['D', 200]));
  assert.equal(r.status.continuous.remaining, 70 * MIN);
  assert.equal(r.status.daily.remaining, 130 * MIN); // 10 ч лимит − 7:50
  assert.equal(r.status.driveRemaining, 70 * MIN);
});

test('непознат вид дейност спира с грешка', () => {
  assert.throws(() => analyze([{ type: 'sleep', start: 0, end: 1 }], { now: 2 }), /Непознат вид/);
});
