"""Тестове на сървъра срещу истински PostgreSQL.

Пускане (от папка server):
    TEST_DATABASE_URL=postgresql+psycopg://taho:taho@127.0.0.1:5432/taho_test pytest -q
"""
import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.error import HTTPError
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import event

os.environ["DATABASE_URL"] = os.environ.get(
    "TEST_DATABASE_URL", "postgresql+psycopg://taho:taho@127.0.0.1:5432/taho_test")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi.testclient import TestClient  # noqa: E402

from app import main, security  # noqa: E402
from app.db import Base, SessionLocal, engine  # noqa: E402
from app.models import AuthToken, Company, Invite, User  # noqa: E402

H = 3600_000
DAY = 24 * H
NOW = int(time.time() * 1000)
T0 = NOW - 2 * DAY  # записите в тестовете са от преди 2 дни
TEST_REGISTRATION_CODE = "synthetic-test-registration-code"
TRUCK_PROFILE = {
    "heightM": 4.0,
    "widthM": 2.5,
    "lengthM": 16.5,
    "grossWeightT": 40.0,
    "axleLoadT": 10.0,
    "axleCount": 5,
    "hazmat": False,
}


@pytest.fixture()
def client(monkeypatch):
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    main.login_throttle.hits.clear()
    with main.join_lock:
        main.join_throttle.hits.clear()
        main.join_aggregate_throttle.hits.clear()
    with main.route_options_lock:
        main.route_options_throttle.hits.clear()
    monkeypatch.setenv("REGISTRATION_CODE", TEST_REGISTRATION_CODE)
    with TestClient(main.app) as c:
        yield c


def auth(token):
    return {"Authorization": f"Bearer {token}"}


def register(c, email="shef@firma.bg"):
    r = c.post("/api/owner/register", json={"company": "Транс ЕООД", "name": "Иван", "email": email,
                                            "password": "тайна-парола",
                                            "registration_code": TEST_REGISTRATION_CODE})
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


def join_key(code, ip="testclient"):
    return f"{ip}|{main.fingerprint(main.normalize_code(code))}"


def join_aggregate_key(ip="testclient"):
    return f"{ip}|"


def route_options(c, token):
    return c.post("/api/route-options", json=route_options_body(), headers=auth(token))


def route_options_body():
    return {
        "origin": {"lat": 42.7, "lon": 23.3},
        "destination": {"lat": 43.2, "lon": 27.9},
        "truckProfile": TRUCK_PROFILE.copy(),
    }


class RouterResponse:
    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _limit):
        return b'{"trip":{"status":0}}'


def successful_router(calls):
    def urlopen(*_args, **_kwargs):
        calls.append(True)
        return RouterResponse()
    return urlopen


def test_register_login_me(client):
    token = register(client)
    me = client.get("/api/me", headers=auth(token)).json()
    assert me["user"]["role"] == "owner" and me["company"]["name"] == "Транс ЕООД"
    assert client.post("/api/owner/login", json={"email": "SHEF@firma.bg ", "password": "тайна-парола"}).status_code == 200
    assert client.post("/api/owner/login", json={"email": "shef@firma.bg", "password": "грешна"}).status_code == 401
    assert client.post("/api/owner/register", json={"company": "Друга", "name": "Петър", "email": "shef@firma.bg",
                                                     "password": "12345678",
                                                     "registration_code": TEST_REGISTRATION_CODE}).status_code == 409


@pytest.mark.parametrize(("elapsed", "status"), [
    (30 * DAY - 1, 200),
    (30 * DAY, 401),
    (30 * DAY + 1, 401),
])
def test_token_idle_expiry_boundaries(client, monkeypatch, elapsed, status):
    now = 2_000_000_000_000
    monkeypatch.setattr(main, "now_ms", lambda: now)
    token = register(client)
    last_used = now - elapsed
    with SessionLocal() as db:
        auth_token = db.query(AuthToken).filter_by(token_hash=main.fingerprint(token)).one()
        auth_token.created_at = now - elapsed - DAY
        auth_token.last_used_at = last_used
        db.commit()

    assert client.get("/api/me", headers=auth(token)).status_code == status
    with SessionLocal() as db:
        auth_token = db.query(AuthToken).filter_by(token_hash=main.fingerprint(token)).one()
        assert auth_token.last_used_at == (now if status == 200 else last_used)


@pytest.mark.parametrize(("age", "status"), [
    (90 * DAY - 1, 200),
    (90 * DAY, 401),
    (90 * DAY + 1, 401),
])
def test_token_absolute_expiry_boundaries(client, monkeypatch, age, status):
    now = 2_000_000_000_000
    monkeypatch.setattr(main, "now_ms", lambda: now)
    token = register(client)
    last_used = now - 2 * H
    with SessionLocal() as db:
        auth_token = db.query(AuthToken).filter_by(token_hash=main.fingerprint(token)).one()
        auth_token.created_at = now - age
        auth_token.last_used_at = last_used
        db.commit()

    assert client.get("/api/me", headers=auth(token)).status_code == status
    with SessionLocal() as db:
        auth_token = db.query(AuthToken).filter_by(token_hash=main.fingerprint(token)).one()
        assert auth_token.last_used_at == (now if status == 200 else last_used)


