# Route-options candidate-count contract v1

This contract describes the client-side candidate-count policy for
`POST /api/route-options`. The provider request asks for two alternates, so the
UI accepts at most three route candidates in total: the primary `trip` and up
to two entries in `alternates`.

## Whole-response validation

The primary trip must be valid. `alternates` may be absent, null, or an array
with zero to two entries. Each alternate must be a valid direct trip or a
`{ "trip": ... }` wrapper. Every candidate must be valid for the response to be
accepted.

An `alternates` array with more than two entries makes the entire response
invalid. The UI checks the array length before inspecting its entries, shows no
partial candidate list, and does not truncate or otherwise rewrite the provider
response. Invalid responses use a bounded generic error and do not disclose
provider response details. Existing selected geometry is preserved and the
user can retry after a rejected response.

The three-candidate maximum is a client normalization policy; it does not
change the server's pass-through behavior, its 5 MiB response-size limit, or
the provider request. It is not a payload-byte limit or a browser performance
measurement.

## Provider and suitability limits

This contract does not establish provider licensing, attribution, commercial
use, storage, or redistribution rights for route data. Those rights must be
verified against the provider's applicable terms before use. It does not
certify that a route is physically, legally, or operationally suitable for a
vehicle, and it makes no live-provider verification claim.
