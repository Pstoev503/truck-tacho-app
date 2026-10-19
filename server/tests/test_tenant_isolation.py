"""TENANT-01: изолация между две фирми и между шофьори на една фирма.

Две synthetic фирми: A (ownerA, driverA1, driverA2) и B (ownerB, driverB).
Всеки отказ проверява и че базата е същата като преди заявката; положителните
контроли показват, че същата заявка минава в своята фирма.

Пускане (от папка server, само срещу тестова база):
    TEST_DATABASE_URL=postgresql+psycopg://taho:taho@127.0.0.1:5432/taho_test pytest -q tests/test_tenant_isolation.py
"""
from types import SimpleNamespace

import pytest
from sqlalchemy import select

# test_api задава DATABASE_URL към тестовата база преди да зареди приложението
from test_api import H, NOW, T0, add_driver, auth, client, join, register  # noqa: F401
from app.db import SessionLocal
from app.models import Activity, AuthToken, Company, Invite, Route, Shift, User

WPS = [{"lat": 42.0, "lon": 23.0, "label": "start"}, {"lat": 43.0, "lon": 24.0, "label": "end"}]
GEOMETRY = [{"lat": 42.0, "lon": 23.0}, {"lat": 42.5, "lon": 23.5}, {"lat": 43.0, "lon": 24.0}]
TABLES = (Company, User, AuthToken, Invite, Activity, Shift, Route)


def db_state() -> dict:
    """Всички редове от всички таблици, за сравнение преди/след."""
    with SessionLocal() as db:
        return {
            model.__tablename__: [
                {col.name: getattr(row, col.key) for col in model.__table__.columns}
                for row in db.scalars(select(model).order_by(model.id))
            ]
            for model in TABLES
        }


def route_row(route_id: int) -> dict:
    with SessionLocal() as db:
        r = db.get(Route, route_id)
        return {col.name: getattr(r, col.key) for col in Route.__table__.columns}


def make_route(c, boss, name, driver_id=None, notes=""):
    r = c.post("/api/routes", json={"name": name, "driver_id": driver_id, "waypoints": WPS,
                                    "geometry": GEOMETRY, "notes": notes}, headers=auth(boss))
    assert r.status_code == 200, r.text
    return r.json()["route"]["id"]


@pytest.fixture()
def world(client):  # noqa: F811
    owner_a = register(client, "owner-a@tenant-a.test")
    owner_b = register(client, "owner-b@tenant-b.test")
    a1 = add_driver(client, owner_a, "Driver-A1 synthetic")
    a2 = add_driver(client, owner_a, "Driver-A2 synthetic")
    b = add_driver(client, owner_b, "Driver-B synthetic")
    w = SimpleNamespace(
        c=client, owner_a=owner_a, owner_b=owner_b,
        a1_id=a1["driver"]["id"], a2_id=a2["driver"]["id"], b_id=b["driver"]["id"],
        a1=join(client, a1["invite"]["code"]), a2=join(client, a2["invite"]["code"]), b=join(client, b["invite"]["code"]),
    )
    me = lambda token: client.get("/api/me", headers=auth(token)).json()  # noqa: E731
    w.owner_a_id, w.owner_b_id = me(owner_a)["user"]["id"], me(owner_b)["user"]["id"]
    w.company_a, w.company_b = me(owner_a)["company"]["id"], me(owner_b)["company"]["id"]
    assert w.company_a != w.company_b
    w.route_a1 = make_route(client, owner_a, "Route-A1", w.a1_id, "notes-A1")
    w.route_a2 = make_route(client, owner_a, "Route-A2", w.a2_id, "notes-A2")
    w.route_a_free = make_route(client, owner_a, "Route-A-unassigned")
    w.route_b = make_route(client, owner_b, "Route-B", w.b_id, "notes-B-secret")
    # B и A1 вече имат дневник и смяна на сървъра
    for token, tag in ((w.b, "B"), (w.a1, "A1")):
        r = client.put("/api/sync", json={
            "activities": [{"type": "drive", "start": T0, "end": T0 + H}, {"type": "rest", "start": T0 + H, "end": None}],
            "status": {"activity": "rest", "tag": tag},
            "shifts": [{"day": "2026-10-13", "data": {"note": f"shift-{tag}"}}],
        }, headers=auth(token))
        assert r.status_code == 200, r.text
    return w


