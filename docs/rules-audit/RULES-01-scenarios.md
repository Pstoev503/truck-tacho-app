# RULES-01 — детерминирани гранични сценарии

Версия: `bdddd307c4729985ba82a34f2d3d4a0af67a71df` (PLAN-02). `tacho-rules.js` е идентичен с `shef@449dc5e`.

## Условия

- T0 = `2026-10-12T00:00:00Z` (понеделник 00:00 UTC). Всички времена са UTC. Записите са синтетични, без реални водачи.
- Точните входове и опции на всеки изпълнен сценарий са в скрипта в раздел „Възпроизвеждане“. Таблицата е кратко описание. При разминаване скриптът е водещ.
- Нотация: `drive 270` = каране 270 мин, `rest 45` = почивка 45 мин, `work` = друга работа. Последователните записи са съседни, без празнини.
- Анализатор: `analyze(log, { now: края на последния запис, lastWeeklyRestEnd: T0, ...изброените опции })`.
- Плановник: `buildPlan({ stages: [{ distanceKm, roadType: 'motorway' }], departure: T0, now: T0, activities, ...изброените опции })`. Изключение е S-20, при който `departure = now =` края на историята. „Пълна история“ = `rest` от T0 − 8 × 24 ч до началото на зададените дейности; тогава `historyCoverage.complete` е true.
- **„Изпълнен“** означава, че входът е пуснат срещу реалния код със скрипта по-долу (Node v22.22.0, 18.10.2026), а „действително“ е буквалният изход. Скриптът **не** е добавен в репото и не се отчита като `node --test` pass. **„Не е изпълнен“** означава, че очакването е изведено само от четене на кода и текста.
- „Съвпада“ = действителното отговаря на нормативното очакване. „Разминаване“ = основа за находка. „Предпоставка“ = резултатът зависи от факт, който входът не доказва; не е доказано нарушение.

## Таблица

