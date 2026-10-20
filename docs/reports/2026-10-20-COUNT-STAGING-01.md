# COUNT-STAGING-01 — брой варианти на INT-32 в истински браузър срещу synthetic staging (отчет)

- **Task:** #173. Автор: Claude. Проверява: Codex.
- **База на клона:** `9897be64d503735ca31ec88a0d7acd8802f6e837` (приетият RELEASE-GATES-03). Клонът `claude/release-gates-03` остава само за четене.
- **APP:** `1a2ccc6543ae2301c0b5dc7b3ead9a5dcff38f76` (INT-32, с приетия ROUTE-OPTIONS-COUNT-01), в отделен чист checkout. Старото S7 доказателство за `9c6fbc9` не покрива този head.
- **Runbook:** `docs/runbooks/isolated-staging-check-v3.md`, Git blob `ad39eafc760be23ff46c4fdbbe04ba22ac112122`. Head-ът на harness-а се записва при пуска.
- **Обхват:** браузър + **реален synthetic** сървър (Docker API + tmpfs PostgreSQL) + **fake** router. Не е E2E с реален доставчик. Без production, лиценз или merge.

## 1. Файлове (точно 7 нови)

| Файл | Роля |
|---|---|
| `docs/runbooks/isolated-staging-check-v3.md` | v3, изведен от приетия v2. Режими на fake router-а и S7C (раздел 6.2); разликата е в раздел 10 |
| `scripts/browser-count-staging.mjs` | Driver: внася приетия `browser-staging.mjs` (само за четене) за стартирането, изолацията, UI действията и шестте S7 стъпки; добавя S7C |
| `scripts/browser-count-staging.test.mjs` | 8 unit теста без браузър (**не са S7C**) |
| `scripts/check-count-staging.py` | Runner: функциите са същите като на приетия `check-browser-staging.py`; разликите са в 3 |
| `scripts/test-check-count-staging.py` | 22 теста със stub docker, фалшиви driver-и и режимите на fake router-а (**не са S7C**) |
| `.github/workflows/count-staging.yml` | Само за този клон и 7-те пътя. Права `contents: read`, `persist-credentials: false`, 20 мин., без тайни и без инсталиране |
| `docs/reports/2026-10-20-COUNT-STAGING-01.md` | Този отчет |

Приетите v1/v2, `browser-staging.mjs` (+ тестът), `check-browser-staging.py` (+ тестът) и `check-candidate-staging.py` са байт-идентични. Тест проверява техните blob-ове от `9897be6`. Не съм пипал runtime кода, съществуващите workflow-и или документи.

## 2. Какво се промени в APP и броевете

- **Разлика `9c6fbc9` → `1a2ccc6`:** `ui/route-options-response.mjs` (+2 реда: `MAX_ROUTE_OPTION_CANDIDATES = 3` и отказ на целия отговор при повече от 2 `alternates`, преди да ги обходи), тестът му и два документа. `server/`, `scripts/`, `boss.html`, `planner.html` и `engine/` са непроменени.
- **Броеве на `1a2ccc6`** (`check-packaged-web.py`, без Docker): `planner.html` 21, `boss.html` 15.

## 3. v3 runbook и runner: точни разлики

**v2 → v3.** Блоковете `docker-0`, `docker-1`, `docker-2`, `docker-3`, `docker-5`, `helpers`, `owner`, `s1`–`s6` и `docker-7` са буква по буква като в v2 (тест го проверява). Променени са:

- `vars`: новият `T10_SHA`.
- `router-script`: `answer()` с режими `1`/`3`/`4`/`5001` от файл в контейнера на fake router-а.
  - Режим `1` (и без файл) е точно v2 `TRIP`; тест го сравнява с v2.
  - Непознат режим → 500.
  - Лог редът е непроменен.
- `docker-4`: добавен е `router_mode()` = `docker exec "$T10_ROUTER_ID" python -c '…'`, само в собствения контейнер на пуска.

**Runner спрямо приетия `check-browser-staging.py`.** Механиката е същата:
- guard-ове преди Docker, Bash и стартиране на браузъра;
- дословни блокове + същите 3 отчетени реда;
- почистване по label и проверка за собствени процеси.

Различни са:
- пиновете (APP `1a2ccc6`, v3 blob);
- driver-ът (`browser-count-staging.mjs`, `--timeout 420`);
- 13 нови S7C маркера, общо 31 S7/S7C;
- отделна анотация за S7C.

Няма `--allow-wrong-sha` или подобен изход.

## 4. S7C (за всяка ширина: 1280 и 375 емулирана, нов browser context след S7)

Само UI действия, а отговорът на API-то стига до страницата непроменен. Режимът на fake router-а се сменя с `router_mode`.

1. **Режим `3`:** HTTP 200 → точно 3 бутона (401/402/403 км), нищо не е избрано. Към router-а **+1** заявка с `costing=truck` и `height=4.1`. После се избира вариант 2.
2. **Режим `4` при избрана линия от доставчика:** HTTP 200, **+1** към router-а с валиден профил. В UI:
   - точно „Отговорът с вариантите е невалиден. Опитай отново.“;
   - 0 бутона, без отрязване до 3;
   - Leaflet `path`, `rKm` (произход и брой точки), съобщението за избор и четирите ключа на черновата в Local Storage са непроменени.

   Сравнението е след като картата спре да се анимира. Без това една анимация на Leaflet дава фалшива разлика в `d`, открита при локален пуск.
