# TI-01 — Traffic Intelligence Interface Contract v0.1

**Дата:** 2026-10-17 · **Статус:** предложение за преглед, не внедрен API · **Собственик на интеграцията:** отговорникът на Top10EU.

## 1. Граници и терминология

Traffic Intelligence (TI) приема нормализирани пътни сегменти и контекст на планираното пътуване и връща *данни/оценки*, не маршрут или правно решение. Съществуващият planner остава собственик на почивките, правилата за управление, промените на маршрута и крайното ETA. Текущата визуализация е **Leaflet**; настоящият договор не избира картографски renderer. Няма твърдение, че `route.js` гарантира truck-safe routing. Occupancy на паркинги е извън TI-01.

**Единици:** продължителност в `seconds` (целочислена, >=0); разстояние в `meters`; скорост в `km/h` (само когато е измерена/изрично предоставена); координати WGS84 GeoJSON `[longitude,latitude]`; времена ISO 8601 UTC с `Z`. `null` значи неизвестно/неприложимо според `kind` и `status`, никога 0. Идентификаторите са непрозрачни UTF-8 низове; не се извежда значение от тях.

## 2. Предложен endpoint и заявка

`POST /traffic/v0.1/evaluate-route` (логически договор, **не съществуващ endpoint**). Заявката съдържа:

| Поле | Изискване |
|---|---|
| `contractVersion` | точно `0.1` |
| `requestId` | уникален за всеки опит | 
| `evaluationCycle` | нов непрозрачен ID за всеки входен цикъл, дори при същата routeRevision | 
| `inputRevision` | ID на конкретния вход (времена, почивки, история) в цикъла | 
| `attempt` | цяло число 1..3 в рамките на evaluationCycle |
| `routeRevision` | непрозрачен, неизменен идентификатор на конкретната версия на маршрута |
| `departureAt` | UTC дата/час на потегляне |
| `vehicleProfileRef` | препратка към профил; не се изпращат лични данни |
| `segments` | подреден масив, `sequence` от 0 нагоре без пропуски; уникален `segmentRef` в рамките на revision |
| `segments[].geometry` | GeoJSON LineString в WGS84; при липса — explicit `null`, тогава не се допуска геометрично предположение |
| `segments[].direction` | `forward`, `reverse` или `unknown` относно подадената геометрия; `unknown` не може да бъде автоматично съпоставено с еднопосочен incident |
| `segments[].baseDurationSeconds` | базово време от routing engine, без добавяне на TI ефекти; може `null` |
| `segments[].expectedEntryAt` | UTC час на очаквано навлизане, **изчислен от planner**, включително предходни участъци и почивки |

TI **не изчислява сам почивките**. При първоначална заявка planner подава очакваните времена за влизане; след връщане на оценки може да ги актуализира и да направи ограничен брой повторни заявки (§6). `departureAt` не замества `expectedEntryAt`.

## 3. Отговор

`requestId`, `routeRevision`, `evaluationCycle`, `inputRevision`, `attempt`, `evaluatedAt` (UTC), `segments[]` в същия ред, `summaryStatus` (`fresh|stale|unavailable|unknown`), `warnings[]`. За всеки сегмент:

- `segmentRef`, `sequence`, `status` (`fresh|stale|unavailable|unknown`), `matching` (`matched|ambiguous|unmatched`) и `matchConfidence` (0..1 или `null`), `expectedEntryAt` (echo).
- `routingBase`: `{candidateRef,kind:"routing_base",durationSeconds,source}`; `source` обозначава routing engine, не доставчик на трафик.
- `measured`, `historical`, `forecast`: независими кандидати за **пълно време за преминаване на сегмента**, всеки `{candidateRef,kind,status,durationSeconds,source,observedAt,publishedAt,receivedAt,validFrom,validTo,generatedAt,horizonSeconds}`. Полета, които не важат, са `null`. При forecast `generatedAt` и `horizonSeconds` са задължителни, ако forecast е наличен; до валидиран модел `forecast.status="unavailable"`.
- `incidents[]`: `{eventRef,eventVersion,lifecycle,effectKind,closure,baseCandidateRef,replacementDurationSeconds,adjustmentSeconds,alreadyIncludedIn,independenceEvidenceRef,source,validFrom,validTo,matchConfidence}`. `closure` е `open|closed|unknown`; `adjustmentSeconds` може да е число само при обоснована, независима оценка и `effectKind="adjustment"`.
- `selected`: `{candidateRef,baseCandidateRef,appliedEventRefs,kind,status,durationSeconds,source,selectionReason}` — кандидатът, избран според правилата в §4; `durationSeconds:null` ако няма надеждна оценка.
- `passability`: `open|closed|unknown`, `vehicleApplicability`: `covered|not_covered|unknown`, `provenance[]`.

