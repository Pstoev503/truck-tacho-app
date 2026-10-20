# INT32-RELEASE-DELTA-01 — count-fix receipt

Task#174. Review snapshot: 2026-10-20 20:38:23 UTC, current branch head
`bf21dc87c74fbfb7b6713faeb10e9b9eb4cd962e`; accepted APP/INT32 source
`1a2ccc6543ae2301c0b5dc7b3ead9a5dcff38f76`. This receipt corrects the proof
fields only; it is not a new source implementation.

## Exact files and source

Changed exactly the two requested documentation files:

- `docs/reviews/2026-10-20-int32-count-delta.md`
- `docs/reports/2026-10-20-INT32-RELEASE-DELTA-01.md`

The four accepted source files and blob IDs are listed in the review addendum.
No code, workflow, source receipt, or existing contract was changed.
`docs/contracts/route-options-truck-v1.md` remains restored at its accepted-base
SHA-1 blob `4f2ecd24aa826d23e9abb67467816c8b9d263d3d`.

## Actual API and CI evidence

The count-fix proof is the exact [APP/INT32 commit
`1a2ccc6`](https://github.com/Pstoev503/truck-tacho-app/commit/1a2ccc6543ae2301c0b5dc7b3ead9a5dcff38f76)
and its [successful Actions run #315](https://github.com/Pstoev503/truck-tacho-app/actions/runs/39485719893),
not the later documentation-seed run. I inspected all four job logs:

- [Server job `118845480020`](https://github.com/Pstoev503/truck-tacho-app/actions/runs/39485719893/job/118845480020):
  257 PostgreSQL tests passed.
- [Engine job `118845480468`](https://github.com/Pstoev503/truck-tacho-app/actions/runs/39485719893/job/118845480468):
  466 Node tests passed.
- [UI/integration job `118845480470`](https://github.com/Pstoev503/truck-tacho-app/actions/runs/39485719893/job/118845480470):
  278 UI + 8 integration tests passed.
- [Docker job `118845480393`](https://github.com/Pstoev503/truck-tacho-app/actions/runs/39485719893/job/118845480393):
  fixture-backed HTTP validation passed (43 fixtures); packaged HTTP checks
  served 21 planner files and 15 boss files with expected types.

The independently recorded Node total is 752/752. The count-focused suite is
39/39 (12 new meaningful cases over the 27-case base). Dynamic-import probes
loaded the actual old helper without a missing-export/setup failure and
reproduced both overcounts (3 alternates → 4 candidates; 5,000 → 5,001);
the fixed helper rejects both responses whole. These are synthetic/test
checks—not live-provider or production API checks. No tests were rerun for this
documentation-only correction.

## Separate staging and next step

The browser/API staging work is [COUNT-STAGING task
#173](https://github.com/Pstoev503/truck-tacho-app/issues/173), currently
pending acceptance as a separate package. Its status is not a blocker to this
documentation task, and this receipt does not claim its future result or that
an artifact can never arrive. The older `9c6fbc9` browser proof does not cover
the new APP head.

No documentation-task blocker remains. Next: review/accept this corrected
receipt; the distinct staging package follows its own acceptance process.
Own remaining estimate for this correction/re-review: 15–30 minutes, not
guaranteed. Checkpoint: 2026-10-21 00:30 Europe/Sofia. No need to wait for
Claude. No merge, production, provider-use, or licensing approval is implied.
