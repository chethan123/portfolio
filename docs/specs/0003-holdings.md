# Holdings — the workhorse table, and the grouping that absorbs four screens

> Triage label to apply when this is filed: `ready-for-agent`
>
> Covers DESIGN.md §8.1 (the Holdings screen), §8.2 (the query layer — and, specifically, the fact
> that this slice adds **no** new query to it), §8.3 (the deferred saved view builder, of which this
> table is the ~70% the design already claims it is), and §8.4 (navigation). Builds on the
> foundation slice (0001), which created `holding_valued` and the one query module over it, and on
> the pricing slice (0002), which put real prices, staleness and an as-of timestamp behind every
> figure this screen shows.

## Problem Statement

`/holdings` is a 55-line stub. It counts holdings, counts distinct accounts, and says the table "is
built in the dashboards slice". It is second in the navigation — an order §8.4 sets by frequency of
use, under the bracket labelled *daily* — and what it renders is a sentence.

Everything the screen needs is already in memory when it renders that sentence:

- **Eight dimensions arrive on every row and two of them are read.** `ValuedHolding` carries owner,
  account, institution, account kind, tax treatment, classification, asset class and instrument on
  every row `currentHoldings()` returns, because §8.2's view was built to put them there. The route
  uses `accountId` to count a set and `length` to count rows, and drops the rest on the floor.
- **"Everything Priya owns at Fidelity" cannot be asked.** Account detail answers it for one
  account. Analysis answers three fixed cuts — person, account kind, asset class — as donuts, with
  no way to combine two of them or to see the rows underneath. Neither answers a question that
  crosses accounts and narrows on two dimensions at once, which is most of what a household asks.
- **Cost basis and unrealized gain are on no screen at all.** The view computes both, 0001 exposed
  both, 0002 made both real by pricing the instruments — and there is nowhere in the application to
  read them. The same is true of institution and classification, which nothing displays anywhere.
- **The four pages this table was supposed to absorb are simply missing.** §8.1 says a groupable,
  filterable Holdings table "absorbs what would otherwise be four more pages" — by person, by
  account, tax view, unrealized — and calls them "the same table with the grouping changed, not
  separate features". The four pages are unbuilt on the strength of that promise, and the table that
  discharges it is unbuilt too. §8.1's "deliberately not in v1" list rests on the same promise: a
  per-account drill-down is out because "the filtered Holdings table already is one", and a tax page
  is out because it is "a group-by plus a chart on Overview".

So the cost of the stub is not one thin screen. It is four screens' worth of questions the design
decided not to build pages for, all of them currently unanswerable, over data that is already loaded
and already correct.

## Solution

Rebuild the route as the workhorse §8.1 describes: every position the household holds, on one
screen, filterable, groupable with subtotals, sortable, and explicit about what it could not value.

**No new query.** `holding_valued` already exposes every dimension §8.3 lists, and
`currentHoldings()` already returns them all. This slice is a pure function over rows that exist — a
filter is a predicate over the shared view, and a group is a fold over the array a screen already
holds. That is precisely what §8.2 asks for: three hand-rolled dashboard queries disagreeing is the
weakest point named in the whole design, and the fourth one would be the first one written after the
mitigation was in place. If a filter here appears to need SQL, the filter is wrong.

**Seven dimensions, not four and not eight.** §8.1 grants Holdings four — person, account, tax
treatment, classification. §8.3's `Dimension` union has eight, adding institution, account kind,
asset class and instrument. §8.1 predates §8.3, nothing in either forbids the extra four, and three
of them are free: they are columns on rows already in hand. The eighth, `instrument`, is not adopted
— a filter over the very thing each row *is* is a search box, and a search box is out of scope.

**A filter is offered only when it can discriminate** — rendered only if the dimension has at least
two distinct values in the data actually loaded. A single-person household is never asked to choose
between one person. This is the direct answer to §13.7's refusal of account search, which said a
filter over twelve rows "is a control that costs more than it saves": what was refused there was a
control that cannot discriminate, not filtering as such. Making that a rule rather than a judgement
call means the screen scales down to a one-account instance without a special case anywhere.

