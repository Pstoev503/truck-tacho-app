# BROWSER-STAGING-01 — S7 в истински headless браузър срещу synthetic Docker staging (отчет)

- **Task:** #167. Автор: Claude. Проверява: Codex.
- **База на клона:** `da5dcfac072464382614d739c65b857c6b887c22` (приетият STAGING-CANDIDATE-01). Клонът `claude/staging-candidate-01` остава само за четене.
- **APP:** `9c6fbc9d64041ac401c3cd87bcb3f4d2eaafc354` (INT-31), в отделен чист checkout. Чакащата поправка на брояча от Copilot не е включена.
- **Runbook:** `docs/runbooks/isolated-staging-check-v2.md`, непроменен, blob `f0d7750ff89f8f4c6e5259e35e0cee419df53ce4`.
- **Статус:** технически преглед, не сертификат. Обхватът е S7 в браузър срещу **реален** synthetic сървър (Docker API + tmpfs PostgreSQL) и **fake** router. Това не е E2E с реален доставчик. Без production, лиценз или merge.

## 1. Файлове (точно 6 нови)

| Файл | Роля |
|---|---|
| `scripts/browser-staging.mjs` | Driver на S7. Използва Chrome DevTools Protocol през вградения в Node 22 `WebSocket`, без npm пакети. |
| `scripts/browser-staging.test.mjs` | 10 unit теста на driver-а (`node --test`). Не стартират браузър, затова **не са S7**. |
| `scripts/check-browser-staging.py` | Runner-ът. Механиката е тази на приетия `check-candidate-staging.py`, плюс един ред за браузъра. |
| `scripts/test-check-browser-staging.py` | 16 теста на runner-а със stub docker/bash/browser и фалшиви driver-и. Също **не са S7**. |
| `.github/workflows/browser-staging.yml` | Само за този клон и тези 6 пътя. Права `contents: read`, `persist-credentials: false`, job до 20 мин., без тайни. |
| `docs/reports/2026-10-20-BROWSER-STAGING-01.md` | Този отчет. |

Не съм пипал v1/v2 runbook-а, приетите runner-и и тестовете им (тест проверява blob-овете им), съществуващите workflow-и или runtime кода.

## 2. Runner: точна разлика спрямо приетия `check-candidate-staging.py`

- **Същото:**
  - пиновете (APP `9c6fbc9`, v2 blob `f0d7750`);
  - guard-ове преди Docker и Bash;
  - дословните v2 блокове в същия ред;
  - двата оркестрационни реда;
  - почистване само на записаните ID-та с label-а на пуска;
  - проверката за останали ресурси по точния label и за временната директория.
- **Добавено:**
  1. **Един отчетен ред** веднага след блока `s6`. Той е последният ред на скрипта, така че `trap cleanup EXIT` на runbook-а идва след него:
     ```
     node "$T10_BROWSER_DRIVER" --base "$T10_BASE" --browser "$T10_BROWSER" --router "$T10_ROUTER_ID" --profile-dir "$T10_DIR/browser-profile" --timeout 300
     ```
     Използва само променливи на самия runbook. `T10_BROWSER` и `T10_BROWSER_DRIVER` идват от runner-а.
  2. **Guard-ове за инструментите**, след проверките на APP и blob и преди първия Docker:
     - браузърът съществува и отговаря на `--version`;
     - `node` има вграден `WebSocket`.

     Иначе: `GUARD FAIL … S7 NOT RUN`, exit 2. Изходът от `--version` не се отчита като „браузърът работи“. Това се твърди само след реално стартиране (`S7 browser launched: …` от `Browser.getVersion`).
  3. **18 S7 маркера**, които отпечатва само driver-ът, след реални проверки в браузъра.
  4. **Проверка след пуска:** не трябва да е останал процес, чийто команден ред съдържа временната директория на пуска. Профилът на браузъра е в нея. Такъв процес само се отчита; runner-ът не го убива.

## 3. Driver (S7 от замразения v2, раздел 6.1)

- **Браузър.** Вече наличният Chrome/Chromium на машината. Без инсталиране.
  - Флагове: `--headless=new`, собствен нов `--user-data-dir` в `$T10_DIR`, `--remote-debugging-port=0` (loopback), `--no-proxy-server`, `--disable-background-networking`, `--disable-sync`, `--disable-component-update`, `--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1` и др.
  - Proxy променливите на средата се махат за процеса на браузъра.
  - `--no-sandbox` се добавя само ако процесът е root. На CI runner-а не е.
- **Мрежа.** `Fetch.requestPaused` за всяка заявка. Минават само тези към точния `--base` origin; останалите получават `failRequest(BlockedByClient)` и се броят по host. Плочките на картата са блокирани и не се търси място (точките са с координати).
- **Само UI действия**, без инжектирано състояние:
  - мишка: `Input.dispatchMouseEvent` в центъра на елемента, и то само ако `elementFromPoint` попада в него;
  - текст: `Input.insertText` след Ctrl+A;
  - клавиши: Tab, после ArrowDown за „Опасен товар“ = Не.
