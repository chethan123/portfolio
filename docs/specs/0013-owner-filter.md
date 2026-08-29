# Owner filter — reading every money screen as one or more owners

> Triage label to apply when this is filed: `ready-for-agent`
>
> Covers ADR-0008, which decides the shape: one household-wide selection, carried across screens,
> never derived from who signed in. Builds on the holdings slice (0003), whose Holdings table
> already carries an in-memory `owner` dimension and the URL-as-state discipline this slice
> generalises; on the chart-range work (0008, 0009), whose param-parsing discipline is copied
> though its cookie and middleware deliberately are not; and on DESIGN.md §4.2's single owner per
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
  `allocationBars`' docstring (`app/routes/overview.tsx:211-214`) records that the per-person cut was
  left out because it needs the holdings themselves, and fetching them there would add another
  hand-rolled dashboard query.

So the question "what does this look like for just the children?" is answerable on one screen out of
four, and only for a table — never for a chart, a net worth figure, an allocation, or a dividend
projection.

This is the deferred half of DESIGN.md §8.3, which records that the dashboards "are not five
features — they are one query shape with different arguments", lists `holdings by user` and
`…by person over time` among them, and names *persisting the Holdings table's filter and group
state, and adding a measure picker* as most of the remaining work — this slice does the first half
of that pair. This slice does the filter half of that, for one dimension,
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

Owner ids are `bigint` and therefore cross as **strings** — `server/db.ts:28-30` registers the type
parsers that keep them so, and ARCHITECTURE.md:738-739 states the guarantee. (§5.6's `Number()`
prohibition is about money; a cardinality is `Number()`d freely. An id is neither: it is a string
because a bigint does not survive one.)

**The grammar is one param, comma-separated:** `?owner=3` and `?owner=1,3`. Today's single-value
`?owner=3` on Holdings keeps working and now means the same thing household-wide, so no bookmark
breaks.

**Normalisation, so one view has one URL** — the rule `toSearch` and the Holdings canonical redirect
(`app/routes/holdings.tsx:121-123`) already establish:

- ids are sorted numerically and de-duplicated;
- a selection naming **every** account-owning person normalises to `ALL_OWNERS`;
- an empty selection is `ALL_OWNERS` — "nobody" is not a view;
- a non-digit id is **kept**, not dropped, and the predicate matches nothing — dropping it would
  widen the view, which is the failure `app/lib/holdings-view.ts:399-407` exists to prevent;
  `isAccount` (`app/lib/valuation.server.ts:370-384`) takes the same position, keeping the bad id and
  emitting `false` so "no such row" comes out of the query rather than out of an early return. Its
  guard is `/^\d+$/` and nothing more, so this slice adds the length guard it lacks — an id past
  `bigint`'s range currently reaches Postgres and 500s;
- a request whose `owner` param is not already in canonical spelling is redirected to the one that
  is, before any database work.

**The URL is the only carrier — there is no cookie and no middleware.** The filter is present if
`?owner=` is present and absent otherwise, which is the whole of the resolution rule. Unlike the
chart range, this slice adds no persistence: ADR-0008 records why, and the consequence is that
closing the tab forgets the filter structurally rather than by a chosen cookie lifetime.

**It travels between screens on the navigation links.** `NAVIGATION` in `app/root.tsx:115-120` is a
list of bare paths rendered through the `NavItems` component (`:129`), and a bare path makes
`NavLink` drop the query string — which is exactly why the filter does not survive a nav click
today. The links become `to={{ pathname, search }}`, reading the search once in the shell. That is
the entire carry mechanism.

`NavItems` is rendered four times, though, and only two of them should carry: the desktop rail
(`:199`) and the mobile drawer (`:240`) render `NAVIGATION`, while `:202` and `:241` render
`FOOTER_NAVIGATION`, which is Settings — a screen this filter does not touch. So the carry is a prop
on `NavItems` rather than a change inside it.

Two consequences worth stating plainly, because they are the price of the simplicity:

- Typing `/holdings` by hand, or opening an old bookmark, starts unfiltered. For a self-hosted
  instance read by one family, that is not a defect worth a cookie.
- Every link **out** of a filtered screen that should stay filtered has to carry the search. The nav
  is the main path; the account rows are deliberately not (an account screen ignores the filter), and
  the masking and refresh controls already round-trip `pathname + search` through their `redirectTo`
  field (`app/components/masking-toggle.tsx:77`).

**An id that names nobody is kept**, the predicate matches nothing, the screen shows its empty state,
and that state says the filter names an owner who is no longer recorded, with a link that clears it.
One rule, since there is now only one source.

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
| `manualNetWorth` | **no** | the rule is a display decision about two lines; it belongs in the loader |
| `accountTotal`, `accountHoldings`, `accountSeries`, `accountSessionSeries`, `accountFirstRecordedDate` | **no** | already narrower than an owner; ADR-0008's account-screen rule |
| `latestObservedSession` | **no** | a fact about the price feed, not about holdings |

`manualNetWorth` was going to take the filter and answer `[]`, as a forcing function. It does not,
because `[]` cannot be told apart from an instance with no manual rows — and the screen needs that
distinction anyway to decide whether to explain the absence. The rule lives in the Overview loader
instead, on one line carrying the §7 citation, where the decision is visible.

Two implementation notes the tickets carry:

- **`readTotal` has no `where` hook** (`app/lib/valuation.server.ts:228-247`) — it is the one reader
  built without one, and `netWorth()` goes through it. It gains the same optional predicate its two
  siblings already have.
