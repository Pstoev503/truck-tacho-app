# ROUTE-OPTIONS-COUNT-01 — implementation receipt

Task#164 review follow-up, based on accepted INT-31 commit
`9c6fbc9d64041ac401c3cd87bcb3f4d2eaafc354` and prior implementation commit
`7e064a9`.

## Delivery

Changed exactly four files:

- `ui/route-options-response.mjs`
- `ui/route-options-response.test.mjs`
- `docs/contracts/route-options-count-v1.md`
- `docs/reports/2026-10-20-ROUTE-OPTIONS-COUNT-01.md`

`docs/contracts/route-options-truck-v1.md` is restored byte-for-byte to its
accepted-base content. The new count contract defines the UI policy: at most
three candidates total (primary trip plus up to two alternates), whole-response
failure for larger lists, no truncation, and provider licensing/suitability
disclaimers.

The helper rejects over-limit arrays by checking their length before iteration.
Existing direct and wrapped alternate compatibility remains supported.
Executed-UI regressions cover both prior manual and provider geometry, cleared
stale choices, and a valid retry.

## Evidence and checks

- Eight new top-level focused cases cover exactly two wrapped, direct, and mixed
  alternates; three-alternate whole-response rejection; 5,000-entry early
  rejection with zero entry inspections; frozen overflow immutability; malformed
  plus overflow; and bounded error/private-marker absence. The six executed-UI
  state/retry regressions remain present.
- The helper at base `9c6fbc9d` accepted 5,000 valid alternates and returned
  5,001 candidates from a synthetic 185,051-byte response. The updated helper
  rejects that same response.
- Two independent dynamic-import probes loaded the actual helper source from
  base `9c6fbc9d` (without importing any new exports): the old helper accepted
  three alternates as four candidates and 5,000 alternates as 5,001 candidates;
  the updated helper rejects both whole responses.
- `node --test ui/route-options-response.test.mjs`: 39 passed (accepted suite
  had 27; 12 new cases total across the original change and this follow-up).
- `node --test ui/*.test.mjs integration/*.test.mjs`: 286 passed.
- `cd engine && node --test`: 466 passed; no engine files changed.
- `node --test`: 752 passed.
- `git diff --check`: passed.
- Restored `docs/contracts/route-options-truck-v1.md` SHA-1 blob matches the
  accepted-base file exactly: `4f2ecd24aa826d23e9abb67467816c8b9d263d3d`.

Base Actions run `39459011738` passed all four jobs. Branch push runs reported
`action_required` with zero jobs, not failures. No browser performance
measurement, live-provider verification, or production claim is made. No
boss/server/engine/workflow files were changed. The server's existing 5 MiB
response limit and pass-through behavior remain unchanged.

## Handoff

Implementation and local checks are complete. Remaining estimate: 10–15 minutes
for final review/validation and handoff, not guaranteed. Next: commit the
four-file correction and request review. This receipt does not authorize
merging, production deployment, or provider use.
