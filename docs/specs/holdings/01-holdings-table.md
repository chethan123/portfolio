# 01 — Every position, filtered and grouped

_Part of [0003-holdings.md](../0003-holdings.md)._

**What to build:** The workhorse (DESIGN.md §8.1). `/holdings` stops counting rows and starts
showing them: every position the household holds, on one screen, filterable on seven dimensions,
groupable by any of them with subtotals, sortable on every column, and honest about the holdings it
could not value. No new query — `currentHoldings()` already returns every dimension this filters on,
and a filter here is a predicate over the shared view rather than the fourth hand-rolled dashboard
query §8.2 warns about. The grouping is what absorbs the four pages §8.1 decided not to build: by
person, by account, tax view, unrealized are this table with the grouping changed.

Two extractions come with it. `app/lib/money.ts` takes the digit-level primitives that are private
to `allocation.ts` today, so that subtotals and the money sort reuse the one implementation of
decimal arithmetic instead of copying it — which is what makes "money arithmetic in JavaScript stays
exactly one module wide" structural rather than a comment. And `holdingNote` leaves
`app/routes/account.tsx` into a module both routes import, so Account detail and Holdings cannot
drift on what "never priced" reads as.

Note for whoever picks this up: the Stitch mock set has no filter controls, no grouped table and no
empty state, and §13.7 lists what else in it belongs to a different product. The design brief for
this ticket is `docs/design/holdings-ui-brief.md`. And per `docs/screenshots/README.md`, a change to
a screen is not finished until the screenshots are retaken — `holdings-*.png` currently records the
stub deliberately, and this is the ticket that replaces it.

**Blocked by:** Nothing. The query layer landed in 0001 and pricing landed in 0002.

**Status:** ready-for-agent

**The table**

- [ ] `/holdings` renders one row per holding from `currentHoldings()`, with no new SQL anywhere in
      the slice
- [ ] Each row carries instrument (symbol and name), account, institution, owner, tax treatment,
      classification, quantity, price, value, cost basis and unrealized gain
- [ ] The account cell links to that account's detail page, which is where the manual balance edit
      §8.4 wants from here already lives
- [ ] Money and quantity cells are right-aligned tabular figures rendered through `format.ts`, and
      no cell computes anything
- [ ] A null price, cost basis or unrealized renders as an em dash, never as `$0.00`
- [ ] A total for the rows currently displayed sits above the table, with its coverage

**Filtering**

- [ ] Person, account, institution, account kind, tax treatment, classification and asset class are
      each offered as a filter
- [ ] `instrument` is deliberately not offered — a filter over the thing each row is, is a search
      box, and search is out of scope
- [ ] A dimension's control renders only when the loaded rows hold at least two distinct values for
      it, so a one-person household is never asked to choose between one person
- [ ] Each control's options are the values present in the rows, not every value on record, so no
      option can produce an empty table
- [ ] Two or more filters combine as an AND, so "everything Priya owns at Fidelity" is one view
- [ ] Every figure above the table describes the filtered rows, never the whole portfolio
- [ ] A "clear filters" affordance returns to the unfiltered table and is absent when nothing is
      filtered

**Grouping and subtotals**

- [ ] Any dimension that can be filtered on can be grouped by, and the ungrouped table is the
      default
- [ ] A grouped view is one `<table>` with a group header row and a subtotal row per group — not one
      panel per group, whose independent column widths would stop the value column lining up
- [ ] A subtotal is the exact decimal sum of the rows in its group, computed through `money.ts` and
      never through a float
- [ ] Each subtotal row shows the group's share of the portfolio, against the gross positive total
      `allocation.ts` derives, with the caveat said in words beside the table
- [ ] Groups are ordered largest first with a deterministic tie-break, so two renders of the same
      data give the same order
- [ ] Every row appears in exactly one group, including rows whose dimension value is unusual

**Sorting**

- [ ] Every column is sortable, ascending and descending, from its header
- [ ] Money columns sort through `compareDecimal` — never a string compare, which puts `"9.0000"`
      above `"10.0000"`, and never `toPlotValue`, which `format.ts` reserves for chart geometry
- [ ] Negative values sort below every positive rather than by magnitude, so a liability lands at
      the bottom of a descending value column
- [ ] Null values sort last in both directions, because an unpriced holding is not a worthless one
- [ ] The active sort column and direction are visible in the header and announced to assistive
      technology
- [ ] Sorting inside a grouped view sorts the rows within each group and leaves the group order to
      the subtotals

**Coverage and honesty**

- [ ] A never-priced holding is listed, contributes nothing to any subtotal, and says so on its row
- [ ] Value coverage and cost-basis coverage are reported as separate counts, because a 401k holding
      is routinely priced with no cost basis
- [ ] Unrealized coverage follows the narrower of the two rather than being asserted as complete
- [ ] A stale price is shown with its last known value and reads differently from one that never
      existed (§6.2)
- [ ] The words on a row come from the shared `holdingNote`, so this screen and Account detail say
      the same thing about the same holding
- [ ] The page-level as-of timestamp from 0002 is present, since this screen shows figures (§11)

**Empty states**

- [ ] An instance with no holdings shows the first-run empty state and no figure at all — a zero and
      an empty instance must not look alike (§8.4)
- [ ] A filter combination matching nothing says so in those terms, and is visibly different from an
      empty instance
- [ ] That state offers a way back to the unfiltered table without editing the URL
- [ ] A group containing only unpriced holdings shows its coverage rather than a `$0.00` subtotal

**Mobile**

- [ ] Below the existing 768px breakpoint the same DOM reflows into card-shaped rows, with no second
      render path
- [ ] Every field on the desktop row is present on the card — nothing is hidden on a phone (§11)
- [ ] Group headers and subtotals stay visible in the reflowed view
- [ ] The page does not scroll horizontally on a 390px viewport

**State in the URL**

- [ ] Filters, grouping and sort are query parameters read by the loader, with no React state and no
      new hook
- [ ] The controls are a `<form method="get">`, so the screen works with JavaScript disabled
- [ ] A filtered, grouped, sorted view is linkable and bookmarkable, and the back button returns to
      the previous view
- [ ] The default state carries no query parameters, so `/holdings` is the unfiltered table
- [ ] An unknown, repeated, absurdly long or otherwise hostile parameter value is ignored and the
      page renders — never a 500
