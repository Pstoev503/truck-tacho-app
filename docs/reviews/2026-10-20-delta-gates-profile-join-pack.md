# Delta гейтове: профил на камиона, еднократна покана, шефски екран в образа

Вход: INT-27 `b70c940a5a73a978c7eec8dfed3b03cd7dfb6d8f`, CI run [39415985295](https://github.com/Pstoev503/truck-tacho-app/actions/runs/39415985295) success. Codex е прочел 4-те лога: 257 PostgreSQL server, 685 Node, 43 fixtures, 21 planner и 12 boss файла в образа и през HTTP. Автор: Claude (RELEASE-GATES-02 #147), 20.10.2026.

Това е **delta** към последните приети пакети. Не е общ одит, не е production приемане и не е правно заключение. Старите формулировки „pending“ в M1–M5 бележките не се пренаписват; тук е само текущото състояние за четирите области.

## Легенда

- **Решение:**
  - **covered:** поведението е доказано в посочения обхват;
  - **open:** нужна е истинска външна информация, отделно изпълнение или поправка;
  - **not-in-scope:** не е цел на тези пакети.
- **Произход на доказателството:**
  - **CI (Codex read logs):** immutable CI run, чиито логове е прочел Codex. Авторът (Claude) не може да чете логовете в своята среда (proxy 403).
  - **Codex probes:** независими проверки на Codex, описани в коментара му за приемане.
  - **author:** проверка на автора (Claude) в scratch, описана в отчет или коментар.
  - **report:** твърдение в отчета на пакета.
- **Injected/mock ≠ live.** Тестовете с injected `urlopen`, fake router или fake DOM доказват логиката на приложението, а не реален маршрутизатор или браузър.

## Приети пакети, на които се основава матрицата

| Пакет | Task / PR | Приет SHA | Приемане | Общ кандидат и CI |
|---|---|---|---|---|
| PROFILE-02 (server, задължителен профил) | #117 / #118 | `0df5d7667a263cd0b580b8d719b2fd41d1a1150c` | [коментар](https://github.com/Pstoev503/truck-tacho-app/pull/118#issuecomment-6282008477) | INT-23 `e498be89162e7a2b3612d215e9d5fc7ba72ed1c9`, run [39359390779](https://github.com/Pstoev503/truck-tacho-app/actions/runs/39359390779): 228 PG / 652 Node (Codex read logs) |
| ROUTE-RESPONSE-01 (ограничен upstream JSON) | #129 / #130 | `1f4f39d90d3eac084e1c43f35787d1f22467ef04` | [коментар](https://github.com/Pstoev503/truck-tacho-app/pull/130#issuecomment-6283504403) | INT-24 `f0dcd90d2845b064ba408608c9a3511adb3837e4`, run [39370490945](https://github.com/Pstoev503/truck-tacho-app/actions/runs/39370490945) (Codex: success по immutable head) |
| PROFILE-UI-01 (UI, ръчен профил) | #125 / #126 | `adbef5bb5ccb28c408868908bb282ed72a82e4a4` | [коментар](https://github.com/Pstoev503/truck-tacho-app/pull/126#issuecomment-6286004267) | INT-25 `c0afe5b423f54cdcb12402fb4043828cb956d5e7`, run [39387490311](https://github.com/Pstoev503/truck-tacho-app/actions/runs/39387490311): 685 Node / 246 PG (Codex read logs) |
| JOIN-RACE-01 (еднократна покана) | #133 / #134 | `359658ce94e6732bdbaf3f6c3f29c66d7957d581` | [коментар](https://github.com/Pstoev503/truck-tacho-app/pull/134#issuecomment-6288997489) | INT-26 `d1d0151f52be967703bc6d0574329e5cf69a7351`, run [39401629773](https://github.com/Pstoev503/truck-tacho-app/actions/runs/39401629773): 257 PG / 685 Node (Codex read logs). Source run-ът е `action_required`, не pass |
| PACK-BOSS-01 (шефски екран в образа и през HTTP) | #137 / #138 | `efaa5206a71f9cb899185f58766fea949e074192` | [коментар](https://github.com/Pstoev503/truck-tacho-app/pull/138#issuecomment-6289970743) | INT-27 `b70c940…`, run [39415985295](https://github.com/Pstoev503/truck-tacho-app/actions/runs/39415985295) (Codex read logs) |

Всички SHA-та и run-ове по-горе са проверени от автора през GitHub API: commit-ът съществува, а run-ът е `completed/success` на посочения head.

## Матрица

### A. Профил на камиона на сървъра и произход

Файлове на входа: `server/app/main.py` (`RouteOptionsIn`, `route_options`), `server/app/truck_profile.py`, `docs/contracts/route-options-truck-v1.md`, `docs/contracts/truck-profile-v1.md`, `server/tests/test_api.py`, `server/tests/test_truck_profile.py`.

| # | Гейт | Наблюдавано поведение | Доказателство (произход) | Граница | Решение | Следващо / собственик / зависимост |
|---|---|---|---|---|---|---|
| A1 | Липсващ, частичен или невалиден профил не води до изходяща заявка | 422 преди мрежа и квота | `test_route_options_missing_profile_rejects_before_egress_or_budget`, `…incomplete_profile…`, `…invalid_profile…` (CI, Codex read logs); 87 Codex probes; author DRY-RUN S1: 422, 0 заявки към fake router | Injected urlopen и fake router | covered | — |
| A2 | `ignore_access` / `ignore_restrictions` в профила се отказват | 422, 0 мрежа, 0 квота | `test_route_options_rejects_access_bypass_options_before_egress_or_budget` (CI) | — | covered | — |
| A3 | Валиден профил стига непроменен до `costing_options.truck` | Точни 7 полета, без конверсия, без `label` в `locations` | `test_route_options_maps_distinct_profiles_without_mutating_input` (CI, injected urlopen); author: 300 UI body-та срещу `e498be8` с fake `urlopen` ([#125](https://github.com/Pstoev503/truck-tacho-app/issues/125#issuecomment-6282076460)); author DRY-RUN S3 с fake router по HTTP | **Не е реален маршрутизатор** | covered (mapping) | Ефектът при реален provider е в E1 |
| A4 | Неконфигуриран маршрутизатор → 503 без изходяща заявка | 503 „Маршрутизаторът не е активиран“ | `test_route_options_rejects_missing_or_invalid_router_without_egress`, `test_route_options_invalid_config_does_not_consume_budget` (CI); author DRY-RUN S2 | — | covered | — |
| A5 | Отговорът на маршрутизатора е ограничен; NaN/∞/дълбочина → общ 503/502 | Ограничен размер, depth 100, общи грешки | ROUTE-RESPONSE-01: CI на INT-24 и 45 Codex probes (synthetic, не PG/live) | Depth 100 е guard на приложението, не лимит на provider | covered | — |
| A6 | Физическата достоверност на въведените стойности (височина, маса, оси, hazmat) | Ръчно въведени и непроверени; без default | Договорите и отчетите (report) | Схема и CI не доказват истинност | **open** (M4b-profile) | Източник и жизнен цикъл на реалните данни за камиона; собственик: Павел (бизнес решение) |

### B. Профил в UI и произход на линията

Файлове: `boss.html`, `ui/truck-profile-input.mjs`, `ui/truck-profile-input.test.mjs`.

| # | Гейт | Наблюдавано поведение | Доказателство (произход) | Граница | Решение | Следващо / собственик / зависимост |
|---|---|---|---|---|---|---|
| B1 | 7 празни контрола, изричен hazmat избор, без default | Без `value`, `autocomplete=off`, „Избери/Не/Да“ | Node тестове в CI (Codex read logs: 685); Codex mock browser | — | covered | — |
| B2 | Строг parser, без заявка без валиден профил, точно body | Отказ на непълен или невалиден профил; body с точно 3 полета | Node тестове (CI); author mocked Chromium smoke | Mock API | covered | — |
| B3 | Остарели отговори и грешки се пренебрегват; изходът е незабавен | Generation-контролер; локалният изход не чака сървъра | 6 изпълними теста върху реалния inline скрипт в Node `vm` (CI); Codex mock browser (8 s забавен logout → 459 ms локален изход) | Fake DOM / mock; не реален сървър | covered | — |
| B4 | Линия от маршрутизатора не се възстановява от draft-а; неизвестният произход е „непотвърден“ | Draft geometry `[]` за provider линия; етикет „непотвърден произход“ | Изпълними `vm` тестове и сравнение стар срещу нов (author, повторено от Codex) | Линии с непотвърден произход не се махат при смяна на профила | covered (в сесия) | — |
| B5 | Съобщение при 422 от `/api/route-options` | Съществуващият `api()` показва общо съобщение за парола/имейл | Отчет PROFILE-UI-01 (report) | При валиден клиентски профил е рядко | **open** (нисък) | Отделен малък UI пакет при нужда; собственик: Codex (възлагане) |
| B6 | Реален браузър + реален сървър + реален маршрутизатор | Не е изпълнено | — | — | **open** | Runbook S7 (ръчно) + E1 (реален маршрутизатор) |

### C. Еднократна покана: claim, свежа валидност, ред на заключванията, rollback

Файлове: `server/app/main.py` (`join`, `make_invite`), `docs/contracts/join-single-use-v1.md`, `server/tests/test_api.py`.

| # | Гейт | Наблюдавано поведение | Доказателство (произход) | Граница | Решение | Следващо / собственик / зависимост |
|---|---|---|---|---|---|---|
| C1 | Едновременни join за един код → 1 токен, губещият получава общ 404 | Условен `UPDATE … RETURNING` | `test_concurrent_join_claims_one_invite_once`, `test_five_concurrent_joins_leave_one_new_token_and_preserve_old_state`, `test_concurrent_normalized_invite_aliases_share_one_claim` (CI на INT-26, PostgreSQL); author DRY-RUN S4: 200 + 404, трети опит 404 | Една машина, един процес | covered | — |
| C2 | Валидността се проверява след заключването (изтичане, активност) | Свежо време и `active` под row lock | `test_join_rechecks_expiry_after_waiting_for_driver_row_lock`, `test_join_rechecks_driver_activity_after_waiting_for_driver_row_lock` (CI); 11 Codex probes (SQL compile, не локален PG) | — | covered | — |
| C3 | Подновяване срещу join без deadlock | Ред: шофьор → покана | `test_concurrent_join_and_reinvite_use_driver_then_invite_lock_order` (CI); author DRY-RUN S5 (1 пуск, < 1 s) | Един пуск не доказва липса на deadlock | covered | — |
| C4 | Rollback при грешка при издаване на токен; повторният опит работи | Няма частични промени | `test_join_claim_rolls_back_if_token_issuance_fails` (CI, fault injection) | Не е изпълнимо в staging без инжекция | covered (само CI) | — |
| C5 | Throttle при много worker-и или разпределени ботове | In-memory, per process | README и договорът (report) | Не е разпределена защита | **not-in-scope** | Решение при deploy: един worker или споделен лимитер; собственик: решение на Павел за хостинга |

### D. Шефският екран в образа и през HTTP

Файлове: `scripts/check-packaged-web.py`, `scripts/check-served-web.py`, `scripts/test-check-served-web.py`, `.github/workflows/tests.yml`.

| # | Гейт | Наблюдавано поведение | Доказателство (произход) | Граница | Решение | Следващо / собственик / зависимост |
|---|---|---|---|---|---|---|
| D1 | Графът на `boss.html` (вкл. inline module imports) е в образа | 12 файла, вкл. `ui/truck-profile-input.mjs`; planner 21 | CI стъпка „Шефският екран е в образа…“ (Codex read logs, run 39415985295) | Регулярни изрази, не JS изпълнение | covered | — |
| D2 | Същият граф през HTTP: 200, непразно тяло, JS MIME | `text/javascript` за `.mjs` | CI стъпка „Шефският екран през HTTP…“ (Codex read logs); author DRY-RUN S6 с реалния app | — | covered | — |
| D3 | HTTP checker-ът не приема credentials в base URL | exit 2 преди заявки, без ехо | 43 fixtures (CI); Codex probes | — | covered | — |
| D4 | Страницата работи коректно в браузър | — | — | Checker-ът не е браузър проверка | **not-in-scope** за D | Виж B6 |

### E. Оставащи зависимости (извън кода)

| # | Зависимост | Състояние | Защо CI не я затваря | Решение | Следващо / собственик |
|---|---|---|---|---|---|
| E1 | Реален маршрутизатор (Valhalla или друг): хостинг, данни, лиценз и условия, диапазони и поведение при профил | Няма настроен; `VALHALLA_URL` липсва по подразбиране | Всички тестове ползват injected `urlopen` или fake router | **open** | Избор на provider или собствен хост и потвърждение на лиценза и условията на данните. Собственик: Павел (решение и разход); след това отделен пакет за проверка с реален маршрутизатор |
| E2 | ADR и опасни товари | `hazmat` е само да/не | Няма ADR клас, тунелни кодове или документи | **open** | Не се решава от UI/CI; нужен е отделен анализ на изискванията |
| E3 | Данни за трафик и пътища (DATEX/АПИ) и лиценз | Писмото до АПИ (с копие до НТД) е изпратено на 20.10 в 11:11; чака се отговор | Външна институция | **open** (EXT-01) | Контрол на 27.10.2026 в 11:15 или при реален отговор. Собственик: Codex следи; **без** ново писмо от Павел |
| E4 | Изолирана staging проверка в Docker | Runbook-ът е готов; Docker стъпките са NOT RUN | В тази среда няма Docker | **open** | Изпълнение по `docs/runbooks/isolated-staging-check-v1.md` на машина с Docker. Собственик: възлагане от Codex |
| E5 | Production: домейн, TLS, архиви, мониторинг, GDPR уведомление | Описано в `server/README.md`; не е изпълнено | Не е цел на CI | **not-in-scope** тук | Преди пилот: отделни решения на Павел (хостинг/плащане) и юрист за уведомлението |
| E6 | Обща правна пригодност на маршрутите и продукта | Няма заключение | — | **not-in-scope** | — |

## Обобщение

- **Covered в обхвата си:** A1–A5, B1–B4, C1–C4, D1–D3. Доказателствата са от CI (логовете са прочетени от Codex), от независими проверки на Codex и от проверки на автора.
- **Отворени:**
  - A6 (M4b-profile: истинност на данните);
  - B5 (съобщение при 422);
  - B6 (реален браузър + сървър + маршрутизатор);
  - E1–E4.
- **M4b-profile остава отворен.** Схемата, UI-ят и зеленият CI не го затварят.
