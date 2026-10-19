"""Validated truck profile and pure Valhalla costing mapper."""

from math import isfinite

from pydantic import BaseModel, ConfigDict, StrictBool, StrictInt, field_validator, model_validator


class TruckProfileIn(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        revalidate_instances="always",
        strict=True,
    )

    heightM: int | float
    widthM: int | float
    lengthM: int | float
    grossWeightT: int | float
    axleLoadT: int | float
    axleCount: StrictInt
    hazmat: StrictBool

    @field_validator("heightM", "widthM", "lengthM", "grossWeightT", "axleLoadT", mode="before")
    @classmethod
    def validate_measurement(cls, value):
        if type(value) not in (int, float):
            raise ValueError("measurement must be a number")
        if (isinstance(value, float) and not isfinite(value)) or value <= 0:
            raise ValueError("measurement must be finite and positive")
        return value

    @field_validator("axleCount")
    @classmethod
    def validate_axle_count(cls, value):
        if value <= 0:
            raise ValueError("axleCount must be positive")
        return value

    @model_validator(mode="after")
    def validate_axle_load(self):
        if self.axleLoadT > self.grossWeightT:
            raise ValueError("axleLoadT must not exceed grossWeightT")
        return self


def valhalla_truck_costing_options(profile: TruckProfileIn) -> dict:
    if not isinstance(profile, TruckProfileIn):
        raise TypeError("profile must be a TruckProfileIn")

    validated = TruckProfileIn.model_validate(profile)
    return {
        "truck": {
            "height": validated.heightM,
            "width": validated.widthM,
            "length": validated.lengthM,
            "weight": validated.grossWeightT,
            "axle_load": validated.axleLoadT,
            "axle_count": validated.axleCount,
            "hazmat": validated.hazmat,
        }
    }
