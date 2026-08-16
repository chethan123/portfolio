# 04 — `holding_valued_at` and net worth at a date

_Part of [0001-foundation-day-zero.md](../0001-foundation-day-zero.md)._

**What to build:** The same figures for any past date, sharing one definition with the current view
rather than reimplementing the join. Because positions are constant between uploads by construction,
net worth on a past date is that date's positions priced at that date's close — with the last close
carried forward so a Saturday equals the preceding Friday. History starts honestly at the first
upload rather than backfilling an assumption, and an account that has since been closed still counts
on the dates it was open.

**Blocked by:** 03.

**Status:** ready-for-agent

- [ ] A set-returning function taking a date returns the same output shape as `holding_valued`
- [ ] For each account it selects the position set with the greatest as-of date at or before the
      requested date, using the same tie-break as the current view
- [ ] An account is included when it has no closing date, or when its closing date is after the
      requested date — so it counts before its closure and not after
- [ ] Price comes from the daily close at the greatest date at or before the requested date, not
      from the live quote table
- [ ] The stale flag is reported false, since staleness is not meaningful for a historical close
- [ ] A Saturday, a Sunday and a market holiday all return the previous trading day's value
- [ ] An account with no position set at or before the requested date contributes no rows, so the
      earliest date with any value is the first upload
- [ ] An empty position set is legal and contributes nothing, so "sold everything" is representable
- [ ] Cash and liability positions resolve to 1.00 for any date the system is asked about, including
      dates before the app was installed, via the seeded 1970 daily close and carry-forward — with
      no branch in the function
- [ ] The query module exposes holdings at a date and a net worth total at a date, using the same
      coverage convention as the current reads
- [ ] Null cost basis and unpriced holdings behave exactly as they do in the current view
- [ ] The fixture builder gains the ability to seed daily closes