def test_active_use_does_not_extend_absolute_token_lifetime(client, monkeypatch):
    now = 2_000_000_000_000
    monkeypatch.setattr(main, "now_ms", lambda: now)
    token = register(client)
    with SessionLocal() as db:
        auth_token = db.query(AuthToken).filter_by(token_hash=main.fingerprint(token)).one()
        auth_token.created_at = now - 90 * DAY
        auth_token.last_used_at = now
        db.commit()

    assert client.get("/api/me", headers=auth(token)).status_code == 401


def test_valid_token_keeps_hourly_last_used_update(client, monkeypatch):
    now = 2_000_000_000_000
    monkeypatch.setattr(main, "now_ms", lambda: now)
    token = register(client)
    with SessionLocal() as db:
        auth_token = db.query(AuthToken).filter_by(token_hash=main.fingerprint(token)).one()
        auth_token.created_at = now - 2 * H
        auth_token.last_used_at = now - 3600_001
        db.commit()

    assert client.get("/api/me", headers=auth(token)).status_code == 200
    with SessionLocal() as db:
        auth_token = db.query(AuthToken).filter_by(token_hash=main.fingerprint(token)).one()
        assert auth_token.last_used_at == now


def test_new_login_issues_a_fresh_valid_token(client, monkeypatch):
    now = 2_000_000_000_000
    monkeypatch.setattr(main, "now_ms", lambda: now)
    register(client)

    login = client.post("/api/owner/login", json={"email": "shef@firma.bg", "password": "тайна-парола"})
    assert login.status_code == 200
    token = login.json()["token"]
    assert client.get("/api/me", headers=auth(token)).status_code == 200


@pytest.mark.parametrize(("created_at", "last_used_at"), [
    (None, 2_000_000_000_000),
    (2_000_000_000_000, None),
    (1.5, 2_000_000_000_000),
    (True, 2_000_000_000_000),
    (-1, 2_000_000_000_000),
    (2_000_000_000_001, 2_000_000_000_002),
    (2_000_000_000_001, 2_000_000_000_000),
])
def test_invalid_token_timestamps_are_rejected_without_refresh(
        monkeypatch, created_at, last_used_at):
    now = 2_000_000_000_000
    monkeypatch.setattr(main, "now_ms", lambda: now)
    user = SimpleNamespace(id=1, active=True)
    token = SimpleNamespace(user_id=1, revoked=False, created_at=created_at, last_used_at=last_used_at)

    class FakeDB:
        committed = False

        def scalar(self, _query):
            return token

        def get(self, _model, _user_id):
            return user

        def commit(self):
            self.committed = True

    monkeypatch.setattr(main, "fingerprint", lambda _raw_token: "test-fingerprint")
    db = FakeDB()
    with pytest.raises(HTTPException) as exc:
        main.current_user(auth("sample")["Authorization"], db)
    assert exc.value.status_code == 401
    assert exc.value.detail == "Входът е изтекъл — влез отново"
    assert not db.committed


def test_password_too_short_and_bad_email(client):
    r = client.post("/api/owner/register", json={"company": "Ф", "name": "Иван", "email": "x", "password": "123"})
    assert r.status_code == 422


def test_registration_code_when_required(client, monkeypatch):
    monkeypatch.setenv("REGISTRATION_CODE", "PILOT")
    body = {"company": "Транс", "name": "Иван", "email": "a@b.bg", "password": "12345678"}
    assert client.post("/api/owner/register", json=body).status_code == 403
    assert client.post("/api/owner/register", json={**body, "registration_code": "WRONG"}).status_code == 403
    response = client.post("/api/owner/register", json={**body, "registration_code": "PILOT"})
    assert response.status_code == 200
    assert client.get("/api/me", headers=auth(response.json()["token"])).status_code == 200


@pytest.mark.parametrize("configured_code", [None, "", " \t\n"])
def test_registration_is_disabled_without_nonempty_configuration(client, monkeypatch, configured_code):
    if configured_code is None:
        monkeypatch.delenv("REGISTRATION_CODE", raising=False)
    else:
        monkeypatch.setenv("REGISTRATION_CODE", configured_code)
    body = {"company": "Транс", "name": "Иван", "email": "a@b.bg", "password": "12345678"}

    response = client.post("/api/owner/register", json=body)

    assert response.status_code == 503
    assert response.json()["detail"] == "Регистрацията не е активирана"
    with SessionLocal() as db:
        assert db.query(Company).count() == 0
        assert db.query(User).count() == 0
        assert db.query(AuthToken).count() == 0


def test_registration_code_compares_unicode_without_server_error(client, monkeypatch):
    monkeypatch.setenv("REGISTRATION_CODE", "κωδικός🔒")
    body = {"company": "Транс", "name": "Иван", "email": "unicode@b.bg", "password": "12345678"}

    wrong = client.post("/api/owner/register", json={**body, "registration_code": "κωδικος🔒"})
    assert wrong.status_code == 403

    response = client.post("/api/owner/register", json={**body, "registration_code": "κωδικός🔒"})
    assert response.status_code == 200
    assert client.get("/api/me", headers=auth(response.json()["token"])).status_code == 200