**Money arithmetic moves to one module.** `allocation.ts` states the invariant in its header — money
arithmetic in JavaScript stays exactly one module wide — and enforced it by keeping its digit-level
primitives private. Subtotals need those same primitives. Copying them would be a second
implementation of rounding, which is the failure the invariant exists to prevent, so they are
extracted to `app/lib/money.ts` and imported by both callers. The invariant stops being a comment
asking to be honoured and becomes structural: there is now literally one module. Sorting a money
column uses an exact integer compare from that same module — never `toPlotValue`, which `format.ts`
reserves for chart geometry as the one sanctioned float, and never a string compare, which sorts
`"9.0000"` above `"10.0000"` and puts the ninth-largest position at the top of the column.

**Three coverages, not one.** Value coverage and cost-basis coverage are different counts over the
same rows, because a 401k holding is routinely priced and still has no cost basis — that is the
normal case, not an edge case. Unrealized inherits the narrower of the two. A single "based on 8 of
12" note under a table carrying all three figures would be wrong about two of them.

**Share on subtotal rows only**, computed against `allocation.ts`'s gross-positive-assets
denominator with the caveat stated in words. A per-row percent column would re-open the
negative-denominator problem Analysis already settled — and settled at length, in the header of
`allocation.ts` — for a column nobody reads row by row.

**State lives in the URL.** The application has zero React hooks and no client state of any kind
today; Overview's range control already establishes the pattern, as links that set a query parameter
the loader reads. Filters, grouping and sort follow it, which makes a filtered view linkable,
bookmarkable, back-button-correct, and — since the controls are a GET form — functional with
JavaScript off.

No migration, no schema change, no change to `holding_valued`.

## User Stories

**Seeing everything at once**

1. As a family member, I want every position the household holds on one screen, so that "what do we
   actually own" is one page rather than a walk through six account pages.
2. As a family member, I want each row to carry its account, owner and tax treatment, so that I can
   read what a line is without remembering which statement it came from.
3. As a family member, I want cost basis and unrealized gain beside value, so that figures the
   database has computed since day one are finally readable somewhere in the application.
4. As a family member, I want to sort on any column, so that "largest position", "worst unrealized
   loss" and "what has no cost basis recorded" are one table sorted three ways.

**Filtering**

5. As a family member, I want to filter by person, so that "everything Priya owns" is a question the
   app answers across accounts rather than one account page at a time.
6. As a family member, I want to combine filters, so that "everything Priya owns at Fidelity" is
   reachable without exporting anything into a spreadsheet.
7. As a family member, I want to be offered a filter only when it can tell my rows apart, so that a
   one-person household is not asked to choose between one person.
8. As a family member, I want every figure above the table to describe what I filtered to, so that a
   filtered view never reports the whole portfolio's total as though it were the subset's.

**Grouping and subtotals**

9. As a family member, I want to group by anything I can filter by, so that the four pages §8.1 says
   this table absorbs really are this table with the grouping changed.
10. As a family member, I want a subtotal on every group, so that a grouping answers "how much" and
    not only "which rows".
11. As a family member, I want each subtotal to say what share of the portfolio its group is, so
    that I am not doing the division myself against a headline further up the page.
12. As a maintainer, I want a subtotal to be the exact sum of the rows above it, so that a total on
    this screen and a total anywhere else in the app cannot differ by a rounding step.

**Telling the truth about partial data**

13. As a family member, I want a never-priced holding listed and excluded from the subtotal it sits
    in, so that a position I hold is neither hidden from me nor valued at a zero it is not worth.
14. As a family member, I want value coverage and cost-basis coverage reported separately, so that a
    401k with prices and no cost basis does not make my valued total look partial.
15. As a family member, I want a stale price to read differently from one that never existed, and in
    the same words this app already uses elsewhere, so that I know which rows need a manual price.
16. As a family member, I want a filter that matches nothing to say so, so that "no rows match this
    combination" is never mistaken for "this instance is empty".

**On a phone**

17. As a family member, I want every column reachable on my phone, so that nothing is hidden from
    the device I read on in the kitchen (§11).
