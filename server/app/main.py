"""Сървър на Top10EU: фирма и собственик, шофьори, синхронизация на дневника, маршрути.

Телефонът на шофьора брои сам (engine/) и праща дневника си тук. Собственикът
вижда шофьорите си в шефското меню (boss.html), което смята броячите в
браузъра със същия код. Сървърът само пази и раздава данните.
"""
import math
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator
import json

from sqlalchemy import delete, select, text, update
from sqlalchemy.orm import Session

from .db import Base, engine, get_db
from .models import Activity, AuthToken, Company, Invite, Route, Shift, User
from .security import (Throttle, fingerprint, hash_password, new_invite_code, new_token, normalize_code,
                       now_ms, verify_password)

DAY_MS = 24 * 3600 * 1000
INVITE_DAYS = 7
MAX_ACTIVITIES_PER_SYNC = 20000
MAX_TS = 4_102_444_800_000  # 2100 г.
MAX_BODY = 5 * 1024 * 1024
HISTORY_LIMIT_MS = 45 * DAY_MS  # телефонът пази 35 дни; по-старото на сървъра не се пипа
TYPES = ("drive", "work", "avail", "rest")



@asynccontextmanager
async def lifespan(_app):
    Base.metadata.create_all(engine)  # таблиците се създават при първото пускане
    yield


app = FastAPI(title="Top10EU", docs_url="/api/docs", openapi_url="/api/openapi.json", lifespan=lifespan)

origins = [o.strip() for o in os.environ.get(
    "ALLOWED_ORIGINS",
    "https://pstoev503.github.io,http://localhost:8765,http://127.0.0.1:8765,http://localhost:8000,http://127.0.0.1:8000",
).split(",") if o.strip()]
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["*"], allow_headers=["*"])


@app.middleware("http")
async def limit_body(request: Request, call_next):
    # заявки над 5 MB не се приемат
    size = request.headers.get("content-length")
    if size and size.isdigit() and int(size) > MAX_BODY:
        return JSONResponse({"detail": "Заявката е твърде голяма"}, status_code=413)
    return await call_next(request)


@app.exception_handler(RequestValidationError)
async def validation_error(_request: Request, exc: RequestValidationError):
    # без да връщаме обратно полученото (може да е NaN или огромно)
    errors = [{"loc": [str(x) for x in e.get("loc", ())], "msg": str(e.get("msg", ""))} for e in exc.errors()]
    return JSONResponse({"detail": "Невалидни данни", "errors": errors[:20]}, status_code=422)

login_throttle = Throttle(max_attempts=8, window_s=15 * 60)
join_throttle = Throttle(max_attempts=10, window_s=15 * 60)


# ─────────────────────────── вход ───────────────────────────

def current_user(authorization: str = Header(default=""), db: Session = Depends(get_db)) -> User:
    if not authorization.lower().startswith("bearer "):
        raise HTTPException(401, "Не си влязъл")
    tok = db.scalar(select(AuthToken).where(AuthToken.token_hash == fingerprint(authorization[7:].strip())))
    if not tok or tok.revoked:
        raise HTTPException(401, "Входът е изтекъл — влез отново")
    user = db.get(User, tok.user_id)
    if not user or not user.active:
        raise HTTPException(401, "Профилът е спрян")
    t = now_ms()
    if t - tok.last_used_at > 3600_000:
        tok.last_used_at = t
        db.commit()
    return user


def owner(user: User = Depends(current_user)) -> User:
    if user.role != "owner":
        raise HTTPException(403, "Само за собственика")
    return user


def driver(user: User = Depends(current_user)) -> User:
    if user.role != "driver":
        raise HTTPException(403, "Само за шофьор")
    return user


def issue_token(db: Session, user: User, device: str = "") -> str:
    token = new_token()
    t = now_ms()
    db.add(AuthToken(user_id=user.id, token_hash=fingerprint(token), device=device[:120], created_at=t, last_used_at=t))
    return token


def user_out(u: User) -> dict:
    return {"id": u.id, "name": u.name, "role": u.role, "email": u.email, "share_location": u.share_location}


def company_out(c: Company) -> dict:
    return {"id": c.id, "name": c.name}


def client_key(request: Request, extra: str = "") -> str:
    ip = request.client.host if request.client else "?"
    return f"{ip}|{extra}"


