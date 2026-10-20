# Truck profile contract v1

This contract defines an isolated input model and a pure mapping to Valhalla's
`costing_options.truck`. It does not add an endpoint, persist a profile, or
contact a router.

## Input

All seven fields are required. Unknown fields are rejected, and the model is
immutable.

| Profile field | Type | Unit / rule |
| --- | --- | --- |
| `heightM` | finite positive number | meters |
| `widthM` | finite positive number | meters |
| `lengthM` | finite positive number | meters |
| `grossWeightT` | finite positive number | metric tons |
| `axleLoadT` | finite positive number | metric tons; at most `grossWeightT` |
| `axleCount` | positive integer | count |
| `hazmat` | boolean | whether the vehicle carries hazardous material |

Measurements accept Python `int` or `float` values only (not booleans, strings,
or null). `axleCount` and `hazmat` are strict types. The measurements must be
finite and positive. The provider reference does not establish application
validation maxima for these values; no physical or legal upper limits are
invented here.

Synthetic example:

```json
{
  "heightM": 4.0,
  "widthM": 2.5,
  "lengthM": 16.0,
  "grossWeightT": 40.0,
  "axleLoadT": 10.0,
  "axleCount": 5,
  "hazmat": false
}
```

## Provider mapping

`valhalla_truck_costing_options(profile)` returns a new object with exactly
these fields and performs no unit conversion or other routing configuration:

```json
{
  "truck": {
    "height": 4.0,
    "width": 2.5,
    "length": 16.0,
    "weight": 40.0,
    "axle_load": 10.0,
    "axle_count": 5,
    "hazmat": false
  }
}
```

| Valhalla field | Source |
| --- | --- |
| `height` | `heightM` (meters) |
| `width` | `widthM` (meters) |
| `length` | `lengthM` (meters) |
| `weight` | `grossWeightT` (metric tons) |
| `axle_load` | `axleLoadT` (metric tons) |
| `axle_count` | `axleCount` |
| `hazmat` | `hazmat` |

The provider mapping is based on the official [Valhalla Route API
reference](https://valhalla.github.io/valhalla/api/route/api-reference/)
("Truck" costing options) and [routing demo](https://valhalla.github.io/demos/routing/)
(weight unit clarification), checked 2026-10-19. The reference supplies the
field names and units; the demo clarifies that truck weight is in metric tons.

## Boundaries and limitations

- Provider-specific maxima and enforcement behavior have not been independently
  tested against a live router. Positive finite values are data validation,
  not proof that a truck is physically or legally permitted.
- `hazmat` is only a boolean flag. It is not an ADR class, tunnel code,
  transport-documentation, or other dangerous-goods assessment.
- This profile does not establish road access, national legal limits, or route
  suitability.
- No endpoint/UI integration, provider URL, credentials, network I/O, database
  storage, or default profile is part of this contract. Do not add options that
  ignore access restrictions.
- M4b-profile remains open until a separate integration package defines and
  validates those boundaries.

## Next integration package

Separately specify the endpoint/UI contract, source and lifecycle of each
vehicle value, authorization and persistence rules, missing-profile behavior,
provider request construction, and error handling. Confirm the applicable
provider limits and legal/ADR inputs before using a profile to select routes.
