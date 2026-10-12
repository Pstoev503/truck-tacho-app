// Тестове за предупреждението за скорост. Пускат се с: node --test (от папка engine)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOverspeedWatch } from './overspeed.js';

// Кара с дадени скорости, по една секунда на стойност; връща всички събития
function drive(speeds, watch = createOverspeedWatch(), t0 = 0) {
  const all = [];
  speeds.forEach((v, i) => {
    for (const e of watch.update(v, t0 + i * 1000)) all.push({ ...e, at: i });
  });
  return all;
}
const said = evs => evs.filter(e => e.type === 'say').map(e => `${e.at}: ${e.text}`);
const repeat = (v, n) => Array(n).fill(v);

test('на 90 км/ч не брои; брои се само над 90', () => {
  assert.deepEqual(drive(repeat(90, 120)), []);
  assert.equal(drive([91]).at(0).type, 'start');
});

test('гласът казва 30, 20, 10 и „записано“ 5 секунди преди истинските 60', () => {
  const evs = drive(repeat(92, 70));
  assert.deepEqual(said(evs), [
    '25: Над 90. 30 секунди.',
    '35: 20 секунди.',
    '45: 10 секунди.',
    '55: Превишението е записано в тахографа.'
  ]);
  assert.equal(evs.find(e => e.type === 'show').at, 25);
  // истинското записване в тахографа е след повече от 60 секунди
  assert.equal(evs.find(e => e.type === 'recorded').at, 61);
});

test('броячът на екрана тръгва от 30 и стига до 0', () => {
  const ticks = drive(repeat(95, 56)).filter(e => e.type === 'tick' && e.shown).map(e => e.remaining);
  assert.equal(ticks[0], 30);
  assert.equal(ticks.at(-1), 0);
});

test('намаляване под 90 за 2 секунди нулира броенето', () => {
  const evs = drive([...repeat(93, 40), 88, 88, 88]);
  const end = evs.find(e => e.type === 'end');
  assert.ok(end);
  assert.equal(end.duration, 40_000);
  assert.equal(end.recorded, false);
  // ново превишение започва отначало
  const again = drive([...repeat(93, 40), 88, 88, 88, ...repeat(93, 30)]);
  assert.equal(again.filter(e => e.type === 'start').length, 2);
});

test('спадане под 90 за 1 секунда (шум на GPS) не нулира', () => {
  const evs = drive([...repeat(91, 20), 89, ...repeat(91, 40)]);
  assert.equal(evs.filter(e => e.type === 'start').length, 1);
  assert.ok(said(evs).some(s => s.includes('записано')));
});

test('ако GPS пропусне момента, казва само последната граница', () => {
  const w = createOverspeedWatch();
  w.update(95, 0);
  const evs = w.update(95, 37_000); // от 55 остават 18 — пропуснати 30 и 20
  assert.deepEqual(evs.filter(e => e.type === 'say').map(e => e.text), ['Над 90. 20 секунди.']);
});

test('превишение над 60 секунди се отбелязва като записано при край', () => {
  const end = drive([...repeat(92, 65), 80, 80, 80]).find(e => e.type === 'end');
  assert.equal(end.recorded, true);
  assert.equal(end.maxSpeed, 92);
});

test('лимитът и резервът се настройват', () => {
  const evs = drive(repeat(81, 60), createOverspeedWatch({ limitKmh: 80, marginSec: 10 }));
  assert.equal(said(evs).at(-1), '50: Превишението е записано в тахографа.');
});