class RegisterIn(BaseModel):
    company: str = Field(min_length=2, max_length=120)
    name: str = Field(min_length=2, max_length=120)
    email: str = Field(min_length=5, max_length=200)
    password: str = Field(min_length=8, max_length=200)
    registration_code: str = ""

    @field_validator("email")
    @classmethod
    def email_ok(cls, v: str) -> str:
        v = v.strip().lower()
        if "@" not in v or "." not in v.split("@")[-1]:
            raise ValueError("Невалиден имейл")
        return v


@app.post("/api/owner/register")
def register(body: RegisterIn, db: Session = Depends(get_db)):
    required = os.environ.get("REGISTRATION_CODE", "")
    if required and body.registration_code != required:
        raise HTTPException(403, "Нужен е код за регистрация")
    if db.scalar(select(User).where(User.email == body.email)):
        raise HTTPException(409, "Има профил с този имейл — влез с паролата")
    t = now_ms()
    company = Company(name=body.company.strip(), created_at=t)
    db.add(company)
    db.flush()
    user = User(company_id=company.id, role="owner", name=body.name.strip(), email=body.email,
                password_hash=hash_password(body.password), active=True, created_at=t)
    db.add(user)
    db.flush()
    token = issue_token(db, user, "регистрация")
    db.commit()
    return {"token": token, "user": user_out(user), "company": company_out(company)}


class LoginIn(BaseModel):
    email: str = Field(max_length=200)
    password: str = Field(max_length=200)


@app.post("/api/owner/login")
def login(body: LoginIn, request: Request, db: Session = Depends(get_db)):
    email = body.email.strip().lower()
    key = client_key(request, email)
    if login_throttle.blocked(key):
        raise HTTPException(429, "Твърде много опити — изчакай 15 минути")
    user = db.scalar(select(User).where(User.email == email))
    if not user or user.role != "owner" or not user.active or not verify_password(body.password, user.password_hash):
        login_throttle.fail(key)
        raise HTTPException(401, "Грешен имейл или парола")
    login_throttle.reset(key)
    token = issue_token(db, user, "вход")
    db.commit()
    return {"token": token, "user": user_out(user), "company": company_out(db.get(Company, user.company_id))}


@app.post("/api/logout")
def logout(authorization: str = Header(default=""), db: Session = Depends(get_db)):
    if authorization.lower().startswith("bearer "):
        tok = db.scalar(select(AuthToken).where(AuthToken.token_hash == fingerprint(authorization[7:].strip())))
        if tok:
            tok.revoked = True
            u = db.get(User, tok.user_id)
            if u and u.role == "driver":
                u.position_json = None  # изключен телефон: шефът не вижда къде е
            db.commit()
    return {"ok": True}


@app.get("/api/me")
def me(user: User = Depends(current_user), db: Session = Depends(get_db)):
    return {"user": user_out(user), "company": company_out(db.get(Company, user.company_id)), "server_time": now_ms()}


# ─────────────────────────── шофьори ───────────────────────────

def make_invite(db: Session, drv: User) -> dict:
    t = now_ms()
    # старите неизползвани кодове спират да важат
    db.execute(update(Invite).where(Invite.user_id == drv.id, Invite.used_at.is_(None)).values(expires_at=t))
    code = new_invite_code()
    exp = t + INVITE_DAYS * DAY_MS
    db.add(Invite(user_id=drv.id, code_hash=fingerprint(code), created_at=t, expires_at=exp))
    return {"code": f"{code[:4]}-{code[4:]}", "expires_at": exp}


def driver_out(db: Session, d: User) -> dict:
    devices = db.scalar(select(AuthToken.id).where(AuthToken.user_id == d.id, AuthToken.revoked.is_(False)).limit(1))
    return {
        "id": d.id, "name": d.name, "active": d.active, "connected": devices is not None,
        "last_sync_at": d.last_sync_at, "status": d.status_json,
        "position": d.position_json if d.share_location else None, "share_location": d.share_location,
    }


def own_driver(db: Session, boss: User, driver_id: int) -> User:
    d = db.get(User, driver_id)
    if not d or d.company_id != boss.company_id or d.role != "driver":
        raise HTTPException(404, "Няма такъв шофьор")
    return d


class DriverIn(BaseModel):
    name: str = Field(min_length=2, max_length=120)


