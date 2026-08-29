# Owner filter — reading every money screen as one or more owners

> Triage label to apply when this is filed: `ready-for-agent`
>
> Covers ADR-0008, which decides the shape: one household-wide selection, carried across screens,
> never derived from who signed in. Builds on the holdings slice (0003), whose Holdings table
> already carries an in-memory `owner` dimension and the URL-as-state discipline this slice
> generalises; on the chart-range work (0008, 0009), whose explicit-URL-over-cookie resolution and
> route middleware are copied rather than reinvented; and on DESIGN.md §4.2's single owner per
> account, which is what makes the filter a single column predicate.

## Problem Statement

A household of four can narrow exactly one screen by person, and only by accident of where that
screen's filtering happens to live.

- **Holdings can.** `DIMENSIONS` in `app/lib/holdings-view.ts:133-209` includes `owner`, both as a
  filter and as a grouping, and the table's whole query is a URL. But it filters **in memory** — the
  loader calls bare `currentHoldings()` (`app/routes/holdings.tsx:126`) and `applyFilters` narrows
  the array afterwards.
- **Overview, Analysis and Income cannot.** Analysis renders `allocationByPerson` as a
  *breakdown* (`app/routes/analysis.tsx:199`, `:249-257`) — it shows every person side by side, and
  offers no way to read the other three panels as one of them. Income has no person cut at all.
  Overview's own module comment (`app/routes/overview.tsx:212-215`) records that the per-person cut
  was left out because it needs the holdings themselves.

So the question "what does this look like for just the children?" is answerable on one screen out of
four, and only for a table — never for a chart, a net worth figure, an allocation, or a dividend
projection.

This is the deferred half of DESIGN.md §8.3, which records that the dashboards "are not five
features — they are one query shape with different arguments", lists `holdings by user` and
`…by person over time` among them, and names *persisting the Holdings table's filter and group
state* as most of the remaining work. This slice does the filter half of that, for one dimension,
across every screen — and leaves the builder itself deferred.

The plumbing is already waiting. `readHoldings(db, source, where?)`
(`app/lib/valuation.server.ts:203-217`) takes an optional predicate, and its docstring says the
point out loud: *"`where` narrows the same read to a subset — one account's holdings, say.
Narrowing here rather than in a second function is the point."* `readSeries` and `readSessionSeries`
take the same predicate, each applying it **inside the lateral** rather than in an outer `WHERE`,
because an outer one drops uncovered dates (`:551-560`). Nothing but `accountId` has ever used them.

## Solution

One selection, spelled the same everywhere, required by the readers rather than remembered by the
author of the next screen.

### The filter itself

A new pure module, `app/lib/owner-filter.ts` — plain `.ts` and not `.server`, for the reason
`app/lib/chart-range.ts:12-15` gives about itself: the control component needs the type and the
serialiser, and neither touches the database.

```ts
/** Whose money a screen is showing. Empty means the whole household. */
export type OwnerFilter = readonly string[];

/** The unfiltered household, spelled as a value so a diff can see the choice. */
export const ALL_OWNERS: OwnerFilter = Object.freeze([]);
```

Owner ids are `bigint` and therefore cross as **strings**, per ARCHITECTURE.md §5.6 and the standing
rule that ids never go through `Number()`.

**The grammar is one param, comma-separated:** `?owner=3` and `?owner=1,3`. Today's single-value
`?owner=3` on Holdings keeps working and now means the same thing household-wide, so no bookmark
breaks.

**Normalisation, so one view has one URL** — the rule `toSearch` and the Holdings canonical redirect
(`app/routes/holdings.tsx:121-123`) already establish:

- ids are sorted numerically and de-duplicated;
- a selection naming **every** account-owning person normalises to `ALL_OWNERS`;
- an empty selection is `ALL_OWNERS` — "nobody" is not a view;
- a malformed id (non-digit, over 18 digits) is dropped at parse, matching `isAccount`'s guard
  against handing a bad bigint to Postgres (`app/lib/valuation.server.ts:370-384`);
- a request whose `owner` param is not already in canonical spelling is redirected to the one that
  is, before any database work.

**Resolution mirrors the chart range exactly** (`app/lib/chart-range.ts:531-577`): an explicit
`owner` param wins; failing that a session cookie; failing that `ALL_OWNERS`. The cookie is
`owner_filter`, `Path=/`, `SameSite=Lax`, and **session-scoped — no `Max-Age`**, which is the one
deliberate difference from `chart_range`'s year and is ADR-0008's answer to a filter that can be
forgotten. It is written by a route middleware carrying the *request's* explicit param, the way
`chartRangeMiddleware` does (`app/lib/chart-range.ts:603-624`) and for the reason its docstring
gives: wrapping a loader's return in `data(value, {headers})` would make every direct-calling test
cope with a union.

