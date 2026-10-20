# ROUTE-OPTIONS-SHAPE-01 — delivery receipt

Task #159 is implemented on the supplied stacked PR branch `codex/route-options-shape01-handoff`, based on accepted commit `6710028709a921d49def929f85e6ad4c66a940a4`. The implementation commit is `f23870df057e265909a47f1bb8bed40b320be842`.

## Files changed

1. `boss.html`
2. `ui/route-options-response.mjs`
3. `ui/route-options-response.test.mjs`
4. `docs/reports/2026-10-20-ROUTE-OPTIONS-SHAPE-01.md`

## Result

The new pure normalizer accepts a valid primary trip, missing/null/empty alternates, wrapped `{ trip }` alternates, and legacy direct-trip alternates. It rejects the whole envelope when a supplied alternate or candidate `legs` shape is malformed; it does not mutate the response. The inline handler normalizes only current (`applied`) responses, after the stale-response guard. A malformed current response clears selectable alternatives and displays one bounded Bulgarian message without changing geometry, provenance, draft/storage, or selection/draw/save state. Geometry decoding and caps remain delegated to the existing provider selector.

## Verification

- Baseline on the accepted code: `node --test` — 713/713 passed.
- Fixed targeted tests: `node --test ui/route-options-response.test.mjs` — 27/27 passed.
- Fixed full suite: `node --test` — 740/740 passed.
- Old-handler comparison used the same new test file with `ROUTE_OPTIONS_BOSS_SOURCE=/tmp/route-options-old-boss.html`. It produced 23 passes and the four expected handler failures: `alternates: {}` throws at `.map`; `alternates: [null]` throws while reading `.trip`. Both regressions were exercised with prior manual and provider geometry. The harness and imports initialized successfully.
- The accepted base workflow run `39450988845` succeeded. No failing CI run was found.
- The executed tests use synthetic DOM/network fixtures only. No browser session or live routing provider was tested.

## Scope and handoff

No server, provider-geometry helper, shared/base branch, dependency, workflow, or production data was changed. No merge, production, or provider/license approval is implied. No implementation blocker remains. Estimated effort for this bounded task was 1–2 hours; that was an estimate, not a delivery guarantee. Next action: review this receipt and the active PR; merge/production decisions remain with the owner.