- **`accountTotals` and `accountTotal` do not use the `ValuedSource` path at all.** They select from
  `account`, inner-join `person` and **left**-join `holding_valued` (`:404-443` and `:470-506`), specifically so an account
  holding nothing reports `0.0000` rather than vanishing — the reasoning is in `accountTotal`'s
  docstring at `:460-461`. Their narrowing is therefore its
  own predicate on `account.owner_id`, not a reuse of the lateral one.

`isAccount` generalises to `isOneOf(column, ids)`, with `isAccount(column, id)` becoming
`isOneOf(column, [id])` — one digit-and-length guard, one answer for an unusable id. It is called
with the column each source exposes: `holding_valued.owner_id`, `v.owner_id`, `a.owner_id`,
`account.owner_id` (unaliased, in `accountTotals`), and — see below — a subquery for
`firstRecordedDate`. Whether to emit a predicate at all is the reader's decision, not the builder's,
so no call site has to branch on `undefined`.

**`firstRecordedDate` has no owner to narrow on.** It reads `position_set` (`:934-943`), which
carries `account_id` and no `owner_id` — deliberately, per DESIGN.md §4.2. Narrowing it needs a
fourth shape: `position_set.account_id in (select id from account where owner_id in (…))`. That
subquery spans **closed** accounts, where `holding_valued` excludes them, so a narrowed
`firstRecordedDate` and a narrowed `currentHoldings` can disagree about which owners have history.
Ticket 02 carries both the shape and the consequence.

### The control

A shared `OwnerFilterControl` in `app/components/`, drawn in the page header strip beside the chart
range where a screen has one. It is a `<form method="get">` of checkboxes with an Apply button —
the `Filters` bar's shape (`app/routes/holdings.tsx:571-619`) — a React Router `<Form method="get">`, not a raw
`<form>` — including its hidden fields, which is how a GET form changes one thing without resetting
the others. It is built by extracting the shared parts of that bar rather than beside it, so there is
one control shape and one options rule. No JavaScript is required, matching `ChartRangeControl`'s
custom-range disclosure.

**It is not drawn at all** when fewer than two people own an open account — the spirit of
`availableFilters`' rule (`app/lib/holdings-view.ts:508`), not its code. That rule counts distinct
values among the *holdings on screen*; this roster counts people, and the two disagree for an owner
who holds nothing. Following the holdings would hide the control on a screen the owner is absent
from, which is the wrong answer for a filter that spans four screens.

**The roster** is `listPeople()` (`app/lib/people.server.ts:61-84`) kept to owners of at least one
**open** account. `accountCount` spans closed accounts too, so it cannot be used unfiltered: an owner
whose accounts are all closed contributes nothing to `holding_valued`, and selecting them would
empty every screen with no explanation — a resolvable id, so the unknown-owner state would not fire.
Their history stays out of the filter's reach, which is recorded as an accepted limitation rather
than solved here.

**A narrowed screen says so in words** beside the figure it narrowed — never a highlighted chip
alone. This is the condition ADR-0008 attaches to the filter surviving navigation, and it is what
keeps the Overview headline from silently meaning something else.

### Two traps this slice has to fix

Both are existing behaviours that would silently eat the filter. The second is a live bug on a
shipped screen and lands first, as ticket 00, rather than riding inside the largest ticket.

1. **`toSearch` rebuilds the query from scratch** (`app/lib/holdings-view.ts:438-453`). Every
   filter, sort and group link on Holdings is built from it, so unless it carries `owner` through,
   clicking a column header clears the filter.
2. **`ChartRangeControl` links to a bare `?range=…`** (`app/components/chart-range-control.tsx:103`),
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
| 00 | [Range links stop replacing the whole query](owner-filter/00-range-links-stop-replacing-the-query.md) | Nothing |
| 01 | [The owner filter, parsed, normalised and carried](owner-filter/01-the-filter-itself.md) | Nothing |
| 02 | [Narrowing the valuation readers](owner-filter/02-narrowing-the-readers.md) | 01 |
| 03 | [The control, and Overview reading as an owner](owner-filter/03-control-and-overview.md) | 00, 01, 02 |
| 04 | [Holdings folds its Owner dimension into the filter](owner-filter/04-holdings.md) | 03 |
| 05 | [Analysis and Income read as an owner](owner-filter/05-analysis-and-income.md) | 03 |
| 06 | [The standing rule, the guide, and the screenshots](owner-filter/06-the-standing-rule.md) | 04, 05 |

## Testing

Postgres-backed, through the builders in `tests/support/fixtures.ts` and the route helpers in
`tests/support/routes.ts`, per the house rules.

- `tests/owner-filter.test.ts` — the pure module: parse, normalise (sort, dedupe, all-selected,
  empty, malformed), serialise, and resolve — presence of the param and nothing else.
- `tests/valuation-owner-filter.test.ts` — every household reader that takes the filter narrows; two owners sum to the
  household total at exact decimal strings; the series readers narrow **inside** the lateral, proven
  by a date on which only the excluded owner has a position set still appearing on the line;
  `manualNetWorth` returns nothing when narrowed; account-scoped readers ignore it because they do
  not take it.
- Per-screen tests rather than a meta-test. `tests/routes/overview.test.ts` and
  `tests/routes/holdings.test.ts` are extended; **`tests/routes/analysis.test.ts` and
  `tests/routes/income.test.ts` do not exist and are created** — those two loaders are exercised
  today only by `tests/invariants/aggregates-agree.test.ts:36-37`. `tests/holdings-view.test.ts`
  takes the `DIMENSIONS` and `toSearch` assertions. Each asserts its screen narrows, and Overview additionally asserts the manual series is absent and the reachable
  range shortens.
- A test that an unresolvable id empties the screen and explains, rather than widening it.
- A test that a nav link from a filtered screen arrives filtered, and that clearing the filter
  produces a bare path.

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