18. As a family member, I want subtotals and coverage visible on a phone too, so that the mobile
    view is the same truth in a different shape rather than a reduced one.

## Implementation Decisions

### Seven dimensions, and why not the eighth

Person · account · institution · account kind · tax treatment · classification · asset class. Each
is a filter, each is a grouping, and they are the same seven in both roles — the whole point of
§8.3's table is that a dimension is one concept used two ways.

**§8.1's four are extended to seven, deliberately.** §8.1 lists person, account, tax treatment and
classification; §8.3's `Dimension` union adds institution, kind, asset class and instrument. §8.1 is
the older text and reads as an illustrative list, not an exhaustive one, and the three added here
are already columns on rows already loaded — the marginal cost of each is a `<select>`.

**`instrument` is refused.** Every other dimension partitions the rows into groups a person can name
in advance. `instrument` partitions a table of holdings into one row per holding, so grouping by it
is the ungrouped table and filtering by it is a search box under a different name. Search is out of
scope (below), and adding a control that only makes sense once the search box exists is building the
second half of a feature first.

### A filter is offered only when it can discriminate

A dimension's control renders only if the loaded rows hold at least two distinct values for it. One
person, one institution, one tax treatment — the control is absent, not disabled and not empty.

**This is the reading of §13.7, not an exception to it.** §13.7 refused search over accounts because
"a filter over twelve rows is a control that costs more than it saves". The cost there was a control
that cannot discriminate — twelve rows are all visible, so the filter buys nothing. That reasoning
narrows to a rule about *discrimination*, and applying the rule rather than the anecdote is what
lets this screen be dense on a household with four people at three institutions and plain on a
household with one of each, with nothing conditional written per dimension.

The options within a control are the distinct values *present in the rows*, not a fetch of every
person or institution on record. An account with nothing in it does not appear as a filter that
would produce an empty table.

### `money.ts`, and what makes the invariant structural

`allocation.ts` keeps its digit-level helpers private and says why: so that "money arithmetic in
JavaScript" stays exactly one module wide. Subtotals need the same helpers, which leaves two options
— copy them, or move them. A copy is a second implementation of half-away-from-zero rounding, and
two implementations of rounding is the thing the invariant was written to prevent.

So they move to `app/lib/money.ts` and `allocation.ts` becomes one of its two callers. The invariant
now holds because there is one module, not because a header asks the next author to keep it that
way. `format.ts` still refuses to compute; nothing in `money.ts` formats. The division of labour is
unchanged — this module does the arithmetic, `format.ts` renders the result.

Two functions are added there rather than in the view module, because both are about a *column*:

- `sumMoney` totals a column of nullable decimal strings and reports `{ amount, known, total }`.
  Skipping nulls is what `sum(value)` does in SQL; counting them anyway is what stops the omission
  being silent (§8.2).
- `compareDecimal` orders two money strings exactly, nulls last in both directions. **Not a string
  compare**, which sorts `"9.0000"` above `"10.0000"`. **Not `toPlotValue`**, which `format.ts`
  reserves for chart geometry and documents as the one sanctioned float: a pixel coordinate can
  afford to be approximate and a sort key cannot, since two positions a hundredth of a cent apart
  would then swap places between renders. Nulls sort last rather than as zero for the same reason
  they render as an em dash rather than as `$0.00` — an unpriced holding is not a worthless one.

### Group rows inside one table, not a panel per group

A grouped view is one `<table>` whose `<tbody>` per group carries a group header row and a subtotal
row, not a stack of panels each containing its own table.

**Separate tables get independent column widths.** Browser table layout is per-table, so a panel
holding two rows and a panel holding forty size their columns differently and the value column stops
lining up down the page — on a screen whose entire job is comparing figures in a column. One table
also keeps the sort a property of the table rather than of each panel, keeps one header row on
screen rather than one per group, and leaves `.data-table`'s existing tokens doing the work with no
new component.

### Share on subtotal rows only

A subtotal carries its share of the portfolio. A holding row does not.

