# INT32 count-delta review addendum

Task#174; count-specific proof for accepted APP/INT32 source
`1a2ccc6543ae2301c0b5dc7b3ead9a5dcff38f76` (`1e7b230699de08519529f933f24026c82ae6d6f3`
is the accepted COUNT01 source head). This short delta supplements, rather than
repeats, the earlier 19-topic matrix.

## Exact source snapshot

These are the four source files at the accepted INT32 snapshot:

| Path | Blob |
| --- | --- |
| `docs/contracts/route-options-count-v1.md` | `1e609fe4e478b889cdf55ee005dc5591a7cc8ee4` |
| `docs/reports/2026-10-20-ROUTE-OPTIONS-COUNT-01.md` | `7bd67b5d9a35466f63d013f153d7a597d10066cc` |
| `ui/route-options-response.mjs` | `07b4f29cb4c435ca973c75999a155f65706be532` |
| `ui/route-options-response.test.mjs` | `52d281252965e48d5a5d9d383b17c5130558aace` |

Separate restoration check: existing
`docs/contracts/route-options-truck-v1.md` is restored unchanged at the accepted
COUNT01 base, SHA-1 blob `4f2ecd24aa826d23e9abb67467816c8b9d263d3d`. It is not one
of the four source files above.

## Count-specific proof

The provider request asks for two alternates, while the UI allows at most three
total candidates (primary trip plus two alternates). The 39-case focused suite
has 12 new meaningful cases over the 27-case base, including the maximum count,
over-limit rejection, early length rejection without inspecting entries,
frozen-overflow immutability, mixed malformed/overflow input, bounded errors
without a private marker, and executed-UI prior-state/retry coverage.

Two dynamic-import probes exercised the actual old helper without importing a
new export or triggering a missing-export/setup failure: the old helper turned
three alternates into four candidates and 5,000 into 5,001; the fixed helper
rejects each complete response. The independent 752-test Node total is
466 engine + 278 UI + 8 integration.

## Provenance and boundaries

- [COUNT01 source PR #165](https://github.com/Pstoev503/truck-tacho-app/pull/165)
  and its [acceptance comment](https://github.com/Pstoev503/truck-tacho-app/pull/165#issuecomment-6299874613).
- [INT32 integration PR #172](https://github.com/Pstoev503/truck-tacho-app/pull/172).
- [Current overall PR #46](https://github.com/Pstoev503/truck-tacho-app/pull/46).
- Separate [COUNT-STAGING task #173](https://github.com/Pstoev503/truck-tacho-app/issues/173);
  it is pending acceptance for its own browser/API proof, not a blocker for this
  documentation receipt.

The exact CI evidence, actual job IDs, receipt snapshot, remaining estimate, and
next checkpoint are in
`docs/reports/2026-10-20-INT32-RELEASE-DELTA-01.md`. No old `9c6fbc9` browser
proof is carried forward as evidence for this new APP head. No provider,
licensing, production, or merge approval is implied.
