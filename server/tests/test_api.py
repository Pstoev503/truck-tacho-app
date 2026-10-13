"""Тестове на сървъра срещу истински PostgreSQL.

Пускане (от папка server):
    TEST_DATABASE_URL=postgresql+psycopg://taho:taho@127.0.0.1:5432/taho_test pytest -q
"""
import os
import sys
from pathlib import Path

import pytest

os.environ["DATABASE_URL"] = os.environ.get(
    "TEST_DATABASE_URL", "postgresql+psycopg://taho:taho@127.0.0.1:5432/taho_test")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

from app import main  # noqa: E402
from app.db import Base, engine  # noqa: E402

H = 3600_000


@pytest.fixture()
def client():
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    main.login_throttle.hits.clear()
    main.join_throttle.hits.clear()
    with TestClient(main.app) as c:
        yield c


def auth(token):
    return {"Authorization": f"Bearer {token}"}


def register(c, email="shef@firma.bg"):
    r = c.post("/api/owner/register", json={"company": "Транс ЕООД", "name": "Иван", "email": email, "password": "тайна-парола"})
    assert r.status_code == 200, r.text
    return r.json()["token"]


def add_driver(c, boss, name="Павел"):
    r = c.post("/api/drivers", json={"name": name}, headers=auth(boss))
    assert r.status_code == 200, r.text
    return r.json()


def join(c, code):
    r = c.post("/api/join", json={"code": code, "device": "тест"})
    assert r.status_code == 200, r.text
    return r.json()["token"]


def test_register_login_me(client):
    token = register(client)
    me = client.get("/api/me", headers=auth(token)).json()
    assert me["user"]["role"] == "owner" and me["company"]["name"] == "Транс ЕООД"
    assert client.post("/api/owner/login", json={"email": "SHEF@firma.bg ", "password": "тайна-парола"}).status_code == 200
    assert client.post("/api/owner/login", json={"email": "shef@firma.bg", "password": "грешна"}).status_code == 401
    assert client.post("/api/owner/register", json={"company": "Друга", "name": "Петър", "email": "shef@firma.bg",
                                                     "password": "12345678"}).status_code == 409


def test_password_too_short_and_bad_email(client):
    r = client.post("/api/owner/register", json={"company": "Ф", "name": "Иван", "email": "x", "password": "123"})
    assert r.status_code == 422


def test_registration_code_when_required(client, monkeypatch):
    monkeypatch.setenv("REGISTRATION_CODE", "PILOT")
    body = {"company": "Транс", "name": "Иван", "email": "a@b.bg", "password": "12345678"}
    assert client.post("/api/owner/register", json=body).status_code == 403
    assert client.post("/api/owner/register", json={**body, "registration_code": "PILOT"}).status_code == 200


def test_login_throttle(client):
    register(client)
    for _ in range(8):
        client.post("/api/owner/login", json={"email": "shef@firma.bg", "password": "грешна"})
    r = client.post("/api/owner/login", json={"email": "shef@firma.bg", "password": "тайна-парола"})
    assert r.status_code == 429


def test_invite_join_and_one_phone_per_driver(client):
    boss = register(client)
    out = add_driver(client, boss)
    code = out["invite"]["code"]
    assert len(code) == 9 and code[4] == "-"
    drv = join(client, code.lower().replace("-", " "))  # кодът се приема и с малки букви и интервали
    me = client.get("/api/me", headers=auth(drv)).json()
    assert me["user"]["role"] == "driver" and me["user"]["name"] == "Павел"
    # кодът е еднократен
    assert client.post("/api/join", json={"code": code}).status_code == 404
    # нов код → новият телефон влиза, старият излиза
    code2 = client.post(f"/api/drivers/{out['driver']['id']}/invite", headers=auth(boss)).json()["invite"]["code"]
    drv2 = join(client, code2)
    assert client.get("/api/me", headers=auth(drv)).status_code == 401
    assert client.get("/api/me", headers=auth(drv2)).status_code == 200


