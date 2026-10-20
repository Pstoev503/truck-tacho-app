# Изолирана staging проверка v1 (disposable, loopback, synthetic)

Версия на входа: INT-27 `b70c940a5a73a978c7eec8dfed3b03cd7dfb6d8f`. Автор: Claude (RELEASE-GATES-02 #147). Не е production процедура, не е deploy и не е разрешение за изпълнение в production.

**Статус на командите:**
- **NOT RUN:** всички Docker стъпки (0–5 и почистването) и ръчният сценарий S7. В работната среда на автора няма Docker демон.
- **DRY-RUN (буквално извлечени блокове, без Docker):** блоковете `vars`, `helpers`, `owner` и `s1`–`s6`. Извлечени са дословно от този файл и са изпълнени локално; подменени са само функциите `start_api`, `router_count` и `router_last`, защото те зависят от Docker. Подмяната и резултатът са в `docs/reports/2026-10-20-RELEASE-GATES-02.md`.
- Очакваните резултати са изведени от кода на входната версия и от теста на блоковете без Docker. В Docker не са наблюдавани.

## 1. Граници

- **Мрежа.** Само loopback на машината, която прави проверката.
  - Отделна Docker bridge мрежа само за този пуск.
  - API-то се публикува **само** на `127.0.0.1`; базата и fake router-ът нямат публикувани портове.
  - Приложението прави изходящи заявки само към `VALHALLA_URL`, който тук е fake router-ът.
  - Мрежата не е `--internal`, защото публикуван порт към internal мрежа не е надежден на всички платформи.
- **Данни.** Само synthetic: адреси `*.test`, synthetic имена и код за регистрация, генерирана временна парола за базата. Не се ползват `.env`, `server/deploy/.env`, Datex, `par.txt`, реални имейли или реални credentials. Токените не се отпечатват.
- **Маршрутизатор.** Няма реален маршрутизатор. Fake router-ът връща фиксиран synthetic trip и записва заявките. **Не доказва** поведение на реален provider, диапазони, ADR или пътна достъпност.
- **Собственост на Docker ресурсите.**
  - Всеки пуск има уникален `T10_RUN`. Той е в имената, в image tag-а и в label-а `t10.stage.run=<T10_RUN>` на всеки създаден ресурс.
  - Стъпка 0 спира, ако някое име, tag или порт вече съществува.
  - Създадените ID-та се записват. Рестартът и почистването трият **само** записаните ID-та и само след проверка, че label-ът им е от този пуск.
  - Без шаблонно триене, `prune`, `rm $(docker ps -aq)` и без mount на работни директории (напр. `C:\Top10EU`). Единственият mount е генерираният `router.py` от временната директория.
- **Без `server/deploy/docker-compose.yml`.** Той публикува 80/443 през Caddy и ползва именуван volume `pgdata`; той е за реален хост.
- **Таймаути.** Всяка HTTP заявка е до 15 s (`curl -m 15`). Readiness на базата и на API-то има deadline 60 s по `SECONDS`. Реалната горна граница е около 70 s за базата (60 s + последен опит и пауза) и около 63 s за API-то (60 s + `curl -m 2` + 1 s).

## 2. Предпоставки (prerequisites / gates)

| # | Предпоставка | Ако липсва |
|---|---|---|
| P1 | bash (Linux/macOS) и Docker Engine с права за `build/run/network/inspect` | Спри. Не заобикаляй с compose или с чужда база. |
| P2 | Git checkout точно на `b70c940a5a73a978c7eec8dfed3b03cd7dfb6d8f` | Спри. |
| P3 | `python3` (3.8+) и `curl` на хоста | Спри. |
| P4 | Свободен loopback порт `18080` | Смени `T10_PORT` или спри. |
| P5 | Достъп до `python:3.13-slim` и `postgres:16` (изтегляне или локално копие) | Спри. |
| P6 | Браузър за ръчния S7 | S7 остава NOT RUN. |

## 3. Променливи

<!-- run:vars -->
```bash
# NOT RUN in Docker; DRY-RUN as an extracted block
set -euo pipefail
export T10_SHA=b70c940a5a73a978c7eec8dfed3b03cd7dfb6d8f
export T10_RUN="$(date +%Y%m%d%H%M%S)-$$"
export T10_LABEL="t10.stage.run=$T10_RUN"
export T10_IMG="t10-stage-api:$T10_RUN"
export T10_NET="t10-stage-$T10_RUN-net" T10_DB="t10-stage-$T10_RUN-db"
export T10_API="t10-stage-$T10_RUN-api" T10_ROUTER="t10-stage-$T10_RUN-router"
export T10_PORT=18080
export T10_BASE="http://127.0.0.1:$T10_PORT"
export T10_DIR="$(mktemp -d -t t10-stage-XXXXXX)"
export T10_DB_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
export T10_REG_CODE=synthetic-staging-registration-code
T10_NET_ID= T10_DB_ID= T10_ROUTER_ID= T10_API_ID= T10_IMG_ID=
```

## 4. Docker стъпки (всички NOT RUN)

### Стъпка 0 — предварителна проверка и почистване при изход

<!-- run:docker-0 -->
```bash
# NOT RUN
owned()     { test "$(docker inspect -f '{{index .Config.Labels "t10.stage.run"}}' "$1" 2>/dev/null)" = "$T10_RUN"; }
owned_net() { test "$(docker network inspect -f '{{index .Labels "t10.stage.run"}}' "$1" 2>/dev/null)" = "$T10_RUN"; }
cleanup() {
  for id in "${T10_API_ID:-}" "${T10_ROUTER_ID:-}" "${T10_DB_ID:-}"; do
    if [ -n "$id" ] && owned "$id"; then docker rm -f "$id" >/dev/null; fi
  done
  if [ -n "${T10_NET_ID:-}" ] && owned_net "$T10_NET_ID"; then docker network rm "$T10_NET_ID" >/dev/null; fi
  if [ -n "${T10_IMG_ID:-}" ] && owned "$T10_IMG_ID"; then docker image rm "$T10_IMG" >/dev/null; fi
  rm -rf -- "$T10_DIR"
}
test "$(git rev-parse HEAD)" = "$T10_SHA"
for name in "$T10_NET" "$T10_DB" "$T10_API" "$T10_ROUTER" "$T10_IMG"; do
  if docker inspect "$name" >/dev/null 2>&1; then echo "exists: $name — stop, nothing created"; exit 1; fi
done
if curl -s -m 2 "$T10_BASE/api/health" >/dev/null; then echo "port $T10_PORT busy — stop"; exit 1; fi
trap cleanup EXIT
```

`cleanup` трие само ID-та, записани от този пуск, и само ако label-ът им е `t10.stage.run=$T10_RUN`. Ресурс с друг label или без label (включително чужд ресурс със съвпадащо име) не се пипа.

### Стъпка 1 — образ от същия Dockerfile

<!-- run:docker-1 -->
```bash
# NOT RUN
docker build --label "$T10_LABEL" -f server/Dockerfile -t "$T10_IMG" .
T10_IMG_ID="$(docker image inspect -f '{{.Id}}' "$T10_IMG")"
owned "$T10_IMG_ID"
```

Tag-ът е уникален за пуска и стъпка 0 е проверила, че не съществува, така че build-ът не презаписва чужд tag.

### Стъпка 2 — пакетиране без мрежа (повторение на CI)

<!-- run:docker-2 -->
```bash
# NOT RUN
docker run --rm -i --network none --label "$T10_LABEL" "$T10_IMG_ID" python - /app/web < scripts/check-packaged-web.py | tail -1
docker run --rm -i --network none --label "$T10_LABEL" "$T10_IMG_ID" python - /app/web --entry boss.html < scripts/check-packaged-web.py | tail -1
```

Очаквано: `PASS: 21 local files reachable from planner.html` и `PASS: 12 local files reachable from boss.html`. Броевете са от CI на INT-27, прочетени от Codex.

### Стъпка 3 — мрежа и база

<!-- run:docker-3 -->
```bash
# NOT RUN
T10_NET_ID="$(docker network create --label "$T10_LABEL" "$T10_NET")"
T10_DB_ID="$(docker run -d --label "$T10_LABEL" --name "$T10_DB" --network "$T10_NET_ID" \
  --tmpfs /var/lib/postgresql/data \
  -e POSTGRES_USER=taho -e POSTGRES_PASSWORD="$T10_DB_PASSWORD" -e POSTGRES_DB=taho_stage postgres:16)"
deadline=$((SECONDS + 60))
until docker exec "$T10_DB_ID" pg_isready -U taho -d taho_stage >/dev/null 2>&1; do
  [ "$SECONDS" -lt "$deadline" ] || { echo "db not ready within 60 s"; exit 1; }
  sleep 2
done
```

### Стъпка 4 — fake router

<!-- run:router-script -->
```bash
# NOT RUN in Docker; DRY-RUN: this exact heredoc writes the router script
cat > "$T10_DIR/router.py" <<'PY'
import json
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
```

<!-- run:docker-4 -->
```bash
# NOT RUN
T10_ROUTER_ID="$(docker run -d --label "$T10_LABEL" --name "$T10_ROUTER" --network "$T10_NET_ID" \
  -v "$T10_DIR/router.py:/fixture/router.py:ro" "$T10_IMG_ID" python /fixture/router.py)"
router_count() { docker logs "$T10_ROUTER_ID" 2>/dev/null | grep -c '^ROUTER-REQUEST' || true; }
router_last()  { docker logs "$T10_ROUTER_ID" 2>/dev/null | grep '^ROUTER-REQUEST' | tail -1 | sed 's/^ROUTER-REQUEST //'; }
```

Shape-ът е polyline6 на точките (42.7, 23.3), (43, 25) и (43.2, 27.9); декодира се с `engine/route.js` `decodePolyline6`.

### Стъпка 5 — API (първо без маршрутизатор)

<!-- run:docker-5 -->
```bash
# NOT RUN
start_api() {   # $1: empty, or VALHALLA_URL
  if [ -n "${T10_API_ID:-}" ]; then
    owned "$T10_API_ID" || { echo "API container is not from this run — stop"; return 1; }
    docker rm -f "$T10_API_ID" >/dev/null
    T10_API_ID=
  fi
  T10_API_ID="$(docker run -d --label "$T10_LABEL" --name "$T10_API" --network "$T10_NET_ID" \
    -p "127.0.0.1:${T10_PORT}:8000" \
    -e DATABASE_URL="postgresql+psycopg://taho:${T10_DB_PASSWORD}@${T10_DB}:5432/taho_stage" \
    -e REGISTRATION_CODE="$T10_REG_CODE" ${1:+-e VALHALLA_URL="$1"} "$T10_IMG_ID")"
  local deadline=$((SECONDS + 60))
  until curl -s -m 2 "$T10_BASE/api/health" | grep -q '"ok":true'; do
    [ "$SECONDS" -lt "$deadline" ] || { docker logs --tail 80 "$T10_API_ID"; return 1; }
    sleep 1
  done
}
start_api ""
```

- Портът е само `127.0.0.1`; не го сменяй на `0.0.0.0` или на публичен адрес.
- Рестартът трие само записания `T10_API_ID` и само ако label-ът му е от този пуск.

## 5. Общи helper-и и собственик (DRY-RUN)

<!-- run:helpers -->
```bash
# post PATH JSON TOKEN NAME → тяло в $T10_DIR/NAME.json, HTTP статус в $T10_DIR/NAME.status; нищо на stdout
post() {
  curl -s -m 15 -o "$T10_DIR/$4.json" -w '%{http_code}' -H 'Content-Type: application/json' \
    ${3:+-H "Authorization: Bearer $3"} -X POST "$T10_BASE$1" -d "$2" > "$T10_DIR/$4.status" || true
}
status() { cat "$T10_DIR/$1.status"; }
# field NAME a.b.0.c → стойността от $T10_DIR/NAME.json (низ дословно, иначе компактен JSON)
field() {
  python3 -c 'import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
for k in sys.argv[2].split("."):
    d = d[int(k)] if isinstance(d, list) else d[k]
print(d if isinstance(d, str) else json.dumps(d, separators=(",", ":"), ensure_ascii=False))' "$T10_DIR/$1.json" "$2"
}
PROFILE='{"heightM":4,"widthM":2.55,"lengthM":16.5,"grossWeightT":40,"axleLoadT":11.5,"axleCount":5,"hazmat":false}'
PTS='"origin":{"lat":42.7,"lon":23.3},"destination":{"lat":43.2,"lon":27.9}'
NOT_FOUND='Кодът е грешен или изтекъл — поискай нов от шефа'
```

<!-- run:owner -->
```bash
post /api/owner/register '{"company":"Synthetic Stage Co","name":"Synthetic Owner","email":"owner@stage.test","password":"synthetic-pass-123","registration_code":"'"$T10_REG_CODE"'"}' "" register
test "$(status register)" = 200
OWNER="$(field register token)"
test -n "$OWNER"      # токенът не се отпечатва
echo "owner ok"
```

## 6. Сценарии

Всеки блок спира при първото неизпълнено очакване (`set -e` + `test`). В доказателствата се записват изходът `… ok` и, при неуспех, статусът и `detail`; токени не се записват.

| # | Сценарий | Очаквано | Покритие в CI на входа |
|---|---|---|---|
| S1 | Профилът липсва | `422`, `detail` = „Невалидни данни“; 0 заявки към router-а | `test_route_options_missing_profile_rejects_before_egress_or_budget`, `…incomplete_profile…`, `…invalid_profile…`, `…access_bypass_options…` |
| S2 | Маршрутизаторът не е настроен | `503`, „Маршрутизаторът не е активиран“; 0 заявки | `test_route_options_rejects_missing_or_invalid_router_without_egress`, `test_route_options_invalid_config_does_not_consume_budget` |
| S3 | Валиден synthetic профил към **fake** router | `200`, `trip.status=0`; точно 1 заявка; `costing=truck`, точните 7 truck полета, `locations` без `label` | `test_route_options_maps_distinct_profiles_without_mutating_input`, `test_route_options_uses_explicit_router_and_bounded_payload` (injected urlopen) |
| S4 | Два едновременни join за един код | Един `200` с непразен токен и един `404` с общото съобщение; трети опит → `404` | `test_concurrent_join_claims_one_invite_once`, `test_five_concurrent_joins_leave_one_new_token_and_preserve_old_state`, `test_concurrent_normalized_invite_aliases_share_one_claim` |
| S5 | Подновяване срещу join | И двете завършват до 15 s; подновяването е `200`; join-ът е `200` или `404`; новият код дава `200`, после `404` | `test_concurrent_join_and_reinvite_use_driver_then_invite_lock_order` |
| S5b | Rollback при грешка при издаване на токен | Не е изпълним в staging без fault injection | Само `test_join_claim_rolls_back_if_token_issuance_fails` |
| S6 | Шефският екран и helper-ът през HTTP | `PASS: 12 …/boss.html`, `PASS: 21 …/planner.html`; helper-ът е `200` с `text/javascript` | CI стъпки „Шефският екран през HTTP…“ и „Планировчикът през HTTP…“ |
| S7 | Изход, отложен отговор, презареждане (ръчно) | Виж 6.1 | `ui/truck-profile-input.test.mjs` (Node `vm` с fake DOM, не браузър) |

<!-- run:s1 -->
```bash
before="$(router_count)"
post /api/route-options "{$PTS}" "$OWNER" s1
test "$(status s1)" = 422
test "$(field s1 detail)" = "Невалидни данни"
test "$(router_count)" = "$before"
echo "S1 ok"
```

<!-- run:s2 -->
```bash
before="$(router_count)"
post /api/route-options "{$PTS,\"truckProfile\":$PROFILE}" "$OWNER" s2
test "$(status s2)" = 503
test "$(field s2 detail)" = "Маршрутизаторът не е активиран"
test "$(router_count)" = "$before"
echo "S2 ok"
```

<!-- run:s3 -->
```bash
start_api "http://${T10_ROUTER}:8002"          # OWNER е в базата и остава валиден
before="$(router_count)"
post /api/route-options "{$PTS,\"truckProfile\":$PROFILE}" "$OWNER" s3
test "$(status s3)" = 200
test "$(field s3 trip.status)" = 0
test "$(router_count)" = "$((before + 1))"
router_last > "$T10_DIR/s3-router.json"
test "$(field s3-router costing)" = truck
test "$(field s3-router costing_options.truck)" = '{"height":4,"width":2.55,"length":16.5,"weight":40,"axle_load":11.5,"axle_count":5,"hazmat":false}'
test "$(field s3-router locations)" = '[{"lat":42.7,"lon":23.3},{"lat":43.2,"lon":27.9}]'
echo "S3 ok"
```

<!-- run:s4 -->
```bash
post /api/drivers '{"name":"Synthetic Driver"}' "$OWNER" driver1
test "$(status driver1)" = 200
CODE="$(field driver1 invite.code)"
post /api/join '{"code":"'"$CODE"'","device":"stage-a"}' "" joinA & pA=$!
post /api/join '{"code":"'"$CODE"'","device":"stage-b"}' "" joinB & pB=$!
wait "$pA" "$pB"
test "$(printf '%s\n' "$(status joinA)" "$(status joinB)" | sort | tr '\n' ' ')" = "200 404 "
for r in joinA joinB; do
  if [ "$(status "$r")" = 200 ]; then test -n "$(field "$r" token)"; else test "$(field "$r" detail)" = "$NOT_FOUND"; fi
done
post /api/join '{"code":"'"$CODE"'","device":"stage-c"}' "" joinC
test "$(status joinC)" = 404
echo "S4 ok"
```

<!-- run:s5 -->
```bash
post /api/drivers '{"name":"Synthetic Driver Two"}' "$OWNER" driver2
test "$(status driver2)" = 200
D2="$(field driver2 driver.id)"; CODE2="$(field driver2 invite.code)"
t0=$SECONDS
post "/api/drivers/$D2/invite" '{}' "$OWNER" reinvite & p1=$!
post /api/join '{"code":"'"$CODE2"'","device":"stage-d"}' "" join2 & p2=$!
wait "$p1" "$p2"
test "$((SECONDS - t0))" -le 15
test "$(status reinvite)" = 200
case "$(status join2)" in 200|404) ;; *) echo "join2: $(status join2)"; exit 1 ;; esac
NEW="$(field reinvite invite.code)"
post /api/join '{"code":"'"$NEW"'","device":"stage-e"}' "" join3
test "$(status join3)" = 200
post /api/join '{"code":"'"$NEW"'","device":"stage-f"}' "" join4
test "$(status join4)" = 404
echo "S5 ok (old-code join: $(status join2))"
```

<!-- run:s6 -->
```bash
python3 -I scripts/check-served-web.py "$T10_BASE" --entry boss.html --ready-timeout 60 --request-timeout 10 > "$T10_DIR/s6-boss.txt"
grep -q '^PASS: 12 local files' "$T10_DIR/s6-boss.txt"
python3 -I scripts/check-served-web.py "$T10_BASE" --ready-timeout 60 --request-timeout 10 > "$T10_DIR/s6-planner.txt"
grep -q '^PASS: 21 local files' "$T10_DIR/s6-planner.txt"
curl -s -m 15 -o /dev/null -D "$T10_DIR/s6-head.txt" "$T10_BASE/ui/truck-profile-input.mjs"
grep -q '^HTTP/1.1 200' "$T10_DIR/s6-head.txt"
grep -qi '^content-type: text/javascript' "$T10_DIR/s6-head.txt"
echo "S6 ok"
```

### 6.1 S7 — ръчни потребителски операции (NOT RUN)

Отвори `http://127.0.0.1:18080/boss.html` в браузър на същата машина, докато работи API-то от S3 (с fake router).

1. „Влез“ с `owner@stage.test` / `synthetic-pass-123` и адрес на сървъра `http://127.0.0.1:18080`. Отвори „Маршрут“.
2. Добави точките `42.7, 23.3` и `43.2, 27.9`. Натисни „Варианти по пътищата“ с празен профил. **Очаквано:** съобщение за 7-те параметъра и фокус на „Височина“; `router_count` не се променя.
3. Попълни `4,1 / 2.55 / 16.5 / 40 / 11.5 / 5 / Не` и натисни „Варианти“. **Очаквано:** 1 вариант, нищо не е избрано автоматично; в `router_last` `height` е `4.1`.
4. Избери варианта и промени „Височина“. **Очаквано:** вариантите и линията са махнати и има съобщение.
5. Избери отново вариант и презареди страницата. **Очаквано:** полетата са празни и линията не се връща („няма избрана пътна геометрия“).
6. Попълни профила и натисни „Излез“ (⚙). **Очаквано:** веднага си на екрана за вход, полетата са празни, а в Local Storage няма `boss_token` и стойности от профила. Отложен отговор на сървъра не може да се наблюдава ръчно без инструменти; той е покрит от `vm` тестовете в CI.

## 7. Почистване и проверка (NOT RUN)

Почистването се изпълнява автоматично от `trap cleanup EXIT` (стъпка 0), включително при грешка. Проверка след изхода:

<!-- run:docker-7 -->
```bash
# NOT RUN — в нов shell, със същия T10_RUN
docker ps -a --filter "label=t10.stage.run=$T10_RUN" --format '{{.ID}} {{.Names}}'
docker network ls --filter "label=t10.stage.run=$T10_RUN" --format '{{.ID}} {{.Name}}'
docker images --filter "label=t10.stage.run=$T10_RUN" --format '{{.ID}} {{.Repository}}:{{.Tag}}'
```

- Очаквано: и трите команди не връщат редове.
- Изтеглените базови образи (`python:3.13-slim`, `postgres:16`) не се пипат.
- Ресурси, които са съществували преди пуска, остават непроменени.

## 8. Доказателства

- SHA, `T10_RUN`, `docker version`, `python3 --version`.
- Изходите `… ok` от блоковете; при неуспех — блокът, статусът и `detail`. Без токени и без паролата на базата.
- За S7: браузър и версия и наблюдението по всяка точка.
- Кои стъпки са NOT RUN и защо.

Този runbook проверява само заявения обхват. Зелен резултат не доказва реален маршрутизатор, ADR, физическа достоверност на въведения профил, пътна достъпност, правна пригодност или production готовност.
