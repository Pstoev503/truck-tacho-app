# STAGING-CANDIDATE-01 — disposable staging на приетия INT-31 (отчет)

- **Task:** #163. Автор: Claude. Проверява: Codex.
- **База на клона:** `f7750d7fea732c2a38cc982f082c46f5dd8329f4` (приетият STAGING-CI-01). Клонът `claude/staging-ci-01` остава само за четене.
- **APP:** `9c6fbc9d64041ac401c3cd87bcb3f4d2eaafc354` (INT-31), в отделен чист checkout само за четене.
- **Runbook:** `docs/runbooks/isolated-staging-check-v2.md`, Git blob `f0d7750ff89f8f4c6e5259e35e0cee419df53ce4`.
- **Head на harness-а:** записва се от всеки CI пуск в анотацията `inputs`. Той не е вграден в runner-а, за да няма кръгова зависимост.
- **Статус:** технически преглед, не сертификат за правно съответствие. Без production, реален доставчик, лиценз или merge.

## 1. Файлове (точно 5 нови)

| Файл | Роля |
|---|---|
| `docs/runbooks/isolated-staging-check-v2.md` | v2 runbook, изведен от приетия v1. Разликата е в раздел 9 на runbook-а. |
| `scripts/check-candidate-staging.py` | Runner-ът. Механиката е същата като на приетия `check-isolated-staging.py`; разликите са в 3. |
| `scripts/test-check-candidate-staging.py` | 27 теста със stub docker, без реален Docker. |
| `.github/workflows/candidate-staging.yml` | Само за този клон и тези 5 пътя. Права `contents: read`, `persist-credentials: false`, job до 15 мин., собствен checkout на APP. |
| `docs/reports/2026-10-20-STAGING-CANDIDATE-01.md` | Този отчет. |

Не съм пипал v1 runbook-а, приетия runner и тестовете му, съществуващите workflow-и, checker-ите, compose, env, зависимостите или runtime кода.

## 2. Действителният граф от файлове и старите проверки

Проверено локално от автора, без Docker:
- Стартирах `scripts/check-packaged-web.py` на `9c6fbc9` и на `b70c940`. Сравних списъците файл по файл:
  - `planner.html`: 21 файла, същите като преди.
  - `boss.html`: 12 → 15. Новите са точно `ui/api-error-message.mjs`, `ui/provider-geometry.mjs` и `ui/route-options-response.mjs`.
- Сравних `b70c940..9c6fbc9` (`git diff --stat`). Файловете `server/`, `server/Dockerfile`, `scripts/check-packaged-web.py`, `scripts/check-served-web.py` и `.github/` **не са променени**. Затова очакванията на S1–S5 (статуси, `detail`, брой заявки към router-а, тяло към router-а, конкурентни join-ове) остават буквално от v1. Променени са само `boss.html`, `engine/route.js` (+тест), трите нови helper-а (+тестове) и документи.

## 3. Runner: какво е същото и какво е различно спрямо приетия

Същото, без промяна в кода:
- Guard-ове преди първото извикване на Docker или bash: APP SHA, чист checkout, blob на runbook-а, маркери (уникални, с bash блок, всички от allowlist-а).
- Същият allowlist и ред. Блоковете се изпълняват дословно в един bash; добавени са само същите 2 оркестрационни реда, които се отпечатват.
- Таймаут с TERM към групата (така trap-ът на runbook-а се изпълнява), след 120 s — KILL.
- Проверка за останали ресурси само по точния label `t10.stage.run=<run>`. Временната директория трябва да е изчезнала.
- Изход: 0 = PASS, 1 = FAIL, 2 = guard. Не се отпечатват токени, пароли или средата.

Различно:
- `APP_SHA` е `9c6fbc9…`, а `RUNBOOK_BLOB` е `f0d7750…`, с път `docs/runbooks/isolated-staging-check-v2.md`. Константата `RUNBOOK_SHA` е махната. Head-ът на harness-а се записва при пуска (`GITHUB_SHA`).
- Очакваните маркери са `PASS: 21 …planner.html`, `PASS: 15 …boss.html`, `owner ok`, `S1 ok` … `S6 ok`, плюс 3 реда `S6 served boss: /ui/<нов helper>.mjs text/javascript`.
- Анотацията `runbook output` съдържа и редовете `S6 served <entry>: /<файл> <MIME>`, по един за всеки от 36-те файла.

## 4. Тестове (27)