def test_new_invite_cancels_old_code(client):
    boss = register(client)
    out = add_driver(client, boss)
    client.post(f"/api/drivers/{out['driver']['id']}/invite", headers=auth(boss))
    assert client.post("/api/join", json={"code": out["invite"]["code"]}).status_code == 404


def test_roles_are_separate(client):
    boss = register(client)
    drv = join(client, add_driver(client, boss)["invite"]["code"])
    assert client.get("/api/drivers", headers=auth(drv)).status_code == 403
    assert client.put("/api/sync", json={}, headers=auth(boss)).status_code == 403
    assert client.get("/api/drivers").status_code == 401


def test_other_company_cannot_see_driver(client):
    boss1 = register(client, "a@a.bg")
    d = add_driver(client, boss1)["driver"]
    boss2 = register(client, "b@b.bg")
    assert client.get(f"/api/drivers/{d['id']}/activities", headers=auth(boss2)).status_code == 404
    assert client.patch(f"/api/drivers/{d['id']}", json={"active": False}, headers=auth(boss2)).status_code == 404


def test_sync_replaces_window_and_keeps_history(client):
    boss = register(client)
    out = add_driver(client, boss)
    did = out["driver"]["id"]
    drv = join(client, out["invite"]["code"])
    t0 = 1_760_000_000_000
    first = [{"type": "drive", "start": t0, "end": t0 + H}, {"type": "rest", "start": t0 + H, "end": t0 + 2 * H},
             {"type": "work", "start": t0 + 2 * H, "end": None}]
    r = client.put("/api/sync", json={"activities": first, "status": {"driveRemaining": 123}}, headers=auth(drv))
    assert r.status_code == 200 and r.json()["routes"] == []
    # второто изпращане е само за последните часове: работата е свършила, започнало е каране
    second = [{"type": "work", "start": t0 + 2 * H, "end": t0 + 3 * H}, {"type": "drive", "start": t0 + 3 * H, "end": None}]
    assert client.put("/api/sync", json={"window_start": t0 + 2 * H, "activities": second}, headers=auth(drv)).status_code == 200
    acts = client.get(f"/api/drivers/{did}/activities", headers=auth(boss)).json()["activities"]
    assert [(a["type"], a["end"]) for a in acts] == [("drive", t0 + H), ("rest", t0 + 2 * H), ("work", t0 + 3 * H), ("drive", None)]
    # филтър по време
    acts = client.get(f"/api/drivers/{did}/activities?since={t0 + 2 * H + 1}", headers=auth(boss)).json()["activities"]
    assert [a["type"] for a in acts] == ["work", "drive"]
    drivers = client.get("/api/drivers", headers=auth(boss)).json()["drivers"]
    assert drivers[0]["status"] == {"driveRemaining": 123} and drivers[0]["connected"] and drivers[0]["last_sync_at"]


def test_sync_validation(client):
    boss = register(client)
    drv = join(client, add_driver(client, boss)["invite"]["code"])
    t0 = 1_760_000_000_000
    bad_order = [{"type": "drive", "start": t0, "end": t0 - 1}]
    assert client.put("/api/sync", json={"activities": bad_order}, headers=auth(drv)).status_code == 422
    future = [{"type": "drive", "start": 9_999_999_999_999, "end": None}]
    assert client.put("/api/sync", json={"activities": future}, headers=auth(drv)).status_code == 422
    before_window = [{"type": "drive", "start": t0, "end": None}]
    assert client.put("/api/sync", json={"window_start": t0 + 1, "activities": before_window}, headers=auth(drv)).status_code == 422
    unknown = [{"type": "fly", "start": t0, "end": None}]
    assert client.put("/api/sync", json={"activities": unknown}, headers=auth(drv)).status_code == 422


def test_location_only_when_driver_shares(client):
    boss = register(client)
    drv = join(client, add_driver(client, boss)["invite"]["code"])
    pos = {"lat": 42.33, "lon": 23.55, "speed": 80, "at": 1_760_000_000_000}
    client.put("/api/sync", json={"position": pos}, headers=auth(drv))
    assert client.get("/api/drivers", headers=auth(boss)).json()["drivers"][0]["position"] is None
    client.put("/api/sync", json={"share_location": True, "position": pos}, headers=auth(drv))
    assert client.get("/api/drivers", headers=auth(boss)).json()["drivers"][0]["position"]["lat"] == 42.33
    client.put("/api/sync", json={"share_location": False}, headers=auth(drv))
    assert client.get("/api/drivers", headers=auth(boss)).json()["drivers"][0]["position"] is None


