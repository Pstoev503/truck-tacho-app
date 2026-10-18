# PLAN-03 — договор карта → планировчик, версия 1.0-draft

Дата: 18.10.2026. Собственик: Codex. Статус: спецификация за следващ адаптер, не реализирана интеграция. Цел: маршрутът се избира върху картата, а графикът се показва по същата геометрия. Не се създава втори двигател.

## 1. Проверени зависимости и граници

- Съществуващият `buildPlan()` и новото `historyCoverage` са в [PLAN-02, PR #15](https://github.com/Pstoev503/truck-tacho-app/pull/15), head `bdddd307c4729985ba82a34f2d3d4a0af67a71df`, върху PLAN-01 #14. Двата пакета не са слети.
- Геометричният модул е в [GEO-01, PR #16](https://github.com/Pstoev503/truck-tacho-app/pull/16). Към този документ той е върнат за корекция и още не е приет. Никаква интеграция не приема предварително, че дефектът е отстранен.
- Локалният `index.html` вече вика buildPlan чрез отделна форма. Неговото автоматично motorway за всеки пренесен етап не е достатъчно за надеждна класификация.
- Този документ променя само договор. Не добавя runtime функция, API endpoint, трафик доставчик, паркинги или юридическо одобрение. TI-01 от втория GPT описва трафик данните; не се дублира тук.

Съществуващият buildPlan вход остава непроменен: `stages`, `departure`, `activities`, `now`, `breakStyle`, `multiManning`, `lastWeeklyRestEnd`. Етапът има `label`, `distanceKm`, `roadType: motorway|ordinary`, `useExtension` и `dailyRest: regular|reduced`. Тези полета са ограничени възможности на MVP, не пълният изискван набор режими за ЕС.

## 2. Планиран адаптер и граници на изпълнение

Предложен интерфейс за отделен следващ пакет:

`createMapPlan(request, { buildPlan, indexRoute, pointAtOffset }) -> result`

Това име е част от спецификацията, не наличен export. Адаптерът е чист, детерминиран, без DOM/мрежа/storage и с изричен `nowUtcMs`. Картата и контролерът пазят и управляват request/revision; двигателят изчислява графика; адаптерът само валидира входа, превежда го и добавя геометрично положение. Никакъв запис в реалния activity log.

## 3. Версии, единици и време

`schemaVersion` е числото 1. `requestId` и `routeRevision` са непразни string. `routeRevision` се сменя при всяка промяна на подредената геометрия, пътните участъци, профила на камиона или маршрутните ограничения. `inputRevision` се сменя при departure, история, избори или получено съществено обновяване на трафика. Едни и същи данни могат да запазят revision; различни данни не могат да използват старата.

Разстоянията в договора са метри, продължителностите са милисекунди, координатите WGS84 `{lat,lon}` в градуси. В buildPlan се превежда само distanceM/1000. Всички моменти са крайни UTC epoch milliseconds. `displayTimeZone` е валидна IANA зона само за показване и за отделната стъпка на преобразуване на потребителския час. Невалиден/двусмислен локален час при DST се уточнява от контролера; адаптерът не гадае offset и не използва системната часова зона.

Полученият отговор се показва само ако едновременно съвпадат requestId, routeRevision и inputRevision с последния подаден вход. Отговор от по-стара заявка се отхвърля, дори да е пристигнал последен. Политиката се прилага и когато бъдещият трафик адаптер стане асинхронен; текущият buildPlan е синхронен.

## 4. Вход на map adapter v1

| Поле | Смисъл и проверка |
|---|---|
| `schemaVersion`, `requestId`, `routeRevision`, `inputRevision` | Задължителни. Неподдържана версия е отказ, не silent downgrade. |
| `nowUtcMs`, `departureUtcMs` | Задължителни finite числа; departure >= now. |
| `displayTimeZone` | IANA зона; не променя UTC аритметиката на двигателя. |
| `route.geometry` | Подредена линия; минимум две валидни точки и положителна дължина. Поддържаният географски обхват следва GEO модула; непокрит полярен/antimeridian случай се отказва изрично. |
| `route.geometryKind` | `road-routed` или `manual-sketch`. Ръчната скица може да даде само ясно означена геометрична оценка; не става „проверен път“. |
| `route.source` | Произход на линията. Не доказва наличен лиценз или проходимост. |
| `route.roadSections` | Непразен подреден масив `{id,fromM,toM,roadType,source}`. Покрива линията от 0 до totalLengthM без застъпване/празнина. Положителни участъци; roadType е явно motorway/ordinary. Отклонение до 0.05м от крайна граница се допуска само като числова точност, не като snap на реално различни маршрути. |
| `route.vehicleProfileRef` | String или null. v1 не валидира ограниченията на камиона; наличен ref сам не доказва проверка. |
| `initialState.activities` | Копие на реалния дневник във формата на analyze: type drive/work/avail/rest, start/end UTC число или parseable ISO с явен timezone, end:null за текуща дейност. Не се измисля история при липса. |
| `initialState.lastWeeklyRestEnd` | Число или null, със същата семантика като buildPlan. Не се въвежда „сега“ само за да изчезне предупреждение. |
| `initialState.source` | Например driver-log/manual-import; произход, не гаранция за достоверност. |
| `choices.breakStyle` | 45 или 15+30, като string; един общ избор за MVP курса. |
| `choices.multiManning` | Boolean към съществуващия анализатор. Изисква отделно потвърждение на предпоставките; няма автоматично правно одобрение. |
| `choices.bySection` | Най-много един `{sectionId,useExtension,dailyRest}` на roadSection; неизвестен sectionId/повторение се отказва. Липсващ запис е useExtension:false, dailyRest:regular. |
| `requirements` | Незадължителен обект от boolean флагове `truckValidatedRoute`, `liveTraffic`, `forecastTraffic`, `exactStops`, `splitDailyRest3Plus9`, `weeklyRest`, `compensation`, `ferry`, `derogation`, `legalCompliance`. Пропуснат флаг е false. Всеки true е познато, но неподдържано v1 изискване → unsupported с конкретния флаг. |
| `requestedStops` | Незадължителен масив от `{id,routeOffsetM,kind,source}`. Празен по подразбиране. Непразен масив е познато, но неподдържано искане за конкретни спирания → unsupported/exactStops. Не се губи при сериализация. |

Неизвестен roadType не се превръща в motorway. Ако класификацията липсва, резултатът е needs-data. За сценарий водачът може изрично да избере roadType със source=manual; това е допускане и остава видимо. Профилът на камиона и vehicle ограниченията не се игнорират при изрично искане за проверка: такова искане е неподдържана capability във v1.

### Явно неподдържани искания във v1

Ако заявката изисква exact parking stop/detour, почивка на конкретен routeOffset, 3+9ч дневна почивка, планирана седмична почивка/компенсация, фериботно условие, дерогация, live/forecast traffic или truck-validated route, връща се `unsupported` със списък. Те не се изтриват тихо и не се показва план, сякаш са изпълнени. Неизвестни полета се отказват като invalid-input, за да не се загубят при cleanRoute/JSON сериализация.

`useExtension` в текущия engine е stage избор, който може да задейства най-много едно ново удължено дежурство в този етап. Не е допълнителен час за всеки пътен участък. Не е свободен избор на произволно дежурство по маршрута. Бъдещите стабилни dutyId/anchor и изборите по дежурство са отделна engine промяна; UI не обещава вече реализирана възможност.

## 5. Превод и геометрично привързване

Всеки roadSection става точно един buildPlan stage със distanceKm=(toM-fromM)/1000 и запазена отделна mapping таблица stageIndex → sectionId/fromM/toM. Преизчислените разстояния от geometry са водещи; ръчно разстояние с друга дължина не се смесва със същата карта. Без геометрия MVP формата може да остане отделен текстов сценарий, но map adapter връща needs-data.

За drive event от даден stage: движението е по избраната линия, с дължина `(end-start)/H * PLANNER_SPEEDS[roadType] * 1000`. Адаптерът натрупва тази дължина вътре в stage; до 0.05м числова грешка при края се обработва като граница. По-голямо несъответствие/надхвърляне е `mapping-inconsistent`, не clamp. Не се закръглява преди натрупването. from/to координатите се вземат чрез pointAtOffset, а не по права линия между waypoint-ите.

За rest event отместването не се увеличава; fromM=toM е достигнатата до момента позиция. Маркерът е **теоретично място за почивка** със stopKind=unassigned. Той не е паркинг и не доказва, че може безопасно/законно да се спре там. Не се мести автоматично към най-близък паркинг без добавяне на достигане/отклонение в двигателя.

Пауза, която engine поставя в началото на следващия stage, остава на текущата граница; mapping не взима stageResults.start като единствен часовник, а последователните events. При празен/извън-обхват stageIndex резултатът е mapping-inconsistent. Крайното разстояние трябва да съвпада с totalLengthM в tolerance. Тази аритметика важи само за постоянните скорости на MVP; бъдещ TI-01 с променливо време по сегмент изисква нов съгласуван duration/distance модел, не второ добавяне на закъснение.

## 6. Резултат и семантика на статуса

| Поле | Значение |
|---|---|
| `schemaVersion`, `requestId`, `routeRevision`, `inputRevision` | Echo, без смяна на стойности. |
| `state` | `estimated`, `needs-data`, `unsupported`, `invalid-input` или `error`. Няма статус „законен курс“. |
| `arrivalUtcMs` | Само ориентировъчен ETA при estimated; null при останалите състояния. |
| `events` | `{id,type,startUtcMs,endUtcMs,stageIndex,sectionId,fromM,toM,fromPoint,toPoint,stopKind}`. За rest stopKind=unassigned; за drive stopKind=null. |
| `engineResult` | Реалният buildPlan резултат, отделен от echo/geo mapping. При грешка/unsupported е null. |
| `historyCoverage` | Реалното поле от PLAN-02, без преизчисляване чрез earliest запис. Празни gaps не са проверка за достоверност. |
| `capabilities`, `warnings`, `assumptions` | Машинни codes плюс четим текст; непотвърдена история/route/traffic/stop се вижда в продукта. |
| `error` | Null при estimated; иначе `{code,field?,details?}`. При вътрешно несъответствие на event mapping: state=error, error.code=MAPPING_INCONSISTENT, ETA=null, events=[], engineResult остава наличен само за диагностика, без представяне като готов карта-план. |

Всички v1 графици са estimated заради приблизителните скорости и непълните capabilities. violations остават видими; резултат с нарушения не се превръща в feasible. `engineResult.confirmed` е наследено техническо поле за поддържаните проверки. UI НЕ го превежда като „нормативно одобрен“ и НЕ отменя warnings за неподдържан режим. Липсващ historyCoverage означава needs-data / engine-version-mismatch, не предположение, че историята е пълна.

## 7. Синтетични JSON примери

Това са само договорни примери, не реален маршрут, история, трафик или изпълнено API. Екваториалният пример има дължина около 1000м при сферичния радиус на GEO; не представлява български път.

```json
{
  "schemaVersion": 1,
  "requestId": "demo-1",
  "routeRevision": "route-r1",
  "inputRevision": "input-r1",
  "nowUtcMs": 1800000000000,
  "departureUtcMs": 1800000000000,
  "displayTimeZone": "Europe/Sofia",
  "route": {
    "geometry": [{"lat": 0, "lon": 0}, {"lat": 0, "lon": 0.008993216059187306}],
    "geometryKind": "manual-sketch",
    "source": "synthetic-example",
    "vehicleProfileRef": null,
    "roadSections": [{"id": "s1", "fromM": 0, "toM": 1000, "roadType": "ordinary", "source": "manual"}]
  },
  "initialState": {"activities": [], "lastWeeklyRestEnd": null, "source": "none"},
  "choices": {"breakStyle": "45", "multiManning": false, "bySection": []}
}
```

Примерен отказ при липсващ тип път (друга заявка, без fabricated engine result):

```json
{
  "schemaVersion": 1,
  "requestId": "demo-missing-roadtype",
  "routeRevision": "route-r2",
  "inputRevision": "input-r2",
  "state": "needs-data",
  "arrivalUtcMs": null,
  "events": [],
  "engineResult": null,
  "historyCoverage": null,
  "capabilities": {},
  "error": {"code": "ROAD_TYPE_REQUIRED", "field": "route.roadSections[0].roadType"},
  "warnings": [{"code": "ROAD_TYPE_REQUIRED", "sectionId": "s1"}],
  "assumptions": []
}
```

## 8. Приемане на бъдещата реализация

| Сценарий | Задължителен очакван резултат |
|---|---|
| Начало/край на една линия | Координатите на event съвпадат с line endpoints; същата revision. |
| Неправ/многосегментен маршрут | Разстоянието е по линията, не chord между waypoint-и. |
| Пауза в средата на stage | fromM=toM и теоретичен unassigned stop; не измислен parking. |
| Пауза на граница между road sections | Една геометрична позиция без скок към край/начало на грешен stage. |
| Няколко roadType секции | Превод km/m и event дължини с точните скорости; без default motorway. |
| Липсваща геометрия/roadType | needs-data; няма синя „проверена“ линия или fabricated ETA. |
| Начален/вътрешен пропуск в историята | Реалните historyCoverage.gaps остават видими; няма правно одобрение. |
| Бъдещо потегляне | Началото е departure точно; интервалът преди него не се добавя след старта и не печели почивка. |
| Променена геометрия/профил | Нова routeRevision; стар отговор не се показва. |
| Променени избори/история | Нова inputRevision; engine се преизчислява от копие на оригиналния дневник. |
| Изчерпано 10ч право | ignoredExtensions остава видимо; UI не отбелязва избора като изпълнен. |
| Зададен exact parking/3+9/traffic | unsupported; изискването не се игнорира. |
| Невалиден stageIndex или дистанционен сбор | mapping-inconsistent без тихо разположение върху друга точка. |
| ISO/UTC и DST | Детерминирани входни epoch моменти; browser timezone не променя изчислението. |
| Повторно натискане „Изчисли“ | Няма промяна/добавяне в реалния дневник, няма остарял отговор. |

Тестовете трябва да проверяват потребителските резултати и граници, не само същата формула, преписана от адаптера. Изпълняват се baseline Node тестовете, adapter тестовете и интерактивна карта/времева линия преди приемане на UI. В този документ тези тестове са критерии, не твърдение за изпълнение.

## 9. Собственост и следващи пакети

Codex притежава engine/plan.js и plan.test.js и този договор. Copilot завършва GEO-01 в route-position.js/test, без едновременни planner редакции. След приемане на GEO се възлага отделен adapter пакет (предложение: engine/map-plan.js/test) по фиксираните версии. UI идва след проверен адаптер и отделно пренасяне на локалните index/boss промени; не се започва от загубващия ги main.

Parking изборите, променливите времена от TI-01, dutyId и пълните нормативни варианти остават изрични последващи engine пакети с отделни критерии. Те не се обявяват за налични от този договор. Не се променят cleanRoute, route payload или server persistence скрито; версията за запазен trip plan се възлага отделно.