| ID | Вход (кратко) | Нормативно очакване | Източник | Действително | Статус | Оценка |
|---|---|---|---|---|---|---|
| S-01 | План 720 км (9 ч), пълна история до T0 | 4:30, 45 мин, 4:30; без нарушения | чл. 6(1), 7 | точно така; `confirmed:true` | изпълнен | съвпада |
| S-02 | План 960 км (12 ч), пълна история до T0 | Пауза непосредствено преди дневната почивка не е нужна | чл. 7, 8(2) | 4:30, 45, 4:30, **45**, 11 ч, 3:00; без нарушения; ETA +45 мин | изпълнен | разминаване (R-08, без нормативен ефект) |
| S-03 | Пълна история до T0 − 6 ч; `work` T0 − 6 ч…T0; план 760 км | Редовна почивка да започне до T0 + 7 ч (дежурство от T0 − 6 ч) или планът да е отказан | чл. 8(2), 4(g) | слята почивка от 09:45 (15,75 ч от началото), 8,25 ч в прозореца, `insufficient`; `DAILY_REST`; `confirmed:false`; ETA 22:00 | изпълнен | разминаване (R-01) |
| S-04 | `drive 270, rest 45, drive 60, rest 660` | Няма нарушение (точно 4:30) | чл. 7 | няма | изпълнен | съвпада |
| S-05 | `drive 271, …` | `CONTINUOUS_DRIVE` | чл. 7 | `CONTINUOUS_DRIVE` | изпълнен | съвпада |
| S-06 | `drive 120, rest 15, drive 150, rest 30, drive 120, rest 660` | Валидна пауза 15 + 30 | чл. 7 | няма | изпълнен | съвпада |
| S-07 | Същото с 30, после 15 | 30 + 15 не е валидно → превишени 4:30 | чл. 7 | `CONTINUOUS_DRIVE` | изпълнен | съвпада |
| S-08 | 3 × дежурство с 10 ч каране | Трето удължение в седмицата | чл. 6(1) | `DAILY_DRIVE_EXT` | изпълнен | съвпада |
| S-09a | 3 × (`drive 270, rest 45, drive 270, rest 540`), `drive 60` | 3 намалени почивки са позволени | чл. 8(4) | няма | изпълнен | съвпада |
| S-09b | Същото, 4 × | 4-та намалена → нарушение | чл. 8(4) | `REDUCED_DAILY_RESTS` | изпълнен | съвпада |
| S-10a | `drive 240, rest 180, drive 240, rest 45, drive 60, rest 540` | 3 + 9 → разделена редовна | чл. 4(g) | `split`, няма нарушение | изпълнен | съвпада |
| S-10b | Същото с `rest 480`, `drive 60` | 3 + 8 не е дневна почивка | чл. 4(g), 8(2) | `DAILY_REST` | изпълнен | съвпада |
| S-11a | 5 × (`drive 240, rest 1200`), `drive 240, rest 1140, work 60`, `rest 2700` от точно T0 + 144 ч, `drive 60` | Навреме | чл. 8(6) | няма | изпълнен | съвпада |
| S-11b | Същото с `work 61` → начало T0 + 144 ч + 1 мин | Закъсняла | чл. 8(6) | `WEEKLY_REST_LATE` | изпълнен | съвпада |
| S-12a | 2 седмици, всяка завършва с `rest 1440`, после `drive 60` | Две поредни намалени седмични → нарушение | чл. 8(6) | `CONSECUTIVE_REDUCED_WEEKLY` | изпълнен | съвпада |
| S-12b | S-12a с `international:true` | Позволено само при доказани условия на дерогацията | чл. 8(6), 8(6b) | няма нарушение и няма проверка на условията | изпълнен | разминаване (R-07) |
| S-12c | S-12a, втората седмична е `rest 2700` | Намалена + редовна е валидно | чл. 8(6) | няма | изпълнен | съвпада |
| S-13a | Ферибот: `rest 300F, drive 30, rest 60F, work 30, rest 300F` след 9 ч каране | Редовна 11 ч, 2 прекъсвания × общо 60 мин → валидна | чл. 9(1) | `regular`, няма нарушение | изпълнен | съвпада |
| S-13b | Същото с `drive 31` (общо 61 мин) | Без сливане → няма дневна почивка | чл. 9(1) | `DAILY_DRIVE`, `DAILY_REST` | изпълнен | съвпада |
| S-14 | 14 ч дежурство, ферибот `rest 300F, drive 30, rest 360F` | 9,5 ч в прозореца; прекъсване е позволено само при редовна → не е валидна дневна | чл. 9(1), 4(g), 8(2) | `reduced` (9,5 ч), няма нарушение | изпълнен | разминаване (R-06) |
| S-15a | Соло `drive 120, rest 45, work 315`, после `drive 270, rest 45, drive 150, rest 660, drive 30` | Почивката е на 15,75 ч → нарушение на 24-ч прозорец | чл. 8(2) | `DAILY_REST` (8,25 ч) | изпълнен | съвпада |
| S-15b | S-15a с `multiManning:true`. Допускане: вторият водач е дошъл след соло карането (2 ч > първия час) | Не е двойка по чл. 4(o) → същото като S-15a | чл. 4(o), 8(5) | няма нарушение, `regular` | изпълнен | разминаване (R-02a) |
| S-15c | План: история до 11.10 14:00, соло `drive` 14:00–16:00, `work` 16:00–24:00; 960 км; `multiManning:false` | Нарушение (24-ч прозорец) | чл. 8(2) | `DAILY_REST`, `confirmed:false` | изпълнен | съвпада |
| S-15d | S-15c с `multiManning:true`; вторият водач се присъединява в T0 | Не е двойка (2 ч соло каране в дежурството) → като S-15c | чл. 4(o), 8(5) | няма нарушения, **`confirmed:true`** | изпълнен | разминаване (R-02a) |
| S-15e | План: история до 11.10 16:00, само `work` 16:00–24:00; 960 км; `multiManning:false` | Нарушение при единичен водач | чл. 8(2) | `DAILY_REST`, `confirmed:false` | изпълнен | съвпада |
| S-15f | S-15e с `multiManning:true` | Зависи дали двама водачи са в превозното средство от първото каране — входът не го доказва | чл. 4(o), 8(5) | няма нарушения, `confirmed:true` | изпълнен | предпоставка (R-02b) |
| S-16a | `work 360, drive 270, rest 660` | 10:30 работа без пауза — нарушение по 2002/15 | Дир. 2002/15, чл. 5(1) | няма (не се проверява) | изпълнен | разминаване (R-04) |
| S-16b | 6 × (`work 180, drive 270, rest 45, drive 270, rest 660`), `rest 2700` | 72 ч работно време > 60 ч | Дир. 2002/15, чл. 4(a); 561, чл. 6(2) | няма | изпълнен | разминаване (R-04) |
| S-16c | План: пълна история до T0 − 2 ч, `work` T0 − 2 ч…T0, 720 км | Пауза до 6 ч работа | Дир. 2002/15, чл. 5(1) | `drive 270` преди първата пауза (6:30 работа); `confirmed:true` | изпълнен | разминаване (R-04) |
| S-17a | 6 дежурства: 9, 9, 10, 10, 9, 9 ч каране (= 56 ч) | Без нарушение | чл. 6(1), 6(2) | няма | изпълнен | съвпада |
| S-17b | Последният ден 9 ч 01 мин | `WEEKLY_DRIVE`; и трето удължение | чл. 6(1), 6(2) | `WEEKLY_DRIVE`, `DAILY_DRIVE_EXT` | изпълнен | съвпада |
| S-18 | План 720 км, `breakStyle:'15+30'`, `lastWeeklyRestEnd:T0`, история само `rest` T0 − 48 ч…T0 | 4:00, 15, 0:30, 30, 4:00, 15, 0:30; без нарушения; непълна история → `confirmed:false` | чл. 7 | точно така | изпълнен | съвпада |
| S-19 | План: пълна история до T0 − 4 ч, `work` T0 − 4 ч…T0, 960 км, `regular` | Редовна почивка трябва да има 11 ч в прозореца | чл. 8(2), 4(g), 8(4) | етикет „Редовна 11 ч“ от 10:30 (14,5 ч), слята почивка от 09:45 (13,75 ч), 10,25 ч в прозореца → `reduced`; `reducedRestsLeft:2`; `confirmed:true` | изпълнен | разминаване (R-03) |
| S-20 | История: `rest` T0 − 8 д…T0, после 5 × (`drive 270, rest 45, drive 270, rest 660`) и `drive 270, rest 45, drive 150, rest 660` (52 ч); `departure = now = 17.10 02:30`; `lastWeeklyRestEnd:T0`; 720 км | Спиране при 56 ч или отказ | чл. 6(2) | `WEEKLY_DRIVE`; `weekly.driven` 61 ч; ETA 17.10 12:15; `confirmed:false` | изпълнен | разминаване (R-05) |
| S-21 | Курс частично в Сърбия/Турция | AETR | AETR | няма вход за режим; извън текущия обхват | не е изпълнен | R-10 |
| S-22 | Автобус, случаен превоз, 12 дни | чл. 8(6a), Рег. 2024/1258 | чл. 8(6a) | няма вход; извън текущия обхват | не е изпълнен | R-10 |
| S-23 | Нощен труд: 10 ч каране + 1 ч товарене в 24 ч | Работно време ≤ 10 ч | Дир. 2002/15, чл. 7 | не се проверява (от четене на кода) | не е изпълнен | R-04; нощният период по българското право не е проверен |
| S-24 | Редовна седмична почивка в кабината | Забранено | чл. 8(8) | не се проверява | не е изпълнен | R-10, признато в README |

