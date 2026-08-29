# 02 — Narrowing the valuation readers

_Part of [0013-owner-filter.md](../0013-owner-filter.md)._

**What to build:** The owner filter becomes a **required first argument** on every household-scoped
reader in `app/lib/valuation.server.ts`, and the SQL narrows on `owner_id`. Every existing call site
passes `ALL_OWNERS`, so no screen changes behaviour in this ticket — the diff is deliberately noisy
and deliberately mechanical.

The requiredness is the point, and it is the whole of the standing rule this slice was asked for. A
default would make the filter something a new screen can forget; no default makes "the whole
household" a word somebody typed. `app/components/net-worth-chart.tsx:297-345` already does exactly
this with `masked` and `session`, for exactly this reason.

Separating it from the screens is what makes it reviewable: this ticket is a signature change plus
three predicates, and it can be read for correctness without any argument about controls or copy.

**Blocked by:** 01 — it needs `OwnerFilter` and `ALL_OWNERS`.

**Status:** ready-for-agent

**The predicate**

- [ ] `isOwner(column, filter)` sits beside `isAccount` and returns a predicate for a set of ids
- [ ] For `ALL_OWNERS` the reader omits the predicate **entirely** rather than emitting a tautology,
      so an unfiltered plan is byte-identical to today's
- [ ] Ids are already digit-guarded by 01, and the builder still refuses to interpolate anything
      that is not, for the reason `isAccount` states at `:370-379`
- [ ] It is called with the column its source actually exposes: `holding_valued.owner_id`,
      `v.owner_id`, `a.owner_id` — the same three-alias awkwardness `isAccount` already lives with

**Signatures that gain the filter**

- [ ] `currentHoldings`, `holdingsAt`, `netWorth`, `netWorthAt`
- [ ] `accountTotals`, `netWorthChange`, `firstRecordedDate`
- [ ] `netWorthSeries`, `netWorthSessionSeries`
- [ ] `manualNetWorth`
- [ ] In every case the filter is the **first** parameter and has **no default**; `db` stays last
      with its `getDb()` default

**Signatures that do not**

- [ ] `accountTotal`, `accountHoldings`, `accountSeries`, `accountSessionSeries`,
      `accountFirstRecordedDate` — already narrower than an owner, per ADR-0008
- [ ] `latestObservedSession` — a fact about the price feed, not about holdings
- [ ] A comment at the seam says why the line falls where it does, so the next reader does not
      "finish the job"

**Where the narrowing goes**

- [ ] `readHoldings` combines the owner predicate with any existing `where` rather than replacing it
- [ ] `readTotal` gains the optional `where` its two siblings already have — it is the one reader
      built without one (`:228-247`), and `netWorth()` goes through it
- [ ] `readSeries` and `readSessionSeries` apply the predicate **inside the lateral**, never in the
      outer `WHERE` — `:551-560` explains that an outer predicate drops a date the subquery did not
      cover, which silently shortens a line
- [ ] `accountTotals` narrows with its own predicate on `account.owner_id`, because it does not use
      the `ValuedSource` path — it selects from `account` and **left**-joins `holding_valued`
      (`:404-467`) so an account holding nothing still reports `0.0000`
- [ ] `netWorthChange` narrows both its `present` and `past` CTEs, or the delta compares one owner
      against the household

**`manualNetWorth`**

- [ ] It takes the filter and returns `[]` whenever the filter is on
- [ ] Its docstring says this is DESIGN.md §7's third rule made structural — the manual series has no
      owner and no honest way to acquire one
- [ ] It does not query the database at all in that case

**Call sites**

- [ ] Every existing caller passes `ALL_OWNERS` explicitly, including `scripts/seed-demo.ts` and
      `scripts/capture-screenshots.ts` if they call a reader
- [ ] No call site passes a literal `[]`

**Tests** (`tests/valuation-owner-filter.test.ts`)

- [ ] Each household reader narrowed to one owner returns only that owner's rows
- [ ] Two owners' narrowed totals sum to the household total, as exact decimal strings at the stored
      scale — never `toBeCloseTo`
- [ ] `ALL_OWNERS` returns exactly what the reader returns today, for every reader
- [ ] The lateral rule has a reproducing case: a date on which only the **excluded** owner has a
      position set still appears on the narrowed line, carried forward, rather than being dropped
- [ ] `accountTotals` narrowed still reports an owned account that holds nothing as `0.0000`
- [ ] `netWorthChange` narrowed compares owner to owner on both ends
- [ ] `manualNetWorth` returns `[]` under any non-empty filter and its rows under `ALL_OWNERS`
- [ ] An owner id naming nobody yields empty results rather than an error
- [ ] `firstRecordedDate` narrowed returns the selected owners' first position set, not the
      household's
