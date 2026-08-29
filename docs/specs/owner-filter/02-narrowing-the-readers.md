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

- [ ] `isAccount` generalises to `isOneOf(column, ids)`; `isAccount(column, id)` becomes
      `isOneOf(column, [id])`. One guard, one answer for an unusable id, one place to change
- [ ] Whether to narrow at all is the **reader's** decision, not the builder's: for `ALL_OWNERS` the
      reader passes no predicate, so no call site branches on an `undefined` return
- [ ] An id that cannot be a `bigint` yields `false` rather than an early return, so "no such owner"
      comes out of the query — `isAccount`'s reason at `:370-379`
- [ ] It is called with the column each source exposes: `holding_valued.owner_id`, `v.owner_id`,
      `a.owner_id`, and unaliased `account.owner_id` in `accountTotals`. `isAccount` already lives
      with five such columns (`:491`, `:524`, `:617`, `:836`, `:966`), so the awkwardness is not new

**Signatures that gain the filter**

- [ ] `currentHoldings`, `holdingsAt`, `netWorth`, `netWorthAt`
- [ ] `accountTotals`, `netWorthChange`, `firstRecordedDate`
- [ ] `netWorthSeries`, `netWorthSessionSeries`
- [ ] In every case the filter is the **first** parameter and has **no default**; `db` stays last
      with its `getDb()` default

**Signatures that do not**

- [ ] `accountTotal`, `accountHoldings`, `accountSeries`, `accountSessionSeries`,
      `accountFirstRecordedDate` — already narrower than an owner, per ADR-0008
- [ ] `latestObservedSession` — a fact about the price feed, not about holdings
- [ ] `manualNetWorth` — it has no owner to narrow on, and a filtered screen decides not to *draw* it
      rather than asking it for nothing. An empty return cannot be told from an instance with no
      manual rows, and the screen needs that difference to know whether to explain the absence
- [ ] A comment at the seam says why the line falls where it does, so the next reader does not
      "finish the job"

**Where the narrowing goes**

- [ ] `readHoldings` combines the owner predicate with any existing `where` rather than replacing it
- [ ] `readTotal` gains the optional `where` its two siblings already have — it is the one reader
      built without one (`:228-247`), and `netWorth()` goes through it
- [ ] `readSeries` and `readSessionSeries` apply the predicate **inside the lateral**, never in the
      outer `WHERE` — `:551-560` explains that an outer predicate drops a date the subquery did not
      cover, which silently shortens a line
- [ ] `accountTotals` (`:404-443`) narrows with its own predicate on `account.owner_id`, because it
      does not use the `ValuedSource` path — it selects from `account` and **left**-joins
      `holding_valued` so an account holding nothing still reports `0.0000` (the reasoning is in
      `accountTotal`'s docstring at `:460-461`)
- [ ] `netWorthChange` narrows both its `present` and `past` CTEs (`:892-901`), or the delta compares
      one owner against the household
- [ ] **`firstRecordedDate` needs a shape none of the above provide.** It reads `position_set`
      (`:934-943`), which has `account_id` and no `owner_id`. It narrows by subquery:
      `position_set.account_id in (select id from account where owner_id in (…))`
- [ ] That subquery spans **closed** accounts, where `holding_valued` excludes them — so a narrowed
      `firstRecordedDate` may report history for an owner whose current holdings are empty. The
      docstring says so, because ticket 03's chart reach depends on it

**Call sites**

- [ ] All ten production call sites — every one is in a route loader — pass `ALL_OWNERS` explicitly
- [ ] No call site passes a literal `[]`
- [ ] The roughly one hundred test call sites are updated mechanically; that noise is the bulk of the
      diff and is expected

**Tests** (`tests/valuation-owner-filter.test.ts`)

- [ ] Each household reader narrowed to one owner returns only that owner's rows
- [ ] Two owners' narrowed totals sum to the household total, as exact decimal strings at the stored
      scale — never `toBeCloseTo`
- [ ] `ALL_OWNERS` adds no `where` clause — asserted by reading the builder, not by a test that
      claims the code equals itself. That the existing suite still passes is the change loop's job
- [ ] The lateral rule has a reproducing case: a date on which only the **excluded** owner has a
      position set still appears on the narrowed line, carried forward, rather than being dropped
- [ ] `accountTotals` narrowed still reports an owned account that holds nothing as `0.0000`
- [ ] `netWorthChange` narrowed compares owner to owner on both ends
- [ ] An owner id naming nobody yields empty results rather than an error
- [ ] An owner whose accounts are all closed yields no holdings but a real `firstRecordedDate`
- [ ] `firstRecordedDate` narrowed returns the selected owners' first position set, not the
      household's