- **Само четене**, без промяна: стойности в DOM, текстове, `document.activeElement`, наличие на `boss_token` и `boss_route_geometry` в `localStorage`. Самият токен не се чете и не се печата.
- **Router.** `docker logs <T10_ROUTER_ID>`, само за четене, за броя заявки и тялото на последната.
- **Две ширини, всяка в собствен нов browser context** (празен `localStorage`): `desktop-1280` (1280×900) и `mobile-375` (375×812, mobile, DPR 2).
- **Стъпки за всяка ширина:**
  1. Вход през формата (`owner@stage.test` / synthetic парола от runbook-а, адрес = `--base`), после раздел „Маршрут“ и 2 точки чрез координати.
  2. Празен профил → съобщение за 7-те параметъра, 7 видими грешки по полетата, фокус на „Височина“, **+0** заявки към router-а.
  3. Профил `4,1 / 2.55 / 16.5 / 40 / 11.5 / 5 / Не` → точно 1 вариант, нищо не е избрано (няма плътна линия, „няма избрана пътна геометрия“). Към router-а отива **+1** заявка с `costing=truck` и `height=4.1`.
  4. Избор на варианта (плътна линия, „по линията от маршрутизатора“), после смяна на височината → вариантите, линията и изборът са махнати и има съобщение.
  5. Нов вариант, избор, презареждане → 7-те полета са празни, точките са запазени, линията от маршрутизатора не се връща, `boss_route_geometry` е `[]`.
  6. Попълнен профил, ⚙, „Излез“. Заявката `POST /api/logout` се **задържа 2000 ms** с `Fetch.requestPaused`. Докато е задържана: екран за вход, няма `boss_token`, 7-те полета са празни. След това заявката продължава и отговорът е HTTP 200.
- **Грешки в страницата.** `Runtime.exceptionThrown`, включително необработени отхвърлени promise-и, проваля S7. Преди проверката има 1 s изчакване за късни грешки.
- **Почистване.** Винаги, включително при неуспех, таймаут или SIGTERM: `Browser.close`, после SIGTERM и при нужда SIGKILL **само** за процесите с точния `--user-data-dir=<профила на пуска>`. После профилът се изтрива. Съществуваща папка не се използва и не се трие.

## 4. Тестове (без браузър; не са S7)

- **Runner, 16 теста:**
  - CLI с грешен APP SHA, замърсен checkout или грешен blob → exit 2 и 0 извиквания на docker, bash и браузър;
  - липсващ браузър → `S7 NOT RUN`, exit 2, 0 docker;
  - браузър без `--version` → exit 2, 0 docker;
  - `node` без `WebSocket` → exit 2, 0 docker;
  - скриптът е дословните v2 блокове + точно 3 отчетени реда, а редът за браузъра е веднага след `s6`;
  - пиновете и blob-овете на приетите файлове са непроменени;
  - S7 маркерите не са в runbook-а;
  - фалшив driver получава точните аргументи (положителна проверка с почистване);
  - провалена проверка в браузъра и таймаут в браузъра → почистването все пак тече;
  - липсващ маркер на стъпка → FAIL, въпреки exit 0;
  - останал процес на пуска → FAIL и runner-ът **не** го убива;
  - търсенето на процеси е само за директорията на пуска;
  - в доказателствата няма тайни.
- **Driver, 10 теста:**
  - аргументи: само loopback http, без userinfo и път;
  - политика на заявките: плочки, Nominatim, други портове, `localhost` срещу `127.0.0.1`;
  - парсване на лога на router-а;
  - изолация: proxy и флагове;
  - търсене на собствените процеси;
  - липсващ браузър;
  - браузър, който излиза при стартиране;
  - браузър, който не отваря DevTools → общ таймаут и спиране на собствения процес;
  - съществуваща папка за профил не се пипа;
  - лоши аргументи.

## 5. Локално от автора (без Docker; не е CI доказателството)

Нямах Docker демон, затова не е изпълняван v2 runbook-ът. Driver-ът е стартиран срещу реалния сървър на `9c6fbc9`:
- uvicorn и PostgreSQL 16 на loopback;
- `router.py` от runbook-а;
- собственикът е регистриран със същата заявка като в блока `owner`;
- Chromium 141.0.7390.37 (Playwright build) и Node 22.22.0.

Резултат: двете ширини и шестте стъпки минават, 0 JS изключения, блокирани са само заявки към `tile.openstreetmap.org`.

**Мутационни проверки** върху **копие** на `boss.html` (не в APP):

| Мутация | Резултат |
|---|---|
| Изходът чака сървъра | `step 6 logout: timed out waiting for login screen after logout`, exit 1 |
| Вариантът се избира автоматично | `step 3 options: an option was selected automatically`, exit 1 |
| Грешка в страницата след 500 ms | `step page errors: JS exceptions: Error: synthetic page error`, exit 1 |

Почистването е без останали процеси и във всеки от трите случая.