@app.get("/api/drivers")
def list_drivers(boss: User = Depends(owner), db: Session = Depends(get_db)):
    rows = db.scalars(select(User).where(User.company_id == boss.company_id, User.role == "driver").order_by(User.name))
    return {"drivers": [driver_out(db, d) for d in rows], "server_time": now_ms()}


@app.post("/api/drivers")
def add_driver(body: DriverIn, boss: User = Depends(owner), db: Session = Depends(get_db)):
    d = User(company_id=boss.company_id, role="driver", name=body.name.strip(), active=True, created_at=now_ms())
    db.add(d)
    db.flush()
    invite = make_invite(db, d)
    db.commit()
    return {"driver": driver_out(db, d), "invite": invite}


@app.post("/api/drivers/{driver_id}/invite")
def reinvite(driver_id: int, boss: User = Depends(owner), db: Session = Depends(get_db)):
    d = own_driver(db, boss, driver_id)
    if not d.active:
        raise HTTPException(409, "Шофьорът е спрян")
    invite = make_invite(db, d)
    db.commit()
    return {"invite": invite}


class DriverPatch(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=120)
    active: bool | None = None


@app.patch("/api/drivers/{driver_id}")
def patch_driver(driver_id: int, body: DriverPatch, boss: User = Depends(owner), db: Session = Depends(get_db)):
    d = own_driver(db, boss, driver_id)
    if body.name is not None:
        d.name = body.name.strip()
    if body.active is not None:
        d.active = body.active
        if not body.active:
            db.execute(update(AuthToken).where(AuthToken.user_id == d.id).values(revoked=True))
            db.execute(update(Invite).where(Invite.user_id == d.id, Invite.used_at.is_(None)).values(expires_at=now_ms()))
    db.commit()
    return {"driver": driver_out(db, d)}


def activity_out(a: Activity) -> dict:
    out = {"type": a.type, "start": a.start, "end": a.end}
    if a.ferry:
        out["ferry"] = True
    if a.manual:
        out["manual"] = True
    return out


@app.get("/api/drivers/{driver_id}/activities")
def driver_activities(driver_id: int, since: int | None = None, until: int | None = None,
                      boss: User = Depends(owner), db: Session = Depends(get_db)):
    d = own_driver(db, boss, driver_id)
    q = select(Activity).where(Activity.driver_id == d.id)
    if since is not None:  # всичко, което не е свършило преди since
        q = q.where((Activity.end.is_(None)) | (Activity.end >= since))
    if until is not None:
        q = q.where(Activity.start < until)
    rows = db.scalars(q.order_by(Activity.start, Activity.id))
    return {"activities": [activity_out(a) for a in rows], "server_time": now_ms()}


@app.get("/api/drivers/{driver_id}/shifts")
def driver_shifts(driver_id: int, from_day: str = "", to_day: str = "",
                  boss: User = Depends(owner), db: Session = Depends(get_db)):
    d = own_driver(db, boss, driver_id)
    q = select(Shift).where(Shift.driver_id == d.id)
    if from_day:
        q = q.where(Shift.day >= from_day)
    if to_day:
        q = q.where(Shift.day <= to_day)
    rows = db.scalars(q.order_by(Shift.day))
    return {"shifts": [{"day": s.day, "data": s.data, "updated_at": s.updated_at} for s in rows]}


# ─────────────────────────── телефонът на шофьора ───────────────────────────

class JoinIn(BaseModel):
    code: str = Field(min_length=4, max_length=40)
    device: str = Field(default="", max_length=120)


@app.post("/api/join")
def join(body: JoinIn, request: Request, db: Session = Depends(get_db)):
    key = client_key(request)
    if join_throttle.blocked(key):
        raise HTTPException(429, "Твърде много опити — изчакай 15 минути")
    t = now_ms()
    inv = db.scalar(select(Invite).where(Invite.code_hash == fingerprint(normalize_code(body.code))))
    if not inv or inv.used_at is not None or inv.expires_at < t:
        join_throttle.fail(key)
        raise HTTPException(404, "Кодът е грешен или изтекъл — поискай нов от шефа")
    d = db.get(User, inv.user_id)
    if not d or not d.active:
        raise HTTPException(404, "Кодът е грешен или изтекъл — поискай нов от шефа")
    inv.used_at = t
    # един телефон на шофьор: старите входове спират
    db.execute(update(AuthToken).where(AuthToken.user_id == d.id).values(revoked=True))
    token = issue_token(db, d, body.device or "телефон")
    db.commit()
    return {"token": token, "user": user_out(d), "company": company_out(db.get(Company, d.company_id))}