def test_existing_owner_can_login_when_registration_is_disabled(client, monkeypatch):
    register(client)
    monkeypatch.delenv("REGISTRATION_CODE", raising=False)

    response = client.post("/api/owner/login", json={"email": "shef@firma.bg", "password": "тайна-парола"})
    assert response.status_code == 200
    assert client.get("/api/me", headers=auth(response.json()["token"])).status_code == 200


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


def test_join_limits_ten_lookups_per_ip_and_code_without_partial_reservation(client, monkeypatch):
    code = "bad-join-code"
    for _ in range(10):
        assert client.post("/api/join", json={"code": code}).status_code == 404

    key = join_key(code)
    aggregate_key = join_aggregate_key()
    monkeypatch.setattr(main, "select", lambda *_args, **_kwargs: pytest.fail("unexpected DB lookup"))
    assert client.post("/api/join", json={"code": code}).status_code == 429
    assert len(main.join_throttle.hits[key]) == 10
    assert len(main.join_aggregate_throttle.hits[aggregate_key]) == 10
    assert code not in str(main.join_throttle.hits)


def test_different_valid_code_works_after_ten_bad_codes_from_same_ip(client):
    boss = register(client)
    invite = add_driver(client, boss)["invite"]["code"]
    for _ in range(10):
        assert client.post("/api/join", json={"code": "wrong-invite"}).status_code == 404

    assert client.post("/api/join", json={"code": invite}).status_code == 200
    assert len(main.join_throttle.hits[join_key(invite)]) == 1
    assert len(main.join_aggregate_throttle.hits[join_aggregate_key()]) == 11


def test_join_aggregate_limits_one_hundred_codes_before_database_lookup(client, monkeypatch):
    for i in range(100):
        code = f"bad-{i:05d}"
        assert client.post("/api/join", json={"code": code}).status_code == 404

    blocked_code = "fresh-code"
    monkeypatch.setattr(main, "select", lambda *_args, **_kwargs: pytest.fail("unexpected DB lookup"))
    assert client.post("/api/join", json={"code": blocked_code}).status_code == 429
    assert len(main.join_aggregate_throttle.hits[join_aggregate_key()]) == 100
    assert not main.join_throttle.hits[join_key(blocked_code)]


def test_normalized_join_code_aliases_share_a_budget(client):
    for i in range(10):
        code = "ab-cd" if i % 2 else "A B C D"
        assert client.post("/api/join", json={"code": code}).status_code == 404

    assert client.post("/api/join", json={"code": "ABCD"}).status_code == 429
    assert len(main.join_throttle.hits[join_key("a-b c d")]) == 10


def test_same_code_has_an_independent_budget_for_another_ip(client):
    code = "missing-invite"
    for _ in range(10):
        assert client.post("/api/join", json={"code": code}).status_code == 404

    other = TestClient(main.app, client=("198.51.100.42", 12345))
    with other:
        assert other.post("/api/join", json={"code": code}).status_code == 404
    assert len(main.join_throttle.hits[join_key(code)]) == 10
    assert len(main.join_throttle.hits[join_key(code, "198.51.100.42")]) == 1
    assert len(main.join_aggregate_throttle.hits[join_aggregate_key("198.51.100.42")]) == 1


def test_successful_and_used_invite_lookups_keep_spending_both_budgets(client):
    boss = register(client)
    code = add_driver(client, boss)["invite"]["code"]
    assert client.post("/api/join", json={"code": code}).status_code == 200
    assert client.post("/api/join", json={"code": code}).status_code == 404
    assert len(main.join_throttle.hits[join_key(code)]) == 2
    assert len(main.join_aggregate_throttle.hits[join_aggregate_key()]) == 2


@pytest.mark.parametrize("state", ["inactive", "used", "expired"])
def test_rejected_invite_states_spend_both_join_budgets(client, state):
    boss = register(client)
    out = add_driver(client, boss)
    code = out["invite"]["code"]
    with SessionLocal() as db:
        invite = db.query(Invite).one()
        if state == "inactive":
            db.get(User, out["driver"]["id"]).active = False
        elif state == "used":
            invite.used_at = NOW
        else:
            invite.expires_at = NOW - 1
        db.commit()

    assert client.post("/api/join", json={"code": code}).status_code == 404
    assert len(main.join_throttle.hits[join_key(code)]) == 1
    assert len(main.join_aggregate_throttle.hits[join_aggregate_key()]) == 1


