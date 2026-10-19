# Интеграционен план v1 — приетите версии към `main`

Автор: Claude (INT-02, #42). Приемане: Codex. Дата: 19.10.2026 (Europe/Sofia). Документът е план. Не е merge, не е изпълнен интеграционен PR и не е правно одобрение.

## 1. Изходно положение (REST API, 19.10.2026 ~01:10 UTC)

| Ref | SHA |
|---|---|
| `main` | `26ef2442910757d4427670de38d61d6b78d1ad99` |
| `shef` (= head на PR #7) | `449dc5e047e9e71b5fdd0c9a22a3331b8e16e4be` |
| CI-01 (`claude/ci-01-ui-integration`, PR #41) | `fa19f2148017526bced0213e41ee8dc5d8bc45c6` |

API compare:
- `main...fa19f21`: `ahead` 44, `behind` 0, 50 файла.
- `shef...fa19f21`: `ahead` 31, `behind` 0, 22 файла.
- Локално `git merge-base --is-ancestor`: `main` → `shef` → `fa19f21`.

Изводи:
- **`fa19f21` е линеен наследник на `main`.** PR от `fa19f21` към `main` не може да има конфликт, докато `main` е на `26ef244`.
- **Съставът наследява целия #7.** `fa19f21` = `shef` + 22 файла.

### Приети пакети и реалните им head-ове (#18 срещу API)

| Пакет | PR | Head по API | Приет head в #18 | Съвпада | Ancestor на `fa19f21` |
|---|---|---|---|---|---|
| PLAN-01 | #14 | `423e2e5e9e549cd2d56c5eb88443586b3f15239d` | същият | да | да |
| PLAN-02 | #15 | `bdddd307c4729985ba82a34f2d3d4a0af67a71df` | същият | да | да |
| GEO-01 | #16 | `d9f009cd9c70f49ec4f6b77053ae4a7358988e0d` | същият | да | не (пренесен като blob) |
| PLAN-03 | #17 (draft) | `889be5983b7993a040020643b3b86d8f4749670f` | същият | да | не (пренесен като blob) |
| MAP-01 | #25 | `80b25535e87177e3ebe4026c9ad81943dd7d246f` | същият | да | да |
| PLAN-04 | #27 | `007a75c77bde6213015567b84ddffe6940b2fa83` | същият | да | не (пренесен като blob) |
| UI-01 | #34 | `909f77067f3b3588b30c9f673fd1e7f7ba96a831` | същият | да | да |
| PLAN-05 | #35 | `5ff4eeb32c2a14c0bb1c81f8fa4a1e9e53bc2b2f` | същият | да | не (пренесен като blob) |
| INT-01 | #37 | `272bcebafacbf79ed576f2e011a8298f21a683ec` | същият | да | не (пренесен като blob) |
| CI-01 | #41 | `fa19f2148017526bced0213e41ee8dc5d8bc45c6` | същият | да | е самият състав |

„Пренесен като blob“ означава, че Codex е добавил точния файл със staging commit (`Stage verified …`, `accepted PLAN-05 …`, `preserve accepted …`) вместо merge. Затова ancestry не е доказателство; доказателство е съвпадението на blob-а (раздел 2).

Документационни пакети **извън** `fa19f21`, приети в #18:

| Пакет | PR | Head | База | Файлове (всички нови пътища, липсват във `fa19f21`) |
|---|---|---|---|---|
| ORG-01 | #9 | `d69b8c84f1066dca8c22894b7792fdaa39c3b3d9` | `main` | `docs/project/BASELINE.md`, `FILE-OWNERSHIP.md`, `REPOSITORY-LAYOUT.md`, `docs/reports/2026-10-16-repository-coordination.md` |
| DATA-01 | #11 | `d636657395c4782fb0438aab1a02c052d473db0d` | `main` | `docs/providers/bg-datex-acceptance.md`, `bg-datex-discovery.md`, `bg-datex-rfi.md`, `docs/reports/2026-10-16-bg-datex-discovery.md` |
| TI-01 | #21 | `19195ebda7de33ee6d90a16d07f342057cff3d97` (приета семантика `475d9a55fefd45582ae4fbe040220b05254086c4`) | `shef` | `docs/traffic-intelligence/CONTRACT-v0.1.md`, `QUALITY-v0.1.md`, `SCENARIOS-v0.1.md`, `docs/reports/2026-10-17-TI-01.md`. `475d9a5..19195eb` променя само отчета (report-only) |
| RULES-01 | #23 | `eeef390c3193391859ed6ebb0b15710a49ecd277` | PLAN-02 | `docs/rules-audit/RULES-01.md`, `RULES-01-scenarios.md`, `docs/reports/2026-10-18-RULES-01.md` |
| RULES-02 | #30 | `f20717b6b45dd1e8b4bfc4eb9776dca9b3c4b90e` | PLAN-04 | `docs/rules-audit/RULES-02-PLAN-04-review.md`, `docs/reports/2026-10-19-RULES-02.md` |

**Изключени (неприети към възлагането):** UI-02 #40 (`54ccefab…`, 7 файла: `planner.html`, `ui/map-planner.*`, `ui/planner-initial-state*`, отчет) и TI-02 #31 (`f910efba…`, `engine/traffic-contract.js/.test.js`, отчет). TI-01 примерите имат грешни refs, поправени само в неприетия TI-02, затова TI-01 не се обявява за окончателно готов.

## 2. Окончателни приети blob-ове във `fa19f21`

Всеки от 22-та файла, различни от `shef`, е проследен до последния приет пакет. За всеки е проверено `git rev-parse <приет head>:<път> == git rev-parse fa19f21:<път>`. Seed/report-only commit-ите (`b80e9cb`, `89718e7`) са надписани от финалните отчети и не оставят собствено съдържание.

| Файл | Окончателен източник | Blob във `fa19f21` | = приетия head |
|---|---|---|---|
| `.github/workflows/tests.yml` | CI-01 #41 (надгражда #7) | `32f4c665cb4333dbfe8b9faac9a05d7918015e5d` | да |
| `docs/planner-contract-v1.md` | PLAN-03 #17 | `fef59da4fd3d1aa3ec137ac5a305cf3926a654ed` | да |
| `docs/reports/2026-10-18-GEO-01.md` | GEO-01 #16 | `dbffd5cf92e6285525327af497e763f131091362` | да |
| `docs/reports/2026-10-18-PLAN-01.md` | PLAN-01 #14 | `41d660411c0abf4af04561884439e82e55bb5dd9` | да |
| `docs/reports/2026-10-18-PLAN-02.md` | PLAN-02 #15 | `7b255b3e2e6f8b5975a7006da2472ba050a6ac2d` | да |
| `docs/reports/2026-10-19-CI-01.md` | CI-01 #41 | `6f05e039ab79666e1fa04f2a573af8a8b4deab00` | да |
| `docs/reports/2026-10-19-INT-01.md` | INT-01 #37 | `d5d41c193cdb9f6f7776040c678e06de0e333a9a` | да |
| `docs/reports/2026-10-19-MAP-01.md` | MAP-01 #25 | `59054d39bdd16304b020b802e022b42519361056` | да |
| `docs/reports/2026-10-19-PLAN-04.md` | PLAN-04 #27 | `3d7ee6eae13b95111d6bda847c2ef0fa665e5bdc` | да |
| `docs/reports/2026-10-19-PLAN-05.md` | PLAN-05 #35 | `43f73093a6031a4a532829fdf4f1eed857fd3340` | да |
| `docs/reports/2026-10-19-UI-01.md` | UI-01 #34 | `875f71e7abbe75aa275b101010def86ed31e723e` | да |
| `engine/map-plan.js` | MAP-01 #25 | `1da4b91f90228b33f46162c04b1bbb3fc4dbeb5e` | да |
| `engine/map-plan.test.js` | MAP-01 #25 | `c49507249847dc6949c3f70b0f4c3fa412e00930` | да |
| `engine/plan.js` | PLAN-05 #35 (надгражда #14 → #15 → #27) | `0397d69f16220f31a22495695d62e22ee61b9ae1` | да |
| `engine/plan.test.js` | PLAN-05 #35 (надгражда #14 → #15 → #27) | `b3dedaee902fb7c1c0dcb5874c6011f41c333c2d` | да |
| `engine/route-position.js` | GEO-01 #16 | `5bd31f63745c5f2f1fad9c6eb0a57735be716ef7` | да |
| `engine/route-position.test.js` | GEO-01 #16 | `3683719800bfbc4244ec016da8b84b57d067ace3` | да |
| `integration/map-plan-rest.integration.test.mjs` | INT-01 #37 | `09fe1c8867f635f0475235d75b058e9fc499baae` | да |
| `planner.html` | UI-01 #34 | `67707dd6a1d3839a52521fa2a56d58f56434cb03` | да |
| `ui/map-planner.css` | UI-01 #34 | `68160ac2a78121a444d5355f1be36ebbddc65cb9` | да |
| `ui/map-planner.mjs` | UI-01 #34 | `a3043eded6c8592aa306911da18b8ae3df405d05` | да |
| `ui/map-planner.test.mjs` | UI-01 #34 | `98aa8e1a50ff29c0ca007d56b95da0ddd35f8ac8` | да |

Останалите 28 файла от #7 са непроменени във `fa19f21` (същите blob-ове като `shef`). Единствената разлика от #7 е `tests.yml`, надграден от CI-01.

## 3. Припокривания между пакетите

| Път | Пакети, които го пипат | Окончателен blob | Бележка |
|---|---|---|---|
| `engine/plan.js`, `engine/plan.test.js` | #14, #15, #27, #35 (и неприетият локален оригинал) | PLAN-05 `0397d69` / `b3dedae` | Междинните head-ове #14/#15/#27 **не** трябва да се сливат отделно след интеграцията: всеки би върнал по-стар blob |
| `.github/workflows/tests.yml` | #7, #41 | CI-01 `32f4c66` | #41 съдържа #7 + новия job |
| `planner.html`, `ui/map-planner.*` | #34; неприетият #40 | UI-01 | #40 е следващ gate, не част от кандидата |
| `docs/reports/2026-10-19-MAP-01.md`, `…-UI-01.md` | seed commit + финален отчет | финалният | seed-овете нямат самостоятелна стойност |
| Документационни пакети #9/#11/#21/#23/#30 | само собствени нови пътища | — | Без припокриване с кандидата или помежду си |

## 4. Зависимост от #7 — задължителен gate

`fa19f21` не може да се интегрира без #7, защото приетият runtime реално зависи от файлове, въведени само в #7:

- `engine/plan.js:2` — `import { haversineKm } from './route.js'`. `engine/route.js` идва от #7.
- `planner.html:8,59` — `vendor/leaflet-1.9.4/leaflet.css` и `leaflet.js` идват от #7.
- jobs `server` и `docker` в `tests.yml` пускат `server/` от #7.

#7 (29 файла: `server/` FastAPI с профили/сигурност, `boss.html`, `index.html`, `engine/sync.js`, `engine/route.js`, `sw.js`, `vendor/leaflet-1.9.4`, `.gitignore`, `README.md`, `tests.yml`) **не е приет** като самостоятелен пакет в #18. Приемането на PLAN/MAP/UI не го приема. BASE-01 освен това е намерил 12 разлики и 8 само локални файла между локалната папка и `shef`.

**Предпоставка G1 — review на #7 @ `449dc5e`** (отделна задача, не част от интеграцията):
1. `server/app/security.py`, `main.py`, `models.py`, `db.py`: автентикация, пароли/токени, регистрационен код, достъп между фирми, валидация на входа. Изпълнение на `server/tests/test_api.py` (вече в CI job `server`).
2. `server/deploy/.env.example`, `docker-compose.yml`, `Dockerfile`: проверено е, че трите стойности в `.env.example` са празни. Остава преглед на портове, volumes и потребител в контейнера.
3. `vendor/leaflet-1.9.4/`: сверка на `leaflet.js`/`leaflet.css` с официалния 1.9.4 (hash) и наличие на `LICENSE`.
4. `engine/route.js`, `engine/sync.js` с тестовете им; `index.html`, `boss.html`, `sw.js`: функционален и privacy преглед (какво се синхронизира към сървъра).
5. Решение на Павел дали `shef` (а не локалната папка) е изходната истина за тези 29 файла, предвид BASE-01.

Без G1 интеграционният PR трябва да остане Draft/неслят.

## 5. Единствен предложен път

**Кандидат:** точно `fa19f2148017526bced0213e41ee8dc5d8bc45c6`, без нови commit-и. Той вече съдържа всички приети runtime пакети с проверени blob-ове и CI за engine + UI + integration + server + docker.

Последователност:

1. **G1:** review на #7 @ `449dc5e` по раздел 4. Ако излязат поправки, те стават нов приет head на `shef` и кандидатът се изгражда отново (стъпка 2а).
2. **Интеграционен PR (Codex, изолирана подготовка):**
   - а) Нов клон `codex/int-03-candidate` точно от `fa19f21` (или от новия `shef` + повторено пренасяне на 22-та blob-а, ако G1 промени `shef`).
   - б) PR към `main`, Draft до G1. Очакван diff: 50 файла (28 от #7 + 22 от раздел 2), без конфликт (`behind` 0).
   - в) Преди Ready: blob проверка (раздел 6) и CI run по head.
3. **Сливане (решение на Павел, не на агент):** с merge commit, не squash, за да се запази проследяването към staging commit-ите и PR номерата.
4. **След сливането (решение на собственика):** затваряне като „включени“ на #7, #14, #15, #16, #17, #25, #27, #34, #35, #37, #41. Те не трябва да се сливат отделно, защото #14/#15/#27 биха върнали стари blob-ове на `plan.js`.
5. **Документационен PR (отделен, по избор):** от новия `main`, с точните blob-ове на #9, #11, #23, #30. TI-01 #21 се отлага, докато TI-02 не бъде приет с erratum-а на примерите.
6. **Следващи gates, извън този кандидат:** UI-02 #40 (върнат за `storage.clear`/`key:null`) и TI-02 #31 (без receipt). Всеки — като отделен PR върху новия `main` след собственото си приемане.

**Очаквана крайна файлова конфигурация след стъпка 3:** дървото на `fa19f21`, т.е. `main@26ef244` + 29-те файла на #7 (с `tests.yml` от CI-01) + 21-те други файла от раздел 2. Без `ui/planner-initial-state*`, `engine/traffic-contract*` и без документите от стъпка 5.

## 6. Проверки за бъдещия състав

Върху кандидата (в корена на checkout-а):

```
cd engine && node --test              # очаквано 191/191
node --test ui/*.test.mjs             # очаквано 21/21
node --test integration/*.test.mjs    # очаквано 8/8
```

Общо 220, колкото е CI-01. CI job-овете `server` (pytest с PostgreSQL 16) и `docker` (build) трябва да са success по точния head.

Проверка, че всеки включен source файл е приетият blob:

```
for pair in \
  "engine/plan.js 5ff4eeb32c2a14c0bb1c81f8fa4a1e9e53bc2b2f" \
  "engine/plan.test.js 5ff4eeb32c2a14c0bb1c81f8fa4a1e9e53bc2b2f" \
  "engine/map-plan.js 80b25535e87177e3ebe4026c9ad81943dd7d246f" \
  "engine/map-plan.test.js 80b25535e87177e3ebe4026c9ad81943dd7d246f" \
  "engine/route-position.js d9f009cd9c70f49ec4f6b77053ae4a7358988e0d" \
  "engine/route-position.test.js d9f009cd9c70f49ec4f6b77053ae4a7358988e0d" \
  "planner.html 909f77067f3b3588b30c9f673fd1e7f7ba96a831" \
  "ui/map-planner.mjs 909f77067f3b3588b30c9f673fd1e7f7ba96a831" \
  "ui/map-planner.css 909f77067f3b3588b30c9f673fd1e7f7ba96a831" \
  "ui/map-planner.test.mjs 909f77067f3b3588b30c9f673fd1e7f7ba96a831" \
  "integration/map-plan-rest.integration.test.mjs 272bcebafacbf79ed576f2e011a8298f21a683ec" \
  ".github/workflows/tests.yml fa19f2148017526bced0213e41ee8dc5d8bc45c6"; do
  set -- $pair
  [ "$(git rev-parse CANDIDATE:$1)" = "$(git rev-parse $2:$1)" ] && echo "OK $1" || echo "DIFF $1"
done
git diff --stat 449dc5e047e9e71b5fdd0c9a22a3331b8e16e4be CANDIDATE   # очаквано точно 22 файла
```

(`CANDIDATE` е head на интеграционния клон. Отчетите се проверяват по таблицата в раздел 2.)

**Ръчен браузърен flow** на `planner.html` (UI-01), по критериите на Codex:
1. Чертане на маршрут.
2. Задаване на тип път по секции.
3. Invalidation при промяна на маршрута или изборите.
4. Относително време.
5. Маркери за почивка (теоретични, не паркинги).
6. Clear.

Отделно: `index.html` и `boss.html` от #7 като част от G1.

## 7. Какво не е направено

- Локален merge rehearsal към `main` **не** е изпълняван. Твърдението „без конфликт“ стъпва на ancestry (`behind` 0), а не на изпробван merge.
- Тестове на различен състав (например с документационните пакети или с ново `shef`) не са пускани.
- Сверката на Leaflet с upstream не е правена.
- G1 не е започвана; тя е отделна задача.