**The denominator is the gross positive total**, the one `allocation.ts` derives at length: the net
total explodes where debts nearly cancel assets (a $500k house against a $490k mortgage makes the
house 5,000% of the portfolio) and goes negative for a household in net debt, at which point every
asset reports a negative share. The rule and its consequences are already written down in that
module's header and are not restated in a second place — this screen imports the rule.

A per-row percent column would apply that same reasoning to hundreds of rows for a figure nobody
compares row by row, and would put a negative share on every liability row where the caveat has
nowhere to live. On subtotals there are a handful of numbers, and one line of prose beside them can
say what they are a share of.

### Three coverages, because they genuinely differ

The screen reports value coverage, cost-basis coverage and unrealized coverage separately.

`costBasis` is null whenever a statement omitted it, which 401k statements routinely do; `price` is
null only when an instrument has never been quoted. So a portfolio can be 12-of-12 priced and
4-of-12 cost-based, and `unrealized` — null when either side is unknown — follows the narrower of
the two. Reporting one coverage over a table carrying all three figures would be right about at most
one column, and §8.2's rule is "sum what is known and label the coverage", per figure.

### State in the URL, over a GET form

Filters, grouping and sort are query parameters read by the loader. No `useState`, no
`useSearchParams` — the application has zero React hooks today and this screen does not introduce
the first one.

- **The controls are a `<form method="get">`** with a submit button, so the whole screen works with
  JavaScript disabled and the browser does the serialisation. Sort headers and the grouping control
  are links, following Overview's segmented range control exactly.
- **Unknown or hostile parameter values are ignored, never thrown on.** A value that is not one of
  the seven dimensions, or an id that names nothing, drops out of the filter set and the page
  renders unfiltered. A URL is user input arriving from a bookmark, a shared link, or a crawler; a
  500 on `?group=<script>` would be the page's own doing, and `valuation.server.ts` already sets
  this posture with `isAccount`, which turns a non-numeric id into a predicate matching nothing
  rather than into a database error.
- **The default state carries no parameters**, so `/holdings` is the unfiltered table and every
  control's "off" position is a link back to a bare path — the same shape as Overview's default
  range.

### The mobile reflow is CSS over one DOM tree

§8.1 wants cards on mobile; §11 forbids hiding anything on a phone. Both are satisfied by rendering
one table and reflowing it below 768px with the existing breakpoint, so the phone gets card-shaped
rows with each cell labelled, and no second render path can drift from the first.

**Tap-to-expand is deferred.** §8.1 asks for "a card list with a few fields visible and
tap-to-expand". A `<details>` element cannot wrap a `<tr>` — the disclosure would have to live
inside one cell or the table would have to become a list of divs on mobile only — and there is no
client JS to do it otherwise. Showing every field on the card is the honest version of the same
requirement: it costs vertical scroll, which a phone is good at, rather than hiding a column, which
§11 forbids. When the app gains its first client-side interaction, this is a good candidate for it.

### `holdingNote` is extracted

`app/routes/account.tsx` has a private `holdingNote` that renders the asset class and any
qualification of the price — "never priced", "price is stale" — as one middot-joined string.
Holdings needs exactly the same sentence on exactly the same rows.

**It moves to a module both routes import.** Two copies would be two vocabularies for one fact, and
the way that surfaces is a family member seeing "never priced" on the account page and something
subtly different on Holdings for the same holding, and reasonably concluding they are different
states. This is the same argument §8.2 makes about queries, applied to words.

## Testing Decisions

### What makes a good test here

The whole slice is a pure function from `ValuedHolding[]` and a set of URL parameters to rows,
groups and subtotals. Tests should exercise exactly that, and never a database.

- **Every money assertion is an exact decimal string** — `'12345.6700'`, never `toBeCloseTo`. This
  module adds money outside SQL, and the entire justification for allowing that is that it is exact;
  a tolerant assertion tests something other than the property that matters.
- One behaviour per test, named for the rule — "a filter matching nothing is not an empty
  portfolio", not "buildHoldingsView returns rows".
- Fixtures are built by a local `holding()` helper with overrides, as `tests/allocation.test.ts`
  already does, so a test names only the fields it is about.
- The hostile-input cases are written as the URL strings a browser would actually send, so that the
  parsing and the defaulting are tested together rather than the parser being tested against values
  it would never receive.

