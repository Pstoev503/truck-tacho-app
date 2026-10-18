# RULES-02 — независим review на PLAN-04 (PR #27)

Изпълнител: Claude. Приемане: Codex. Task #28, регистър #18. Дата: 19.10.2026 (Europe/Sofia).
Документът е ограничен технически review на един PR. Не е правно становище и не одобрява пълна законност на курс.

## Обект и база

| | Ref | SHA |
|---|---|---|
| Преглеждан head | PR #27 `codex/planner-daily-rest-deadline` | `007a75c77bde6213015567b84ddffe6940b2fa83` |
| База | PLAN-02 `codex/planner-history-coverage` | `bdddd307c4729985ba82a34f2d3d4a0af67a71df` |

И двата SHA са потвърдени през REST API на 18.10.2026 21:09 UTC. Diff `bdddd307..007a75c`: `engine/plan.js` (+45/−21), `engine/plan.test.js` (+110), `docs/reports/2026-10-19-PLAN-04.md`. `tacho-rules.js` не е променен. Прочетен е само за справка; нищо не е редактирано.

## Вердикт

**Approve за ограничения обхват.** В проверените случаи PLAN-04 отстранява R-01, R-03 и R-08 от RULES-01. Не открих нов дефект, който води до нарушение или до неправилно отчитане на удължение или намалена почивка. Има една **ниска** находка (P4-01): консервативен фалшив сигнал, без нормативен риск. Тя не блокира. Описаните наблюдения не са дефекти.

## Реални проверки

- `cd engine && node --test` на чист worktree на `007a75c`: **131/131 pass** (117 baseline + 14 PLAN-04; GEO не е в този PR). Node v22.22.0, Linux.
- Независими сонди извън репото: 16 варианта, V01–V15 и V13b. Пуснати са срещу `007a75c` и, за сравнение, срещу базата `bdddd307`. Входовете са различни от 14-те нови теста: други количества работа, история с почивка и разделена почивка, смяна на избора в двете посоки, последно налично право, бъдещо потегляне, 35-дневна история. Скриптът и буквалните изходи са в раздел „Възпроизвеждане“. Сондите не са тестове в репото и не се отчитат като pass.
- За всяка планирана дневна почивка (≥ 9 ч) сондата сверява етикета на събитието с `kind` от `analyze()` върху история + план.
- Docker, DB, UI и CI не са повторени: няма конкретна причина, а PR-ът не ги засяга.

## Резултати по критериите в #28

| Критерий | Вариант | Резултат на `007a75c` | База `bdddd307` | Оценка |
|---|---|---|---|---|
| Редовни 11 ч след 6 ч работа (R-01) | V01 | почивка 07:00 = точно 13 ч след началото на дежурството; `regular` 11 ч; без нарушения | `DAILY_REST`, `insufficient` 8,25 ч | поправено |
| Етикет „редовна“ след 4 ч работа (R-03) | V02 | 09:00 (13 ч); етикет „Редовна“ → `regular` 11 ч; `reducedRestsLeft` 3 | етикет „Редовна“ → `reduced` 10,25 ч | поправено |
| Излишна пауза преди дневна (R-08) | V03 | 4:30, 45, 4:30, дневна 09:45 | допълнителна пауза 45 мин | поправено |
| Срок точно / преди / след | V10, V13b; тестовете на PLAN-04 за ±1 мин | дневна почивка точно на срока или по-рано, никога след него | — | съвпада |
| 15 + 30 около срока | V10 | 4:00, 15, 0:30, 30, 4:00 → дневна точно на срока 09:15; 15-те мин не изтласкват почивката | — | съвпада |
| 45 мин, свършваща точно на срока | V13b | вместо пауза дневна почивка 45 мин преди срока (`>=`). Нормативно е равностойно, защото пауза + почивка би се сляла в една почивка | — | съвпада |
| Избрани 9 ч само с налично право; последен остатък; изчерпване | V07 | 3-та намалена → `reduced` 9 ч; следващата → редовна с обяснение в `ignoredDailyRests`; `reducedRestsLeft` 0 | — | съвпада |
| Няколко секции, смяна regular → reduced | V06 | секция 2 ползва 9-ч срок; етикет „Намалена“ → `reduced` 9 ч | — | съвпада |
| Няколко секции, смяна reduced → regular | V05 | срокът за 11 ч на секция 2 вече е минал → `DAILY_REST_DEADLINE_MISSED`, етикет „…извън срока“, `confirmed:false`; анализаторът брои почивката като `reduced` 10,75 ч | — | очаквано, описано в PLAN-04 отчета |
| Неизползван extension при ранна дневна | V08 | ден 1 е отрязан от срока на 7 ч 15 мин → не е удължение; ден 2 → 10 ч; `extendedDuties` 1, `extensionsLeft` 1 | — | съвпада |
| Исторически използван extension | V09 | 9 ч 30 мин в историята → план 30 мин до 10 ч, после дневна; удължението е в седмицата на началото на дежурството (неделя) | — | съвпада с правилото на анализатора |
| Край на курса на срока | тест на PLAN-04 | без измислено събитие след пристигането | — | съвпада (не е повторено отделно) |
| Неизвестна история / бъдещ старт | V11 | дежурство от T0−14 ч, неизвестен интервал → незабавна 11 ч почивка при старта, `DAILY_REST_DEADLINE_MISSED`, `DAILY_REST` остава, `confirmed:false` | `DAILY_REST` | консервативно; наследено от PLAN-01 (празнината не е почивка) |
| Вече пропуснат срок не се заличава | V11 | `DAILY_REST` остава във `violations` | — | съвпада |
| `multiManning` | V14 | 30-ч прозорец, изборът `regular` се спазва | — | само наследена предпоставка (RULES-01 R-02); не е регресия |
| Етикет ↔ класификация | всички | 25 планирани дневни почивки в V01–V15 и V13b: 22 са „Редовна“ → `regular` или „Намалена“ → `reduced`, без разминаване; 3 (V04, V05, V11) са изрично „…извън срока“ | V02: „Редовна“ → `reduced` | поправено |
| Производителност | V15 | 35-дневна история, 5000 км в 3 секции: < 0,1 с | — | без забележка |