@pytest.mark.parametrize(("elapsed", "blocked"), [
    (899.999, True),
    (900, False),
    (900.001, False),
])
def test_join_budget_window_boundary(elapsed, blocked, monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(security.time, "time", lambda: clock[0])
    ip = f"window-check-{elapsed}"
    key, aggregate_key = join_key("window-check", ip), join_aggregate_key(ip)
    with main.join_lock:
        main.join_throttle.reset(key)
        main.join_aggregate_throttle.reset(aggregate_key)
    for _ in range(10):
        main.join_throttle.fail(key)
    for _ in range(100):
        main.join_aggregate_throttle.fail(aggregate_key)
    clock[0] += elapsed

    assert main.join_throttle.blocked(key) is blocked
    assert main.join_aggregate_throttle.blocked(aggregate_key) is blocked
    with main.join_lock:
        main.join_throttle.reset(key)
        main.join_aggregate_throttle.reset(aggregate_key)


def test_join_lock_is_released_before_database_lookup(client):
    acquired_during_query = []

    def check_lock_released(_conn, _cursor, _statement, _parameters, _context, _executemany):
        acquired = main.join_lock.acquire(blocking=False)
        acquired_during_query.append(acquired)
        if acquired:
            main.join_lock.release()

    event.listen(engine, "before_cursor_execute", check_lock_released)
    try:
        assert client.post("/api/join", json={"code": "missing-invite"}).status_code == 404
    finally:
        event.remove(engine, "before_cursor_execute", check_lock_released)
    assert acquired_during_query and all(acquired_during_query)


def test_concurrent_same_code_requests_reserve_no_more_than_ten_lookups(client):
    with ThreadPoolExecutor(max_workers=20) as pool:
        statuses = list(pool.map(
            lambda _index: client.post("/api/join", json={"code": "parallel-missing"}).status_code,
            range(20),
        ))

    assert statuses.count(404) == 10
    assert statuses.count(429) == 10
    assert len(main.join_throttle.hits[join_key("parallel-missing")]) == 10
    assert len(main.join_aggregate_throttle.hits[join_aggregate_key()]) == 10


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
    t0 = T0
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
    t0 = T0
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
    pos = {"lat": 42.33, "lon": 23.55, "speed": 80, "at": T0}
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


def test_stale_open_entry_is_closed_after_long_offline(client):
    """Телефонът е бил 5 дни без връзка: старият отворен запис на сървъра се затваря."""
    boss = register(client)
    out = add_driver(client, boss)
    did, drv = out["driver"]["id"], join(client, out["invite"]["code"])
    old = NOW - 5 * DAY
    client.put("/api/sync", json={"activities": [{"type": "drive", "start": old, "end": None}]}, headers=auth(drv))
    recent = [{"type": "rest", "start": NOW - 2 * DAY, "end": NOW - DAY}, {"type": "work", "start": NOW - DAY, "end": None}]
    assert client.put("/api/sync", json={"activities": recent}, headers=auth(drv)).status_code == 200
    acts = client.get(f"/api/drivers/{did}/activities", headers=auth(boss)).json()["activities"]
    assert acts[0] == {"type": "drive", "start": old, "end": NOW - 2 * DAY}
    assert [a["end"] is None for a in acts] == [False, False, True]


def test_sync_rejects_bad_shapes(client):
    boss = register(client)
    drv = join(client, add_driver(client, boss)["invite"]["code"])
    two_open = [{"type": "drive", "start": T0, "end": None}, {"type": "rest", "start": T0 + H, "end": None}]
    assert client.put("/api/sync", json={"activities": two_open}, headers=auth(drv)).status_code == 422
    open_in_middle = [{"type": "drive", "start": T0, "end": None}, {"type": "rest", "start": T0 + H, "end": T0 + 2 * H}]
    assert client.put("/api/sync", json={"activities": open_in_middle}, headers=auth(drv)).status_code == 422
    too_old = [{"type": "drive", "start": NOW - 60 * DAY, "end": NOW - 59 * DAY}]
    assert client.put("/api/sync", json={"activities": too_old}, headers=auth(drv)).status_code == 422
    huge_end = [{"type": "drive", "start": T0, "end": 10 ** 20}]
    assert client.put("/api/sync", json={"activities": huge_end}, headers=auth(drv)).status_code == 422
    nan_speed = '{"share_location": true, "position": {"lat": 42, "lon": 23, "speed": NaN, "at": 1}}'
    r = client.put("/api/sync", content=nan_speed, headers={**auth(drv), "Content-Type": "application/json"})
    assert r.status_code == 422
    big_status = {"x": "a" * 9000}
    assert client.put("/api/sync", json={"status": big_status}, headers=auth(drv)).status_code == 422


def test_location_cleared_on_rest_and_logout(client):
    boss = register(client)
    drv = join(client, add_driver(client, boss)["invite"]["code"])
    pos = {"lat": 42.33, "lon": 23.55, "at": NOW}
    client.put("/api/sync", json={"share_location": True, "position": pos, "status": {"activity": "drive"}}, headers=auth(drv))
    assert client.get("/api/drivers", headers=auth(boss)).json()["drivers"][0]["position"]
    client.put("/api/sync", json={"status": {"activity": "rest"}}, headers=auth(drv))
    assert client.get("/api/drivers", headers=auth(boss)).json()["drivers"][0]["position"] is None
    client.put("/api/sync", json={"position": pos, "status": {"activity": "drive"}}, headers=auth(drv))
    client.post("/api/logout", headers=auth(drv))
    assert client.get("/api/drivers", headers=auth(boss)).json()["drivers"][0]["position"] is None


def test_cancelled_route_cannot_be_reopened_by_driver(client):
    boss = register(client)
    out = add_driver(client, boss)
    drv = join(client, out["invite"]["code"])
    wps = [{"lat": 42.0, "lon": 23.0}, {"lat": 43.0, "lon": 24.0}]
    rid = client.post("/api/routes", json={"name": "x", "driver_id": out["driver"]["id"], "waypoints": wps},
                      headers=auth(boss)).json()["route"]["id"]
    client.patch(f"/api/routes/{rid}", json={"status": "cancelled"}, headers=auth(boss))
    assert client.patch(f"/api/routes/{rid}", json={"status": "seen"}, headers=auth(drv)).status_code == 409


def test_code_typed_with_cyrillic_letters(client):
    boss = register(client)
    code = add_driver(client, boss)["invite"]["code"]
    cyr = code.translate(str.maketrans("ABEKMHPCTXY", "АВЕКМНРСТХУ")).lower()
    assert client.post("/api/join", json={"code": cyr}).status_code == 200


def test_oversized_body_rejected(client):
    r = client.post("/api/owner/login", content=b"x" * 10, headers={"Content-Length": str(6 * 1024 * 1024), "Content-Type": "application/json"})
    assert r.status_code == 413


@pytest.mark.parametrize("configured", [
    None, "", " \t\n", "/router", "https:///route", "ftp://router.example",
    "https://" + ":".join(("test-user", "test-password")) + "@router.example",
    "https://router.example/path?key=value",
    "https://router.example/path#fragment", "https://router.example:notaport",
    "https://router.example:65536", "https://router.example:",
])
def test_route_options_rejects_missing_or_invalid_router_without_egress(
        client, monkeypatch, configured):
    token = register(client)
    if configured is None:
        monkeypatch.delenv("VALHALLA_URL", raising=False)
    else:
        monkeypatch.setenv("VALHALLA_URL", configured)
    calls = []
    monkeypatch.setattr(main, "urlopen", lambda *args, **kwargs: calls.append((args, kwargs)))

    response = client.post("/api/route-options", json={
        "origin": {"lat": 42.7, "lon": 23.3},
        "destination": {"lat": 43.2, "lon": 27.9},
        "truckProfile": TRUCK_PROFILE,
    }, headers=auth(token))

    assert response.status_code == 503
    assert response.json()["detail"] == "Маршрутизаторът не е активиран"
    assert not calls


@pytest.mark.parametrize(("configured", "expected_url"), [
    ("  https://router.example/base///  ", "https://router.example/base/route"),
    ("http://127.0.0.1:8000/valhalla/", "http://127.0.0.1:8000/valhalla/route"),
])
def test_route_options_uses_explicit_router_and_bounded_payload(
        client, monkeypatch, configured, expected_url):
    token = register(client)
    monkeypatch.setenv("VALHALLA_URL", configured)
    calls = []

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self, limit):
            assert limit == main.MAX_BODY + 1
            return b'{"trip":{"status":0}}'

    def fake_urlopen(request, timeout):
        calls.append((request, timeout))
        return Response()

    monkeypatch.setattr(main, "urlopen", fake_urlopen)
    response = client.post("/api/route-options", json={
        "origin": {"lat": 42.7, "lon": 23.3},
        "destination": {"lat": 43.2, "lon": 27.9},
        "truckProfile": TRUCK_PROFILE,
    }, headers=auth(token))

    assert response.status_code == 200
    assert len(calls) == 1
    request, timeout = calls[0]
    assert request.full_url == expected_url
    assert request.get_method() == "POST"
    assert timeout == 25
    assert json.loads(request.data) == {
        "locations": [{"lat": 42.7, "lon": 23.3}, {"lat": 43.2, "lon": 27.9}],
        "costing": "truck",
        "costing_options": {
            "truck": {
                "height": 4.0,
                "width": 2.5,
                "length": 16.5,
                "weight": 40.0,
                "axle_load": 10.0,
                "axle_count": 5,
                "hazmat": False,
            },
        },
        "units": "kilometers",
        "alternates": 2,
    }


