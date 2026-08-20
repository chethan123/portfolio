# 02 — The market calendar

_Part of [0002-pricing.md](../0002-pricing.md)._

**What to build:** The check that decides whether polling is worth attempting: a weekday and
session-hours test in the configured market timezone, plus a small hardcoded NYSE holiday table
(DESIGN.md §10). It is a cost optimisation and nothing else — a wrongly skipped poll costs nothing
and a wrongly attempted one costs one request — so it stays a pure function of an instant, with no
database, no clock of its own, and no place in any write path.

**Blocked by:** none.

**Status:** ready-for-agent

- [ ] One function answers whether the market is open, taking the instant and the timezone as
      arguments rather than reading the system clock or the configuration itself
- [ ] It performs no network call and no database query
- [ ] A Saturday or Sunday is closed
- [ ] A weekday inside regular session hours is open; the same weekday before the open or after the
      close is closed
- [ ] Session boundaries are computed in the market timezone, so both annual daylight-saving
      transitions need no special case
- [ ] A date in the hardcoded NYSE holiday table is closed regardless of it being a weekday
- [ ] The holiday table states the years it covers, and an instant beyond that window is treated as
      an ordinary weekday rather than throwing — an unknown holiday costs one wasted request
- [ ] Half-day early closes are not modelled: the calendar reports open until the regular close on
      those days
- [ ] The configured market timezone is honoured, so an operator setting a different exchange's zone
      gets that zone's weekdays and hours
- [ ] Tests drive fixed instants — a weekend, the minute before and after the open, the minute after
      the close, a listed holiday, and a date on each side of both daylight-saving transitions — and
      none of them depends on the machine's clock or locale
- [ ] Nothing outside the poller consults the calendar; no correctness rule depends on it