## Находка

### P4-01 — Ниска — фалшив `DAILY_REST_DEADLINE_MISSED`, когато почивката продължава почивка от историята

- **Място:** `engine/plan.js`, `buildPlan()`, ред 193 (`if (time > restDeadline)`). Сравнява се началото на **планираното** събитие, а не началото на непрекъснатата почивка, част от която е вече в историята.
- **Минимален repro (V04):** пълна история до T0 − 14 ч, `work` T0 − 14 ч…T0 − 2 ч, `rest` T0 − 2 ч…T0, потегляне T0, етап 400 км, опции по подразбиране.
- **Очаквано:** почивката започва в T0 − 2 ч, т.е. 12 ч след началото на дежурството, преди 11-часовия срок в T0 − 1 ч. С добавените 11 ч тя е непрекъсната 13 ч, от които 12 ч в прозореца. Почивката е редовна и навреме, планът няма нарушение.
- **Действително:** `ignoredDailyRests: [DAILY_REST_DEADLINE_MISSED]`, етикет „Дневна почивка 11 ч — избраният вид е извън срока“, `confirmed:false`. Анализаторът върху същия резултат: `regular` 12 ч, без нарушения.
- **Нова ли е:** да, като сигнал. На базата същият вход дава `DAILY_REST`, защото планът кара веднага. Затова PLAN-04 е подобрение и грешката е само в консервативна посока: няма пропуснато нарушение.
- **Ефект:** водачът, който вече почива при потеглянето, вижда „извън срока“ и `confirmed:false` без основание.
- **Минимална препоръка:** за проверката на ред 193 (и по избор за `time >= restDeadline` на ред 176) да се използва ефективното начало на почивката: `analysisAt(time).status.currentRest?.since ?? time`, когато текущата дейност е `rest`. Регресия: V04.
- **Проба на препоръката (само в локално копие извън репото, не е комитната и не е предложена като код):** с тази промяна на ред 193 `node --test` дава 131/131. V04 става `confirmed:true` без сигнал. V05 и V11 запазват `DAILY_REST_DEADLINE_MISSED`. Окончателната реализация и тестът са на Codex.

## Наблюдения (не са дефекти)

- **Разделена почивка (V12):** след 3 ч почивка в историята планът поставя пълна 11 ч почивка по-рано, отколкото позволява 3 + 9. Това е консервативно и съвпада с #17, където 3 + 9 е unsupported. Базата използваше разделената почивка случайно.
- **V05:** `reduced` право се изразходва от почивка, обозначена „…извън срока“. Сигналът и `confirmed:false` са налице и PLAN-04 отчетът го описва. Ако продуктът иска друго поведение, това е решение по избора, не дефект.
- **V11:** планът започва с 11-часова почивка, макар реално водачът да е можел да почива в неизвестния интервал. Това е следствие от правилото на PLAN-01 „неизвестното не е почивка“ и е явно сигнализирано.
- R-02, R-04, R-05 и R-06 от RULES-01 не са променени от PR-а (V14, V15 показват седмичните нарушения като преди). Не се отчитат като регресии.

## Граници на проверката

- Проверени са само детерминираните случаи по-горе и 14-те теста на PR-а. Липсата на други находки не доказва липса на дефекти извън тях.
- Не са проверени: изборите за `dailyRest` в комбинация с почивка на ферибот, седмична почивка в средата на курса, история с ръчни застъпващи се записи.
- Официалните текстове не са препрочетени от тази среда (EUR-Lex е блокиран). Позоваването е на прочита на Codex в PLAN-04 отчета и на RULES-01.

## Възпроизвеждане

Скриптът е документиран тук; не е source или test файл в репото. Пуска се срещу checkout:

```
git worktree add /tmp/p4 007a75c77bde6213015567b84ddffe6940b2fa83
node rules02-probe.mjs /tmp/p4
```

Полето `ms` (време за изпълнение) е премахнато от изходите по-долу, защото не е детерминирано.