Всяко ненулево числово поле за време/скорост/ефект има изрични `kind` и `source` в своя обект. `source` съдържа `{sourceId,recordId,recordVersion,licenseRef}`; при вътрешен routing base `sourceId="routing-engine"`. За извлечени данни provenance записва `transformationId` и входните source refs. Суров брой МПС (`vehicleCount`) може да бъде метаданни със собствен `kind="count"` и период, но **никога** не се конвертира директно в скорост или ETA.

## 4. Семантика на replacement/adjustment (без двойно броене)

**Правило:** `routingBase`, `measured`, `historical` и `forecast` са алтернативни *пълни продължителности* за същия сегмент, а не суми. TI избира **един** допустим кандидат. Предложен ред при съвпадащ сегмент, посока, времеви прозорец и профил: валидно измерване, ако е представително за `expectedEntryAt`; иначе валидирана прогноза; иначе историческа оценка; иначе routing base. Измерване „сега“ не е автоматично представително за далечно бъдещо навлизане. Кандидатът трябва да носи времеви статус и обоснована приложимост.

**Референции:** Всеки пълен кандидат има уникален в отговора `candidateRef` (напр. `measured:s1`); при промяна на стойността ref се сменя. `baseCandidateRef` сочи точно съществуващ `candidateRef` или е `null`. `alreadyIncludedIn` е масив от candidate refs; празен масив НЕ доказва независимост. `independenceEvidenceRef` е проверима препратка или `null`. `effectKind` е `replacement|adjustment|none`.

- `replacement`: `replacementDurationSeconds` е пълната продължителност (цяло число >=0), `adjustmentSeconds=null`, `baseCandidateRef=null`; създава алтернативен кандидат `replacement:<eventRef>:<eventVersion>`, никога добавка.
- `adjustment`: `replacementDurationSeconds=null`, `adjustmentSeconds` е цяло число (вкл. отрицателно), `baseCandidateRef` съвпада с избрания пълен кандидат, `independenceEvidenceRef` е проверим и ненулев; ако ref е в `alreadyIncludedIn` или доказателството липсва, ефектът се блокира.
- `none`: `replacementDurationSeconds=null`, `adjustmentSeconds=null`, `baseCandidateRef=null`.

**Алгоритъм:** (1) филтрирай по route segment, посока, време, профил, lifecycle и freshness; (2) потвърдено `closed` дава `selected.durationSeconds=null`; (3) разгледай routing base, measured, historical, validated forecast и replacement като алтернативни **пълни** времена; избери един приложим кандидат по приоритета и специфичността; (4) приложи adjustment само към точно посочения избран кандидат, с независимо доказателство и без вече включен или корелиран ефект, при резултат >=0; (5) `selected.candidateRef` е избраният ref или `derived:<baseCandidateRef>:<eventRef>`, `selected.baseCandidateRef` е `null` без приложен adjustment, `selected.appliedEventRefs` е списъкът на приложените ефекти; `selected.source` и `provenance[]` съдържат входния кандидат, event refs и evidence. При неясна независимост избраното време не се променя и се връща `possible_double_count`.

**Passability:** `open` изисква изрично положително доказателство за проходимост в `provenance[]` със source, посока, профил и валидност за expectedEntryAt. Празен `incidents[]`, измерено или историческо време не доказват open. Без такова доказателство `passability=unknown`.

**Забрана:** `selected.durationSeconds = routingBase + (measured - routingBase) + incidentDelay`, когато измерването вече включва инцидента. Ако `vehicleApplicability` е `not_covered` или `unknown`, не се твърди truck-safe ETA и не се прилага непроверен профилно-зависим ефект.

## 5. Нормализиран вход от доставчик и жизнен цикъл

