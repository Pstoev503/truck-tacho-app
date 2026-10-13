// Тестове за маршрута и синхронизацията. Пускат се с: node --test (от папка engine)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeRoute, decodeRoute, parseHash, googleMapsLinks, gpx, straightKm, cleanRoute } from './route.js';
import { syncPayload, statusSnapshot, dayKey, recentShifts, serverUrl } from './sync.js';
import { switchTo, addManual } from './activity-log.js';
import { analyze } from './tacho-rules.js';

const samokov = { lat: 42.337, lon: 23.553, label: 'Самоков, склад' };
const sofia = { lat: 42.6977, lon: 23.3219, label: 'София' };
const timisoara = { lat: 45.7489, lon: 21.2087, label: 'Тимишоара' };
const route = { name: 'Самоков – Тимишоара', notes: 'Без Видин', waypoints: [samokov, sofia, timisoara] };

test('маршрутът минава през връзка без загуби (и на кирилица)', () => {
  const back = decodeRoute(encodeRoute(route));
  assert.deepEqual(back, route);
  assert.match(encodeRoute(route), /^[A-Za-z0-9_-]+$/);
});

test('повредена връзка не чупи приложението', () => {
  assert.equal(decodeRoute('%%%'), null);
  assert.equal(decodeRoute(''), null);
  assert.equal(cleanRoute({ waypoints: [samokov] }), null);
  assert.equal(cleanRoute({ waypoints: [samokov, { lat: 99, lon: 0 }] }), null);
});

test('адресът с #route= и #join= се чете', () => {
  const h = parseHash('#route=' + encodeRoute(route));
  assert.equal(h.route.name, route.name);
  const j = parseHash('#join=ABCD-EFGH&server=' + encodeURIComponent('https://api.example.eu'));
  assert.deepEqual(j, { join: 'ABCD-EFGH', server: 'https://api.example.eu' });
});

test('Google Maps: от мястото на телефона, точките са междинни', () => {
  const [link] = googleMapsLinks(route.waypoints);
  const u = new URL(link);
  assert.equal(u.searchParams.get('destination'), '45.7489,21.2087');
  assert.equal(u.searchParams.get('waypoints'), '42.337,23.553|42.6977,23.3219');
  assert.equal(u.searchParams.get('origin'), null);
  assert.equal(u.searchParams.get('travelmode'), 'driving');
});

test('Google Maps: много точки се делят на етапи по 9 междинни', () => {
  const pts = Array.from({ length: 23 }, (_, i) => ({ lat: 42 + i * 0.1, lon: 23, label: '' }));
  const links = googleMapsLinks(pts);
  assert.equal(links.length, 3); // 10 + 10 + 3
  const second = new URL(links[1]);
  assert.equal(second.searchParams.get('origin'), `${pts[9].lat},23`);
  assert.equal(second.searchParams.get('waypoints').split('|').length, 9);
  const last = new URL(links.at(-1));
  assert.equal(last.searchParams.get('destination'), `${pts[22].lat},23`);
});

test('GPX има всички точки и екранира имената', () => {
  const x = gpx({ ...route, name: 'A & B <тест>' });
  assert.equal((x.match(/<rtept /g) || []).length, 3);
  assert.ok(x.includes('A &amp; B &lt;тест&gt;'));
});

test('разстояние по права линия София – Тимишоара ≈ 380 км', () => {
  const km = straightKm([sofia, timisoara]);
  assert.ok(km > 370 && km < 390, String(km));
});

// ---------- синхронизация ----------

const H = 3600_000, DAY = 24 * H;
const T0 = Date.UTC(2026, 9, 13, 4, 0);

test('изпраща само последните 3 дни и откъде да замени', () => {
  let log = switchTo([], 'drive', T0 - 6 * DAY);
  log = switchTo(log, 'rest', T0 - 6 * DAY + 4 * H);
  log = switchTo(log, 'drive', T0 - DAY);
  log = switchTo(log, 'rest', T0 - DAY + 2 * H);
  const p = syncPayload(log, T0);
  assert.deepEqual(p.activities.map(a => a.type), ['rest', 'drive', 'rest']);
  // дългата почивка от преди 6 дни свърши вчера, затова и тя влиза — от нейното начало
  assert.equal(p.window_start, T0 - 6 * DAY + 4 * H);
  assert.equal(syncPayload(log, T0, true).activities.length, 4);
});

test('ръчният запис се изпраща с отметка', () => {
  let log = switchTo([], 'rest', T0);
  log = addManual(log, { type: 'drive', start: T0 - 3 * H, end: T0 - 2 * H }, T0 + H);
  const p = syncPayload(log, T0 + H);
  assert.ok(p.activities.some(a => a.manual && a.type === 'drive'));
});

test('празен дневник: нищо за замяна', () => {
  assert.deepEqual(syncPayload([], T0), { window_start: null, activities: [] });
});

test('образ на броячите за собственика', () => {
  const r = analyze(switchTo([], 'drive', T0), { now: T0 + 4 * H + 20 * 60_000 });
  const s = statusSnapshot(r, T0 + 4 * H + 20 * 60_000);
  assert.equal(s.activity, 'drive');
  assert.equal(s.driveRemaining, 10 * 60_000);
  assert.deepEqual(s.warnings, ['BREAK_SOON']);
});

test('смените от отчета получават ключ ГГГГ-ММ-ДД', () => {
  const now = new Date(2026, 9, 13, 12).getTime();
  const hist = { [new Date(2026, 9, 12).toDateString()]: { start: '06:00' }, [new Date(2026, 8, 1).toDateString()]: { start: 'старо' } };
  assert.deepEqual(recentShifts(hist, now), [{ day: '2026-10-12', data: { start: '06:00' } }]);
  assert.equal(dayKey(new Date(2026, 0, 5, 23, 30).getTime()), '2026-01-05');
});

test('адресът на сървъра се почиства', () => {
  assert.equal(serverUrl(' https://api.top10.eu/ '), 'https://api.top10.eu');
  assert.equal(serverUrl('javascript:alert(1)'), '');
  assert.equal(serverUrl(''), '');
});