## Обобщение

- Изпълнени са 34 реда: 22 съвпадат, 11 са разминавания (основа за R-01…R-08) и 1 е предпоставка (S-15f). Неизпълнени са 4 (S-21…S-24).
- Валидни гранични случаи (очаквано без нарушение): S-01, S-04, S-06, S-09a, S-10a, S-11a, S-12c, S-13a, S-17a, S-18. Невалидни: S-05, S-07, S-08, S-09b, S-10b, S-11b, S-12a, S-13b, S-15a, S-15c, S-15e, S-17b.
- Нито един сценарий не е тест в `engine/*.test.js`.

## Възпроизвеждане

Скриптът е документиран тук. Не е source или test файл в репото. За да се изпълни, се запазва извън репото и се пуска срещу checkout на `bdddd307`:

```
git worktree add /tmp/rules01-base bdddd307c4729985ba82a34f2d3d4a0af67a71df
node rules01-probe.mjs /tmp/rules01-base
```

Скриптът само чете `engine/tacho-rules.js` и `engine/plan.js`. Не пише във файлове.

```js
// RULES-01: възпроизвеждане на сценариите. Употреба: node rules01-probe.mjs <път до repo на bdddd307>
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root = resolve(process.argv[2] || '.');
const { analyze } = await import(pathToFileURL(resolve(root, 'engine/tacho-rules.js')).href);
const { buildPlan } = await import(pathToFileURL(resolve(root, 'engine/plan.js')).href);
const MIN = 60_000, H = 60 * MIN, D = 24 * H;
const T0 = Date.parse('2026-10-12T00:00:00Z'); // понеделник 00:00 UTC
// seq(start, [[type, минути, {ferry}], ...]) -> съседни записи без празнини
const seq = (start, parts) => { let t = start; return parts.map(([type, m, x]) => { const a = { type, start: t, end: t + m * MIN, ...(x || {}) }; t += m * MIN; return a; }); };
const endOf = l => l.at(-1).end;
const iso = t => new Date(t).toISOString().replace(':00.000Z', 'Z');
const codes = r => r.violations.map(v => v.code);
const A = (id, log, opt = {}) => { const o = { now: endOf(log), lastWeeklyRestEnd: T0, ...opt };
  const r = analyze(log, o); const d = r.duties.find(x => x.rest) ;
  console.log(id, JSON.stringify({ from: iso(log[0].start), to: iso(endOf(log)), opts: Object.keys(opt), violations: codes(r), firstRestKind: d?.rest?.kind ?? null, inWindowH: d?.rest ? d.rest.inWindow / H : null })); return r; };
const full = (until) => [{ type: 'rest', start: T0 - 8 * D, end: until }]; // пълна история от T0-8д
const Pl = (id, activities, km, opt = {}) => { const p = buildPlan({ stages: [{ distanceKm: km, roadType: 'motorway', ...(opt.stage || {}) }], departure: opt.departure ?? T0, now: opt.now ?? T0, activities, ...(opt.plan || {}) });
  const r = analyze([...activities, ...p.activities], { now: p.arrival, gapsAsRest: false, ...(opt.plan?.multiManning ? { multiManning: true } : {}), ...(opt.plan?.lastWeeklyRestEnd != null ? { lastWeeklyRestEnd: opt.plan.lastWeeklyRestEnd } : {}) });
  console.log(id, JSON.stringify({ confirmed: p.confirmed, coverage: p.historyCoverage.complete, violations: codes(p), arrival: iso(p.arrival),
    events: p.events.map(e => `${e.type}:${iso(e.start)}+${(e.end - e.start) / MIN}m${e.type === 'rest' ? ':' + e.label : ''}`),
    dutyRests: r.duties.filter(d => d.rest).map(d => ({ start: iso(d.start), restStart: iso(d.rest.s), kind: d.rest.kind, inWindowH: d.rest.inWindow / H })),
    reducedRestsLeft: p.status.daily.reducedRestsLeft, weeklyDrivenH: p.status.weekly.driven / H })); return p; };

// ── плановник
Pl('S-01', full(T0), 720);
Pl('S-02', full(T0), 960);
Pl('S-03', [...full(T0 - 6 * H), { type: 'work', start: T0 - 6 * H, end: T0 }], 760);
Pl('S-15c', [...full(T0 - 10 * H), ...seq(T0 - 10 * H, [['drive', 120], ['work', 480]])], 960, { plan: { multiManning: false } });
Pl('S-15d', [...full(T0 - 10 * H), ...seq(T0 - 10 * H, [['drive', 120], ['work', 480]])], 960, { plan: { multiManning: true } });
Pl('S-15e', [...full(T0 - 8 * H), { type: 'work', start: T0 - 8 * H, end: T0 }], 960, { plan: { multiManning: false } });
Pl('S-15f', [...full(T0 - 8 * H), { type: 'work', start: T0 - 8 * H, end: T0 }], 960, { plan: { multiManning: true } });
Pl('S-16c', [...full(T0 - 2 * H), { type: 'work', start: T0 - 2 * H, end: T0 }], 720);
Pl('S-18', [{ type: 'rest', start: T0 - 48 * H, end: T0 }], 720, { plan: { breakStyle: '15+30', lastWeeklyRestEnd: T0 } });
Pl('S-19', [...full(T0 - 4 * H), { type: 'work', start: T0 - 4 * H, end: T0 }], 960);
{ // S-20: седмична почивка до T0, после 5 дни × 9 ч и 6-ти ден 7 ч каране (52 ч), потегляне веднага след последната 11 ч почивка
  const day = [['drive', 270], ['rest', 45], ['drive', 270], ['rest', 660]];
  const h = [{ type: 'rest', start: T0 - 8 * D, end: T0 }, ...seq(T0, [...day, ...day, ...day, ...day, ...day, ['drive', 270], ['rest', 45], ['drive', 150], ['rest', 660]])];
  Pl('S-20', h, 720, { departure: endOf(h), now: endOf(h), plan: { lastWeeklyRestEnd: T0 } });
}
// ── анализатор (now = край на последния запис, lastWeeklyRestEnd = T0)
A('S-04', seq(T0, [['drive', 270], ['rest', 45], ['drive', 60], ['rest', 660]]));
A('S-05', seq(T0, [['drive', 271], ['rest', 45], ['drive', 60], ['rest', 660]]));
A('S-06', seq(T0, [['drive', 120], ['rest', 15], ['drive', 150], ['rest', 30], ['drive', 120], ['rest', 660]]));
A('S-07', seq(T0, [['drive', 120], ['rest', 30], ['drive', 150], ['rest', 15], ['drive', 120], ['rest', 660]]));
{ const d = [['drive', 270], ['rest', 45], ['drive', 270], ['rest', 45], ['drive', 60], ['rest', 660]]; A('S-08', seq(T0, [...d, ...d, ...d])); }
{ const d = [['drive', 270], ['rest', 45], ['drive', 270], ['rest', 540]];
  A('S-09a', seq(T0, [...d, ...d, ...d, ['drive', 60]])); A('S-09b', seq(T0, [...d, ...d, ...d, ...d, ['drive', 60]])); }
A('S-10a', seq(T0, [['drive', 240], ['rest', 180], ['drive', 240], ['rest', 45], ['drive', 60], ['rest', 540]]));
A('S-10b', seq(T0, [['drive', 240], ['rest', 180], ['drive', 240], ['rest', 45], ['drive', 60], ['rest', 480], ['drive', 60]]));
for (const [id, w] of [['S-11a', 60], ['S-11b', 61]]) { const p = []; for (let i = 0; i < 5; i++) p.push(['drive', 240], ['rest', 1200]);
  A(id, seq(T0, [...p, ['drive', 240], ['rest', 1140], ['work', w], ['rest', 2700], ['drive', 60]])); }
{ const wk = r => { const p = []; for (let i = 0; i < 5; i++) p.push(['drive', 240], ['rest', 1200]); return [...p, ['drive', 240], ['rest', r]]; };
  A('S-12a', seq(T0, [...wk(1440), ...wk(1440), ['drive', 60]]));
  A('S-12b', seq(T0, [...wk(1440), ...wk(1440), ['drive', 60]]), { international: true });
  A('S-12c', seq(T0, [...wk(1440), ...wk(2700), ['drive', 60]])); }
const F = { ferry: true };
A('S-13a', seq(T0, [['drive', 270], ['rest', 45], ['drive', 270], ['rest', 300, F], ['drive', 30], ['rest', 60, F], ['work', 30], ['rest', 300, F], ['drive', 60]]));
A('S-13b', seq(T0, [['drive', 270], ['rest', 45], ['drive', 270], ['rest', 300, F], ['drive', 31], ['rest', 60, F], ['work', 30], ['rest', 300, F], ['drive', 60]]));
A('S-14', seq(T0, [['drive', 270], ['rest', 45], ['drive', 270], ['work', 255], ['rest', 300, F], ['drive', 30], ['rest', 360, F], ['drive', 60]]));
A('S-15a', seq(T0, [['drive', 120], ['rest', 45], ['work', 315], ['drive', 270], ['rest', 45], ['drive', 150], ['rest', 660], ['drive', 30]]));
A('S-15b', seq(T0, [['drive', 120], ['rest', 45], ['work', 315], ['drive', 270], ['rest', 45], ['drive', 150], ['rest', 660], ['drive', 30]]), { multiManning: true });
A('S-16a', seq(T0, [['work', 360], ['drive', 270], ['rest', 660]]));
{ const d = [['work', 180], ['drive', 270], ['rest', 45], ['drive', 270], ['rest', 660]]; A('S-16b', seq(T0, [...d, ...d, ...d, ...d, ...d, ...d, ['rest', 2700]])); }
for (const [id, x] of [['S-17a', 0], ['S-17b', 1]]) { const p = [];
  for (const m of [540, 540, 600, 600, 540, 540 + x]) { let left = m; while (left > 0) { const a = Math.min(270, left); p.push(['drive', a]); left -= a; if (left > 0) p.push(['rest', 45]); } p.push(['rest', 660]); }
  A(id, seq(T0, p)); }
```