### The seam

**`app/lib/holdings-view.ts` and `app/lib/money.ts`**, both pure over `ValuedHolding[]`, both with
no import of anything server-side. Filtering, the discriminating-control rule, grouping, subtotals,
coverage and sorting are all reachable from the first; the arithmetic and the ordering from the
second. Neither needs Postgres, a fixture builder, or a running app.

**Prior art is `tests/allocation.test.ts`**, whose header makes exactly this argument for exactly
this reason: `allocation.ts` is pure by design because it groups rows the query layer already
returned, so its tests are unit tests with a fixture function rather than a fixture builder, and
they run without a database. This slice is the same shape one size larger, and it inherits the same
posture — including the part of that header about pinning the arithmetic, not just the grouping.

The route itself gets no separate test seam. It reads parameters, calls `currentHoldings()`, calls
the view builder and renders; asserting that a loader called a function tests React Router. The one
thing worth an integration-shaped test is that a real `currentHoldings()` result feeds the builder
without a shape mismatch, and that is a type-level guarantee already.

### What gets tested

Through the view builder:

- **Filtering.** Each of the seven dimensions narrows the rows; two filters combine as an AND; a
  filter naming a value absent from the data yields zero rows rather than every row; an unknown
  dimension name is ignored and the table renders unfiltered.
- **Discrimination.** A dimension with one distinct value offers no control; the same dimension with
  two offers both; options are drawn from the loaded rows rather than from a fixed list; the option
  set narrows as other filters narrow the rows.
- **Grouping and subtotals.** Grouping by each dimension produces the expected groups; a subtotal is
  the exact decimal sum of its rows, asserted as a string, including a case where a float sum would
  drift; groups are ordered largest first with a deterministic tie-break; every row appears in
  exactly one group.
- **Coverage.** Value coverage and cost-basis coverage diverge on a portfolio where a holding is
  priced with no cost basis; unrealized coverage follows the narrower one; a group whose every
  holding is unpriced reports zero known over a non-zero total rather than a `0.0000` valuation.
- **The gross-positive denominator.** A portfolio containing a liability: the positive subtotals'
  shares sum to `1.000000`, the liability's share is negative, and a household in net debt does not
  produce positive shares for its debts or negative ones for its assets.
- **Sorting.** A value column sorted descending puts `10.0000` above `9.0000`; negatives sort below
  every positive rather than by magnitude; nulls sort last in both directions; ties break
  deterministically so two renders of the same data give the same order.
- **Empty and empty-ish.** No holdings at all, versus a filter combination matching nothing — the
  two are distinguishable in the builder's output, not only in the copy the route chooses.
- **Hostile input.** `?group=` with an unknown value, a filter parameter repeated, an id that is not
  digits, an absurdly long value: each is ignored and none throws.

Through `money.ts`: rounding half away from zero at the money scale, a sum of many rows staying
exact at six figures, `compareDecimal` against the 9-versus-10 case, negatives, and nulls.

### Prior art

`tests/allocation.test.ts` for the shape and the exactness. `app/lib/allocation.ts` for the
denominator rule the subtotals reuse. `tests/format.test.ts` for the convention of asserting on
rendered strings rather than on numbers. Nothing new is needed in `tests/support/` — this slice's
tests touch no database, which is the point of choosing this seam.

## Out of Scope

- **Free-text search over symbol or name.** The dimension filters cover the questions §8.1 names;
  search is a different control with its own matching and ranking questions, and §13.7's scepticism
  about controls that cannot discriminate applies to it until a household's table is long enough to
  need it.
- **Saved views and persisted filter state** (§8.3). The design is explicit that this table is ~70%
  of the view builder and that persisting its state is most of the rest. This slice ships the 70%;
  it does not start the builder.
- **A measure picker** (§8.3). The column set is fixed. Choosing measures is the other part of the
  builder's remaining work.
- **CSV or spreadsheet export.** Nothing in the design asks for it, and it would be the first export
  path in the app.
- **Tap-to-expand mobile cards** (§8.1). Deferred with a reason, above: a `<details>` cannot wrap a
  `<tr>` and there is no client JS. Every field is shown instead, which hides nothing (§11).
