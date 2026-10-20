# ROUTE-OPTIONS-COUNT-01 — implementation receipt

Task#164. Implementation based on accepted INT-31 commit `9c6fbc9d64041ac401c3cd87bcb3f4d2eaafc354`; implementation commit `7e064a9`.

## Delivery

Changed exactly four files:

- `ui/route-options-response.mjs`
- `ui/route-options-response.test.mjs`
- `docs/contracts/route-options-truck-v1.md`
- `docs/reports/2026-10-20-ROUTE-OPTIONS-COUNT-01.md`

The UI accepts at most three candidates total: the primary trip and up to two alternates. It rejects a larger `alternates` array by checking its length before iterating; it does not truncate the provider response or expose a partial list. Existing trip formats and compatibility for wrapped and direct alternates are unchanged. Executed-UI regressions cover both prior manual and provider geometry, cleared stale choices, and a valid retry.

## Evidence and checks

- The helper at base `9c6fbc9d` accepted 5,000 valid alternates and returned 5,001 candidates from a synthetic 185,051-byte response.
- The updated helper rejects the same 5,000-alternate, 185,051-byte synthetic response. A separate getter-based test verifies the early guard does not inspect entries; exactly three candidates remain accepted.
- `node --test ui/route-options-response.test.mjs`: 31 passed.
- `node --test ui/*.test.mjs integration/*.test.mjs`: 278 passed.
- `cd engine && node --test`: 466 passed.
- `node --test`: 744 passed.
- `git diff --check`: passed.

No browser performance measurement, live-provider verification, or production claim is made. No boss/server/engine/workflow files were changed. The server's existing 5 MiB response limit and pass-through behavior remain unchanged; this candidate cap is the UI normalization policy.

## Handoff

Code and local Node checks are complete; no implementation blocker remains. The current PR branch is `codex/route-options-count01-handoff`. Next: review the four-file diff and follow the PR's acceptance process. This receipt does not authorize merging, production deployment, or provider use.