def assert_denied_unchanged(w, method, url, status, json=None, token=None, secrets=()):
    """Заявката е отказана с точния код, без чужди данни в отговора и без промяна в базата."""
    before = db_state()
    r = w.c.request(method, url, json=json, headers=auth(token))
    assert r.status_code == status, (method, url, r.status_code, r.text)
    for secret in secrets:
        assert secret not in r.text, (url, secret)
    assert db_state() == before, (method, url)
    return r


B_SECRETS = ("Driver-B", "Route-B", "notes-B-secret", "shift-B", "tenant-b")


# 1
def test_owner_lists_contain_only_own_company(world):
    w = world
    drivers_a = w.c.get("/api/drivers", headers=auth(w.owner_a))
    assert drivers_a.status_code == 200
    assert sorted(d["id"] for d in drivers_a.json()["drivers"]) == sorted([w.a1_id, w.a2_id])
    assert not any(s in drivers_a.text for s in B_SECRETS)
    routes_a = w.c.get("/api/routes", headers=auth(w.owner_a))
    assert sorted(r["id"] for r in routes_a.json()["routes"]) == sorted([w.route_a1, w.route_a2, w.route_a_free])
    assert not any(s in routes_a.text for s in B_SECRETS)
    # положителен контрол: B вижда своите данни
    assert [d["id"] for d in w.c.get("/api/drivers", headers=auth(w.owner_b)).json()["drivers"]] == [w.b_id]
    assert [r["id"] for r in w.c.get("/api/routes", headers=auth(w.owner_b)).json()["routes"]] == [w.route_b]


# 2
@pytest.mark.parametrize("body", [{"name": "Renamed by A"}, {"active": False}, {"name": "Renamed by A", "active": False}])
def test_owner_cannot_patch_foreign_driver_or_owner(world, body):
    w = world
    for target in (w.b_id, w.owner_b_id, w.owner_a_id):
        r = assert_denied_unchanged(w, "PATCH", f"/api/drivers/{target}", 404, body, w.owner_a, B_SECRETS)
        assert r.json() == {"detail": "Няма такъв шофьор"}
    # B шофьорът е още активен и входът му работи
    assert w.c.get("/api/me", headers=auth(w.b)).status_code == 200
    # положителен контрол: собствен шофьор
    r = w.c.patch(f"/api/drivers/{w.a2_id}", json=body, headers=auth(w.owner_a))
    assert r.status_code == 200 and r.json()["driver"]["id"] == w.a2_id


# 3
def test_owner_cannot_reinvite_foreign_driver(world):
    w = world
    for target in (w.b_id, w.owner_b_id):
        r = assert_denied_unchanged(w, "POST", f"/api/drivers/{target}/invite", 404, None, w.owner_a, B_SECRETS)
        assert "invite" not in r.json()
    # положителен контрол: нов код за собствения шофьор
    with SessionLocal() as db:
        invites_a2 = len(db.scalars(select(Invite).where(Invite.user_id == w.a2_id)).all())
    assert w.c.post(f"/api/drivers/{w.a2_id}/invite", headers=auth(w.owner_a)).status_code == 200
    with SessionLocal() as db:
        assert len(db.scalars(select(Invite).where(Invite.user_id == w.a2_id)).all()) == invites_a2 + 1


# 4
@pytest.mark.parametrize("path", ["activities", "shifts", "activities?since=0", "shifts?from_day=2000-01-01"])
def test_owner_cannot_read_foreign_activities_or_shifts(world, path):
    w = world
    for target in (w.b_id, w.owner_b_id):
        r = assert_denied_unchanged(w, "GET", f"/api/drivers/{target}/{path}", 404, None, w.owner_a, B_SECRETS)
        assert set(r.json()) == {"detail"}
    # положителен контрол: A1 има данни и A ги вижда; B вижда своите
    own = w.c.get(f"/api/drivers/{w.a1_id}/{path}", headers=auth(w.owner_a)).json()
    assert own.get("activities") or own.get("shifts")
    other = w.c.get(f"/api/drivers/{w.b_id}/{path}", headers=auth(w.owner_b)).json()
    assert other.get("activities") or other.get("shifts")