@pytest.mark.parametrize(("response_size", "status"), [
    (main.MAX_BODY - 1, 200),
    (main.MAX_BODY, 200),
    (main.MAX_BODY + 1, 502),
])
def test_route_options_bounds_upstream_response_size(
        client, monkeypatch, response_size, status):
    token = register(client)
    monkeypatch.setenv("VALHALLA_URL", "https://synthetic-router.example")
    response_body = b'{"trip":{"status":0}}' + b" " * (
        response_size - len(b'{"trip":{"status":0}}'))

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self, limit):
            assert limit == main.MAX_BODY + 1
            return response_body[:limit]

    monkeypatch.setattr(main, "urlopen", lambda *_args, **_kwargs: Response())

    response = route_options(client, token)

    assert response.status_code == status
    if status == 200:
        assert response.json() == {"trip": {"status": 0}}
    else:
        assert response.json() == {"detail": "Маршрутизаторът не върна валиден маршрут"}


INVALID_ROUTE_JSON = [
    pytest.param(b'{"trip":{"status":NaN}}', id="nan"),
    pytest.param(b'{"trip":{"status":Infinity}}', id="infinity"),
    pytest.param(b'{"trip":{"status":-Infinity}}', id="negative-infinity"),
    pytest.param(b'{"trip":{"status":1e400}}', id="positive-overflow"),
    pytest.param(b'{"trip":{"status":-1e400}}', id="negative-overflow"),
    pytest.param(b'{"trip":{"status":1.0e+9999}}', id="large-exponent"),
    pytest.param(b'{"trip":{"status":-9E9999}}', id="negative-large-exponent"),
    pytest.param(b'{"trip":undefined}', id="non-json-literal"),
    pytest.param(b'{"trip":{"status":0,}}', id="trailing-comma"),
    pytest.param(b"", id="empty"),
    pytest.param(b"\xff", id="invalid-utf8"),
    pytest.param(b'{"trip":{"status":' + b"9" * 5000 + b'}}', id="oversized-integer"),
    pytest.param(
        b'{"trip":{"nested":' + b"[" * 1100 + b"0" + b"]" * 1100 + b'}}',
        id="excessive-depth",
    ),
]