def test_shifts_upsert(client):
    boss = register(client)
    out = add_driver(client, boss)
    drv = join(client, out["invite"]["code"])
    client.put("/api/sync", json={"shifts": [{"day": "2026-10-13", "data": {"start": "06:00"}}]}, headers=auth(drv))
    client.put("/api/sync", json={"shifts": [{"day": "2026-10-13", "data": {"start": "06:00", "end": "17:30"}}]}, headers=auth(drv))
    shifts = client.get(f"/api/drivers/{out['driver']['id']}/shifts", headers=auth(boss)).json()["shifts"]
    assert len(shifts) == 1 and shifts[0]["data"]["end"] == "17:30"
    assert client.put("/api/sync", json={"shifts": [{"day": "13.10.2026", "data": {}}]}, headers=auth(drv)).status_code == 422


def test_routes_flow(client):
    boss = register(client)
    out = add_driver(client, boss)
    did = out["driver"]["id"]
    drv = join(client, out["invite"]["code"])
    wps = [{"lat": 42.33, "lon": 23.55, "label": "Самоков"}, {"lat": 42.69, "lon": 23.32, "label": "София"},
           {"lat": 45.75, "lon": 21.23, "label": "Тимишоара"}]
    r = client.post("/api/routes", json={"name": "Самоков – Тимишоара", "driver_id": did, "waypoints": wps,
                                         "notes": "Без магистрала през Видин"}, headers=auth(boss))
    assert r.status_code == 200, r.text
    rid = r.json()["route"]["id"]
    # шофьорът получава маршрута при синхронизация
    routes = client.put("/api/sync", json={}, headers=auth(drv)).json()["routes"]
    assert [x["id"] for x in routes] == [rid] and routes[0]["waypoints"][2]["label"] == "Тимишоара"
    # шофьорът не може да го променя, само да го отбележи
    assert client.patch(f"/api/routes/{rid}", json={"name": "друго"}, headers=auth(drv)).status_code == 403
    assert client.patch(f"/api/routes/{rid}", json={"status": "done"}, headers=auth(drv)).status_code == 200
    assert client.put("/api/sync", json={}, headers=auth(drv)).json()["routes"] == []
    # собственикът вижда всичко
    assert client.get("/api/routes", headers=auth(boss)).json()["routes"][0]["status"] == "done"


def test_route_validation(client):
    boss = register(client)
    one = [{"lat": 42.0, "lon": 23.0}]
    assert client.post("/api/routes", json={"name": "x", "waypoints": one}, headers=auth(boss)).status_code == 422
    bad = [{"lat": 142.0, "lon": 23.0}, {"lat": 42.0, "lon": 23.0}]
    assert client.post("/api/routes", json={"name": "x", "waypoints": bad}, headers=auth(boss)).status_code == 422
    other_boss = register(client, "c@c.bg")
    d = add_driver(client, other_boss)["driver"]
    ok = [{"lat": 42.0, "lon": 23.0}, {"lat": 43.0, "lon": 24.0}]
    assert client.post("/api/routes", json={"name": "x", "driver_id": d["id"], "waypoints": ok}, headers=auth(boss)).status_code == 404


def test_deactivated_driver_is_logged_out(client):
    boss = register(client)
    out = add_driver(client, boss)
    drv = join(client, out["invite"]["code"])
    client.patch(f"/api/drivers/{out['driver']['id']}", json={"active": False}, headers=auth(boss))
    assert client.get("/api/me", headers=auth(drv)).status_code == 401
    assert client.post(f"/api/drivers/{out['driver']['id']}/invite", headers=auth(boss)).status_code == 409


def test_logout(client):
    boss = register(client)
    assert client.post("/api/logout", headers=auth(boss)).status_code == 200
    assert client.get("/api/me", headers=auth(boss)).status_code == 401
