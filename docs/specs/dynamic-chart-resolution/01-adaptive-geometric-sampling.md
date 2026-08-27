# 01 — Adaptive, geometrically-decaying date sampling

Part of [0009-dynamic-chart-resolution.md](../0009-dynamic-chart-resolution.md). Published as
[issue #74](https://github.com/chethan123/portfolio/issues/74); when the two disagree, this file
wins. Read the parent spec first, and
[ADR-0003](../../adr/0003-anchored-geometric-chart-sampling.md) for why this shape was chosen over
the alternatives.

**What to build:** Replace `app/lib/chart-range.ts`'s fixed `SAMPLES = 25` constant and
`sampleWindow` implementation with the two-regime scheme the spec describes. Everything else in the
module — `resolveRange`, `isRangeDisabled`, the cookie handling, the `RANGES` table — is untouched;
this ticket only touches how `sampleWindow` turns a `(since, until)` pair into a list of dates.

**Blocked by:** Nothing. Touches one module and its own test file.

**Status:** ready-for-agent

## The algorithm, precisely

Prose alone leaves the numeric solve ambiguous, so:

- Let `D` be the whole number of calendar days between `since` and `until` (`D = 0` when they're
  equal).
- Let `CAP` be a new named constant, `180`.
- If `D + 1 <= CAP`: return every calendar date from `since` to `until` inclusive, in ascending
  order — `D + 1` dates total. No decay, no solve. (This is the existing behavior for every span up
  to 180 days and must come out byte-for-byte identical to today's output for those spans.)
- Else: return exactly `CAP` dates. Compute them by:
  1. Solving for a ratio `r > 1` such that `1 + r + r² + ... + r^(CAP-2)` equals `D` — i.e.
     `CAP - 1` gap terms, the first fixed at `1`, growing geometrically, summing to the total span.
     Use bisection: the sum is continuous and strictly increasing in `r` for `r > 1` (approaching
     `CAP - 1` as `r → 1⁺`, unbounded as `r` grows), and `D >= CAP` always holds in this branch
     (since this branch only fires when `D + 1 > CAP`), so a solution always exists. Iterate to a
     tolerance tight enough that day-offsets round stably (an absolute tolerance on `r` around
     `1e-9` is more than sufficient at `CAP = 180`).
  2. Building cumulative day-offsets backward from `until`: `offset(0) = 0`,
     `offset(k) = offset(k-1) + r^(k-1)` for `k = 1..CAP-1` (so `offset(1) = 1`, matching the fixed
     first gap). `offset(CAP-1)` equals `D` by construction of `r`.
  3. Rounding each offset to the nearest whole day, converting to a date as `until` minus that many
     days, and returning the list in ascending (oldest-first) order. Because offsets are
     monotonically increasing by at least 1 at every step, rounding cannot produce a duplicate or an
     out-of-order pair — no dedup pass is needed for this branch, unlike the removed fixed-sample
     implementation.

## Acceptance criteria

- [ ] A span with `D + 1 <= 180` returns every calendar day in range, both endpoints included, in
      ascending order — identical output to today's implementation for every existing
      short-to-medium preset (1W, 1M, 3M, most YTD spans).
- [ ] A span with `D + 1 > 180` (a full 1Y in a leap-adjacent stretch, 5Y, a multi-year "All" or
      custom range) returns exactly 180 dates, with the first gap from `until` exactly one day, gaps
      strictly increasing walking backward, and the earliest returned date exactly equal to `since`.
- [ ] The transition at `D + 1` exactly equal to 180, and at 181, is covered — no off-by-one gap or
      duplicate at the seam.
- [ ] A `since`/`until` pair where `until` is an arbitrary past date (simulating a custom range)
      decays relative to that `until`, not relative to any wall-clock date — the function takes no
      implicit dependency on the current date beyond what's passed in.
- [ ] The regression from spec 0009: a `since` just one or two days before `until`, sampled under a
      budget-exceeding span (simulate a 1Y-equivalent `D`), yields at least two of the returned
      dates falling on or after that `since` — reproducing the original bug's setup and proving it
      no longer reproduces.
- [ ] The existing fixed-count assertions in `tests/chart-range.test.ts`
      (`describe("sampling: twenty-five points, deduped by calendar day", ...)`: exactly 25 dates
      for `"5y"`, at most 8 for `"1w"`) are replaced with assertions of the behavior above, not left
      alongside it.
- [ ] Every other existing test in that file — preset boundaries, disabled-state rule, per-surface
      data-source rule — passes unmodified.
- [ ] `npm run typecheck` and `npm test` pass.
- [ ] No file outside `app/lib/chart-range.ts` and `tests/chart-range.test.ts` changes —
      `overview.tsx`, `account.tsx`, `valuation.server.ts`, and the chart component all consume the
      same output shape and need no edits, which this ticket's diff should demonstrate by not
      touching them.