# 5
def test_owner_cannot_create_route_for_foreign_driver(world):
    w = world
    for target in (w.b_id, w.owner_b_id, w.owner_a_id):
        assert_denied_unchanged(w, "POST", "/api/routes", 404,
                                {"name": "Smuggled", "driver_id": target, "waypoints": WPS}, w.owner_a, B_SECRETS)
    # положителен контрол
    rid = make_route(w.c, w.owner_a, "Route-A1-second", w.a1_id)
    row = route_row(rid)
    assert (row["company_id"], row["driver_id"]) == (w.company_a, w.a1_id)


# 6
@pytest.mark.parametrize("extra", [{}, {"name": "Changed"}, {"notes": "x", "status": "cancelled"}])
def test_owner_cannot_assign_own_route_to_foreign_driver(world, extra):
    w = world
    before = route_row(w.route_a1)
    assert_denied_unchanged(w, "PATCH", f"/api/routes/{w.route_a1}", 404,
                            {"driver_id": w.b_id, **extra}, w.owner_a, B_SECRETS)
    assert route_row(w.route_a1) == before
    # B шофьорът не получава маршрута
    assert w.route_a1 not in [r["id"] for r in w.c.get("/api/routes", headers=auth(w.b)).json()["routes"]]


# 7
@pytest.mark.parametrize("body", [
    {}, {"name": "Hijacked"}, {"status": "cancelled"}, {"driver_id": None, "notes": "x"},
    {"waypoints": WPS[::-1]}, {"geometry": []},
])
def test_owner_cannot_patch_foreign_route(world, body):
    w = world
    before = route_row(w.route_b)
    r = assert_denied_unchanged(w, "PATCH", f"/api/routes/{w.route_b}", 404, body, w.owner_a, B_SECRETS)
    assert r.json() == {"detail": "Няма такъв маршрут"}
    assert route_row(w.route_b) == before
    # B пак вижда маршрута си непроменен
    assert [x["name"] for x in w.c.get("/api/routes", headers=auth(w.b)).json()["routes"]] == ["Route-B"]


# 8
def test_driver_sees_only_routes_assigned_to_them(world):
    w = world
    listed = w.c.get("/api/routes", headers=auth(w.a1))
    assert [r["id"] for r in listed.json()["routes"]] == [w.route_a1]
    for secret in ("Route-A2", "Route-A-unassigned", *B_SECRETS):
        assert secret not in listed.text
    synced = w.c.put("/api/sync", json={}, headers=auth(w.a1)).json()["routes"]
    assert [r["id"] for r in synced] == [w.route_a1]
    # положителни контроли за другите шофьори
    assert [r["id"] for r in w.c.get("/api/routes", headers=auth(w.a2)).json()["routes"]] == [w.route_a2]
    assert [r["id"] for r in w.c.get("/api/routes", headers=auth(w.b)).json()["routes"]] == [w.route_b]


# 9
@pytest.mark.parametrize("status", ["seen", "done"])
def test_driver_cannot_mark_other_routes(world, status):
    w = world
    for rid in (w.route_a2, w.route_a_free, w.route_b):
        before = route_row(rid)
        r = assert_denied_unchanged(w, "PATCH", f"/api/routes/{rid}", 404, {"status": status}, w.a1,
                                    ("Route-A2", "Route-A-unassigned", *B_SECRETS))
        assert r.json() == {"detail": "Няма такъв маршрут"}
        assert route_row(rid) == before
    # положителен контрол: собственият маршрут
    r = w.c.patch(f"/api/routes/{w.route_a1}", json={"status": status}, headers=auth(w.a1))
    assert r.status_code == 200 and route_row(w.route_a1)["status"] == status


# 10
@pytest.mark.parametrize("body", [
    {"status": "seen", "name": "Driver rename"},
    {"status": "seen", "notes": "driver notes"},
    {"status": "done", "waypoints": WPS[::-1]},
    {"status": "done", "geometry": GEOMETRY[:2]},
    {"status": "seen", "driver_id": "A2"},
    {"status": "cancelled"},
    {"status": "new"},
    {"name": "Driver rename"},
])
def test_driver_can_only_set_seen_or_done_on_own_route(world, body):
    w = world
    if body.get("driver_id") == "A2":
        body = {**body, "driver_id": w.a2_id}
    before = route_row(w.route_a1)
    assert_denied_unchanged(w, "PATCH", f"/api/routes/{w.route_a1}", 403, body, w.a1)
    assert route_row(w.route_a1) == before