```js
// RULES-02: независими сонди за PLAN-04. Употреба: node rules02-probe.mjs <checkout на 007a75c>
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const root = resolve(process.argv[2] || '.');
const { analyze } = await import(pathToFileURL(resolve(root, 'engine/tacho-rules.js')).href);
const { buildPlan } = await import(pathToFileURL(resolve(root, 'engine/plan.js')).href);
const MIN = 60_000, H = 60 * MIN, D = 24 * H;
const T0 = Date.parse('2026-10-12T00:00:00Z'); // понеделник 00:00 UTC
const iso = t => new Date(t).toISOString().slice(5, 16).replace('T', ' ');
const seq = (start, parts) => { let t = start; return parts.map(([type, m]) => { const a = { type, start: t, end: t + m * MIN }; t += m * MIN; return a; }); };
const full = until => [{ type: 'rest', start: T0 - 8 * D, end: until }];
function run(id, { activities, stages, departure = T0, now = T0, ...rest }) {
  const t0 = performance.now();
  const p = buildPlan({ stages, departure, now, activities, ...rest });
  const ms = performance.now() - t0;
  const r = analyze([...activities, ...p.activities], { now: p.arrival, gapsAsRest: false, multiManning: !!rest.multiManning,
    ...(rest.lastWeeklyRestEnd != null ? { lastWeeklyRestEnd: rest.lastWeeklyRestEnd } : {}) });
  const daily = p.events.filter(e => e.type === 'rest' && e.end - e.start >= 9 * H).map(e => {
    const d = r.duties.find(x => x.rest && x.rest.s <= e.start && x.rest.e >= e.end);
    return `${iso(e.start)} «${e.label}» → ${d ? d.rest.kind + ' ' + d.rest.inWindow / H + 'h' : 'ongoing/none'}`;
  });
  console.log(id, JSON.stringify({ confirmed: p.confirmed, violations: p.violations.map(v => v.code),
    ignoredDailyRests: p.ignoredDailyRests.map(x => x.code ?? 'fallback'), ignoredExtensions: p.ignoredExtensions.length,
    extendedDuties: p.extendedDuties.map(iso), stagesExt: p.stages.map(s => s.extensionUsed), arrival: iso(p.arrival),
    events: p.events.map(e => `${e.type}@${iso(e.start)}+${(e.end - e.start) / MIN}`), daily,
    extensionsLeft: p.status.daily.extensionsLeft, reducedRestsLeft: p.status.daily.reducedRestsLeft, ms: Math.round(ms) }));
}
const mw = km => ({ distanceKm: km, roadType: 'motorway' });
// V01 = RULES-01 S-03 (R-01): 6 ч работа преди старт, 760 км
run('V01', { activities: [...full(T0 - 6 * H), { type: 'work', start: T0 - 6 * H, end: T0 }], stages: [mw(760)] });
// V02 = RULES-01 S-19 (R-03): 4 ч работа, 960 км, regular
run('V02', { activities: [...full(T0 - 4 * H), { type: 'work', start: T0 - 4 * H, end: T0 }], stages: [mw(960)] });
// V03 = RULES-01 S-02 (R-08): 12 ч каране, без работа
run('V03', { activities: full(T0), stages: [mw(960)] });
// V04: почивка в историята, непосредствено преди старта (сливане): дежурство от T0-14ч, работа до T0-2ч, почивка 2ч до T0
run('V04', { activities: [...full(T0 - 14 * H), { type: 'work', start: T0 - 14 * H, end: T0 - 2 * H }, { type: 'rest', start: T0 - 2 * H, end: T0 }], stages: [mw(400)] });
// V05: смяна на избора: секция 1 reduced (кара до 9-ч срок), секция 2 regular
run('V05', { activities: [...full(T0 - 4 * H), { type: 'work', start: T0 - 4 * H, end: T0 }], stages: [{ ...mw(680), dailyRest: 'reduced' }, mw(400)] });
// V06: обратната смяна: секция 1 regular, секция 2 reduced
run('V06', { activities: [...full(T0 - 4 * H), { type: 'work', start: T0 - 4 * H, end: T0 }], stages: [mw(560), { ...mw(400), dailyRest: 'reduced' }] });
// V07: последно налично право за намалена (2 използвани в историята), дълъг reduced етап с 3 дежурства
{ const d = [['drive', 270], ['rest', 45], ['drive', 270], ['rest', 540]];
  const h = [{ type: 'rest', start: T0 - 8 * D, end: T0 }, ...seq(T0, [...d, ...d])]; const dep = h.at(-1).end;
  run('V07', { activities: h, stages: [{ ...mw(2000), dailyRest: 'reduced' }], departure: dep, now: dep, lastWeeklyRestEnd: T0 }); }
// V08: useExtension при 5 ч предишна работа — срокът реже под 9 ч; удължението не трябва да се изразходва
run('V08', { activities: [...full(T0 - 5 * H), { type: 'work', start: T0 - 5 * H, end: T0 }], stages: [{ ...mw(1600), useExtension: true }] });
// V09: исторически използвано удължение в текущото дежурство (9 ч 30 мин каране), после план
{ const h = [...full(T0 - 11 * H), ...seq(T0 - 11 * H, [['drive', 270], ['rest', 45], ['drive', 270], ['rest', 45], ['drive', 30]])];
  run('V09', { activities: h, stages: [mw(200)], departure: h.at(-1).end, now: h.at(-1).end }); }
// V10: 15+30 с 30-мин пауза точно на срока: 3 ч 45 мин работа, след това 4:00 + 15 + 0:30 → 30-мин пауза би свършила след срока
run('V10', { activities: [...full(T0 - 225 * MIN), { type: 'work', start: T0 - 225 * MIN, end: T0 }], stages: [mw(960)], breakStyle: '15+30' });
// V11: бъдещо потегляне след неизвестен интервал: последен запис каране, свършил T0-10ч; now=T0, старт T0+5ч
run('V11', { activities: [...full(T0 - 14 * H), { type: 'drive', start: T0 - 14 * H, end: T0 - 10 * H }], stages: [mw(400)], departure: T0 + 5 * H });
// V12: разделена почивка 3 ч в историята (3 + 9 позволява по-късна 9-ч втора част)
run('V12', { activities: [...full(T0 - 8 * H), ...seq(T0 - 8 * H, [['drive', 240], ['rest', 180], ['work', 60]])], stages: [mw(960)] });
// V13: 45-мин пауза, която свършва точно на срока (>= в условието)
run('V13', { activities: [...full(T0 - 195 * MIN), { type: 'work', start: T0 - 195 * MIN, end: T0 }], stages: [mw(960)] });
// V13b: 45-мин пауза би свършила точно на 11-ч срок (7 ч 45 мин работа преди старт; срок T0+5:15)
run('V13b', { activities: [...full(T0 - 465 * MIN), { type: 'work', start: T0 - 465 * MIN, end: T0 }], stages: [mw(960)] });
// V14: двойка (наследена предпоставка), 8 ч работа, 960 км
run('V14', { activities: [...full(T0 - 8 * H), { type: 'work', start: T0 - 8 * H, end: T0 }], stages: [mw(960)], multiManning: true });
// V15: производителност — 35-дневна история с ежедневни дежурства и 5000 км курс (смесени избори)
{ const h = [{ type: 'rest', start: T0 - 40 * D, end: T0 - 35 * D }]; let t = T0 - 35 * D;
  while (t < T0 - D) { for (const [ty, m] of [['drive', 270], ['rest', 45], ['drive', 180], ['rest', 765]]) { h.push({ type: ty, start: t, end: t + m * MIN }); t += m * MIN; } }
  h.push({ type: 'rest', start: t, end: T0 });
  run('V15', { activities: h, stages: [mw(1500), { ...mw(1500), dailyRest: 'reduced', useExtension: true }, { distanceKm: 2000, roadType: 'ordinary' }] }); }
```