class ActivityIn(BaseModel):
    type: Literal["drive", "work", "avail", "rest"]
    start: int = Field(ge=0, le=MAX_TS)
    end: int | None = Field(default=None, ge=0, le=MAX_TS)
    ferry: bool = False
    manual: bool = False


class PositionIn(BaseModel):
    lat: float = Field(ge=-90, le=90, allow_inf_nan=False)
    lon: float = Field(ge=-180, le=180, allow_inf_nan=False)
    speed: float | None = Field(default=None, ge=0, le=300, allow_inf_nan=False)
    accuracy: float | None = Field(default=None, ge=0, le=100000, allow_inf_nan=False)
    at: int = Field(ge=0, le=MAX_TS)


def small_dict(v: dict | None, limit: int) -> dict | None:
    if v is not None and len(json.dumps(v, ensure_ascii=False, allow_nan=False)) > limit:
        raise ValueError("Твърде много данни")
    return v


class ShiftIn(BaseModel):
    day: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    data: dict

    @field_validator("data")
    @classmethod
    def data_size(cls, v: dict) -> dict:
        return small_dict(v, 16_000)


class SyncIn(BaseModel):
    # от кой момент нататък дневникът се заменя с изпратения (най-ранното начало в него)
    window_start: int | None = Field(default=None, ge=0, le=MAX_TS)
    activities: list[ActivityIn] = Field(default_factory=list, max_length=MAX_ACTIVITIES_PER_SYNC)
    status: dict | None = None

    @field_validator("status")
    @classmethod
    def status_size(cls, v: dict | None) -> dict | None:
        return small_dict(v, 8_000)
    share_location: bool | None = None
    position: PositionIn | None = None
    shifts: list[ShiftIn] = Field(default_factory=list, max_length=60)


def routes_for_driver(db: Session, d: User) -> list[dict]:
    rows = db.scalars(select(Route).where(Route.driver_id == d.id, Route.status.in_(("new", "seen")))
                      .order_by(Route.created_at.desc()).limit(20))
    return [route_out(r) for r in rows]


@app.put("/api/sync")
def sync(body: SyncIn, me: User = Depends(driver), db: Session = Depends(get_db)):
    # едновременни синхронизации на един шофьор се редят една след друга
    db.execute(text("SELECT pg_advisory_xact_lock(:k)"), {"k": me.id})
    t = now_ms()
    acts = body.activities
    for a in acts:
        if a.end is not None and a.end < a.start:
            raise HTTPException(422, "Запис с край преди началото")
        if a.start > t + 5 * 60_000:
            raise HTTPException(422, "Запис в бъдещето — провери часовника на телефона")
    open_acts = [a for a in acts if a.end is None]
    if len(open_acts) > 1 or (open_acts and open_acts[0].start < max(a.start for a in acts)):
        raise HTTPException(422, "Само последният запис може да е отворен")
    if acts:
        window = body.window_start if body.window_start is not None else min(a.start for a in acts)
        if any(a.start < window for a in acts):
            raise HTTPException(422, "Запис преди началото на прозореца")
        if window < t - HISTORY_LIMIT_MS:
            raise HTTPException(422, "Прозорецът е твърде стар — историята на сървъра не се пипа")
        # запис отпреди прозореца, който е останал отворен или влиза в него (телефонът
        # е бил дълго без връзка), свършва в началото на прозореца
        db.execute(update(Activity).where(
            Activity.driver_id == me.id, Activity.start < window,
            (Activity.end.is_(None)) | (Activity.end > window)).values(end=window))
        # заменяме дневника от прозореца нататък; по-старото остава за историята
        db.execute(delete(Activity).where(Activity.driver_id == me.id, Activity.start >= window))
        db.add_all([Activity(driver_id=me.id, type=a.type, start=a.start, end=a.end, ferry=a.ferry and a.type == "rest",
                             manual=a.manual) for a in acts])
    if body.share_location is not None:
        me.share_location = body.share_location
        if not body.share_location:
            me.position_json = None
    if body.position is not None and me.share_location:
        me.position_json = body.position.model_dump()
    if body.status is not None:
        me.status_json = body.status
        if body.status.get("activity") == "rest":
            me.position_json = None  # в почивка шефът не вижда къде е
    for s in body.shifts:
        row = db.scalar(select(Shift).where(Shift.driver_id == me.id, Shift.day == s.day))
        if row:
            row.data, row.updated_at = s.data, t
        else:
            db.add(Shift(driver_id=me.id, day=s.day, data=s.data, updated_at=t))
    me.last_sync_at = t
    db.commit()
    return {"ok": True, "server_time": t, "routes": routes_for_driver(db, me)}


