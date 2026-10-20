# INT32 count-delta review addendum

Task#174; count-specific proof for accepted base
`1a2ccc6543ae2301c0b5dc7b3ead9a5dcff38f76`. This is a short delta, not a repeat
of the earlier 19-topic matrix.

## Source fingerprint

The four relevant source/contract blobs at the accepted base are:

| Path | Blob |
| --- | --- |
| `docs/contracts/route-options-count-v1.md` | `1e609fe4e478b889cdf55ee005dc5591a7cc8ee4` |
| `server/app/main.py` | `7f79b2c6d3f91b12af778dd51d473d379c8184bd` |
| `ui/route-options-response.mjs` | `07b4f29cb4c435ca973c75999a155f65706be532` |
| `ui/route-options-response.test.mjs` | `52d281252965e48d5a5d9d383b17c5130558aace` |

## Count-specific proof

`POST /api/route-options` asks the provider for two alternates. The UI therefore
accepts at most three candidates: the primary trip and up to two alternates.
More than two alternates invalidates the whole response before entries are
inspected; the UI neither truncates nor exposes a partial list. Tests include
the maximum accepted count, over-limit rejection, early rejection of 5,000
alternates, and executed-UI handling of rejected results. The server remains a
pass-through and its 5 MiB response limit is not a candidate-count limit.

The CI totals and the pending browser gate are recorded in
`docs/reports/2026-10-20-INT32-RELEASE-DELTA-01.md`. Passing standard CI does not
establish browser performance, live-provider behavior, route suitability,
licensing, or production readiness.
