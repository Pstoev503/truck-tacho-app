// Тестове за дневника на дейностите. Пускат се с: node --test (от папка engine)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { switchTo, current, addManual, prune, parse, totals, KEEP_MS } from './activity-log.js';
import { analyze } from './tacho-rules.js';

const MIN = 60_000, H = 60 * MIN;
const T0 = Date.UTC(2026, 9, 13, 4, 0); // вторник 07:00 в София

test('смяна на дейност затваря текущата и отваря нова', () => {
  let log = switchTo([], 'work', T0);
  log = switchTo(log, 'drive', T0 + 15 * MIN);
  assert.deepEqual(log, [
    { type: 'work', start: T0, end: T0 + 15 * MIN },
    { type: 'drive', start: T0 + 15 * MIN, end: null }
  ]);
  assert.equal(current(log).type, 'drive');
});

test('същата дейност не добавя запис', () => {
  const log = switchTo(switchTo([], 'drive', T0), 'drive', T0 + H);
  assert.equal(log.length, 1);
});

test('стария дневник не се променя', () => {
  const a = switchTo([], 'drive', T0);
  const b = switchTo(a, 'rest', T0 + H);
  assert.equal(a[0].end, null);
  assert.equal(b[0].end, T0 + H);
});

test('бързо двойно натискане заменя записа с нулева дължина', () => {
  let log = switchTo([], 'work', T0);
  log = switchTo(log, 'drive', T0 + MIN);
  log = switchTo(log, 'rest', T0 + MIN);
  assert.deepEqual(log.map(e => e.type), ['work', 'rest']);
});

test('часовник назад не прави обратни записи', () => {
  let log = switchTo([], 'drive', T0);
  log = switchTo(log, 'rest', T0 - 5 * MIN);
  assert.ok(log.every(e => e.end == null || e.end >= e.start));
  assert.equal(current(log).type, 'rest');
});

test('ферибот: почивката се разделя с отметка, двете части са една почивка за броячите', () => {
  let log = switchTo([], 'rest', T0);
  log = switchTo(log, 'rest', T0 + H, { ferry: true });
  assert.equal(log.length, 2);
  assert.equal(current(log).ferry, true);
  const r = analyze(log, { now: T0 + 3 * H });
  assert.equal(r.status.currentRest.length, 3 * H);
});

test('ръчен запис в миналото се подрежда преди текущата дейност', () => {
  let log = switchTo([], 'rest', T0 + 2 * H);
  log = addManual(log, { type: 'drive', start: T0, end: T0 + H }, T0 + 3 * H);
  assert.deepEqual(log.map(e => [e.type, e.manual || false]), [['drive', true], ['rest', false]]);
  assert.equal(current(log).type, 'rest');
});

test('ръчен запис в средата на текущата дейност я разделя', () => {
  let log = switchTo([], 'work', T0);
  log = addManual(log, { type: 'drive', start: T0 + H, end: T0 + 2 * H }, T0 + 3 * H);
  assert.deepEqual(log.map(e => [e.type, e.start, e.end]), [
    ['work', T0, T0 + H],
    ['drive', T0 + H, T0 + 2 * H],
    ['work', T0 + 2 * H, null]
  ]);
  const t = totals(log, T0, T0 + 3 * H);
  assert.equal(t.work, 2 * H);
  assert.equal(t.drive, H);
  assert.equal(t.manual, true);
});

test('ръчен запис: проверки', () => {
  assert.throws(() => addManual([], { type: 'drive', start: T0 + H, end: T0 }, T0 + 2 * H));
  assert.throws(() => addManual([], { type: 'drive', start: T0, end: T0 + 3 * H }, T0 + 2 * H));
  assert.throws(() => addManual([], { type: 'fly', start: T0, end: T0 + H }, T0 + 2 * H));
});

test('изрязване на старите записи пази отворения', () => {
  let log = switchTo([], 'drive', T0);
  log = switchTo(log, 'rest', T0 + H);
  const later = T0 + KEEP_MS + 2 * H;
  assert.deepEqual(prune(log, later).map(e => e.type), ['rest']);
});

test('четене: повредени записи се пропускат, само последният е отворен', () => {
  const text = JSON.stringify([
    { type: 'drive', start: T0, end: null },
    { type: 'bogus', start: T0, end: T0 + 1 },
    { type: 'rest', start: T0 + H, end: null },
    { type: 'work', start: 'утре' },
    null
  ]);
  const log = parse(text);
  assert.deepEqual(log, [
    { type: 'drive', start: T0, end: T0 + H },
    { type: 'rest', start: T0 + H, end: null }
  ]);
  assert.deepEqual(parse('не е json'), []);
  assert.deepEqual(parse('{"a":1}'), []);
});

test('броячите четат дневника: 4 ч 10 мин каране → остават 20 мин до пауза', () => {
  let log = switchTo([], 'drive', T0);
  const r = analyze(log, { now: T0 + 4 * H + 10 * MIN });
  assert.equal(r.status.driveRemaining, 20 * MIN);
  assert.equal(r.status.binding, 'break');
  assert.equal(r.status.daily.driven, 4 * H + 10 * MIN);
});

test('пауза 45 мин в дневника нулира непрекъснатото каране', () => {
  let log = switchTo([], 'drive', T0);
  log = switchTo(log, 'rest', T0 + 4 * H);
  log = switchTo(log, 'drive', T0 + 4 * H + 45 * MIN);
  const r = analyze(log, { now: T0 + 5 * H });
  assert.equal(r.status.continuous.driven, 15 * MIN);
  assert.equal(r.status.daily.driven, 4 * H + 15 * MIN);
});