# ─────────────────────────── маршрути ───────────────────────────

class Waypoint(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lon: float = Field(ge=-180, le=180)
    label: str = Field(default="", max_length=120)

    @field_validator("lat", "lon")
    @classmethod
    def finite(cls, v: float) -> float:
        if not math.isfinite(v):
            raise ValueError("Невалидна координата")
        return v


class RouteIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    driver_id: int | None = None
    waypoints: list[Waypoint] = Field(min_length=2, max_length=25)
    notes: str = Field(default="", max_length=2000)


class RoutePatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    driver_id: int | None = None
    waypoints: list[Waypoint] | None = Field(default=None, min_length=2, max_length=25)
    notes: str | None = Field(default=None, max_length=2000)
    status: Literal["new", "seen", "done", "cancelled"] | None = None


def route_out(r: Route) -> dict:
    return {"id": r.id, "name": r.name, "driver_id": r.driver_id, "waypoints": r.waypoints, "notes": r.notes,
            "status": r.status, "created_at": r.created_at, "updated_at": r.updated_at}


@app.post("/api/routes")
def create_route(body: RouteIn, boss: User = Depends(owner), db: Session = Depends(get_db)):
    if body.driver_id is not None:
        own_driver(db, boss, body.driver_id)
    t = now_ms()
    r = Route(company_id=boss.company_id, driver_id=body.driver_id, created_by=boss.id, name=body.name.strip(),
              waypoints=[w.model_dump() for w in body.waypoints], notes=body.notes, status="new",
              created_at=t, updated_at=t)
    db.add(r)
    db.commit()
    return {"route": route_out(r)}


@app.get("/api/routes")
def list_routes(user: User = Depends(current_user), db: Session = Depends(get_db)):
    if user.role == "driver":
        return {"routes": routes_for_driver(db, user)}
    rows = db.scalars(select(Route).where(Route.company_id == user.company_id)
                      .order_by(Route.created_at.desc()).limit(100))
    return {"routes": [route_out(r) for r in rows]}


@app.patch("/api/routes/{route_id}")
def patch_route(route_id: int, body: RoutePatch, user: User = Depends(current_user), db: Session = Depends(get_db)):
    r = db.get(Route, route_id)
    if not r or r.company_id != user.company_id:
        raise HTTPException(404, "Няма такъв маршрут")
    if user.role == "driver":
        # шофьорът само отбелязва, че е видял или минал маршрута
        if r.driver_id != user.id:
            raise HTTPException(404, "Няма такъв маршрут")
        if body.status not in ("seen", "done") or any(
                v is not None for v in (body.name, body.waypoints, body.notes, body.driver_id)):
            raise HTTPException(403, "Шофьорът може само да отбележи маршрута като видян или минат")
        if r.status == "cancelled":
            raise HTTPException(409, "Маршрутът е отменен от шефа")
        r.status = body.status
    else:
        if body.driver_id is not None:
            own_driver(db, user, body.driver_id)
            r.driver_id = body.driver_id
        if body.name is not None:
            r.name = body.name.strip()
        if body.waypoints is not None:
            r.waypoints = [w.model_dump() for w in body.waypoints]
        if body.notes is not None:
            r.notes = body.notes
        if body.status is not None:
            r.status = body.status
    r.updated_at = now_ms()
    db.commit()
    return {"route": route_out(r)}


@app.get("/api/health")
def health():
    return {"ok": True, "server_time": now_ms()}


# Приложението (index.html, boss.html, engine/) може да се сервира от същия сървър
web_root = os.environ.get("WEB_ROOT")
if web_root and Path(web_root).is_dir():
    app.mount("/", StaticFiles(directory=web_root, html=True), name="web")