@pytest.mark.parametrize("response_body", INVALID_ROUTE_JSON)
def test_route_options_rejects_invalid_upstream_json_generically(
        client, monkeypatch, response_body):
    token = register(client)
    monkeypatch.setenv("VALHALLA_URL", "https://synthetic-router.example")

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self, limit):
            assert limit == main.MAX_BODY + 1
            return response_body

    monkeypatch.setattr(main, "urlopen", lambda *_args, **_kwargs: Response())

    response = route_options(client, token)

    assert response.status_code == 503
    assert response.json() == {"detail": "Маршрутизаторът временно не отговаря"}
    decoded_body = response_body.decode("utf-8", errors="ignore")
    assert not decoded_body or decoded_body not in response.text


def test_route_options_maps_json_recursion_error_to_generic_503(client, monkeypatch):
    token = register(client)
    monkeypatch.setenv("VALHALLA_URL", "https://synthetic-router.example")
    original_loads = json.loads

    def fail_route_response(data, *args, **kwargs):
        if data == b'{"trip":{"status":0}}':
            raise RecursionError("synthetic parser recursion")
        return original_loads(data, *args, **kwargs)

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self, _limit):
            return b'{"trip":{"status":0}}'

    monkeypatch.setattr(main.json, "loads", fail_route_response)
    monkeypatch.setattr(main, "urlopen", lambda *_args, **_kwargs: Response())

    response = route_options(client, token)

    assert response.status_code == 503
    assert response.json() == {"detail": "Маршрутизаторът временно не отговаря"}


def test_route_options_invalid_json_failures_consume_owner_budget(client, monkeypatch):
    token = register(client)
    monkeypatch.setenv("VALHALLA_URL", "https://synthetic-router.example")

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self, _limit):
            return b'{"trip":{"status":NaN}}'

    monkeypatch.setattr(main, "urlopen", lambda *_args, **_kwargs: Response())

    assert all(route_options(client, token).status_code == 503 for _ in range(10))
    assert route_options(client, token).status_code == 429


def test_route_options_maps_distinct_profiles_without_mutating_input(client, monkeypatch):
    token = register(client)
    monkeypatch.setenv("VALHALLA_URL", "https://synthetic-router.example")
    payloads = []

    def fake_urlopen(request, timeout):
        assert timeout == 25
        payloads.append(json.loads(request.data))
        return RouterResponse()

    monkeypatch.setattr(main, "urlopen", fake_urlopen)
    profiles = [
        TRUCK_PROFILE.copy(),
        {
            "heightM": 3,
            "widthM": 2,
            "lengthM": 12,
            "grossWeightT": 18,
            "axleLoadT": 6,
            "axleCount": 3,
            "hazmat": True,
        },
    ]
    original_profiles = [profile.copy() for profile in profiles]

    for profile in profiles:
        body = route_options_body()
        body["truckProfile"] = profile
        response = client.post("/api/route-options", json=body, headers=auth(token))
        assert response.status_code == 200

    assert profiles == original_profiles
    assert payloads == [
        {
            "locations": [{"lat": 42.7, "lon": 23.3}, {"lat": 43.2, "lon": 27.9}],
            "costing": "truck",
            "costing_options": {
                "truck": {
                    "height": 4.0,
                    "width": 2.5,
                    "length": 16.5,
                    "weight": 40.0,
                    "axle_load": 10.0,
                    "axle_count": 5,
                    "hazmat": False,
                },
            },
            "units": "kilometers",
            "alternates": 2,
        },
        {
            "locations": [{"lat": 42.7, "lon": 23.3}, {"lat": 43.2, "lon": 27.9}],
            "costing": "truck",
            "costing_options": {
                "truck": {
                    "height": 3,
                    "width": 2,
                    "length": 12,
                    "weight": 18,
                    "axle_load": 6,
                    "axle_count": 3,
                    "hazmat": True,
                },
            },
            "units": "kilometers",
            "alternates": 2,
        },
    ]
    assert payloads[0] != payloads[1]