Изход на `007a75c` (18.10.2026, Node v22.22.0), без други редакции:

```
V01 {"confirmed":true,"violations":[],"ignoredDailyRests":[],"ignoredExtensions":0,"extendedDuties":[],"stagesExt":[false],"arrival":"10-12 21:15","events":["drive@10-12 00:00+270","rest@10-12 04:30+45","drive@10-12 05:15+105","rest@10-12 07:00+660","drive@10-12 18:00+195"],"daily":["10-12 07:00 «Редовна дневна почивка 11 ч» → regular 11h"],"extensionsLeft":2,"reducedRestsLeft":3}
V02 {"confirmed":true,"violations":[],"ignoredDailyRests":[],"ignoredExtensions":0,"extendedDuties":[],"stagesExt":[false],"arrival":"10-12 23:45","events":["drive@10-12 00:00+270","rest@10-12 04:30+45","drive@10-12 05:15+225","rest@10-12 09:00+660","drive@10-12 20:00+225"],"daily":["10-12 09:00 «Редовна дневна почивка 11 ч» → regular 11h"],"extensionsLeft":2,"reducedRestsLeft":3}
V03 {"confirmed":true,"violations":[],"ignoredDailyRests":[],"ignoredExtensions":0,"extendedDuties":[],"stagesExt":[false],"arrival":"10-12 23:45","events":["drive@10-12 00:00+270","rest@10-12 04:30+45","drive@10-12 05:15+270","rest@10-12 09:45+660","drive@10-12 20:45+180"],"daily":["10-12 09:45 «Редовна дневна почивка 11 ч» → regular 11h"],"extensionsLeft":2,"reducedRestsLeft":3}
V04 {"confirmed":false,"violations":[],"ignoredDailyRests":["DAILY_REST_DEADLINE_MISSED"],"ignoredExtensions":0,"extendedDuties":[],"stagesExt":[false],"arrival":"10-12 16:45","events":["rest@10-12 00:00+660","drive@10-12 11:00+270","rest@10-12 15:30+45","drive@10-12 16:15+30"],"daily":["10-12 00:00 «Дневна почивка 11 ч — избраният вид е извън срока» → regular 12h"],"extensionsLeft":2,"reducedRestsLeft":3}
V05 {"confirmed":false,"violations":[],"ignoredDailyRests":["DAILY_REST_DEADLINE_MISSED"],"ignoredExtensions":0,"extendedDuties":[],"stagesExt":[false,false],"arrival":"10-13 02:00","events":["drive@10-12 00:00+270","rest@10-12 04:30+45","drive@10-12 05:15+240","rest@10-12 09:15+660","drive@10-12 20:15+270","rest@10-13 00:45+45","drive@10-13 01:30+30"],"daily":["10-12 09:15 «Дневна почивка 11 ч — избраният вид е извън срока» → reduced 10.75h"],"extensionsLeft":2,"reducedRestsLeft":2}
V06 {"confirmed":true,"violations":[],"ignoredDailyRests":[],"ignoredExtensions":0,"extendedDuties":[],"stagesExt":[false,false],"arrival":"10-12 21:45","events":["drive@10-12 00:00+270","rest@10-12 04:30+45","drive@10-12 05:15+150","drive@10-12 07:45+120","rest@10-12 09:45+540","drive@10-12 18:45+180"],"daily":["10-12 09:45 «Намалена дневна почивка 9 ч» → reduced 9h"],"extensionsLeft":2,"reducedRestsLeft":2}
V07 {"confirmed":true,"violations":[],"ignoredDailyRests":["fallback"],"ignoredExtensions":0,"extendedDuties":[],"stagesExt":[false],"arrival":"10-15 12:45","events":["drive@10-13 13:30+270","rest@10-13 18:00+45","drive@10-13 18:45+270","rest@10-13 23:15+540","drive@10-14 08:15+270","rest@10-14 12:45+45","drive@10-14 13:30+270","rest@10-14 18:00+660","drive@10-15 05:00+270","rest@10-15 09:30+45","drive@10-15 10:15+150"],"daily":["10-13 23:15 «Намалена дневна почивка 9 ч» → reduced 9h","10-14 18:00 «Редовна дневна почивка 11 ч» → regular 11h"],"extensionsLeft":2,"reducedRestsLeft":0}
V08 {"confirmed":true,"violations":[],"ignoredDailyRests":[],"ignoredExtensions":0,"extendedDuties":["10-12 19:00"],"stagesExt":[true],"arrival":"10-13 20:15","events":["drive@10-12 00:00+270","rest@10-12 04:30+45","drive@10-12 05:15+165","rest@10-12 08:00+660","drive@10-12 19:00+270","rest@10-12 23:30+45","drive@10-13 00:15+270","rest@10-13 04:45+45","drive@10-13 05:30+60","rest@10-13 06:30+660","drive@10-13 17:30+165"],"daily":["10-12 08:00 «Редовна дневна почивка 11 ч» → regular 11h","10-13 06:30 «Редовна дневна почивка 11 ч» → regular 11h"],"extensionsLeft":1,"reducedRestsLeft":3}
V09 {"confirmed":true,"violations":[],"ignoredDailyRests":[],"ignoredExtensions":0,"extendedDuties":["10-11 13:00"],"stagesExt":[false],"arrival":"10-12 13:30","events":["drive@10-12 00:00+30","rest@10-12 00:30+660","drive@10-12 11:30+120"],"daily":["10-12 00:30 «Редовна дневна почивка 11 ч» → regular 11h"],"extensionsLeft":2,"reducedRestsLeft":3}
V10 {"confirmed":true,"violations":[],"ignoredDailyRests":[],"ignoredExtensions":0,"extendedDuties":[],"stagesExt":[false],"arrival":"10-12 23:45","events":["drive@10-12 00:00+240","rest@10-12 04:00+15","drive@10-12 04:15+30","rest@10-12 04:45+30","drive@10-12 05:15+240","rest@10-12 09:15+660","drive@10-12 20:15+210"],"daily":["10-12 09:15 «Редовна дневна почивка 11 ч» → regular 11h"],"extensionsLeft":2,"reducedRestsLeft":3}
V11 {"confirmed":false,"violations":["DAILY_REST"],"ignoredDailyRests":["DAILY_REST_DEADLINE_MISSED"],"ignoredExtensions":0,"extendedDuties":[],"stagesExt":[false],"arrival":"10-12 21:45","events":["rest@10-12 05:00+660","drive@10-12 16:00+270","rest@10-12 20:30+45","drive@10-12 21:15+30"],"daily":["10-12 05:00 «Дневна почивка 11 ч — избраният вид е извън срока» → insufficient 5h"],"extensionsLeft":2,"reducedRestsLeft":3}
V12 {"confirmed":true,"violations":[],"ignoredDailyRests":[],"ignoredExtensions":0,"extendedDuties":[],"stagesExt":[false],"arrival":"10-12 23:45","events":["drive@10-12 00:00+270","rest@10-12 04:30+660","drive@10-12 15:30+270","rest@10-12 20:00+45","drive@10-12 20:45+180"],"daily":["10-12 04:30 «Редовна дневна почивка 11 ч» → regular 11h"],"extensionsLeft":2,"reducedRestsLeft":3}
V13 {"confirmed":true,"violations":[],"ignoredDailyRests":[],"ignoredExtensions":0,"extendedDuties":[],"stagesExt":[false],"arrival":"10-12 23:45","events":["drive@10-12 00:00+270","rest@10-12 04:30+45","drive@10-12 05:15+270","rest@10-12 09:45+660","drive@10-12 20:45+180"],"daily":["10-12 09:45 «Редовна дневна почивка 11 ч» → regular 11h"],"extensionsLeft":2,"reducedRestsLeft":3}
V13b {"confirmed":true,"violations":[],"ignoredDailyRests":[],"ignoredExtensions":0,"extendedDuties":[],"stagesExt":[false],"arrival":"10-12 23:45","events":["drive@10-12 00:00+270","rest@10-12 04:30+660","drive@10-12 15:30+270","rest@10-12 20:00+45","drive@10-12 20:45+180"],"daily":["10-12 04:30 «Редовна дневна почивка 11 ч» → regular 11h"],"extensionsLeft":2,"reducedRestsLeft":3}
V14 {"confirmed":true,"violations":[],"ignoredDailyRests":[],"ignoredExtensions":0,"extendedDuties":[],"stagesExt":[false],"arrival":"10-12 23:45","events":["drive@10-12 00:00+270","rest@10-12 04:30+45","drive@10-12 05:15+270","rest@10-12 09:45+660","drive@10-12 20:45+180"],"daily":["10-12 09:45 «Редовна дневна почивка 11 ч» → regular 11h"],"extensionsLeft":2,"reducedRestsLeft":3}
V15 {"confirmed":false,"violations":["WEEKLY_DRIVE","WEEKLY_REST_LATE","WEEKLY_DRIVE","FORTNIGHT_DRIVE","WEEKLY_DRIVE","FORTNIGHT_DRIVE","WEEKLY_DRIVE","FORTNIGHT_DRIVE","FORTNIGHT_DRIVE","WEEKLY_DRIVE","FORTNIGHT_DRIVE","WEEKLY_REST_LATE"],"ignoredDailyRests":["fallback"],"ignoredExtensions":0,"extendedDuties":["10-13 17:30"],"stagesExt":[false,true,false],"arrival":"10-18 22:36","events":["drive@10-12 00:00+270","rest@10-12 04:30+45","drive@10-12 05:15+270","rest@10-12 09:45+660","drive@10-12 20:45+270","rest@10-13 01:15+45","drive@10-13 02:00+270","rest@10-13 06:30+660","drive@10-13 17:30+45","drive@10-13 18:15+225","rest@10-13 22:00+45","drive@10-13 22:45+270","rest@10-14 03:15+45","drive@10-14 04:00+60","rest@10-14 05:00+540","drive@10-14 14:00+270","rest@10-14 18:30+45","drive@10-14 19:15+270","rest@10-14 23:45+660","drive@10-15 10:45+30","drive@10-15 11:15+240","rest@10-15 15:15+45","drive@10-15 16:00+270","rest@10-15 20:30+660","drive@10-16 07:30+270","rest@10-16 12:00+45","drive@10-16 12:45+270","rest@10-16 17:15+660","drive@10-17 04:15+270","rest@10-17 08:45+45","drive@10-17 09:30+270","rest@10-17 14:00+660","drive@10-18 01:00+270","rest@10-18 05:30+45","drive@10-18 06:15+270","rest@10-18 10:45+660","drive@10-18 21:45+51.81818181966146"],"daily":["10-12 09:45 «Редовна дневна почивка 11 ч» → regular 11h","10-13 06:30 «Редовна дневна почивка 11 ч» → regular 11h","10-14 05:00 «Намалена дневна почивка 9 ч» → reduced 9h","10-14 23:45 «Редовна дневна почивка 11 ч» → regular 11h","10-15 20:30 «Редовна дневна почивка 11 ч» → regular 11h","10-16 17:15 «Редовна дневна почивка 11 ч» → regular 11h","10-17 14:00 «Редовна дневна почивка 11 ч» → regular 11h","10-18 10:45 «Редовна дневна почивка 11 ч» → regular 11h"],"extensionsLeft":1,"reducedRestsLeft":2}
```