**An unresolvable id is treated differently by source**, which is ADR-0008's honesty rule:

- from the **URL**, it is kept. The predicate matches nothing, the screen shows its empty state, and
  the state says the filter names an owner who is no longer recorded, with a link that clears it.
- from the **cookie**, it is dropped. If that empties the selection, the screen shows the household.
  This is `decodeRangeCookieValue` returning `null` on anything unrecognised
  (`app/lib/chart-range.ts:495-506`), applied to a stale member of a set.

### The readers

The filter becomes a **required first argument, with no default**, on every household-scoped reader.
This is the whole of the standing rule: a new screen cannot read holdings without saying whose, and
`ALL_OWNERS` is a word in the diff rather than an omission. The precedent is
`app/components/net-worth-chart.tsx:297-345`, whose `masked` and `session` props are deliberately
required with no default so a new caller cannot forget them.

| Reader | Takes the filter | Why |
|---|---|---|
| `currentHoldings`, `holdingsAt`, `netWorth`, `netWorthAt` | yes | the household reads |
| `accountTotals`, `netWorthChange`, `firstRecordedDate` | yes | household aggregates and the chart's reach |
| `netWorthSeries`, `netWorthSessionSeries` | yes | narrowing goes **inside** the lateral |
| `manualNetWorth` | yes — and returns nothing when the filter is on | DESIGN.md §7 rule 3, made structural |
| `accountTotal`, `accountHoldings`, `accountSeries`, `accountSessionSeries`, `accountFirstRecordedDate` | **no** | already narrower than an owner; ADR-0008's account-screen rule |
| `latestObservedSession` | **no** | a fact about the price feed, not about holdings |

`manualNetWorth` taking a filter it answers by returning `[]` is the load-bearing oddity: it is what
stops a future Overview-shaped screen from drawing household history under a narrowed line, without
that screen's author having read §7.

Two implementation notes the tickets carry:

- **`readTotal` has no `where` hook** (`app/lib/valuation.server.ts:228-247`) — it is the one reader
  built without one, and `netWorth()` goes through it. It gains the same optional predicate its two
  siblings already have.
- **`accountTotals` and `accountTotal` do not use the `ValuedSource` path at all.** They select from
  `account`, inner-join `person` and **left**-join `holding_valued` (`:404-467`), specifically so an
  account holding nothing reports `0.0000` rather than vanishing. Their narrowing is therefore its
  own predicate on `account.owner_id`, not a reuse of the lateral one.

A new predicate builder sits beside `isAccount`: `isOwner(column, filter)`, returning a predicate
that is omitted entirely for `ALL_OWNERS` rather than emitting a tautology, and that is called with
the right column per source — `holding_valued.owner_id`, `v.owner_id`, `a.owner_id`.

### The control

A shared `OwnerFilterControl` in `app/components/`, drawn in the page header strip beside the chart
range where a screen has one. It is a `<form method="get">` of checkboxes with an Apply button —
the `Filters` bar's shape (`app/routes/holdings.tsx:571-619`), including its hidden fields, which is
how a GET form changes one thing without resetting the others. No JavaScript is required, matching
`ChartRangeControl`'s custom-range disclosure.

**It is not drawn at all** when the household has fewer than two account-owning people, which is
`availableFilters`' existing rule (`app/lib/holdings-view.ts:508`) and means a single-person
household never sees it.

**The roster** is `listPeople()` (`app/lib/people.server.ts:61-84`) kept to `accountCount > 0`. That
count already spans open and closed accounts, which is exactly ADR-0008's rule: an owner whose
accounts are all closed still has history worth reading.

**A narrowed screen says so in words** beside the figure it narrowed — never a highlighted chip
alone. This is the condition ADR-0008 attaches to the filter surviving navigation, and it is what
keeps the Overview headline from silently meaning something else.

### Two traps this slice has to fix

Both are existing behaviours that would silently eat the filter:

1. **`toSearch` rebuilds the query from scratch** (`app/lib/holdings-view.ts:438-453`). Every
   filter, sort and group link on Holdings is built from it, so unless it carries `owner` through,
   clicking a column header clears the filter.
