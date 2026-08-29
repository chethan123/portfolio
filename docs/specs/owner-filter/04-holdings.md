# 04 — Holdings folds its Owner dimension into the filter

_Part of [0013-owner-filter.md](../0013-owner-filter.md)._

**What to build:** Holdings stops carrying its own person filter and reads the household one
instead. `owner` leaves `DIMENSIONS` as a **filter** and stays as a **grouping**, and the table —
the one screen that narrowed in memory — narrows in SQL.

This is mostly a subtraction, which is why it is its own ticket: two controls that mean the same
thing on one page will drift, and the deletion is easier to review when it is not tangled with a new
screen's behaviour. The param name does not change, so a bookmarked `/holdings?owner=3` keeps
working and now means the same thing everywhere.

**Blocked by:** 03 — it needs the control.

**Status:** ready-for-agent

**The dimension**

- [ ] `owner` is removed from the filter dimensions in `app/lib/holdings-view.ts:133-209`, so the
      filter bar no longer offers an Owner select
- [ ] `owner` remains a **grouping**: grouping by owner is a different act from narrowing to one,
      and it stays useful under a multi-owner filter
- [ ] Grouping by owner still drops the Owner column (`app/routes/holdings.tsx:310-315`)
- [ ] The Owner column still shows for every row when not grouped by owner
- [ ] `availableFilters` no longer builds an owner facet, and nothing else regresses: `DIMENSIONS`
      maps to exactly `["account", "institution", "kind", "tax", "classification", "assetClass"]`,
      asserted as that literal list rather than as a count

**Carrying the filter through every link — the trap**

- [ ] `toSearch` (`app/lib/holdings-view.ts:438-453`) carries `owner` through. It rebuilds the query
      from scratch, and every filter, sort and group link on the screen is built from it — without
      this, clicking a column header clears the filter
- [ ] `owner` is passed to `toSearch` as its own argument rather than smuggled into `HoldingsQuery`.
      A param that `toSearch` emits but `parseQuery` refuses to parse is a seam with a hole in it,
      and the next person to add a dimension falls through it
- [ ] `owner` is emitted in canonical spelling and omitted entirely when the filter is off, so an
      unfiltered table's URL stays `/holdings`
- [ ] The canonical redirect at `app/routes/holdings.tsx:121-123` accounts for `owner`, and a
      non-canonical spelling redirects once before any database work
- [ ] The filter bar's hidden fields carry `owner` alongside `group`, `sort` and `dir`
      (`:585-589`)
- [ ] The row-editor params `edit` and `saved` keep working under a filter, and the action's redirect
      (`:246`) preserves it

**Narrowing in SQL**

- [ ] The loader passes the resolved filter to `currentHoldings` rather than filtering the returned
      array
- [ ] `applyFilters` no longer sees an owner key
- [ ] The summary line and every group subtotal reflect the narrowed set, as exact decimal strings

**Editing under a filter**

- [ ] Opening a row's correction form under a filter works, and saving returns to the same narrowed,
      sorted, grouped view
- [ ] Correcting a position in an account outside the current filter is not reachable from this
      screen, because the row is not on it — no new refusal is invented for a case that cannot arise

**Tests** (`tests/routes/holdings.test.ts`, plus `tests/holdings-view.test.ts` for the `DIMENSIONS`
and `toSearch` assertions — the pure-module file is where most of this ticket's risk lives)

- [ ] The filter bar offers no Owner select, and the dimension ids match the literal list above
- [ ] Group-by owner still works, still drops the column, and works under a multi-owner filter
- [ ] A bookmarked `?owner=3` narrows the table exactly as the old dimension did
- [ ] Sorting, grouping and filtering by another dimension all preserve `owner`
- [ ] A row correction under a filter returns to the narrowed view
- [ ] The narrowed totals match the sum of the narrowed rows