| Група | Брой | Какво доказва |
|---|---|---|
| GuardTests | 6 | Грешен SHA, замърсен checkout, грешен blob, липсващ, дублиран или празен маркер → GuardError и 0 извиквания на docker |
| CliGuardTests | 6 | През CLI: същите случаи + без docker в PATH → exit 2, 0 docker, 0 bash, без Traceback. **Нов:** чужд checkout с копирани новите helper-и се отказва по SHA. |
| PinTests (нови) | 3 | runbook-ът закрепва същия SHA като runner-а. 21/15 и трите helper маркера съвпадат с **действителния** граф на APP. v2 се различава от v1 само в `vars`, `docker-2`, `s6` и коментара на `docker-7`. |
| S6BlockTests (нови) | 3 | Дословният v2 блок `s6` през runner-а срещу локален stdlib сървър: (а) 36 файла с точен MIME → PASS; (б) `.mjs` като `application/javascript` → FAIL; (в) липсващ нов helper → FAIL |
| ScriptTests | 2 | Скриптът е само дословните блокове + 2 оркестрационни реда; блок извън allowlist-а (вкл. `docker-7`) не влиза |
| CleanupTests | 7 | Image с пренасочен tag, чужди и без label ресурси, отказано изтриване на образ, неуспешна проверка, таймаут, останал ресурс с label, чист пуск |

Локално (автор, Python 3.13.16): `Ran 27 tests … OK`.

## 5. Реален Docker пуск в CI

Отчетът не може да съдържа пуска, който неговият собствен commit задейства. Затова тук е пускът на първия head на пакета (`5b4f567`), където runbook-ът, runner-ът, тестовете и workflow-ът са същите като на крайния. Крайният head и неговият пуск са в предаването в #163.

**Пуск на `5b4f567d8490c6ab9cd0892bcb3166752b2f604d`**

- run [39460488670](https://github.com/Pstoev503/truck-tacho-app/actions/runs/39460488670), job 118758372282, 16:47:17–16:47:54Z, success. Прочетени са метаданните на стъпките и `::notice` анотациите.
- **Входове:**
  - APP `9c6fbc9d64041ac401c3cd87bcb3f4d2eaafc354`;
  - RUNBOOK `docs/runbooks/isolated-staging-check-v2.md`, blob `f0d7750ff89f8f4c6e5259e35e0cee419df53ce4`;
  - harness `5b4f567…`;
  - Docker server 28.0.4.
- **Стъпка 5 (stub тестове):** `Ran 27 tests; failures 0, errors 0, skipped 0; OK`.
- **Стъпка 6 (реален Docker):**
  - пакетиране в образа без мрежа: `PASS: 21 local files reachable from planner.html in /app/web` и `PASS: 15 local files reachable from boss.html in /app/web`;
  - `owner ok`;
  - S1–S4: `ok`;
  - S5: `ok (old-code join: 200)`;
  - S6: 36 реда `S6 served …` — boss 15 и planner 21. Всеки файл е 200, с непразно тяло и точен MIME (`text/html`, `text/javascript`, `text/css`, `image/png`, `application/json`), включително `/ui/api-error-message.mjs`, `/ui/provider-geometry.mjs` и `/ui/route-options-response.mjs`. Обслуженият списък е равен на пакетирания. Последният ред е `S6 ok (served = packaged; planner 21, boss 15; exact MIME per file)`.
- **Почистване:** `bash exit 0`. Не е останал container, network или image с label `t10.stage.run=20261020164729-3274`. Временната директория е изтрита. Времето е 23 s, а резултатът — `RESULT: PASS`.

| Сценарий | Статус |
|---|---|
| S1–S6 | PASS в реален disposable Docker (`5b4f567`) |
| S5b | NOT RUN (няма fault injection в staging; покрит само от сървърния тест) |
| S7 | NOT RUN |

## 6. Ограничения

- **S7 е NOT RUN.** Няма браузър, реален сървър с реален маршрутизатор и E2E. Няма изводи за ADR, правна страна, физическа достоверност на камиона, лиценз или production.
- Fake router-ът е в synthetic private bridge мрежа и не доказва поведение на реален provider.
- S6 проверява HTTP отговорите (статус, непразно тяло, точен MIME) и графа на референциите. Не изпълнява JavaScript в браузър.
- Доказателството е само за закрепения APP `9c6fbc9`. Бъдещи кандидат-версии (например чакащата поправка на брояча) **не са покрити**. Няма твърдение за автоматичен повторен тест.
- Proxy-то в средата на автора връща 403 за job логовете. Авторът чете само метаданните на стъпките и `::notice` анотациите. Пълният лог е за Codex.