Изход при изпълнение на 18.10.2026 (Node v22.22.0, Linux), без редакции:

```
S-01 {"confirmed":true,"coverage":true,"violations":[],"arrival":"2026-10-12T09:45Z","events":["drive:2026-10-12T00:00Z+270m","rest:2026-10-12T04:30Z+45m:Пауза 45 мин","drive:2026-10-12T05:15Z+270m"],"dutyRests":[],"reducedRestsLeft":3,"weeklyDrivenH":9}
S-02 {"confirmed":true,"coverage":true,"violations":[],"arrival":"2026-10-13T00:30Z","events":["drive:2026-10-12T00:00Z+270m","rest:2026-10-12T04:30Z+45m:Пауза 45 мин","drive:2026-10-12T05:15Z+270m","rest:2026-10-12T09:45Z+45m:Пауза 45 мин","rest:2026-10-12T10:30Z+660m:Редовна дневна почивка 11 ч","drive:2026-10-12T21:30Z+180m"],"dutyRests":[{"start":"2026-10-12T00:00Z","restStart":"2026-10-12T09:45Z","kind":"regular","inWindowH":11.75}],"reducedRestsLeft":3,"weeklyDrivenH":12}
S-03 {"confirmed":false,"coverage":true,"violations":["DAILY_REST"],"arrival":"2026-10-12T22:00Z","events":["drive:2026-10-12T00:00Z+270m","rest:2026-10-12T04:30Z+45m:Пауза 45 мин","drive:2026-10-12T05:15Z+270m","rest:2026-10-12T09:45Z+45m:Пауза 45 мин","rest:2026-10-12T10:30Z+660m:Редовна дневна почивка 11 ч","drive:2026-10-12T21:30Z+30m"],"dutyRests":[{"start":"2026-10-11T18:00Z","restStart":"2026-10-12T09:45Z","kind":"insufficient","inWindowH":8.25}],"reducedRestsLeft":3,"weeklyDrivenH":9.5}
S-15c {"confirmed":false,"coverage":true,"violations":["DAILY_REST"],"arrival":"2026-10-13T01:15Z","events":["drive:2026-10-12T00:00Z+150m","rest:2026-10-12T02:30Z+45m:Пауза 45 мин","drive:2026-10-12T03:15Z+270m","rest:2026-10-12T07:45Z+45m:Пауза 45 мин","rest:2026-10-12T08:30Z+660m:Редовна дневна почивка 11 ч","drive:2026-10-12T19:30Z+270m","rest:2026-10-13T00:00Z+45m:Пауза 45 мин","drive:2026-10-13T00:45Z+30m"],"dutyRests":[{"start":"2026-10-11T14:00Z","restStart":"2026-10-12T07:45Z","kind":"insufficient","inWindowH":6.25}],"reducedRestsLeft":3,"weeklyDrivenH":12}
S-15d {"confirmed":true,"coverage":true,"violations":[],"arrival":"2026-10-13T01:15Z","events":["drive:2026-10-12T00:00Z+150m","rest:2026-10-12T02:30Z+45m:Пауза 45 мин","drive:2026-10-12T03:15Z+270m","rest:2026-10-12T07:45Z+45m:Пауза 45 мин","rest:2026-10-12T08:30Z+660m:Редовна дневна почивка 11 ч","drive:2026-10-12T19:30Z+270m","rest:2026-10-13T00:00Z+45m:Пауза 45 мин","drive:2026-10-13T00:45Z+30m"],"dutyRests":[{"start":"2026-10-11T14:00Z","restStart":"2026-10-12T07:45Z","kind":"regular","inWindowH":11.75}],"reducedRestsLeft":3,"weeklyDrivenH":12}
S-15e {"confirmed":false,"coverage":true,"violations":["DAILY_REST"],"arrival":"2026-10-13T00:30Z","events":["drive:2026-10-12T00:00Z+270m","rest:2026-10-12T04:30Z+45m:Пауза 45 мин","drive:2026-10-12T05:15Z+270m","rest:2026-10-12T09:45Z+45m:Пауза 45 мин","rest:2026-10-12T10:30Z+660m:Редовна дневна почивка 11 ч","drive:2026-10-12T21:30Z+180m"],"dutyRests":[{"start":"2026-10-11T16:00Z","restStart":"2026-10-12T09:45Z","kind":"insufficient","inWindowH":6.25}],"reducedRestsLeft":3,"weeklyDrivenH":12}
S-15f {"confirmed":true,"coverage":true,"violations":[],"arrival":"2026-10-13T00:30Z","events":["drive:2026-10-12T00:00Z+270m","rest:2026-10-12T04:30Z+45m:Пауза 45 мин","drive:2026-10-12T05:15Z+270m","rest:2026-10-12T09:45Z+45m:Пауза 45 мин","rest:2026-10-12T10:30Z+660m:Редовна дневна почивка 11 ч","drive:2026-10-12T21:30Z+180m"],"dutyRests":[{"start":"2026-10-11T16:00Z","restStart":"2026-10-12T09:45Z","kind":"regular","inWindowH":11.75}],"reducedRestsLeft":3,"weeklyDrivenH":12}
S-16c {"confirmed":true,"coverage":true,"violations":[],"arrival":"2026-10-12T09:45Z","events":["drive:2026-10-12T00:00Z+270m","rest:2026-10-12T04:30Z+45m:Пауза 45 мин","drive:2026-10-12T05:15Z+270m"],"dutyRests":[],"reducedRestsLeft":3,"weeklyDrivenH":9}
S-18 {"confirmed":false,"coverage":false,"violations":[],"arrival":"2026-10-12T10:00Z","events":["drive:2026-10-12T00:00Z+240m","rest:2026-10-12T04:00Z+15m:Пауза 15 мин","drive:2026-10-12T04:15Z+30m","rest:2026-10-12T04:45Z+30m:Пауза 30 мин (15 + 30)","drive:2026-10-12T05:15Z+240m","rest:2026-10-12T09:15Z+15m:Пауза 15 мин","drive:2026-10-12T09:30Z+30m"],"dutyRests":[],"reducedRestsLeft":3,"weeklyDrivenH":9}
S-19 {"confirmed":true,"coverage":true,"violations":[],"arrival":"2026-10-13T00:30Z","events":["drive:2026-10-12T00:00Z+270m","rest:2026-10-12T04:30Z+45m:Пауза 45 мин","drive:2026-10-12T05:15Z+270m","rest:2026-10-12T09:45Z+45m:Пауза 45 мин","rest:2026-10-12T10:30Z+660m:Редовна дневна почивка 11 ч","drive:2026-10-12T21:30Z+180m"],"dutyRests":[{"start":"2026-10-11T20:00Z","restStart":"2026-10-12T09:45Z","kind":"reduced","inWindowH":10.25}],"reducedRestsLeft":2,"weeklyDrivenH":12}
S-20 {"confirmed":false,"coverage":true,"violations":["WEEKLY_DRIVE"],"arrival":"2026-10-17T12:15Z","events":["drive:2026-10-17T02:30Z+270m","rest:2026-10-17T07:00Z+45m:Пауза 45 мин","drive:2026-10-17T07:45Z+270m"],"dutyRests":[{"start":"2026-10-12T00:00Z","restStart":"2026-10-12T09:45Z","kind":"regular","inWindowH":11},{"start":"2026-10-12T20:45Z","restStart":"2026-10-13T06:30Z","kind":"regular","inWindowH":11},{"start":"2026-10-13T17:30Z","restStart":"2026-10-14T03:15Z","kind":"regular","inWindowH":11},{"start":"2026-10-14T14:15Z","restStart":"2026-10-15T00:00Z","kind":"regular","inWindowH":11},{"start":"2026-10-15T11:00Z","restStart":"2026-10-15T20:45Z","kind":"regular","inWindowH":11},{"start":"2026-10-16T07:45Z","restStart":"2026-10-16T15:30Z","kind":"regular","inWindowH":11}],"reducedRestsLeft":3,"weeklyDrivenH":61}
S-04 {"from":"2026-10-12T00:00Z","to":"2026-10-12T17:15Z","opts":[],"violations":[],"firstRestKind":"regular","inWindowH":11}
S-05 {"from":"2026-10-12T00:00Z","to":"2026-10-12T17:16Z","opts":[],"violations":["CONTINUOUS_DRIVE"],"firstRestKind":"regular","inWindowH":11}
S-06 {"from":"2026-10-12T00:00Z","to":"2026-10-12T18:15Z","opts":[],"violations":[],"firstRestKind":"regular","inWindowH":11}
S-07 {"from":"2026-10-12T00:00Z","to":"2026-10-12T18:15Z","opts":[],"violations":["CONTINUOUS_DRIVE"],"firstRestKind":"regular","inWindowH":11}
S-08 {"from":"2026-10-12T00:00Z","to":"2026-10-14T19:30Z","opts":[],"violations":["DAILY_DRIVE_EXT"],"firstRestKind":"regular","inWindowH":11}
S-09a {"from":"2026-10-12T00:00Z","to":"2026-10-14T09:15Z","opts":[],"violations":[],"firstRestKind":"reduced","inWindowH":9}
S-09b {"from":"2026-10-12T00:00Z","to":"2026-10-15T04:00Z","opts":[],"violations":["REDUCED_DAILY_RESTS"],"firstRestKind":"reduced","inWindowH":9}
S-10a {"from":"2026-10-12T00:00Z","to":"2026-10-12T21:45Z","opts":[],"violations":[],"firstRestKind":"split","inWindowH":9}
S-10b {"from":"2026-10-12T00:00Z","to":"2026-10-12T21:45Z","opts":[],"violations":["DAILY_REST"],"firstRestKind":null,"inWindowH":null}
S-11a {"from":"2026-10-12T00:00Z","to":"2026-10-19T22:00Z","opts":[],"violations":[],"firstRestKind":"regular","inWindowH":20}
S-11b {"from":"2026-10-12T00:00Z","to":"2026-10-19T22:01Z","opts":[],"violations":["WEEKLY_REST_LATE"],"firstRestKind":"regular","inWindowH":20}
S-12a {"from":"2026-10-12T00:00Z","to":"2026-10-24T09:00Z","opts":[],"violations":["CONSECUTIVE_REDUCED_WEEKLY"],"firstRestKind":"regular","inWindowH":20}
S-12b {"from":"2026-10-12T00:00Z","to":"2026-10-24T09:00Z","opts":["international"],"violations":[],"firstRestKind":"regular","inWindowH":20}
S-12c {"from":"2026-10-12T00:00Z","to":"2026-10-25T06:00Z","opts":[],"violations":[],"firstRestKind":"regular","inWindowH":20}
S-13a {"from":"2026-10-12T00:00Z","to":"2026-10-12T22:45Z","opts":[],"violations":[],"firstRestKind":"regular","inWindowH":11}
S-13b {"from":"2026-10-12T00:00Z","to":"2026-10-12T22:46Z","opts":[],"violations":["DAILY_DRIVE","DAILY_REST"],"firstRestKind":null,"inWindowH":null}
S-14 {"from":"2026-10-12T00:00Z","to":"2026-10-13T02:30Z","opts":[],"violations":[],"firstRestKind":"reduced","inWindowH":9.5}
S-15a {"from":"2026-10-12T00:00Z","to":"2026-10-13T03:15Z","opts":[],"violations":["DAILY_REST"],"firstRestKind":"insufficient","inWindowH":8.25}
S-15b {"from":"2026-10-12T00:00Z","to":"2026-10-13T03:15Z","opts":["multiManning"],"violations":[],"firstRestKind":"regular","inWindowH":11}
S-16a {"from":"2026-10-12T00:00Z","to":"2026-10-12T21:30Z","opts":[],"violations":[],"firstRestKind":"regular","inWindowH":11}
S-16b {"from":"2026-10-12T00:00Z","to":"2026-10-19T19:30Z","opts":[],"violations":[],"firstRestKind":"regular","inWindowH":11}
S-17a {"from":"2026-10-12T00:00Z","to":"2026-10-17T08:00Z","opts":[],"violations":[],"firstRestKind":"regular","inWindowH":11}
S-17b {"from":"2026-10-12T00:00Z","to":"2026-10-17T08:46Z","opts":[],"violations":["WEEKLY_DRIVE","DAILY_DRIVE_EXT"],"firstRestKind":"regular","inWindowH":11}
```
