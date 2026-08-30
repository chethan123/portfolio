# Chart sample density decays geometrically from the window's end, not a fixed count

`app/lib/chart-range.ts`'s `sampleWindow` always requested a fixed twenty-five evenly spaced dates,
deduped by calendar day, for every chart range regardless of span. A span longer than about
twenty-five days spread those twenty-five samples far enough apart (roughly fifteen days apart on
the default 1Y range) that a household or account whose real recorded history is only a day or two
old had every sample but the most recent one fall before its first upload — the routes drop those
points on the `coverage.total > 0` that `valuation.server.ts` reports (`overview.tsx`,
`account.tsx`) — leaving one usable point, which is one point short of a
line. The value moves every day purely from price refreshes, so the missing line was a sampling
artifact, not a data gap.

We changed `sampleWindow` to sample every calendar day when the whole span fits inside a fixed
budget (180 samples), and once a span exceeds that budget, to space samples with gaps that grow
geometrically walking backward from the window's own end (`until`) rather than from literal "today"
— a custom range with a past end date decays away from its own boundary. The gap nearest the anchor
is fixed at exactly one calendar day; the growth ratio is solved numerically so the accumulated gaps
land exactly on the window's start. This guarantees the day immediately before the anchor is always
sampled, for every preset, without treating recency as a special case.

## Considered options

**Tiered fixed buckets** (daily for the last N days, weekly for the next M, monthly beyond).
Rejected: it needs several arbitrary day thresholds, each requiring its own justification and
re-tuning if the budget or the presets change — the same magic-constant problem a smooth curve was
chosen to avoid.

**A closed-form power-law index-to-offset mapping** (`offset(i) = D · (i/(N-1))^k`), avoiding a
numeric solve. Rejected: worked through with concrete numbers (a multi-year span, a 180-sample
budget), the second sample from the anchor landed under a tenth of a day away and rounded to the
same date as the anchor itself — silently breaking the "always a day back" guarantee for the exact
spans the redesign exists to fix.

## Consequences

- Computing the geometric ratio needs a small numeric solve (bisection over a strictly monotonic
  function), rather than a closed-form formula — confined entirely to one pure function with no I/O.
- The 180-sample budget is a new tunable this module didn't previously have; raising or lowering it
  changes chart density for every long-range preset at once.
- Every other consumer of the resolved date list — `netWorthSeries`, `NetWorthChart`,
  `overview.tsx`/`account.tsx` — is unaffected, because the output stays the same shape: an ordered
  list of ISO dates.