# 11
def test_driver_cannot_reopen_cancelled_route(world):
    w = world
    assert w.c.patch(f"/api/routes/{w.route_a1}", json={"status": "cancelled"}, headers=auth(w.owner_a)).status_code == 200
    for status in ("seen", "done"):
        assert_denied_unchanged(w, "PATCH", f"/api/routes/{w.route_a1}", 409, {"status": status}, w.a1)
    assert route_row(w.route_a1)["status"] == "cancelled"


# 12
@pytest.mark.parametrize(("method", "url", "body"), [
    ("GET", "/api/drivers", None),
    ("POST", "/api/drivers", {"name": "Driver-made driver"}),
    ("PATCH", "/api/drivers/{a2}", {"active": False}),
    ("PATCH", "/api/drivers/{a1}", {"name": "Self rename"}),
    ("POST", "/api/drivers/{a2}/invite", None),
    ("GET", "/api/drivers/{a2}/activities", None),
    ("GET", "/api/drivers/{a1}/shifts", None),
    ("POST", "/api/routes", {"name": "Driver route", "driver_id": "{a1}", "waypoints": WPS}),
    ("POST", "/api/route-options", {"origin": WPS[0], "destination": WPS[1]}),
])
def test_driver_token_has_no_owner_rights(world, method, url, body):
    w = world
    ids = {"{a1}": w.a1_id, "{a2}": w.a2_id}
    for key, value in ids.items():
        url = url.replace(key, str(value))
    if body and body.get("driver_id") in ids:
        body = {**body, "driver_id": ids[body["driver_id"]]}
    r = assert_denied_unchanged(w, method, url, 403, body, w.a1, ("Driver-A2", "Route-A2"))
    assert r.json() == {"detail": "Само за собственика"}


# 13
def test_sync_ignores_supplied_foreign_ids_and_writes_only_own_rows(world):
    w = world
    with SessionLocal() as db:
        b_user = db.get(User, w.b_id)
        b_before = (b_user.status_json, b_user.last_sync_at, b_user.company_id)
        b_acts = [(a.type, a.start, a.end) for a in db.scalars(select(Activity).where(Activity.driver_id == w.b_id))]
        b_shifts = [(s.day, s.data) for s in db.scalars(select(Shift).where(Shift.driver_id == w.b_id))]
        a2_acts = db.scalars(select(Activity).where(Activity.driver_id == w.a2_id)).all()
    start = NOW - 3 * H
    r = w.c.put("/api/sync", json={
        "driver_id": w.b_id, "user_id": w.b_id, "company_id": w.company_b, "id": w.b_id,
        "window_start": start,
        "activities": [{"type": "work", "start": start, "end": start + H, "driver_id": w.b_id},
                       {"type": "drive", "start": start + H, "end": None, "driver_id": w.a2_id}],
        "status": {"activity": "drive", "driver_id": w.b_id},
        "shifts": [{"day": "2026-10-14", "data": {"note": "from-A1"}, "driver_id": w.b_id}],
    }, headers=auth(w.a1))
    # действителното поведение: непознатите полета се пренебрегват, записва се само за A1
    assert r.status_code == 200, r.text
    with SessionLocal() as db:
        b_user = db.get(User, w.b_id)
        assert (b_user.status_json, b_user.last_sync_at, b_user.company_id) == b_before
        assert [(a.type, a.start, a.end) for a in db.scalars(select(Activity).where(Activity.driver_id == w.b_id))] == b_acts
        assert [(s.day, s.data) for s in db.scalars(select(Shift).where(Shift.driver_id == w.b_id))] == b_shifts
        assert db.scalars(select(Activity).where(Activity.driver_id == w.a2_id)).all() == a2_acts == []
        a1 = db.get(User, w.a1_id)
        assert a1.company_id == w.company_a and a1.status_json == {"activity": "drive", "driver_id": w.b_id}
        a1_new = db.scalars(select(Activity).where(Activity.driver_id == w.a1_id, Activity.start >= start)
                            .order_by(Activity.start)).all()
        assert [(a.type, a.start, a.end) for a in a1_new] == [("work", start, start + H), ("drive", start + H, None)]
        assert db.scalar(select(Shift).where(Shift.driver_id == w.a1_id, Shift.day == "2026-10-14")).data == {"note": "from-A1"}
    # ownerB вижда само старите данни на B; ownerA вижда новите при A1
    acts_b = w.c.get(f"/api/drivers/{w.b_id}/activities", headers=auth(w.owner_b)).json()["activities"]
    assert [(a["type"], a["start"], a["end"]) for a in acts_b] == b_acts
    # старата отворена почивка на A1 е затворена точно в началото на прозореца
    acts_a1 = w.c.get(f"/api/drivers/{w.a1_id}/activities", headers=auth(w.owner_a)).json()["activities"]
    assert [(a["type"], a["end"]) for a in acts_a1] == [("drive", T0 + H), ("rest", start), ("work", start + H), ("drive", None)]