@pytest.mark.parametrize(("failure", "status"), [
    ("upstream", 503),
    ("invalid-response", 502),
])
def test_route_options_upstream_failures_do_not_fallback(
        client, monkeypatch, failure, status):
    token = register(client)
    monkeypatch.setenv("VALHALLA_URL", "https://synthetic-router.example/base")
    calls = []

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self, _limit):
            return b"{}"

    def fake_urlopen(request, timeout):
        calls.append(request.full_url)
        if failure == "upstream":
            raise HTTPError(request.full_url, 503, "synthetic", None, None)
        return Response()

    monkeypatch.setattr(main, "urlopen", fake_urlopen)
    response = client.post("/api/route-options", json={
        "origin": {"lat": 42.7, "lon": 23.3},
        "destination": {"lat": 43.2, "lon": 27.9},
        "truckProfile": TRUCK_PROFILE,
    }, headers=auth(token))

    assert response.status_code == status
    assert calls == ["https://synthetic-router.example/base/route"]


def test_route_options_remains_owner_only(client, monkeypatch):
    monkeypatch.setenv("VALHALLA_URL", "https://synthetic-router.example")
    calls = []
    monkeypatch.setattr(main, "urlopen", lambda *args, **kwargs: calls.append((args, kwargs)))

    body = route_options_body()
    anonymous = client.post("/api/route-options", json=body)
    boss = register(client)
    driver = join(client, add_driver(client, boss)["invite"]["code"])
    driver_response = client.post("/api/route-options", json=body, headers=auth(driver))

    assert anonymous.status_code == 401
    assert driver_response.status_code == 403
    assert not calls
    assert not main.route_options_throttle.hits


def test_route_options_missing_profile_rejects_before_egress_or_budget(client, monkeypatch):
    token = register(client)
    monkeypatch.setenv("VALHALLA_URL", "https://synthetic-router.example")
    calls = []
    monkeypatch.setattr(main, "urlopen", lambda *args, **kwargs: calls.append((args, kwargs)))
    body = route_options_body()
    del body["truckProfile"]

    response = client.post("/api/route-options", json=body, headers=auth(token))

    assert response.status_code == 422
    assert not calls
    assert not main.route_options_throttle.hits


@pytest.mark.parametrize("option", ["ignore_access", "ignore_restrictions"])
def test_route_options_rejects_access_bypass_options_before_egress_or_budget(
        client, monkeypatch, option):
    token = register(client)
    monkeypatch.setenv("VALHALLA_URL", "https://synthetic-router.example")
    calls = []
    monkeypatch.setattr(main, "urlopen", lambda *args, **kwargs: calls.append((args, kwargs)))
    body = route_options_body()
    body["truckProfile"][option] = True

    response = client.post("/api/route-options", json=body, headers=auth(token))

    assert response.status_code == 422
    assert not calls
    assert not main.route_options_throttle.hits


@pytest.mark.parametrize("missing_field", [
    "heightM", "widthM", "lengthM", "grossWeightT", "axleLoadT", "axleCount", "hazmat",
])
def test_route_options_rejects_incomplete_profile_before_egress_or_budget(
        client, monkeypatch, missing_field):
    token = register(client)
    monkeypatch.setenv("VALHALLA_URL", "https://synthetic-router.example")
    calls = []
    monkeypatch.setattr(main, "urlopen", lambda *args, **kwargs: calls.append((args, kwargs)))
    body = route_options_body()
    del body["truckProfile"][missing_field]

    response = client.post("/api/route-options", json=body, headers=auth(token))

    assert response.status_code == 422
    assert not calls
    assert not main.route_options_throttle.hits


@pytest.mark.parametrize("profile", [
    None,
    "truck",
    [],
    TRUCK_PROFILE | {"unexpected": True},
    TRUCK_PROFILE | {"heightM": 0},
    TRUCK_PROFILE | {"heightM": -1},
    TRUCK_PROFILE | {"widthM": 0},
    TRUCK_PROFILE | {"lengthM": 0},
    TRUCK_PROFILE | {"grossWeightT": 0},
    TRUCK_PROFILE | {"axleLoadT": 0},
    TRUCK_PROFILE | {"axleLoadT": 41},
    TRUCK_PROFILE | {"axleCount": 0},
    TRUCK_PROFILE | {"axleCount": 5.0},
    TRUCK_PROFILE | {"axleCount": True},
    TRUCK_PROFILE | {"hazmat": "false"},
    TRUCK_PROFILE | {"heightM": "4.0"},
])
def test_route_options_rejects_invalid_profile_before_egress_or_budget(
        client, monkeypatch, profile):
    token = register(client)
    monkeypatch.setenv("VALHALLA_URL", "https://synthetic-router.example")
    calls = []
    monkeypatch.setattr(main, "urlopen", lambda *args, **kwargs: calls.append((args, kwargs)))
    body = route_options_body()
    body["truckProfile"] = profile

    response = client.post("/api/route-options", json=body, headers=auth(token))

    assert response.status_code == 422
    assert not calls
    assert not main.route_options_throttle.hits


