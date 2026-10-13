"""Таблиците. Всички времена са в милисекунди от 1970 г. (UTC), както в приложението."""
from sqlalchemy import JSON, BigInteger, Boolean, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base

Json = JSON().with_variant(JSONB(), "postgresql")


class Company(Base):
    """Фирма (превозвач)."""
    __tablename__ = "companies"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    created_at: Mapped[int] = mapped_column(BigInteger)


class User(Base):
    """Собственик (влиза с имейл и парола) или шофьор (влиза с код за покана)."""
    __tablename__ = "users"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id"), index=True)
    role: Mapped[str] = mapped_column(String(10))  # owner | driver
    name: Mapped[str] = mapped_column(String(120))
    email: Mapped[str | None] = mapped_column(String(200), unique=True, nullable=True)
    password_hash: Mapped[str | None] = mapped_column(String(200), nullable=True)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[int] = mapped_column(BigInteger)
    # последното, което телефонът на шофьора е изпратил
    share_location: Mapped[bool] = mapped_column(Boolean, default=False)
    last_sync_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    status_json: Mapped[dict | None] = mapped_column(Json, nullable=True)
    position_json: Mapped[dict | None] = mapped_column(Json, nullable=True)


class AuthToken(Base):
    """Вход от едно устройство. Пазим само отпечатъка (sha256) на токена."""
    __tablename__ = "auth_tokens"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    device: Mapped[str] = mapped_column(String(120), default="")
    created_at: Mapped[int] = mapped_column(BigInteger)
    last_used_at: Mapped[int] = mapped_column(BigInteger)
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)


class Invite(Base):
    """Код, с който шофьорът свързва телефона си с фирмата. Еднократен, със срок."""
    __tablename__ = "invites"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    code_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[int] = mapped_column(BigInteger)
    expires_at: Mapped[int] = mapped_column(BigInteger)
    used_at: Mapped[int | None] = mapped_column(BigInteger, nullable=True)


class Activity(Base):
    """Запис от дневника на дейностите на шофьора (engine/activity-log.js)."""
    __tablename__ = "activities"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    driver_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    type: Mapped[str] = mapped_column(String(8))  # drive | work | avail | rest
    start: Mapped[int] = mapped_column(BigInteger)
    end: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    ferry: Mapped[bool] = mapped_column(Boolean, default=False)
    manual: Mapped[bool] = mapped_column(Boolean, default=False)
    __table_args__ = (Index("ix_activities_driver_start", "driver_id", "start"),)


class Shift(Base):
    """Смяна от отчета на шофьора: начало, край, места, пробег, бележки, нарушения."""
    __tablename__ = "shifts"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    driver_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    day: Mapped[str] = mapped_column(String(10))  # 2026-10-13
    data: Mapped[dict] = mapped_column(Json)
    updated_at: Mapped[int] = mapped_column(BigInteger)
    __table_args__ = (UniqueConstraint("driver_id", "day", name="uq_shift_driver_day"),)


class Route(Base):
    """Маршрут, начертан от собственика и изпратен на шофьор."""
    __tablename__ = "routes"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id"), index=True)
    driver_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True, index=True)
    created_by: Mapped[int] = mapped_column(ForeignKey("users.id"))
    name: Mapped[str] = mapped_column(String(120))
    waypoints: Mapped[list] = mapped_column(Json)  # [{lat, lon, label}]
    geometry: Mapped[list | None] = mapped_column(Json, nullable=True)  # точното трасе като координати
    notes: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(10), default="new")  # new | seen | done | cancelled
    created_at: Mapped[int] = mapped_column(BigInteger)
    updated_at: Mapped[int] = mapped_column(BigInteger)
