# Route-options truck profile API contract v1

`POST /api/route-options` is an owner-authenticated endpoint. It requires an
explicit vehicle profile on every request and forwards the validated profile
through the existing pure mapper to Valhalla. The endpoint does not store the
profile or choose a default.

## Request

The JSON body contains `origin`, `destination`, and `truckProfile`. Each
waypoint requires `lat` (−90 through 90) and `lon` (−180 through 180); optional
`label` is accepted but is not sent to Valhalla. `truckProfile` uses the seven
required fields and validation rules in
[truck profile contract v1](truck-profile-v1.md). Unknown truck-profile fields,
including `ignore_access` and `ignore_restrictions`, are rejected.

Synthetic request:

```json
{
  "origin": {"lat": 42.7, "lon": 23.3},
  "destination": {"lat": 43.2, "lon": 27.9},
  "truckProfile": {
    "heightM": 3,
    "widthM": 2,
    "lengthM": 12,
    "grossWeightT": 18,
    "axleLoadT": 6,
    "axleCount": 3,
    "hazmat": true
  }
}
```

Measurements are positive finite numbers in meters or metric tons as specified
by the linked profile contract. Integer measurements are accepted; axle count
is a positive integer and `hazmat` is a boolean.

## Provider request and response

The server posts this synthetic JSON to the configured Valhalla `/route`
endpoint. The mapper preserves values and units; these numbers are examples,
not recommended or provider-validated vehicle dimensions.

```json
{
  "locations": [
    {"lat": 42.7, "lon": 23.3},
    {"lat": 43.2, "lon": 27.9}
  ],
  "costing": "truck",
  "costing_options": {
    "truck": {
      "height": 3,
      "width": 2,
      "length": 12,
      "weight": 18,
      "axle_load": 6,
      "axle_count": 3,
      "hazmat": true
    }
  },
  "units": "kilometers",
  "alternates": 2
}
```

A successful API response is the provider's JSON response passed through
unchanged after validation. The server reads at most 5 MiB plus one byte and
rejects responses larger than 5 MiB. JSON must be syntactically valid and
contain only finite numbers; non-standard constants such as `NaN` and
`Infinity`, numeric overflow, and nesting deeper than 100 levels are treated as
upstream failures. Synthetic response:

```json
{"trip": {"status": 0}}
```

Missing or invalid request/profile data returns 422 before outbound network
activity or route-budget use. Missing/invalid router configuration returns 503;
an upstream transport or JSON parsing failure returns a generic 503, an
oversized or structurally invalid upstream response returns 502, and an
exhausted owner route budget returns 429. Upstream failures consume route-budget
attempts. The route budget and owner-only authorization behavior are unchanged.

## Compatibility, provenance, and limits

This is a breaking API change: a caller sending only `origin` and
`destination` now receives 422. No UI/client integration is included, so callers
must supply the explicit profile before using this endpoint.

The source of the vehicle values, their provenance, and their lifecycle are not
defined here: the endpoint does not load defaults, persist profile data, or
establish a UI data source. Provider-specific value ranges and enforcement,
ADR/dangerous-goods requirements, and road-access or route-suitability rules
have not been verified. The positive/finite input checks are not proof of
physical or legal suitability. Do not infer access or restrictions can be
ignored from this contract.