**Поправки, открити по време на работата:**
- **Мрежа.** При първия локален пуск Chrome опита през proxy-то на средата `android.clients.google.com` и `www.google.com`. Proxy-то ги отказа. Причината е, че с proxy имената се разрешават от него, покрай `--host-resolver-rules`. Добавих `--no-proxy-server` и махане на proxy променливите; след това няма такива опити. На CI runner-а няма такова proxy.
- **Почистване при неуспех.** Изтриването на профила падаше с `ENOTEMPTY`, защото помощните процеси на Chrome още пишеха. Сега се спират само процесите с този профил, а изтриването има повторни опити.
- **Убит браузър по време на стартиране.** Не се забелязваше, защото exit кодът е `null` при сигнал, и чакането беше 30 s. Поправено.
- **Мутацията с грешка след 3 s.** Не се хващаше, защото една ширина приключва за под 3 s. Добавено е 1 s изчакване преди проверката за грешки. Грешка, която идва по-късно от това, остава извън обхвата.

## 6. CI (реален браузър и реален Docker)

Отчетът не може да съдържа пуска, който неговият собствен commit задейства. Затова тук е първият пуск, на `bfd890c`. Крайният head и неговият пуск са в предаването в #167.

**Пуск на `bfd890c0b658f5069ac9bdeaba29daff51e75c92`**

- run [39470610191](https://github.com/Pstoev503/truck-tacho-app/actions/runs/39470610191), job 118793375710, 17:57:57–17:59:12Z, success. Прочетени са метаданните на стъпките и `::notice` анотациите.
- **Версии** (действително стартирани):
  - Google Chrome 155.0.8059.84, `/usr/bin/google-chrome`, вече наличен на runner-а; `Browser.getVersion` след стартиране: `Chrome/155.0.8059.84`, protocol 1.3;
  - Node v22.23.3 (`actions/setup-node@v4`, 22);
  - Python 3.13.16;
  - Docker server 28.0.4;
  - Ubuntu 24.04.5 LTS.
- **Входове:** APP `9c6fbc9…`, v2 blob `f0d7750…`, harness `bfd890c…`.
- **Тестове без браузър** (не са S7):
  - driver: `# tests 10 # pass 10 # fail 0`;
  - runner: `Ran 16 tests; failures 0, errors 0, skipped 0; OK`.
- **Реален Docker пуск, S1–S6:**
  - пакетиране: `PASS: 21 … planner.html`, `PASS: 15 … boss.html`;
  - `owner ok`; S1–S4 `ok`; S5 `ok (old-code join: 200)`;
  - 36 реда `S6 served …` с точен MIME;
  - `S6 ok (served = packaged; planner 21, boss 15; exact MIME per file)`.
- **S7 в реалния браузър** (дословни редове):
  - `S7 browser launched: Chrome/155.0.8059.84 (protocol 1.3); Node v22.23.3; headless; own profile dir`
  - за `desktop-1280` и за `mobile-375` — стъпки 1–6 `ok`, както са описани в раздел 3. Стъпка 3: `router requests +1, costing truck, height 4.1 (typed "4,1")`. Стъпка 6: `logout → login screen, no boss_token, 7 fields blank while the server logout was paused 2000 ms; then resumed, HTTP 200`;
  - `S7 desktop-1280 ok (1280x900): 0 JS exceptions, 46 external requests blocked`
  - `S7 mobile-375 ok (375x812 mobile): 0 JS exceptions, 16 external requests blocked`
- **Почистване:**
  - `bash exit 0`;
  - не е останал container, network или image с `t10.stage.run=20261020175820-2741`;
  - не е останал процес с временната директория на пуска, включително браузърът;
  - 48 s, `RESULT: PASS`.
- **Ограничение на доказателството от този пуск.** Анотацията беше отрязана около 4 KB след `S7 js exceptions: 0 (Runtime.exceptionThrow`. Затова последните редове (общият брой блокирани заявки, `S7 ok …` и `S7 cleanup …`) не се виждат в нея. Те са сред задължителните маркери, така че `RESULT: PASS` означава, че са отпечатани, но аз не съм ги прочел пряко. В крайния head изходът е разделен на две анотации (S1–S6 и S7), а заглавията на анотациите са без запетаи, защото запетаята ги отрязваше. Механиката на проверките не е променена.

| Сценарий | Статус на `bfd890c` |
|---|---|
| S1–S6 | PASS в реален disposable Docker |
| S7 (1280 и 375) | PASS в реален headless Chrome 155 срещу synthetic API и fake router |
| S7, изход със задържана заявка към сървъра | PASS (задържане 2000 ms, после HTTP 200) |
| S5b | NOT RUN |

## 7. Ограничения

- **S7 е браузър + реален synthetic сървър + fake router.** Това не е реален доставчик, реална пътна мрежа, ADR, физическа достоверност на камиона, правна оценка, лиценз или production.
- Плочките на картата са блокирани, така че картата е без подложка. Проверява се линията (`path`) в Leaflet слоя, не изображение.
- Headless Chrome на Linux не е мобилен Safari или Android. Ширината 375 е емулация (`Emulation.setDeviceMetricsOverride`).
- Изборът на „Не“ е с клавиатура (Tab + ArrowDown), не с отваряне на падащото меню.
- S5b остава NOT RUN.
- Доказателството е само за `9c6fbc9`. Бъдещи кандидат-версии не са покрити автоматично.