def test_route_options_budget_allows_ten_and_rejects_eleventh(client, monkeypatch):
    token = register(client)
    monkeypatch.setenv("VALHALLA_URL", "https://synthetic-router.example")
    calls = []
    monkeypatch.setattr(main, "urlopen", successful_router(calls))

    responses = [route_options(client, token) for _ in range(11)]

    assert [response.status_code for response in responses] == [200] * 10 + [429]
    assert responses[-1].json()["detail"]
    assert len(calls) == 10


def test_route_options_success_does_not_reset_budget(client, monkeypatch):
    token = register(client)
    monkeypatch.setenv("VALHALLA_URL", "https://synthetic-router.example")
    calls = []
    monkeypatch.setattr(main, "urlopen", successful_router(calls))

    assert all(route_options(client, token).status_code == 200 for _ in range(10))
    assert route_options(client, token).status_code == 429
    assert len(calls) == 10


def test_route_options_upstream_failures_consume_budget(client, monkeypatch):
    token = register(client)
    monkeypatch.setenv("VALHALLA_URL", "https://synthetic-router.example")
    calls = []

    def fail_upstream(request, **_kwargs):
        calls.append(request.full_url)
        raise HTTPError(request.full_url, 503, "synthetic", None, None)

    monkeypatch.setattr(main, "urlopen", fail_upstream)

    assert all(route_options(client, token).status_code == 503 for _ in range(10))
    assert route_options(client, token).status_code == 429
    assert len(calls) == 10


def test_route_options_invalid_config_does_not_consume_budget(client, monkeypatch):
    token = register(client)
    monkeypatch.setenv("VALHALLA_URL", "https://router.example/path?invalid")
    calls = []
    monkeypatch.setattr(main, "urlopen", successful_router(calls))

    assert route_options(client, token).status_code == 503
    monkeypatch.setenv("VALHALLA_URL", "https://synthetic-router.example")

    assert all(route_options(client, token).status_code == 200 for _ in range(10))
    assert route_options(client, token).status_code == 429
    assert len(calls) == 10


@pytest.mark.parametrize(("elapsed", "expected_status"), [
    (59.999, 429),
    (60, 200),
    (60.001, 200),
])
def test_route_options_sliding_window_boundary(client, monkeypatch, elapsed, expected_status):
    token = register(client)
    monkeypatch.setenv("VALHALLA_URL", "https://synthetic-router.example")
    clock = [time.time()]
    monkeypatch.setattr(security.time, "time", lambda: clock[0])
    calls = []
    monkeypatch.setattr(main, "urlopen", successful_router(calls))

    assert all(route_options(client, token).status_code == 200 for _ in range(10))
    clock[0] += elapsed

    assert route_options(client, token).status_code == expected_status
    assert len(calls) == 10 + (expected_status == 200)


def test_route_options_budget_is_shared_by_owner_tokens(client, monkeypatch):
    token = register(client)
    second_token = client.post("/api/owner/login", json={
        "email": "shef@firma.bg", "password": "тайна-парола",
    }).json()["token"]
    monkeypatch.setenv("VALHALLA_URL", "https://synthetic-router.example")
    calls = []
    monkeypatch.setattr(main, "urlopen", successful_router(calls))

    assert all(route_options(client, token).status_code == 200 for _ in range(6))
    assert all(route_options(client, second_token).status_code == 200 for _ in range(4))
    assert route_options(client, second_token).status_code == 429
    assert len(calls) == 10


def test_route_options_budget_is_isolated_by_company_and_owner(client, monkeypatch):
    first_token = register(client)
    second_token = register(client, "other@firma.bg")
    monkeypatch.setenv("VALHALLA_URL", "https://synthetic-router.example")
    calls = []
    monkeypatch.setattr(main, "urlopen", successful_router(calls))

    assert all(route_options(client, first_token).status_code == 200 for _ in range(10))
    assert all(route_options(client, second_token).status_code == 200 for _ in range(10))
    assert route_options(client, first_token).status_code == 429
    assert route_options(client, second_token).status_code == 429
    assert len(calls) == 20


def test_route_options_concurrent_reservations_never_exceed_ten(client, monkeypatch):
    token = register(client)
    monkeypatch.setenv("VALHALLA_URL", "https://synthetic-router.example")
    calls = []
    barrier = threading.Barrier(10)

    def concurrent_upstream(*_args, **_kwargs):
        calls.append(True)
        barrier.wait(timeout=10)
        return RouterResponse()

    monkeypatch.setattr(main, "urlopen", concurrent_upstream)
    with ThreadPoolExecutor(max_workers=12) as pool:
        responses = list(pool.map(lambda _index: route_options(client, token), range(12)))

    assert sorted(response.status_code for response in responses) == [200] * 10 + [429] * 2
    assert len(calls) == 10
