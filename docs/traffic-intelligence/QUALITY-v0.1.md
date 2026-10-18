# TI-01 — Quality & Data Governance v0.1

**Дата:** 2026-10-17 · Проектна спецификация, не доказателство за качество на реален доставчик.

## 1. Статуси и времева приложимост

| Статус | Значение | Поведение |
|---|---|---|
| `fresh` | актуален по документираната freshness policy на source, валиден за `expectedEntryAt` и приложим към сегмент/посока/профил | допустим кандидат, ако няма по-силен конфликт |
| `stale` | съществува, но е извън допустимия freshness прозорец | показва се с предупреждение; **не** се представя като live; fallback към историческа оценка или base, ако е допустимо |
| `unavailable` | липсва услуга, валидиран модел или разрешен достъп | няма числова оценка от този вид (`durationSeconds:null`) |
| `unknown` | не може да се установи валидност, съпоставяне, проходимост или качество | не се преобразува в `fresh`, `open` или нула |

**Freshness** се измерва спрямо `observedAt` за измерване, `generatedAt` за прогноза и `publishedAt/receivedAt` за оперативно закъснение; тези времена **не са взаимозаменяеми**. `validFrom/validTo` ограничават приложимостта за конкретния очакван час на навлизане. `receivedAt` е системен audit timestamp, не доказателство, че измерването е ново. Няма глобален TTL по предположение: `maxObservationAgeSeconds`, `maxPublicationLagSeconds`, `forecastHorizonSeconds` и snapshot cadence се конфигурират **само след потвърждение от доставчика**. До тогава `unknown`, а не измислено SLA.

## 2. Правила за качество

1. Всяко число има `kind`, `unit` и `source`; derived value има lineage на входовете и transformation ID. Нулева скорост е валидна само ако е изрично измерена и значението ѝ е документирано; липсваща скорост = `null`.
2. Географско съвпадение изисква segment, посока и, когато е възможно, road ID/level; proximity alone не доказва match. Не се наследява incident от успореден път или друг мостов етаж.
3. Vehicle applicability: `covered` само ако доставчикът/маршрутният модел изрично покрива релевантните характеристики; `not_covered` означава непокрита характеристика; `unknown` при липса на метаданни. Не се обещава truck routing.
4. `count-only` е наблюдение за поток, **не** скорост и **не** ETA; без калибриран модел не се преобразува.
5. При дублирани описания на едно задръстване от два доставчика се пазят два provenance записа, но **един** избран travel-time кандидат; не се сумират забавяния.
6. Корекция, cancellation, expiry и full-snapshot omission се обработват само според идентичност, версия, област и изрична feed семантика. Неполучен incremental record не отменя затваряне.
7. Ако closure е потвърдено и приложимо към профила и часа на навлизане, `passability=closed` и ETA е `null`; routing/planner взема решение за обход. Ако closure е спорно/двусмислено — `unknown` с warning, не `open`.
8. Историческата оценка е изрично `kind=historical`, с методология, прозорец и sample size (ако са известни); не се маркира като измерена скорост в реално време.
9. Forecast остава `unavailable` докато няма валидиран модел с документиран horizon, оценка на грешката и контрол на drift; не се генерират фиктивни прогнози.
10. При липса на live feed: отделно се показват `measured.status=unavailable|stale` и fallback `historical|routing_base`; UI трябва ясно да означи fallback.
11. При разминаване на `routeRevision`/`requestId` закъснелият отговор се отхвърля; не се записва като актуално ETA.
12. Времевите прозорци са UTC. DST се обработва само при преобразуване от локален час с изрична IANA timezone и disambiguation за двусмислен локален час.

## 3. Историческо съхранение — логически записи, без DDL

- `SourceCatalog`: sourceId, правно основание/licenseRef, покритие, режим full/incremental, версия на feed, документирана retention политика, контактен URL.
- `RawReceiptMetadata`: sourceId, batch/snapshotId, receivedAt, checksum, parser version, права за съхранение; **суров payload само ако лицензът го разрешава**.
- `NormalizedObservation`: stable ID/version, kind/unit/value, геометрия/посока, временни полета, applicability, quality flags, provenance.
- `EventLifecycle`: source event versions, correction/cancellation/expiry, links към корелирани cross-source events, без загуба на оригинална история, ако е законно допустимо.
- `SegmentEstimate`: routeRevision, segmentRef, expectedEntryAt, selected kind/value/status, confidence/warnings, derivedFrom refs, evaluation version; ограничена retention според нужда/лиценз.

**Лиценз и минимизация:** преди ingestion се потвърждават разрешение за архив, производни данни, преразпространение, кеширане, срок и изтриване. При неясни права се ограничава до metadata или се отказва ingestion. Не се събират GPS следи, идентификатори или лична история на водачи в TI-01. Route requests са синтетични или безлични; ако бъдещ deployment използва реални маршрути, изисква отделна оценка на поверителността. Без schema/DDL, DB миграции или инфраструктура в този пакет.

## 4. Наблюдаемост и критерии за приемане

Логически метрики: процент валидирани записи, parse failures, latency `receivedAt-publishedAt`, observation age, процент `matched/ambiguous/unmatched`, source disagreements, active closure conflicts, stale share, late response rejects, version collisions, unavailable forecast share. Метриките се групират по source и route segment без лични данни. При failure UI показва ясно „няма актуални данни“, без зелено оцветяване по подразбиране.

Преди production: проверка на лицензите; schema validation; replay/idempotency тестове; реални cross-source конфликтни примери; калибрация на matching confidence; baseline спрямо независими travel-time измервания; доказана оценка на forecast. Нито едно от тях не е извършено с реален feed в TI-01.

## 5. Полета за потвърждение от реални доставчици

| Поле/условие | Състояние в TI-01 |
|---|---|
| Stable event/observation ID, version semantics, correction/cancellation кодове | **unknown** |
| Full snapshot или incremental; обхват и sequence | **unknown** |
| Честота на обновяване, SLA, timestamp семантика, TTL | **unknown** |
| Geo referencing: coordinates, linear referencing, road ID, carriageway, level | **unknown** |
| Direction и lane-level specificity | **unknown** |
| Значение на speed/travel-time/count, aggregation window, units | **unknown** |
| Включва ли incident delay в измереното travel time | **unknown** |
| Vehicle restrictions / truck profile coverage | **unknown** |
| Closure validity, open/cancel authority, overlap rules | **unknown** |
| Историческо архивиране, derived works, публична визуализация, retention | **unknown** |
| Forecast availability, generation time, horizon, quality | **unknown** |
| Rate limits, authentication, outage behavior | **unknown** |

Тази таблица е интерфейсен checklist за Copilot/отговорника, **не** повторна инвентаризация на DATEX доставчици.

**Първични ориентири (към 2026-10-17, без live проверка):** [DATEX II](https://datex2.eu/); [ЕК — National Access Points](https://transport.ec.europa.eu/transport-themes/smart-mobility/road/its-directive-and-action-plan/national-access-points_en); [Регламент (ЕС) 2022/670](https://eur-lex.europa.eu/eli/reg_del/2022/670/oj). Лицензи и схеми на конкретни доставчици **не са проверени**.