2. **`ChartRangeControl` links to a bare `?range=…`** (`app/components/chart-range-control.tsx:102`),
   which React Router resolves as *replace the whole query*. Picking a range on a filtered Overview
   would drop the filter — the same bug that already drops `?uploaded=` on the account screen.

### Per screen

| Screen | Behaviour |
|---|---|
| **Overview** | Headline, delta, chart, accounts rollup and allocation all narrow. The manual prefix is not drawn while narrowed, and the chart's earliest reachable date becomes the selected owners' first recorded position — so **All** shortens and long presets may disable, as they already do on an account. |
| **Holdings** | `owner` leaves `DIMENSIONS` as a *filter* and stays as a *grouping*. The table narrows through the lens instead, and — being the one screen that filtered in memory — now narrows in SQL. |
| **Analysis** | All four panels narrow, including "Net worth by person", which is retitled **"Net worth by owner"** to match the glossary. The capital-gains rate is unchanged: it is the household's, not an owner's. |
| **Income** | Annual dividend, weighted yield, the sheltered/taxable subtotal and both breakdowns narrow. |
| **Account detail, upload flow, Settings** | Untouched. No control drawn, filter ignored. |

## Tickets

| # | Ticket | Blocked by |
|---|---|---|
| 01 | [The owner filter, parsed, normalised and carried](owner-filter/01-the-filter-itself.md) | Nothing |
| 02 | [Narrowing the valuation readers](owner-filter/02-narrowing-the-readers.md) | 01 |
| 03 | [The control, and Overview reading as an owner](owner-filter/03-control-and-overview.md) | 01, 02 |
| 04 | [Holdings folds its Owner dimension into the filter](owner-filter/04-holdings.md) | 03 |
| 05 | [Analysis and Income read as an owner](owner-filter/05-analysis-and-income.md) | 03 |
| 06 | [The standing rule, the guide, and the screenshots](owner-filter/06-the-standing-rule.md) | 04, 05 |

## Testing

Postgres-backed, through the builders in `tests/support/fixtures.ts` and the route helpers in
`tests/support/routes.ts`, per the house rules.

- `tests/owner-filter.test.ts` — the pure module: parse, normalise (sort, dedupe, all-selected,
  empty, malformed), serialise, the cookie round trip, and URL-over-cookie-over-default resolution.
- `tests/valuation-owner-filter.test.ts` — every household reader narrows; two owners sum to the
  household total at exact decimal strings; the series readers narrow **inside** the lateral, proven
  by a date on which only the excluded owner has a position set still appearing on the line;
  `manualNetWorth` returns nothing when narrowed; account-scoped readers ignore it because they do
  not take it.
- Per-screen tests extend the existing route files rather than adding a meta-test: each asserts its
  screen narrows, and Overview additionally asserts the manual series is absent and the reachable
  range shortens.
- A test that an unresolvable id from the URL empties the screen while the same id from the cookie
  does not.

## Out of Scope

- **The saved view builder** (DESIGN.md §8.3). This slice persists one dimension's filter across
  screens; it does not add a measure picker, a dimension picker, or a stored view.
- **Making the other six Holdings dimensions household-wide.** Only `owner` becomes a lens. Whether
  tax treatment or asset class should follow is a question this slice deliberately leaves open, and
  the answer may well be the builder rather than six more lenses.
- **Joint ownership.** DESIGN.md §4.2 and §14 record single-owner as accepted debt; a filter over
  `owner_id` is one predicate precisely because of it. Nothing here makes the debt harder to pay.
- **Per-owner pre-app history.** §7 rule 3 stands: the manual series has no structure to slice, and
  this slice hides it rather than inventing one.
- **Defaulting the filter to the signed-in family member.** ADR-0008 rejects it; the gate stays
  attribution-only.
- **Settings.** The filter is a reading in progress, not a household preference — there is no
  `app_setting` column and no Settings entry, which is the same call spec 0008 made for the chart
  range.

## Further Notes

**The glossary is already written.** `CONTEXT.md` gained **Person**, **Owner** and **Owner filter**
before this spec existed, and the retitled Analysis panel is the one place the old wording survives
in the UI.

**Screenshots.** `docs/README.md` makes retaking them part of finishing a screen. Four screens
change; ticket 06 carries the retake with `scripts/capture-screenshots.ts` against the demo
household, and checks whether the demo seed has enough owners for the control to draw at all.

**Mobile.** A checkbox list of four names fits the phone layout the `.filter-bar` and `.segmented`
blocks already carry. Nothing here is desktop-shaped.
