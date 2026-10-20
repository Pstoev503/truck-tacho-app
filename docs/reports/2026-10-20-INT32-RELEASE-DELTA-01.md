# INT32-RELEASE-DELTA-01 — count-fix receipt

Task#174, on `codex/int32-release-delta-handoff`, stacked on
`codex/int-32-routeoptionscount01`. Accepted base:
`1a2ccc6543ae2301c0b5dc7b3ead9a5dcff38f76`. Receipt started from branch head
`dc386a9da942fa02e249162169215179150d2d05`.

## Files and result

Changed exactly these two documentation files:

- `docs/reviews/2026-10-20-int32-count-delta.md`
- `docs/reports/2026-10-20-INT32-RELEASE-DELTA-01.md`

The count-specific review addendum records the four source blobs and scope. No
source, workflow, or existing evidence files were changed.

## Checks and current gate

The latest full successful standard Actions run, #318 (`39486413586`, on the
documentation-only seed head based on the accepted source tree), passed all
four jobs:

- PostgreSQL server suite: 257 passed.
- Node suites: 466 engine + 278 UI + 8 integration = 752 passed.
- Docker HTTP checks: 43 fixture cases; planner served 21 local files and boss
  served 15, all with expected types.

These checks are not a browser execution or performance measurement. The new
browser gate remains pending; there is no browser artifact or result to claim.
The receipt push's run #319 (`39486793082`) ended `action_required` with zero
jobs, not a test failure; no tests ran on the receipt commit. No tests were
manually rerun for this documentation-only change. The PR's current check list
has no browser-gate result.

## Estimate, limits, and next

Estimated browser-gate follow-up: 30–60 minutes, not guaranteed. The CI/API
results above are the actual available checks; no live-provider or production
API was exercised. The UI policy is at most three candidates (primary trip plus
two alternates), rejecting larger responses whole without truncation. The
server's pass-through behavior and 5 MiB response-size limit are unchanged.

Blocker: browser-gate result/artifact is pending. Next: obtain and record that
artifact by the 2026-10-21 00:00 Europe/Sofia checkpoint; do not wait for Claude.
This receipt does not authorize merging, production deployment, provider use,
or licensing approval.
