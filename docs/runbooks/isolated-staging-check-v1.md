# Изолирана staging проверка v1 (disposable, loopback, synthetic)

Версия на входа: INT-27 `b70c940a5a73a978c7eec8dfed3b03cd7dfb6d8f`. Автор: Claude (RELEASE-GATES-02 #147). Не е production процедура, не е deploy и не е одобрение.

**Статус на командите.**
- **NOT RUN:** нито една Docker стъпка от този runbook не е изпълнена от автора, защото в работната среда няма Docker демон.
- **Пробно пуснати локално:** HTTP стъпките на сценариите S1–S6. Те са пуснати срещу реалния `app.main:app` с uvicorn и disposable PostgreSQL, **без Docker**. Резултатите са в `docs/reports/2026-10-20-RELEASE-GATES-02.md`.
- Всяка стъпка по-долу е отбелязана **NOT RUN** или **DRY-RUN (локално, без Docker)**.
- Очакваните резултати са изведени от кода на входната версия и от съществуващите тестове. Те не са наблюдавани в Docker.

## 1. Граници

- **Мрежа.** Само loopback на машината, която прави проверката. Отделна Docker bridge мрежа `t10-stage-net`. API-то се публикува **само** на `127.0.0.1`; базата и fake router-ът нямат публикувани портове. Приложението прави изходящи заявки само към `VALHALLA_URL`, който тук е fake router-ът. Мрежата не е `--internal`, защото публикуван порт към internal мрежа не е надежден на всички платформи.
- **Данни.** Само synthetic: адреси `*.test`, synthetic имена и код за регистрация, генерирана временна парола за базата. Не се ползват `.env`, `server/deploy/.env`, Datex, `par.txt`, реални имейли или реални credentials.
- **Маршрутизатор.** Няма реален маршрутизатор. `VALHALLA_URL` сочи към локален fake router в същата изолирана Docker мрежа. Той връща фиксиран synthetic отговор и записва получените заявки. **Не доказва** поведение на реален provider, диапазони, ADR или пътна достъпност.
- **Docker ресурси.** Само ресурси с изрично име и префикс `t10-stage-`: 1 мрежа, 3 контейнера, 1 образ. Базата е на `tmpfs`, без volume. Без mount на работни директории (напр. `C:\Top10EU`) и без `docker system prune`/`volume prune`/`rm $(docker ps -aq)`. Освен двата скрипта, които runbook-ът създава във временна директория, не се mount-ват файлове.
- **Без `server/deploy/docker-compose.yml`.** Този compose публикува 80/443 през Caddy и ползва именуван volume `pgdata`; той е за реален хост и **не се** ползва тук.
- **Таймаути.** Всяко чакане е ограничено: readiness до 60 s, всяка HTTP заявка до 15 s.

## 2. Предпоставки (prerequisites / gates)

| # | Предпоставка | Ако липсва |
|---|---|---|
| P1 | Linux или macOS shell (bash), Docker Engine с права за `docker build/run/network` | Спри: проверката не може да се направи. Не заобикаляй с compose или с чужда база. |
| P2 | Git checkout точно на `b70c940a5a73a978c7eec8dfed3b03cd7dfb6d8f` (`git rev-parse HEAD`) | Спри или запиши точния различен SHA в доказателствата. |
| P3 | `python3` (3.10+) на хоста за двата checker скрипта и JSON обработката | Спри стъпките S5 и S6. |
| P4 | `curl` на хоста | Спри. |
| P5 | Свободни loopback порт `18080` и имената `t10-stage-*` (стъпка 0) | Избери друг порт или спри; не трий чужди ресурси. |
| P6 | Мрежов достъп за изтегляне на `python:3.13-slim` и `postgres:16` (или вече налични локално) | Спри. |
| P7 | Браузър (Chromium, Firefox или Safari) за ръчния сценарий S7 | S7 остава NOT RUN; останалите не зависят от него. |

## 3. Променливи

```bash
# NOT RUN
set -euo pipefail
export T10_SHA=b70c940a5a73a978c7eec8dfed3b03cd7dfb6d8f
export T10_IMG=t10-stage-api:${T10_SHA:0:12}
export T10_NET=t10-stage-net
export T10_DB=t10-stage-db
export T10_API=t10-stage-api
export T10_ROUTER=t10-stage-router
export T10_PORT=18080
export T10_BASE=http://127.0.0.1:${T10_PORT}
export T10_DIR="$(mktemp -d -t t10-stage-XXXXXX)"          # само за този runbook
export T10_DB_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_hex(16))')"   # временна, не се записва никъде
export T10_REG_CODE=synthetic-staging-registration-code
```

`T10_DB_PASSWORD` е временна и живее само в shell сесията. Не я записвай в доказателствата.

## 4. Стъпки

### Стъпка 0 — предварителна проверка (NOT RUN)

```bash
test "$(git rev-parse HEAD)" = "$T10_SHA"
test -z "$(docker ps -aq --filter name='^t10-stage-')" || { echo "t10-stage-* containers exist: stop, do not delete foreign resources"; exit 1; }
test -z "$(docker network ls -q --filter name='^t10-stage-net$')" || { echo "network exists"; exit 1; }
! curl -s -m 2 "$T10_BASE/api/health" >/dev/null || { echo "port $T10_PORT is busy"; exit 1; }
```

Очаквано: и четирите проверки минават без изход. Ако някоя не мине, спри; не трий ресурси, които не са създадени от този runbook.

### Стъпка 1 — образ от същия Dockerfile (NOT RUN)

```bash
docker build -f server/Dockerfile -t "$T10_IMG" .
```

Очаквано: успешен build. Dockerfile-ът копира `server/app`, `index.html`, `boss.html`, `manifest.json`, `sw.js`, `planner.html`, `engine/`, `vendor/` и `ui/` в `/app/web`.

### Стъпка 2 — пакетиране без мрежа (NOT RUN; същото го прави CI)

```bash
docker run --rm -i --network none "$T10_IMG" python - /app/web < scripts/check-packaged-web.py
docker run --rm -i --network none "$T10_IMG" python - /app/web --entry boss.html < scripts/check-packaged-web.py
```

Очаквано: `PASS: 21 local files reachable from planner.html` и `PASS: 12 local files reachable from boss.html`. Броевете са от CI на INT-27, прочетени от Codex.

### Стъпка 3 — изолирана мрежа и база (NOT RUN)

```bash
docker network create "$T10_NET"
docker run -d --name "$T10_DB" --network "$T10_NET" --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_USER=taho -e POSTGRES_PASSWORD="$T10_DB_PASSWORD" -e POSTGRES_DB=taho_stage postgres:16
for i in $(seq 1 30); do docker exec "$T10_DB" pg_isready -U taho -d taho_stage && break; sleep 2; done
docker exec "$T10_DB" pg_isready -U taho -d taho_stage
```

- Базата няма публикуван порт и е на `tmpfs`, без volume.
- Очаквано: `accepting connections` до 60 s.

### Стъпка 4 — fake router (NOT RUN)

Записва се в `$T10_DIR/router.py` и се пуска от същия образ (stdlib Python). Отговаря само на `POST /route` с фиксиран synthetic trip и пише всяка получена заявка в stdout.

```bash
cat > "$T10_DIR/router.py" <<'PY'
import json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
TRIP = {"trip": {"status": 0, "legs": [{"shape": "_mempA_ybmk@_}hQ_iwfB_seK_a_pD"}],
                 "summary": {"length": 401.0, "time": 18600}}}
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        print("ROUTER-REQUEST " + body.decode("utf-8", "replace"), flush=True)
        out = json.dumps(TRIP).encode() if self.path == "/route" else b"{}"
        self.send_response(200 if self.path == "/route" else 404)
        self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(out)))
        self.end_headers(); self.wfile.write(out)
    def log_message(self, *a): pass
ThreadingHTTPServer(("0.0.0.0", 8002), H).serve_forever()
PY
docker run -d --name "$T10_ROUTER" --network "$T10_NET" -v "$T10_DIR/router.py:/fixture/router.py:ro" "$T10_IMG" python /fixture/router.py
```

Брой заявки, получени от fake router-а (използва се в S1–S3):

```bash
router_count() { docker logs "$T10_ROUTER" 2>/dev/null | grep -c '^ROUTER-REQUEST' || true; }
```

### Стъпка 5 — API без маршрутизатор (NOT RUN)

```bash
start_api() {   # $1: празно или VALHALLA_URL
  docker rm -f "$T10_API" >/dev/null 2>&1 || true
  docker run -d --name "$T10_API" --network "$T10_NET" -p "127.0.0.1:${T10_PORT}:8000" \
    -e DATABASE_URL="postgresql+psycopg://taho:${T10_DB_PASSWORD}@${T10_DB}:5432/taho_stage" \
    -e REGISTRATION_CODE="$T10_REG_CODE" ${1:+-e VALHALLA_URL="$1"} "$T10_IMG"
  for i in $(seq 1 60); do curl -s -m 2 "$T10_BASE/api/health" | grep -q '"ok":true' && return 0; sleep 1; done
  docker logs --tail 80 "$T10_API"; return 1
}
start_api ""
```

- `docker rm -f "$T10_API"` трие само контейнера с това точно име, създаден от runbook-а.
- Портът е само `127.0.0.1:18080`. Не го сменяй на `0.0.0.0` или на публичен адрес.
- Очаквано: `{"ok":true,…}` до 60 s.

### Общи helper-и за заявки (NOT RUN)

```bash
J() { python3 -c "import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1], {}, {'d': d}))" "$1"; }
post() { curl -s -m 15 -o "$T10_DIR/out.json" -w '%{http_code}' -H 'Content-Type: application/json' ${3:+-H "Authorization: Bearer $3"} -X POST "$T10_BASE$1" -d "$2"; }
OWNER=$(post /api/owner/register '{"company":"Synthetic Stage Co","name":"Synthetic Owner","email":"owner@stage.test","password":"synthetic-pass-123","registration_code":"'"$T10_REG_CODE"'"}' && J 'd["token"]' < "$T10_DIR/out.json")
PROFILE='{"heightM":4,"widthM":2.55,"lengthM":16.5,"grossWeightT":40,"axleLoadT":11.5,"axleCount":5,"hazmat":false}'
PTS='"origin":{"lat":42.7,"lon":23.3},"destination":{"lat":43.2,"lon":27.9}'
```

## 5. Сценарии

За всеки сценарий запиши в доказателствата: команда, HTTP статус, ключови полета на тялото и `router_count` преди и след.

**Статус от автора:**
- S1–S6 са **DRY-RUN (локално, без Docker)**. Пуснати са срещу uvicorn с `app.main:app`, web root, копиран както в Dockerfile, disposable PostgreSQL 16 и същия `router.py` на `127.0.0.1:8002`. Броят на заявките към fake router-а е броен от неговия лог.
- В Docker сценариите са **NOT RUN**.
- S5b не е изпълним без fault injection.
- S7 е **NOT RUN**.

| # | Сценарий | Стъпки | Очаквано | Покритие в CI на входа |
|---|---|---|---|---|
| S1 | Профилът липсва → 0 изходящи заявки | `before=$(router_count)`; `post /api/route-options "{$PTS}" "$OWNER"`; `after=$(router_count)` | `422`, `detail` = „Невалидни данни“; `after == before` | `test_route_options_missing_profile_rejects_before_egress_or_budget`, `…incomplete_profile…`, `…invalid_profile…`, `…access_bypass_options…` (`server/tests/test_api.py`) |
| S2 | Маршрутизаторът не е настроен → 503, 0 изходящи заявки | API-то е стартирано **без** `VALHALLA_URL` (стъпка 5); `post /api/route-options "{$PTS,\"truckProfile\":$PROFILE}" "$OWNER"` | `503`, „Маршрутизаторът не е активиран“; `router_count` не се променя | `test_route_options_rejects_missing_or_invalid_router_without_egress`, `test_route_options_invalid_config_does_not_consume_budget` |
| S3 | Валиден synthetic профил → точни truck полета към **fake** router | `start_api "http://${T10_ROUTER}:8002"` (токенът `OWNER` е в базата и остава валиден след рестарт на API контейнера); `post /api/route-options "{$PTS,\"truckProfile\":$PROFILE}" "$OWNER"`; `docker logs "$T10_ROUTER" \| grep ROUTER-REQUEST \| tail -1` | `200`, тялото е отговорът на fake router-а; в лога `costing_options.truck` = `{"height":4,"width":2.55,"length":16.5,"weight":40,"axle_load":11.5,"axle_count":5,"hazmat":false}`, `costing` = `truck`, `locations` без `label` | `test_route_options_maps_distinct_profiles_without_mutating_input`, `test_route_options_uses_explicit_router_and_bounded_payload` (с injected `urlopen`, не реален router) |
| S4 | Два едновременни join за един код → 1 успех, 1 общ 404 | Създай шофьор: `post /api/drivers '{"name":"Synthetic Driver"}' "$OWNER"`, вземи `invite.code`; пусни два `curl -m 15 -X POST "$T10_BASE/api/join" -d '{"code":"<CODE>","device":"stage-a"}' & pA=$!` (и `stage-b` → `pB`), после `wait "$pA" "$pB"` (само тези два процеса, не общ `wait`) | Точно един `200` (с `token`) и един `404` „Кодът е грешен или изтекъл — поискай нов от шефа“; трети опит със същия код → `404` | `test_concurrent_join_claims_one_invite_once`, `test_five_concurrent_joins_leave_one_new_token_and_preserve_old_state`, `test_concurrent_normalized_invite_aliases_share_one_claim` |
| S5 | Подновяване на покана срещу join без deadlock | Нов шофьор и код; паралелно `POST /api/drivers/<id>/invite` (собственик) и `POST /api/join` със стария код, всяка с `& p=$!`; `wait` само на двата PID-а | И двете завършват до 15 s, без timeout. Join-ът е или `200` (ако е бил пръв), или `404` (ако подновяването е обезсилило кода); новият код работи веднъж | `test_concurrent_join_and_reinvite_use_driver_then_invite_lock_order` |
| S5b | Rollback и повторен опит след грешка при издаване на токен | **Не е изпълним** в staging без fault injection в кода. | — (не се прави) | Само `test_join_claim_rolls_back_if_token_issuance_fails` (CI) |
| S6 | Шефският екран и helper-ът през HTTP с правилен MIME | `python3 -I scripts/check-served-web.py "$T10_BASE" --entry boss.html --ready-timeout 60 --request-timeout 10`; `curl -sI "$T10_BASE/ui/truck-profile-input.mjs"` | `PASS: 12 local files served … /boss.html`; `200`, `content-type: text/javascript; charset=utf-8` | CI стъпка „Шефският екран през HTTP…“ (INT-27, 12 файла по лог, прочетен от Codex) |
| S7 | Изход, отложен отговор, презареждане → профилът е изчистен | Ръчно в браузър, виж 5.1 | Виж 5.1 | `ui/truck-profile-input.test.mjs`: „logout ends the local session at once while the server logout is pending (deferred response/error)“, „a provider line is not restored from the draft…“ (fake DOM в Node `vm`, не браузър) |

### 5.1 S7 — ръчни потребителски операции (NOT RUN)

Отвори `http://127.0.0.1:18080/boss.html` в браузър на същата машина. Използвай API-то от S3 (с fake router).

1. „Влез“ с `owner@stage.test` / `synthetic-pass-123` и адрес на сървъра `http://127.0.0.1:18080`. Отвори „Маршрут“.
2. Добави 2 точки с координати: `42.7, 23.3` и `43.2, 27.9`. Натисни „Варианти по пътищата“ с празен профил. **Очаквано:** съобщение за 7-те параметъра и фокус на „Височина“; `router_count` не се променя.
3. Попълни `4,1 / 2.55 / 16.5 / 40 / 11.5 / 5 / Не` и натисни „Варианти“. **Очаквано:** 1 вариант, нищо не е избрано автоматично; в лога на fake router-а `height` е `4.1`.
4. Избери варианта и промени „Височина“. **Очаквано:** вариантите изчезват, линията е махната, има съобщение.
5. Избери отново вариант и презареди страницата. **Очаквано:** полетата за камиона са празни, а линията от маршрутизатора не се връща („няма избрана пътна геометрия“).
6. Попълни профила и натисни „Излез“ (⚙). Изходът не чака сървъра; в този setup сървърът отговаря бързо, така че отложен отговор не може да се наблюдава ръчно без инструменти. **Очаквано:** веднага си на екрана за вход, полетата са празни, а в DevTools → Application → Local Storage няма `boss_token` и няма стойности от профила.

### 5.2 Пакетиране и HTTP за planner (NOT RUN; повторение на CI)

```bash
python3 -I scripts/check-served-web.py "$T10_BASE" --ready-timeout 60 --request-timeout 10
```

Очаквано: `PASS: 21 local files served … /planner.html`.

## 6. Почистване (NOT RUN; винаги, и при грешка)

```bash
docker rm -f "$T10_API" "$T10_ROUTER" "$T10_DB" 2>/dev/null || true
docker network rm "$T10_NET" 2>/dev/null || true
docker image rm "$T10_IMG" 2>/dev/null || true
rm -rf -- "$T10_DIR"
unset T10_DB_PASSWORD
docker ps -a --filter name='^t10-stage-' ; docker network ls --filter name='^t10-stage-'
```

- Трият се **само** ресурсите с имената от раздел 3. Изтеглените базови образи (`python:3.13-slim`, `postgres:16`) остават; махни ги само ако си ги изтеглил само за тази проверка.
- Очаквано: последните две команди не показват `t10-stage-*` ресурси.

## 7. Какво да се запише като доказателство

- SHA (стъпка 0) и версиите на `docker version` и `python3 --version`.
- За S1–S6: команда, статус, ключови полета и `router_count` преди и след. Без токени и без паролата на базата.
- За S7: кой браузър и версия, и наблюдението по всяка точка.
- Кои стъпки са **NOT RUN** и защо.

Този runbook проверява само заявения обхват. Зелен резултат не доказва реален маршрутизатор, ADR, физическа достоверност на въведения профил, пътна достъпност, правна пригодност или production готовност.
