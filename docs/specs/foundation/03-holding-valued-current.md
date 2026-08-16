# 03 — `holding_valued` and current net worth

_Part of [0001-foundation-day-zero.md](../0001-foundation-day-zero.md)._

**What to build:** One shared definition of "what do I hold right now and what is it worth", so the
dashboards built later cannot drift on the answer. A share position, a cash balance and a personal
loan all sum through a single path into a net worth total, with the sign living in quantity and no
liability branch anywhere. Partial data is reported as partial rather than as zero. Verified by
tests rather than by a screen — the dashboards slice is this module's first UI consumer.

This ticket also establishes the test seam every later slice uses: a real Postgres, seeded through a
fixture builder that speaks the domain, read through the query module.

**Blocked by:** 02.

**Status:** ready-for-agent

**Test infrastructure**

- [ ] Tests run against a real Postgres with migrations applied — no mock, no in-memory substitute,
      no SQLite
- [ ] Each test runs against a database it does not share, by container-per-run with per-test
      truncation or by transactional rollback, so ordering never matters
- [ ] Data is seeded through a fixture builder speaking the domain — seed a person, an account, a
      position set with holdings, a quote — and never by raw `INSERT` in a test body
- [ ] Tests assert on exact decimal strings at full scale, never on parsed numbers or approximate
      comparisons
- [ ] Tests are named for the rule they protect, and none assert on generated SQL text, on which
      CTE the view uses, or on an index existing

**The view**

- [ ] `holding_valued` is a plain, non-materialised view
- [ ] Every row exposes account id, name, institution, kind and tax treatment; owner id and name;
      instrument id, symbol, name, quote type and price source; classification name and asset class;
      quantity, price, value, cost basis per share, cost basis and unrealized; plus stale and priced
      flags
- [ ] Value is computed in SQL as quantity times price, and is null when price is null
- [ ] Cost basis is quantity times cost basis per share, null when the per-share figure is null;
      unrealized is value minus cost basis, null when either side is null
- [ ] The join to the quote table is a LEFT join

**Behaviour**

- [ ] A positive share position, a `USD` cash position and a negative-quantity liability all sum
      into one net worth total through a single path with no branch
- [ ] Current holdings come from the newest position set per account, tie-broken by creation time
      descending and then by id descending
- [ ] A re-upload for an as-of date that already has a position set resolves deterministically
- [ ] An older position set uploaded late does not displace a newer one
- [ ] Accounts with a closing date set are excluded
- [ ] A holding whose instrument has never been quoted still appears, flagged as unpriced, excluded
      from the total and counted in coverage
- [ ] A null cost basis leaves unrealized null on that row, excludes it from the total, and is
      reported in coverage — never coerced to zero
- [ ] A stale quote has its price used, with the row flagged stale
- [ ] Quantities with fractional shares, and values large enough that float coercion would round,
      cross the boundary as exact decimal strings

**The query module**

- [ ] One module is the only thing that reads the view; it is a thin translation layer with no
      caching and no rules beyond assembling coverage counts
- [ ] It exposes current holdings and a net worth total; the total reports its coverage as a known
      count against a total count, so the UI can say "based on 8 of 12 holdings"
- [ ] Every numeric field on the returned shape is a decimal string