3. **Режим `5001`** (5000 `alternates`, около 633 KB): същото като 2.
4. **Ръчна линия:** „Начертай собствено трасе“, 2 клика по картата, „Готово“ (4 точки в черновата). После режим `4` → същото като 2 за ръчната линия.
5. **Повторен валиден опит, режим `3`:** 3 бутона; вариант 1 се избира. Режимът се връща на `1`.
6. 0 JS изключения; трафик само към `T10_BASE`.

**Ограничение на скоростта.** Сървърът позволява 10 заявки `POST /api/route-options` в минута за собственик. S7 + S7C правят 14 заявки (+1 от S3), затова driver-ът изчаква и го отпечатва (`S7C rate pacing: waiting … s`). Не повтаря заявки.

## 5. Локално от автора (без Docker; не е CI доказателство)

Driver-ът е стартиран срещу реален uvicorn с PostgreSQL на `1a2ccc6`, с `router.py` от v3 (файлът за режима е в scratchpad-а), Chromium 141.0.7390.37 и Node 22.22.0.

- **Резултат:** S7 и S7C при двете ширини минават; 0 JS изключения; блокирани са само заявки към `tile.openstreetmap.org`; pacing около 52 s; почистване без остатъци.
- **Мутации** (на копие на web root-а, не в APP), и двете → `S7C step 2 … expected the bounded error, got "Вариант 1 · 401 км …"`, exit 1:
  - `ui/route-options-response.mjs` от `9c6fbc9` (без ограничение);
  - вариант, който отрязва до 3 вместо да откаже целия отговор.
- **Открито по пътя и поправено:**
  - сравнението на `d` по време на анимация (виж 4.2);
  - при локални повторни пускания срещу един и същ сървър лимитът 10/мин. се пренася между пусканията (429). В CI сървърът е нов за всеки пуск.

## 6. CI (реален браузър и реален Docker)

Отчетът не може да съдържа пуска, който неговият собствен commit задейства. Затова тук е първият пуск, на `5bece34`. Крайният head и неговият пуск са в предаването в #173.

**Пуск на `5bece34cd66eec058c4e8332d4559c89f65fc2ea`**

- run [39487897750](https://github.com/Pstoev503/truck-tacho-app/actions/runs/39487897750), job 118853018517, 19:57:49–19:59:45Z, success. Прочетени са метаданните на стъпките и `::notice` анотациите.
- **Версии:** Google Chrome 155.0.8059.84 (`Browser.getVersion` след стартиране), Node v22.23.3, Python 3.13.16, Docker 28.0.4, Ubuntu 24.04.5.
- **Входове:** APP `1a2ccc6…`, v3 blob `ad39eaf…`, harness `5bece34…`.
- **Тестове без браузър:**
  - count driver: `# tests 8 # pass 8 # fail 0`;
  - runner: `Ran 22 tests … OK`, включително отказа на стария APP `9c6fbc9` (отделен checkout `app-old`).
- **S1–S6:** `PASS: 21 … planner.html`, `PASS: 15 … boss.html`, owner и S1–S5 ok, 36 реда `S6 served …`, `S6 ok`.
- **S7** (приетите 6 стъпки) при `desktop-1280` и `mobile-375`: всичките `ok`, 0 JS изключения.
- **S7C:**
  - при двете ширини стъпки 1–5 са `ok`, както са описани в раздел 4; всеки отговор на `/api/route-options` е 200 (5 за ширина);
  - `S7C rate pacing: waiting 51 s`, после по 1 s;
  - `S7C ok (desktop-1280, mobile-375; max 3 options, overflow 4 and 5001 rejected whole, prior lines kept, valid retry)`.
- **Общо:**
  - `S7 js exceptions: 0 … (S7 and S7C)`;
  - `S7 external requests blocked: 93 (tile.openstreetmap.org); only http://127.0.0.1:18080 reached`;
  - `S7 cleanup: browser stopped (0 own processes left), profile dir removed`.
- **Почистване:** `bash exit 0`; не е останал container, network или image с `t10.stage.run=20261020195802-2901`; няма процес с временната директория; 99 s; `RESULT: PASS`.
- **Козметична поправка в крайния head:** S7C редовете влизаха и в анотацията „runbook output S1-S6“ и я отрязваха около 4 KB. Сега са само в „browser output S7C“. Проверките не са променени.

| Сценарий | Статус на `5bece34` |
|---|---|
| S1–S6 | PASS (реален Docker) |
| S7, 1280 и 375 | PASS (реален headless Chrome 155) |
| S7C, 1280 и 375 | PASS: валиден максимум 3; отказ на целия отговор при 4 и 5001 с непроменени линия, произход и чернова; повторен опит |
| S5b | NOT RUN |

## 7. Ограничения

- Fake router, не реален доставчик или пътна мрежа. 375 е емулация. Плочките са блокирани.
- Проверката на линията е по Leaflet `path` и `rKm`, не по изображение.
- Режимът на fake router-а е фиксиран в контейнера: това е контролиран synthetic отговор, не поведение на доставчик.
- Staging S5b е NOT RUN. ADR, физическа достоверност, правна страна, лиценз и production остават отворени.
- Доказателството е само за `1a2ccc6`. Бъдещи версии не са покрити автоматично.