- **Closed accounts.** `holding_valued` filters them out with `WHERE closed_at is null` (§8.2), so
  an "include closed" toggle is not a filter over these rows — it needs new SQL, which is the one
  thing this slice refuses to add.
- **As-of and statement-date columns, and price source.** They exist in the view but not on
  `ValuedHolding`, so surfacing them per row means widening the shared type and every consumer of
  it. The page-level as-of timestamp from 0002 stays and is enough for freshness.
- **Day-change per holding.** No prior-close column exists anywhere in the schema; there is nothing
  to subtract from. §13.7 already removed the mock's per-row change figures for this reason.
- **The manual balance edit on the account row** (§8.4). §8.4 wants it reachable from Holdings; it
  lives on the account detail page today, which every account cell links to, so it is one hop away.
  Putting a write form inside a filterable, groupable, sortable table is a slice of its own.
- **Multi-currency** (§14.6). Refused at the schema level; every figure here is USD by construction.
- **Any change to `holding_valued` or `holding_valued_at`** (§8.2). The view already exposes every
  dimension this screen needs. A filter that seems to need a view change is a filter that has left
  the mitigation.

## Further Notes

**Contradicts nothing in `docs/adr/`** — that directory still does not exist, and neither does
`CONTEXT.md`. This spec uses DESIGN.md's vocabulary: *dimension*, *measure*, *coverage*, *grouping*,
*classification*, *asset class*. One term is used here that the design does not name and a future
glossary should pick up: a **discriminating filter** — a control offered only where the dimension
has at least two distinct values in the loaded rows.

**Four decisions in this spec extend DESIGN.md rather than implementing it**, and are worth noticing
on review:

1. **Seven filter dimensions rather than §8.1's four.** The three added — institution, account kind,
   asset class — are in §8.3's `Dimension` union and are already columns on rows already loaded. If
   this is wrong, the correction is to hide three `<select>` elements, not to restructure anything.
2. **`instrument` is dropped from §8.3's eight.** Grouping a holdings table by instrument is the
   ungrouped table, and filtering by it is a search box. Adopting it would mean shipping the control
   before the feature it belongs to.
3. **§13.7's refusal of account search is read as a rule about discrimination.** The design refused
   one specific control; this spec generalises the reasoning into "offer a filter only where it can
   tell rows apart" and applies it to all seven. The alternative reading — that any filter over a
   small household is unwarranted — would refuse this whole screen, which §8.1 asks for by name.
4. **Share appears on subtotals only.** §8.3 lists `pct_of_total` as a measure without saying at
   what granularity. Restricting it to group rows keeps the negative-denominator caveat in one place
   beside a handful of figures instead of on every liability row.

**The `money.ts` extraction is a refactor inside this slice, not a separate one.** It touches
`allocation.ts` and nothing else, its tests are the ones already passing, and doing it here is what
keeps this slice from being the moment a second money-rounding implementation entered the codebase.
A reviewer should treat a copied `toUnits` anywhere as the defect it would be.

**The design brief for the UI ticket is `docs/design/holdings-ui-brief.md`**, on the pattern
`docs/design/pricing-ui-brief.md` set for 0002. The Stitch mock set is of no help here:
`docs/research/2026-08-19-stitch-screen-audit.md` records that the twelve screens carry no filter
controls, no grouped table, no empty state and no stale indicator, and §13.7 lists what else in them
is a different product.

**The screenshots contract applies.** `docs/screenshots/README.md` states that these images are the
one thing in the repository that can silently go stale, and that **a change to a screen is not
finished until they are retaken**. `holdings-*.png` currently records the stub *on purpose* — the
README keeps it "so that the day Holdings is built, the before is on record". That day is this
slice: `holdings-light.png` and `holdings-dark.png` must be retaken against the demo household at
the documented viewport, and a mobile pair is worth adding since this is the screen whose mobile
shape §8.1 singles out. The root README describes Holdings in words rather than showing it, for the
stated reason that a screenshot of a stub sells nothing; that sentence can go when the screenshot is
real.
