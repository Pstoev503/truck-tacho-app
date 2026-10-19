import copy
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.truck_profile import TruckProfileIn, valhalla_truck_costing_options  # noqa: E402


PROFILE = {
    "heightM": 4.0,
    "widthM": 2.5,
    "lengthM": 16.0,
    "grossWeightT": 40.0,
    "axleLoadT": 10.0,
    "axleCount": 5,
    "hazmat": True,
}


def make_profile(**changes):
    return TruckProfileIn(**(PROFILE | changes))


def test_maps_all_fields_to_valhalla_truck_options_without_unit_changes():
    profile = make_profile()

    assert valhalla_truck_costing_options(profile) == {
        "truck": {
            "height": 4.0,
            "width": 2.5,
            "length": 16.0,
            "weight": 40.0,
            "axle_load": 10.0,
            "axle_count": 5,
            "hazmat": True,
        }
    }


def test_accepts_integer_and_float_measurements_without_coercion():
    values = PROFILE | {
        "heightM": 4,
        "widthM": 2.5,
        "lengthM": 16,
        "grossWeightT": 40,
        "axleLoadT": 10.0,
    }
    profile = TruckProfileIn(**values)

    assert type(profile.heightM) is int
    assert type(profile.widthM) is float
    assert valhalla_truck_costing_options(profile)["truck"]["weight"] == 40


@pytest.mark.parametrize(
    "field",
    ["heightM", "widthM", "lengthM", "grossWeightT", "axleLoadT"],
)
@pytest.mark.parametrize("value", [True, "1.5", None])
def test_measurements_reject_bool_string_and_null(field, value):
    with pytest.raises(ValidationError):
        make_profile(**{field: value})


@pytest.mark.parametrize(
    "field",
    ["heightM", "widthM", "lengthM", "grossWeightT", "axleLoadT"],
)
@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf"), 0, -1])
def test_measurements_reject_nonfinite_zero_and_negative_values(field, value):
    with pytest.raises(ValidationError):
        make_profile(**{field: value})


@pytest.mark.parametrize("value", [True, 5.0, "5", 0, -1])
def test_axle_count_requires_a_strict_positive_integer(value):
    with pytest.raises(ValidationError):
        make_profile(axleCount=value)


@pytest.mark.parametrize("value", [0, 1, "true", None])
def test_hazmat_requires_a_strict_boolean(value):
    with pytest.raises(ValidationError):
        make_profile(hazmat=value)


@pytest.mark.parametrize(
    "missing_field",
    ["heightM", "widthM", "lengthM", "grossWeightT", "axleLoadT", "axleCount", "hazmat"],
)
def test_all_profile_fields_are_required(missing_field):
    values = PROFILE.copy()
    del values[missing_field]

    with pytest.raises(ValidationError):
        TruckProfileIn(**values)


def test_profile_rejects_extra_fields():
    with pytest.raises(ValidationError):
        make_profile(unrecognized=True)


def test_axle_load_must_not_exceed_gross_weight():
    with pytest.raises(ValidationError):
        make_profile(axleLoadT=40.01)


def test_profile_is_immutable():
    profile = make_profile()

    with pytest.raises(ValidationError):
        profile.heightM = 5


def test_mapping_does_not_mutate_input_or_profile():
    values = copy.deepcopy(PROFILE)
    before = copy.deepcopy(values)
    profile = TruckProfileIn(**values)

    valhalla_truck_costing_options(profile)

    assert values == before
    assert profile == TruckProfileIn(**before)


def test_each_mapping_has_independent_output():
    profile = make_profile()
    first = valhalla_truck_costing_options(profile)
    first["truck"]["height"] = 99
    first["truck"]["added"] = True
    second = valhalla_truck_costing_options(profile)

    assert second == {
        "truck": {
            "height": 4.0,
            "width": 2.5,
            "length": 16.0,
            "weight": 40.0,
            "axle_load": 10.0,
            "axle_count": 5,
            "hazmat": True,
        }
    }
    assert first is not second
    assert first["truck"] is not second["truck"]


@pytest.mark.parametrize("profile", [None, {}, PROFILE])
def test_mapper_rejects_non_model_inputs(profile):
    with pytest.raises(TypeError):
        valhalla_truck_costing_options(profile)


def test_mapper_revalidates_an_invalid_constructed_model():
    invalid = TruckProfileIn.model_construct(**(PROFILE | {"heightM": -1}))

    with pytest.raises(ValidationError):
        valhalla_truck_costing_options(invalid)