Нормализираният provider record съдържа: `sourceId` (стабилен namespace за доставчик), `recordId` (стабилен в source), `recordVersion` (монотонен или provider-specific ordering), `recordType` (`measurement|historical|forecast|incident|closure|count`), `lifecycle` (`active|corrected|cancelled|expired`), `supersedesVersion`, `feedMode` (`incremental|full_snapshot`), `snapshotId`, `publishedAt`, `receivedAt`, `observedAt`, `validFrom`, `validTo`, `generatedAt`, `horizonSeconds`, `geometry`, `direction`, `vehicleApplicability`, `value`, `unit`, `licenseRef`, `rawRef`, `qualityFlags`. Неизвестните полета остават `null`/`unknown` и не се попълват чрез предположение.

- **Идемпотентност:** ключ `(sourceId,recordId,recordVersion)`; повторение със същия payload е no-op. Същият ключ с различен payload се карантинира (`version_collision`). По-стара версия не заменя по-нова.
- **Correction:** нова версия с `supersedesVersion`; предишната остава в audit history, новата е актуална от собствените си валидни времена.
- **Cancellation:** изрично отменя посочения record/event; не изтрива историята. Непотвърдена cancellation от друг доставчик не отменя чужд record.
- **Expiry:** след `validTo` или документиран TTL записът вече не е active; липсващ TTL е `unknown`, не автоматично изтриване. За затваряне при неясна валидност се сигнализира неопределеност и се изисква потвърждение.
- **Incremental feed:** отсъствието на запис в следващ пакет **не е cancellation**. **Full snapshot:** липсващ запис може да бъде деактивиран *само* в рамките на ясно декларираната област, тип и snapshot sequence на конкретния доставчик, след успешна пълна доставка; не отменя чужд доставчик.
- **Cross-source dedup:** корелация по geometry, посока, време, тип и стабилен event fingerprint; запазват се всички оригинални IDs и provenance. Корелацията не означава автоматично сумиране на ефекти. При конфликт: първо explicit correction в същия source, после проверима специфичност/свежест/официален обхват; ако няма достатъчна основа — `unknown` и конфликтен флаг. Няма универсално твърдение, че единият доставчик винаги е по-надежден.

## 6. Геопривързване и итерация по маршрут

Matching изисква съвместими **геометрия + посока + пътна идентичност/ниво**, когато са налични. Геометрично близък успореден път, насрещна посока и пресичане на мост/тунел на различно ниво **не** са достатъчно доказателство. Съхранява се `matchConfidence`; при двусмисленост `matching="ambiguous"`, `passability="unknown"` за спорен constraint, без автоматично прехвърляне на инцидента. `matchConfidence` не е измерена вероятност без калибрация.

Planner подава `expectedEntryAt` за всеки сегмент след предишните етапи и почивки. Лимитът е **3 опита за един `(routeRevision,evaluationCycle)`**, а НЕ за живота на routeRevision. Всеки опит има нов `requestId`, монотонен `attempt` (1..3), а при променен вход — нов `inputRevision`. Нова departure/почивка/история започва нов `evaluationCycle` дори при същия маршрут и получава нов бюджет от 3. Planner приема отговор само при точно съвпадение на активните `routeRevision`, `evaluationCycle`, `inputRevision`, `attempt` и `requestId`; стар опит се отхвърля. При <=60 s промяна на ETA и непроменена passability може да спре рано; при осцилация/несходимост след опит 3 — `unstable_estimate`. TI не изчислява почивки.

## 7. Версиониране, непокрити случаи и примери

Промени на значението на полета изискват нова версия на договора. Непознат enum/поле се обработва безопасно (`unknown`/ignore unknown optional), а липсващо задължително поле е validation error. HTTP транспортни кодове, auth и SLO остават за следващо възлагане. JSON примерите и детерминираните случаи са в `SCENARIOS-v0.1.md`; всички са **синтетични**, не реален feed.

**Източници и проверимост (към 2026-10-17):** [DATEX II — официален стандартен портал](https://datex2.eu/) (формат и модели за обмен; конкретните профили/версии на доставчици са непроверени); [Европейска комисия — национални точки за достъп](https://transport.ec.europa.eu/transport-themes/smart-mobility/road/its-directive-and-action-plan/national-access-points_en) (портал за NAP); [Делегиран регламент (ЕС) 2022/670, EUR-Lex](https://eur-lex.europa.eu/eli/reg_del/2022/670/oj) (правна рамка за RTTI). Тези URL адреси са първични ориентири, **не е извършена жива проверка на съдържанието им в TI-01**. Описаните по-горе семантики са **проектни решения**, не твърдения, че DATEX II задължително използва точно тези JSON полета.