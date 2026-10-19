# G1-01 — преглед на PR #7 преди интеграцията

Автор: Claude (G1-01, #44). Приемане: Codex. Дата: 19.10.2026 (Europe/Sofia). Технически преглед на конкретен gate. Не е пълен security одит, не е правно или GDPR становище и не е сертификат.

## 1. Обект

| | SHA |
|---|---|
| PR #7 head (`shef`) | `449dc5e047e9e71b5fdd0c9a22a3331b8e16e4be` |
| База (`main`) | `26ef2442910757d4427670de38d61d6b78d1ad99` |
| Интеграционен кандидат (CI-01) | `fa19f2148017526bced0213e41ee8dc5d8bc45c6` |

`git diff --name-only 26ef244 449dc5e` дава 29 файла:
- `server/`: 12 файла;
- `boss.html`, `index.html`, `sw.js`;
- `engine/route.js`, `engine/route.test.js`, `engine/sync.js`;
- `vendor/leaflet-1.9.4/`: 8 файла;
- `.github/workflows/tests.yml`, `.gitignore`, `README.md`.

28 от тях имат същия blob във `fa19f21`. Единствената разлика е `tests.yml`, който CI-01 надгражда. Прегледът на `449dc5e` важи без промяна за същите 28 файла в кандидата. Зелените 220 Node теста **не** приемат #7: те не покриват `server/`, `boss.html` и `index.html`.

## 2. Решение

**G1: PASS с ограничения за интеграция в `main`; CHANGES REQUIRED преди публичен deploy.**

- Не открих пропуск в изолацията между фирмите (tenant isolation) или в ролите. Не открих начин шофьор да вмъкне HTML в таблото на собственика по проверените пътища.
- Сървърните тестове минават.
- Leaflet съвпада с официалния 1.9.4.
- Находките са конфигурационни, оперативни или функционални (G1-M1…M5, Medium). Нито една не позволява достъп до данни на друга фирма. Затова не блокират интеграцията на кода, но трябва да бъдат решени или изрично приети, преди сървърът да бъде пуснат публично.
- G1-M5 засяга самия интеграционен кандидат.

## 3. Сървър (`server/app/*`)

### Какво е проверено и е наред

| Област | Как е проверено | Резултат |
|---|---|---|
| Пароли | `security.py:18-35` | scrypt (N=2^14, r=8, p=1), 16-байтов случаен salt, `hmac.compare_digest` |
| Токени | `security.py:38-43`, `main.py:79-92,107-111` | 256-битов `secrets.token_urlsafe`; в базата се пази само sha256; при спиране на шофьор токените се отменят (`main.py:273`) |
| Роли | `main.py:95-104`; сонда P2 | шофьор → owner endpoint 403; собственик → `/api/sync` 403; шофьор не може да редактира полета на маршрут (403) или чужд маршрут (404) |
| Изолация между фирмите | `own_driver` (`main.py:223`), `Route.company_id` (`main.py:499,507`), `/api/sync` по `me.id`; сонда P1 | собственик B към activities/shifts/patch/invite/route patch/route create за шофьор или маршрут на A: **404 на всичките 6**; списъците на B са празни |
| Граници на входа | Pydantic модели (`main.py:342-387,447-474`), `small_dict`, `MAX_BODY`, проверки в `sync` (`main.py:401-414`) | типове `Literal`, времена ≤ 2100 г., координати без NaN/inf, status ≤ 8 KB, shift ≤ 16 KB, ≤ 20000 записа, без записи в бъдещето (> 5 мин) и без пренаписване по-назад от 45 дни |
| Местоположение | `main.py:424-433`, `logout`; тестове `test_location_*` | пази се само при `share_location`; изтрива се при почивка, logout или изключване |
| Отказ при грешки | `validation_error` (`main.py:67-71`) | не връща обратно получените стойности |
| SQL | SQLAlchemy ORM и параметризиран `pg_advisory_xact_lock` | няма сглобяване на SQL от низове |

### Находки

| ID | Тежест | Място | Вход / сонда | Очаквано | Действително | Минимална препоръка |
|---|---|---|---|---|---|---|
| G1-M1 | Medium (deploy) | `main.py:145-147`; `deploy/.env.example` (`REGISTRATION_CODE` празен) | P4: регистрация без код | Публичен сървър не допуска анонимни фирми | 200: всеки може да създаде фирма и собственик | Преди deploy: задължителен непразен `REGISTRATION_CODE` (или отказ при празен в production) и сравнение с `hmac.compare_digest` |
| G1-M2 | Medium | `models.py:142-151`, `main.py:79-92` | P5: `created_at` и `last_used_at` на токена са върнати на 0 (1970 г.) | Изтичане при неактивност или максимален срок | 200: токенът важи безсрочно до logout или изключване | Срок по `last_used_at` (например 30–90 дни) и проверка в `current_user` |
| G1-M3 | Medium | `main.py:122-124,323-330` (`client_key` е само IP за `/api/join`) | P6: 10 грешни кода от един IP, после валиден код | Опитите за ограничение са по IP + нещо стабилно, или с по-висок праг | 429 за валидния код. Шофьори зад един мобилен NAT (CGNAT) или офис IP се блокират взаимно за 15 мин | Ключ IP + префикс на кода или по-висок праг; описване в README |
| G1-M4 | Medium (privacy / ToS) | `main.py:543-567` (`VALHALLA_URL` по подразбиране `https://valhalla1.openstreetmap.de`) | Статично | Production не праща данни към demo услуга без решение | Координатите на начало и цел отиват към публичен demo сървър; `costing: truck` е без профил на превозното средство и без ограничение на честотата | Задължителна `VALHALLA_URL` в production (или изключена функция) и ограничение на честотата; UI да не представя резултата като проверен за камиони маршрут |
| G1-L1 | Low | `main.py:464` срещу `main.py:472` | P3: маршрут с 6000 точки | Записаният маршрут може да се редактира | Създаване 200 (лимит 20000); PATCH със същата геометрия 422 (лимит 5000) | Еднакъв лимит (`route.js` `MAX_GEOMETRY_POINTS` = 20000) |
| G1-L2 | Low | `main.py:520-522` (`own_driver` не проверява `active`) | P7 | Маршрут не се възлага на спрян шофьор | 200 | Проверка на `active` при възлагане |
| G1-L3 | Low | `main.py:58-64` | Статично | Лимитът е независим от заглавките | Проверява само `content-length`; заявка с chunked encoding не се ограничава от middleware-а | Лимит на ниво Caddy (`request_body max_size`) |
| G1-L4 | Low | `main.py:148-149` | Статично | — | 409 „Има профил с този имейл“ разкрива регистрирани имейли | Обща грешка или приемане като продуктово решение |
| G1-L5 | Low | `security.py:42`, `models.py:159` | Статично | — | Кодът за покана се пази като sha256 без salt; при изтичане на базата 8-те знака (~8,5·10^11 комбинации) са податливи на brute force. Кодовете са еднократни и важат 7 дни | Приемливо за пилот; при нужда HMAC със server secret |
| G1-I1 | Info | `main.py:396-423` | Статично | — | Шофьорът може да пренапише собствения си дневник в последните 45 дни (по дизайн). Данните са self-reported, не тахографски | Да не се представят като тахографски запис |
| G1-I2 | Info | `main.py:378,430`; сонда P8 | P8 | — | `status` е свободен JSON от телефона. Собственикът го получава, а `boss.html` ползва `status.crew` като `multiManning` при анализа (виж RULES-01 R-02) | Документирано ограничение |
| G1-I3 | Info | `main.py:49` | Статично | — | `/api/docs` и `/api/openapi.json` са публични | По избор: изключване в production |

## 4. Deploy (`server/Dockerfile`, `deploy/*`, requirements, README)

| Проверка | Резултат |
|---|---|
| `.env.example` | 3 ключа (`DOMAIN`, `DB_PASSWORD`, `REGISTRATION_CODE`), всички с **празни** стойности. Стойностите не са отпечатвани; без тайни |
| Портове | Публикувани са само 80 и 443 (Caddy). `api` и `db` нямат `ports`, т.е. са само във вътрешната мрежа на compose |
| `DB_PASSWORD` | Задължителен (`${DB_PASSWORD:?}`); тестовите `taho/taho` са само за CI и локално |
| Volumes | `pgdata`, `caddy_data` (named) |
| Proxy заглавки | `uvicorn --proxy-headers`, в compose `FORWARDED_ALLOW_IPS: "*"`. Безопасно е само докато `api` не е достъпен извън compose мрежата. Ограничението на опитите (G1-M3) разчита на това, че Caddy подава реалния IP; поведението на Caddy за входящ `X-Forwarded-For` **не е проверено** в тази среда |
| Потребител в контейнера | Без `USER`, т.е. root в контейнера (G1-L6, Low): да се добави непривилегирован потребител |
| `WEB_ROOT` | Копират се `index.html`, `boss.html`, `manifest.json`, `sw.js`, `engine/` (включително `*.test.js`) и `vendor/`. Сървърният код и `.env` не попадат в статичния root |
| Requirements | Production зависимостите са с фиксирани версии; `pytest`/`httpx` в dev са без версия (Low) |

**G1-M5 (Medium, засяга интеграционния кандидат):** `server/Dockerfile` не копира `planner.html` и `ui/`, приети в UI-01. След интеграцията образът няма да сервира картовия планировчик. `docker build` минава, но страницата липсва. Решение за INT-03: отделно file assignment за `Dockerfile` (`COPY planner.html …` и `COPY ui …`) или изрично решение, че планировчикът се сервира от друго място.

## 5. Клиент (`engine/sync.js`, `engine/route.js`, `index.html`, `boss.html`, `sw.js`)

| Проверка | Резултат |
|---|---|
| Какво се синхронизира | `sync.js:18-55`: записите от последните 3 дни (или от посочен момент), кратък образ на броячите (без координати) и смените. При изключено споделяне `locStart`/`locEnd` се изпразват (`index.html:1540-1541`). Позиция се праща само при споделяне, не в почивка и не по-стара от 10 мин. При ново свързване се праща целият локален дневник (до 35 дни) |
| Съхранение на токени | `localStorage` (`th_conn` в `index.html`, сесията в `boss.html`). Без CSP: при XSS токенът би бил достъпен (G1-L7, Low) |
| XSS от шофьор към собственик | `boss.html:196` `esc()`. Името, бележките, смените, нарушенията, поканата и маршрутите минават през `esc()` или `Number()`. `act` (`boss.html:327-328`) е без `esc`, но идва от `analyze()` върху записи с тип `Literal` (4 стойности), т.е. не се контролира свободно. Резултатите от Valhalla се показват само като числа (`Math.round`). Не открих вмъкване по прегледаните пътища; пълен XSS одит не е правен |
| Връзка за покана | `#join=…&server=…` е в hash (не стига до сървъра) и се изчиства с `replaceState`. Преди свързване има `confirm` с хоста; приемат се само `https://` и localhost (`sync.js:76-81`) |
| Service worker | `sw.js`: `/api/` не се кешира; кешират се само `response.ok`; при липса на мрежа се връща `index.html` само при навигация |
| Маршрути | `route.js`: `cleanRoute` ограничава точките, геометрията и текстовете. Google Maps и GPX са с ръчни точки; UI казва „Google Maps може да предложи друго трасе“, но **няма** предупреждение, че трасето не е проверено за камиони (височина, тегло, забрани). Ръчната скица и Valhalla без профил не бива да се представят като маршрут, безопасен за камион (G1-L8, Low/продукт) |

## 6. `vendor/leaflet-1.9.4`

Метод: Git blob SHA не е SHA-256 на съдържанието, затова не се сравнява директно.
1. Изтеглени са метаданните `https://registry.npmjs.org/leaflet/1.9.4` и tarball-ът `leaflet-1.9.4.tgz` (unpkg, jsDelivr и cdnjs са блокирани от мрежата на средата).
2. SHA-512 (base64) на tarball-а е сравнен с `dist.integrity` от registry: `nxS1ynzJ…FA74PA==`. **Съвпада.**
3. SHA-256 на всеки файл от `git show 449dc5e:vendor/leaflet-1.9.4/<f>` е сравнен с файла от `package/dist/` (за `LICENSE` — `package/LICENSE`).

| Файл | SHA-256 | Резултат |
|---|---|---|
| `leaflet.js` | `db49d009c841f5ca34a888c96511ae936fd9f5533e90d8b2c4d57596f4e5641a` | съвпада |
| `leaflet.css` | `a7837102824184820dfa198d1ebcd109ff6d0ff9a2672a074b9a1b4d147d04c6` | съвпада |
| `LICENSE` (BSD 2-Clause, © Volodymyr Agafonkin) | — | съвпада |
| `images/` (5 PNG) | — | всичките съвпадат |

Лицензът не е оценяван юридически; само е потвърдено, че е наличен и е същият като в официалния пакет.

## 7. Тестове

| Проверка | Резултат |
|---|---|
| CI run 39179019940 по `fa19f21` (API, jobs) | `server` 117827617903 success (стъпка „Сървър (PostgreSQL)“ success); `docker` 117827618127 success; `engine` и `ui-integration` success. Логовете не са прочетени: blob storage е блокиран в средата |
| `server/tests/test_api.py` на `449dc5e`, изолиран PostgreSQL 16.15 (временен, само синтетичните данни от теста), Python 3.13.16 venv с `requirements-dev.txt` | **22 passed** |
| Сонди G1 (по-долу) на същия код и база | **8 passed** (сондите проверяват **текущото** поведение, включително находките) |

Сървърните файлове са еднакви в `449dc5e` и `fa19f21`, така че локалният резултат важи и за кандидата. Docker build не е пускан локално.

Покритие на `test_api.py` (22 теста): регистрация и вход; кратка парола и лош имейл; код за регистрация; ограничение на входа; покана и един телефон; нов код отменя стария; разделени роли; друга фирма не вижда шофьор; прозорец на синхронизацията; валидация; местоположение само при споделяне; смени; маршрути и тяхната валидация; спрян шофьор; logout; стар отворен запис; лоши форми; изчистване на местоположението; отменен маршрут; кирилски код; голямо тяло. Не покриват: всички endpoint-и между фирми (покрити от P1), срок на токените, throttle зад NAT, лимит на геометрията при PATCH.

### Възпроизвеждане на сондите

Файлът е само в този документ, не е тест в репото. Пуска се срещу checkout на `449dc5e` и **временна** база:

```
G1_SERVER_ROOT=<checkout>/server TEST_DATABASE_URL=postgresql+psycopg://taho@127.0.0.1:55432/taho_test python -m pytest -q -s test_g1_probe.py
```

```python
"""G1-01: синтетични сонди за PR #7 @ 449dc5e. Само синтетични данни; временна PostgreSQL база."""
import os, sys, time
from pathlib import Path
import pytest
ROOT = Path(os.environ["G1_SERVER_ROOT"])  # checkout/server на 449dc5e
os.environ["DATABASE_URL"] = os.environ["TEST_DATABASE_URL"]
sys.path.insert(0, str(ROOT))
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import update  # noqa: E402
from app import main  # noqa: E402
from app.db import Base, engine, SessionLocal  # noqa: E402
from app.models import AuthToken  # noqa: E402

H = 3600_000; NOW = int(time.time() * 1000)
A = lambda t: {"Authorization": f"Bearer {t}"}

@pytest.fixture()
def c():
    Base.metadata.drop_all(engine); Base.metadata.create_all(engine)
    main.login_throttle.hits.clear(); main.join_throttle.hits.clear()
    with TestClient(main.app) as cl:
        yield cl

def owner(c, email):
    r = c.post("/api/owner/register", json={"company": "Синтетична " + email, "name": "Собственик", "email": email, "password": "синтетична-парола-1"})
    assert r.status_code == 200, r.text
    return r.json()["token"]

def driver(c, boss, name="Шофьор"):
    r = c.post("/api/drivers", json={"name": name}, headers=A(boss)); assert r.status_code == 200
    d = r.json(); j = c.post("/api/join", json={"code": d["invite"]["code"]}); assert j.status_code == 200
    return d["driver"]["id"], j.json()["token"]

def route(c, boss, did, n=2):
    pts = [{"lat": 42.0, "lon": 23.0 + i * 1e-4} for i in range(n)]
    return c.post("/api/routes", json={"name": "Р", "driver_id": did, "waypoints": pts[:2], "geometry": pts if n > 2 else None}, headers=A(boss))

def test_P1_cross_company_isolation_on_every_owner_endpoint(c):
    a, b = owner(c, "a@synthetic.test"), owner(c, "b@synthetic.test")
    da, ta = driver(c, a)
    c.put("/api/sync", json={"activities": [{"type": "drive", "start": NOW - H, "end": NOW - 1}], "shifts": [{"day": "2026-10-18", "data": {"notes": "x"}}]}, headers=A(ta))
    ra = route(c, a, da).json()["route"]["id"]
    results = {
        "activities": c.get(f"/api/drivers/{da}/activities", headers=A(b)).status_code,
        "shifts": c.get(f"/api/drivers/{da}/shifts", headers=A(b)).status_code,
        "patch_driver": c.patch(f"/api/drivers/{da}", json={"active": False}, headers=A(b)).status_code,
        "reinvite": c.post(f"/api/drivers/{da}/invite", headers=A(b)).status_code,
        "patch_route": c.patch(f"/api/routes/{ra}", json={"name": "чужд"}, headers=A(b)).status_code,
        "create_route_for_foreign_driver": route(c, b, da).status_code,
    }
    print("P1", results)
    assert set(results.values()) == {404}
    assert c.get("/api/drivers", headers=A(b)).json()["drivers"] == []
    assert c.get("/api/routes", headers=A(b)).json()["routes"] == []

def test_P2_driver_role_limits(c):
    a = owner(c, "a@synthetic.test"); d1, t1 = driver(c, a, "Ш1"); d2, t2 = driver(c, a, "Ш2")
    r2 = route(c, a, d2).json()["route"]["id"]; r1 = route(c, a, d1).json()["route"]["id"]
    res = {
        "owner_endpoint": c.get("/api/drivers", headers=A(t1)).status_code,
        "other_driver_route": c.patch(f"/api/routes/{r2}", json={"status": "seen"}, headers=A(t1)).status_code,
        "edit_own_route_name": c.patch(f"/api/routes/{r1}", json={"name": "ново"}, headers=A(t1)).status_code,
        "owner_calls_sync": c.put("/api/sync", json={}, headers=A(a)).status_code,
    }
    print("P2", res)
    assert res == {"owner_endpoint": 403, "other_driver_route": 404, "edit_own_route_name": 403, "owner_calls_sync": 403}

def test_P3_route_geometry_create_20000_but_patch_5000(c):
    a = owner(c, "a@synthetic.test"); d, _ = driver(c, a)
    r = route(c, a, d, n=6000); assert r.status_code == 200, r.text
    rid = r.json()["route"]["id"]; geom = r.json()["route"]["geometry"]
    p = c.patch(f"/api/routes/{rid}", json={"geometry": geom}, headers=A(a))
    print("P3 create=200 patch_same_geometry=", p.status_code)
    assert p.status_code == 422

def test_P4_open_registration_without_code(c, monkeypatch):
    monkeypatch.delenv("REGISTRATION_CODE", raising=False)
    r = c.post("/api/owner/register", json={"company": "Произволна", "name": "Анон", "email": "anon@synthetic.test", "password": "синтетична-парола-2"})
    print("P4 register without code ->", r.status_code); assert r.status_code == 200

def test_P5_token_has_no_expiry(c):
    a = owner(c, "a@synthetic.test")
    with SessionLocal() as db:
        db.execute(update(AuthToken).values(created_at=0, last_used_at=0)); db.commit()
    r = c.get("/api/me", headers=A(a)); print("P5 token aged to epoch ->", r.status_code); assert r.status_code == 200

def test_P6_join_throttle_is_per_ip_only(c):
    a = owner(c, "a@synthetic.test")
    rr = c.post("/api/drivers", json={"name": "Шофьор"}, headers=A(a)); assert rr.status_code == 200, rr.text
    good = rr.json()["invite"]["code"]
    for _ in range(10):
        assert c.post("/api/join", json={"code": "ZZZZ-ZZZZ"}).status_code == 404
    r = c.post("/api/join", json={"code": good})
    print("P6 valid code after 10 wrong from same client IP ->", r.status_code); assert r.status_code == 429

def test_P7_route_can_be_assigned_to_deactivated_driver(c):
    a = owner(c, "a@synthetic.test"); d, _ = driver(c, a)
    c.patch(f"/api/drivers/{d}", json={"active": False}, headers=A(a))
    r = route(c, a, d); print("P7 route to deactivated driver ->", r.status_code); assert r.status_code == 200

def test_P8_driver_status_json_free_form_reaches_owner(c):
    a = owner(c, "a@synthetic.test"); d, t = driver(c, a)
    c.put("/api/sync", json={"status": {"crew": True, "anything": "<b>x</b>"}}, headers=A(t))
    st = c.get("/api/drivers", headers=A(a)).json()["drivers"][0]["status"]
    print("P8 owner sees status", st); assert st == {"crew": True, "anything": "<b>x</b>"}
```

Изход (18–19.10.2026):

```
P1 {'activities': 404, 'shifts': 404, 'patch_driver': 404, 'reinvite': 404, 'patch_route': 404, 'create_route_for_foreign_driver': 404}
P2 {'owner_endpoint': 403, 'other_driver_route': 404, 'edit_own_route_name': 403, 'owner_calls_sync': 403}
P3 create=200 patch_same_geometry= 422
P4 register without code -> 200
P5 token aged to epoch -> 200
P6 valid code after 10 wrong from same client IP -> 429
P7 route to deactivated driver -> 200
P8 owner sees status {'crew': True, 'anything': '<b>x</b>'}
```

## 8. Gate-ове

| Gate | Кой решава | Статус |
|---|---|---|
| Интеграция на кода от #7 в `main` | Павел (merge) | Технически: PASS с ограничения (този преглед) |
| G1-M5 (`Dockerfile` без `planner.html`/`ui/`) | Codex: отделно file assignment в INT-03 или решение къде се сервира планировчикът | Отворен, засяга кандидата |
| G1-M1…M4 преди публичен deploy | Codex: кодови поправки по отделни задачи. Павел: решение за `REGISTRATION_CODE`, Valhalla услуга и срок на токените | Отворени |
| Low/Info | Codex: по преценка | Не блокират |
| `shef` като източник за 29-те файла спрямо локалната папка (BASE-01) | Павел | Отворен; извън обхвата на този преглед |
| GDPR / уведомление към шофьорите / договори | Павел с юрист | Извън обхвата |