# 14
def test_owner_token_cannot_sync_as_a_driver(world):
    w = world
    r = assert_denied_unchanged(w, "PUT", "/api/sync", 403, {
        "driver_id": w.a1_id, "activities": [{"type": "drive", "start": T0, "end": None}],
        "status": {"activity": "drive"}}, w.owner_a)
    assert r.json() == {"detail": "Само за шофьор"}


# 15
def test_reassignment_inside_company_moves_access_between_drivers(world):
    w = world
    r = w.c.patch(f"/api/routes/{w.route_a1}", json={"driver_id": w.a2_id}, headers=auth(w.owner_a))
    assert r.status_code == 200 and route_row(w.route_a1)["driver_id"] == w.a2_id
    assert w.route_a1 not in [x["id"] for x in w.c.get("/api/routes", headers=auth(w.a1)).json()["routes"]]
    assert_denied_unchanged(w, "PATCH", f"/api/routes/{w.route_a1}", 404, {"status": "seen"}, w.a1)
    assert sorted(x["id"] for x in w.c.get("/api/routes", headers=auth(w.a2)).json()["routes"]) == sorted([w.route_a1, w.route_a2])
    assert w.c.patch(f"/api/routes/{w.route_a1}", json={"status": "seen"}, headers=auth(w.a2)).status_code == 200


# 16
def test_foreign_driver_tokens_cannot_touch_company_a(world):
    w = world
    for rid in (w.route_a1, w.route_a_free):
        assert_denied_unchanged(w, "PATCH", f"/api/routes/{rid}", 404, {"status": "done"}, w.b, ("Route-A1", "notes-A1"))
    listed = w.c.get("/api/routes", headers=auth(w.b)).text
    assert "Route-A" not in listed and "notes-A1" not in listed
    # ownerB не е собственик на A маршрути
    assert_denied_unchanged(w, "PATCH", f"/api/routes/{w.route_a1}", 404, {"status": "cancelled"}, w.owner_b, ("Route-A1",))


# 17
@pytest.mark.parametrize(("method", "template", "body", "token"), [
    ("PATCH", "/api/drivers/{driver}", {"name": "Probe"}, "owner_a"),
    ("POST", "/api/drivers/{driver}/invite", None, "owner_a"),
    ("GET", "/api/drivers/{driver}/activities", None, "owner_a"),
    ("GET", "/api/drivers/{driver}/shifts", None, "owner_a"),
    ("PATCH", "/api/routes/{route}", {"name": "Probe"}, "owner_a"),
    ("PATCH", "/api/routes/{route}", {"status": "seen"}, "a1"),
])
def test_foreign_and_missing_ids_get_the_same_answer(world, method, template, body, token):
    """Отговорът не издава дали чуждият запис съществува."""
    w = world
    foreign = template.format(driver=w.b_id, route=w.route_b)
    missing = template.format(driver=999_999, route=999_999)
    a = assert_denied_unchanged(w, method, foreign, 404, body, getattr(w, token), B_SECRETS)
    b = assert_denied_unchanged(w, method, missing, 404, body, getattr(w, token))
    assert a.json() == b.json()