Изход на базата `bdddd307` за сравнение:

```
V01 {"confirmed":false,"violations":["DAILY_REST"],"ignoredDailyRests":[],"ignoredExtensions":0,"extendedDuties":[],"stagesExt":[false],"arrival":"10-12 22:00","events":["drive@10-12 00:00+270","rest@10-12 04:30+45","drive@10-12 05:15+270","rest@10-12 09:45+45","rest@10-12 10:30+660","drive@10-12 21:30+30"],"daily":["10-12 10:30 «Редовна дневна почивка 11 ч» → insufficient 8.25h"],"extensionsLeft":2,"reducedRestsLeft":3}
V02 {"confirmed":true,"violations":[],"ignoredDailyRests":[],"ignoredExtensions":0,"extendedDuties":[],"stagesExt":[false],"arrival":"10-13 00:30","events":["drive@10-12 00:00+270","rest@10-12 04:30+45","drive@10-12 05:15+270","rest@10-12 09:45+45","rest@10-12 10:30+660","drive@10-12 21:30+180"],"daily":["10-12 10:30 «Редовна дневна почивка 11 ч» → reduced 10.25h"],"extensionsLeft":2,"reducedRestsLeft":2}
V03 {"confirmed":true,"violations":[],"ignoredDailyRests":[],"ignoredExtensions":0,"extendedDuties":[],"stagesExt":[false],"arrival":"10-13 00:30","events":["drive@10-12 00:00+270","rest@10-12 04:30+45","drive@10-12 05:15+270","rest@10-12 09:45+45","rest@10-12 10:30+660","drive@10-12 21:30+180"],"daily":["10-12 10:30 «Редовна дневна почивка 11 ч» → regular 11.75h"],"extensionsLeft":2,"reducedRestsLeft":3}
V04 {"confirmed":false,"violations":["DAILY_REST"],"ignoredDailyRests":[],"ignoredExtensions":0,"extendedDuties":[],"stagesExt":[false],"arrival":"10-12 05:45","events":["drive@10-12 00:00+270","rest@10-12 04:30+45","drive@10-12 05:15+30"],"daily":[],"extensionsLeft":2,"reducedRestsLeft":3}
V05 {"confirmed":true,"violations":[],"ignoredDailyRests":[],"ignoredExtensions":0,"extendedDuties":[],"stagesExt":[false,false],"arrival":"10-13 02:00","events":["drive@10-12 00:00+270","rest@10-12 04:30+45","drive@10-12 05:15+240","drive@10-12 09:15+30","rest@10-12 09:45+45","rest@10-12 10:30+660","drive@10-12 21:30+270"],"daily":["10-12 10:30 «Редовна дневна почивка 11 ч» → reduced 10.25h"],"extensionsLeft":2,"reducedRestsLeft":2}
V06 {"confirmed":true,"violations":[],"ignoredDailyRests":[],"ignoredExtensions":0,"extendedDuties":[],"stagesExt":[false,false],"arrival":"10-12 22:30","events":["drive@10-12 00:00+270","rest@10-12 04:30+45","drive@10-12 05:15+150","drive@10-12 07:45+120","rest@10-12 09:45+45","rest@10-12 10:30+540","drive@10-12 19:30+180"],"daily":["10-12 10:30 «Намалена дневна почивка 9 ч» → reduced 9.75h"],"extensionsLeft":2,"reducedRestsLeft":2}
V07 {"confirmed":true,"violations":[],"ignoredDailyRests":["fallback"],"ignoredExtensions":0,"extendedDuties":[],"stagesExt":[false],"arrival":"10-15 14:15","events":["drive@10-13 13:30+270","rest@10-13 18:00+45","drive@10-13 18:45+270","rest@10-13 23:15+45","rest@10-14 00:00+540","drive@10-14 09:00+270","rest@10-14 13:30+45","drive@10-14 14:15+270","rest@10-14 18:45+45","rest@10-14 19:30+660","drive@10-15 06:30+270","rest@10-15 11:00+45","drive@10-15 11:45+150"],"daily":["10-14 00:00 «Намалена дневна почивка 9 ч» → reduced 9.75h","10-14 19:30 «Редовна дневна почивка 11 ч» → regular 11.75h"],"extensionsLeft":2,"reducedRestsLeft":0}
V08 {"confirmed":false,"violations":["DAILY_REST"],"ignoredDailyRests":[],"ignoredExtensions":0,"extendedDuties":["10-11 19:00"],"stagesExt":[true],"arrival":"10-13 21:00","events":["drive@10-12 00:00+270","rest@10-12 04:30+45","drive@10-12 05:15+270","rest@10-12 09:45+45","drive@10-12 10:30+60","rest@10-12 11:30+660","drive@10-12 22:30+270","rest@10-13 03:00+45","drive@10-13 03:45+270","rest@10-13 08:15+45","rest@10-13 09:00+660","drive@10-13 20:00+60"],"daily":["10-12 11:30 «Редовна дневна почивка 11 ч» → insufficient 7.5h","10-13 09:00 «Редовна дневна почивка 11 ч» → regular 11.75h"],"extensionsLeft":2,"reducedRestsLeft":3}
V09 {"confirmed":true,"violations":[],"ignoredDailyRests":[],"ignoredExtensions":0,"extendedDuties":["10-11 13:00"],"stagesExt":[false],"arrival":"10-12 13:30","events":["drive@10-12 00:00+30","rest@10-12 00:30+660","drive@10-12 11:30+120"],"daily":["10-12 00:30 «Редовна дневна почивка 11 ч» → regular 11h"],"extensionsLeft":2,"reducedRestsLeft":3}
V10 {"confirmed":true,"violations":[],"ignoredDailyRests":[],"ignoredExtensions":0,"extendedDuties":[],"stagesExt":[false],"arrival":"10-13 00:30","events":["drive@10-12 00:00+240","rest@10-12 04:00+15","drive@10-12 04:15+30","rest@10-12 04:45+30","drive@10-12 05:15+240","rest@10-12 09:15+15","drive@10-12 09:30+30","rest@10-12 10:00+30","rest@10-12 10:30+660","drive@10-12 21:30+180"],"daily":["10-12 10:30 «Редовна дневна почивка 11 ч» → reduced 10.25h"],"extensionsLeft":2,"reducedRestsLeft":2}
V11 {"confirmed":false,"violations":["DAILY_REST"],"ignoredDailyRests":[],"ignoredExtensions":0,"extendedDuties":[],"stagesExt":[false],"arrival":"10-12 10:45","events":["drive@10-12 05:00+30","rest@10-12 05:30+45","drive@10-12 06:15+270"],"daily":[],"extensionsLeft":2,"reducedRestsLeft":3}
V12 {"confirmed":true,"violations":[],"ignoredDailyRests":[],"ignoredExtensions":0,"extendedDuties":[],"stagesExt":[false],"arrival":"10-13 00:30","events":["drive@10-12 00:00+270","rest@10-12 04:30+45","drive@10-12 05:15+30","rest@10-12 05:45+660","drive@10-12 16:45+270","rest@10-12 21:15+45","drive@10-12 22:00+150"],"daily":["10-12 05:45 «Редовна дневна почивка 11 ч» → split 10.25h"],"extensionsLeft":2,"reducedRestsLeft":3}
V13 {"confirmed":true,"violations":[],"ignoredDailyRests":[],"ignoredExtensions":0,"extendedDuties":[],"stagesExt":[false],"arrival":"10-13 00:30","events":["drive@10-12 00:00+270","rest@10-12 04:30+45","drive@10-12 05:15+270","rest@10-12 09:45+45","rest@10-12 10:30+660","drive@10-12 21:30+180"],"daily":["10-12 10:30 «Редовна дневна почивка 11 ч» → regular 11h"],"extensionsLeft":2,"reducedRestsLeft":3}
V13b {"confirmed":false,"violations":["DAILY_REST"],"ignoredDailyRests":[],"ignoredExtensions":0,"extendedDuties":[],"stagesExt":[false],"arrival":"10-13 00:30","events":["drive@10-12 00:00+270","rest@10-12 04:30+45","drive@10-12 05:15+270","rest@10-12 09:45+45","rest@10-12 10:30+660","drive@10-12 21:30+180"],"daily":["10-12 10:30 «Редовна дневна почивка 11 ч» → insufficient 6.5h"],"extensionsLeft":2,"reducedRestsLeft":3}
V14 {"confirmed":true,"violations":[],"ignoredDailyRests":[],"ignoredExtensions":0,"extendedDuties":[],"stagesExt":[false],"arrival":"10-13 00:30","events":["drive@10-12 00:00+270","rest@10-12 04:30+45","drive@10-12 05:15+270","rest@10-12 09:45+45","rest@10-12 10:30+660","drive@10-12 21:30+180"],"daily":["10-12 10:30 «Редовна дневна почивка 11 ч» → regular 11.75h"],"extensionsLeft":2,"reducedRestsLeft":3}
V15 {"confirmed":false,"violations":["WEEKLY_DRIVE","WEEKLY_REST_LATE","WEEKLY_DRIVE","FORTNIGHT_DRIVE","WEEKLY_DRIVE","FORTNIGHT_DRIVE","WEEKLY_DRIVE","FORTNIGHT_DRIVE","FORTNIGHT_DRIVE","WEEKLY_DRIVE","FORTNIGHT_DRIVE","WEEKLY_REST_LATE"],"ignoredDailyRests":["fallback"],"ignoredExtensions":0,"extendedDuties":["10-13 19:00"],"stagesExt":[false,true,false],"arrival":"10-19 03:51","events":["drive@10-12 00:00+270","rest@10-12 04:30+45","drive@10-12 05:15+270","rest@10-12 09:45+45","rest@10-12 10:30+660","drive@10-12 21:30+270","rest@10-13 02:00+45","drive@10-13 02:45+270","rest@10-13 07:15+45","rest@10-13 08:00+660","drive@10-13 19:00+45","drive@10-13 19:45+225","rest@10-13 23:30+45","drive@10-14 00:15+270","rest@10-14 04:45+45","drive@10-14 05:30+60","rest@10-14 06:30+540","drive@10-14 15:30+270","rest@10-14 20:00+45","drive@10-14 20:45+270","rest@10-15 01:15+45","rest@10-15 02:00+660","drive@10-15 13:00+30","drive@10-15 13:30+240","rest@10-15 17:30+45","drive@10-15 18:15+270","rest@10-15 22:45+45","rest@10-15 23:30+660","drive@10-16 10:30+270","rest@10-16 15:00+45","drive@10-16 15:45+270","rest@10-16 20:15+45","rest@10-16 21:00+660","drive@10-17 08:00+270","rest@10-17 12:30+45","drive@10-17 13:15+270","rest@10-17 17:45+45","rest@10-17 18:30+660","drive@10-18 05:30+270","rest@10-18 10:00+45","drive@10-18 10:45+270","rest@10-18 15:15+45","rest@10-18 16:00+660","drive@10-19 03:00+51.81818181966146"],"daily":["10-12 10:30 «Редовна дневна почивка 11 ч» → regular 11.75h","10-13 08:00 «Редовна дневна почивка 11 ч» → regular 11.75h","10-14 06:30 «Намалена дневна почивка 9 ч» → reduced 9h","10-15 02:00 «Редовна дневна почивка 11 ч» → regular 11.75h","10-15 23:30 «Редовна дневна почивка 11 ч» → regular 11.75h","10-16 21:00 «Редовна дневна почивка 11 ч» → regular 11.75h","10-17 18:30 «Редовна дневна почивка 11 ч» → regular 11.75h","10-18 16:00 «Редовна дневна почивка 11 ч» → regular 11.75h"],"extensionsLeft":2,"reducedRestsLeft":2}
```
