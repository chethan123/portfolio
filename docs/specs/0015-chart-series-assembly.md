# One series assembly for both chart surfaces

Canonical here. Implements [issue #156](https://github.com/chethan123/portfolio/issues/156), which
records the evidence; when the two disagree, this file wins.

See [ADR-0003](../adr/0003-anchored-geometric-chart-sampling.md) for the sampling that picks the
dates, [ADR-0006](../adr/0006-intraday-quotes-are-an-observation-log.md) for why 1D is a second
front rather than a finer grid, and [ADR-0008](../adr/0008-the-owner-filter-is-a-household-wide-view.md)
for why every household-scoped read names whose money it is reading.

## Problem Statement

`app/lib/chart-range.ts` deepened once already: spec 0008 pulled the range vocabulary out of two
routes and made `Surface` a parameter. Everything *downstream* of the window that module resolves
is still written twice, step for step, in `app/routes/overview.tsx` and `app/routes/account.tsx`.

Both routes declare a private `isoDate`, and so does `chart-range.ts`, and so does
`net-worth-chart.tsx`. Both register the range middleware under the same docstring, call
`readChartRange`, clock `today`, read their earliest date and the latest observed session together,
call `resolveRange`, branch on `resolved.session === undefined` to choose between a date-series
reader and a session-series reader, filter the result on `coverage.total > 0` while renaming `at`
to `date`, and assemble the same payload block of `range`, `custom`, `session`, `rangeOptions`,
`customMin` and `customMax`.

Two of those are worse than repetition.

**The coverage filter is a domain rule stated as route code.** ARCHITECTURE.md §6.3: "An account
with no position set at or before a date contributes **no rows** — not a zero. Callers read
`coverage.total` rather than the amount to decide where a line begins, so a chart starts where
history starts instead of climbing out of a fictional zero." That sentence is the whole reason the
filter exists, and it is spelled character-for-character in two loader bodies with a
separately-worded comment above each. A third chart surface would spell it again, or forget to and
draw a fictional climb out of zero with nothing failing.

**Nobody owns 1D.** `chart-range.ts` decides whether 1D resolved; the two loaders decide which
reader that implies; `valuation.server.ts` decides how a session is priced; `net-worth-chart.tsx`
decides how a session instant is labelled. `asSessionPoints` exists in `valuation.server.ts` for no
reason except to make the two loaders' ternaries type-check, and its own docstring says why — "a
rule copied into two loaders drifts" — which is the argument that has not yet been applied to the
ternary it serves.

The consequence for tests is the one `docs/developing.md` already names: "If what you want to test
lives inside a loader body, the fix is to move it out." Today the assembly is reachable only
through full loader invocations in two route test files, so the rule that a line starts where
history starts is asserted incidentally, by two screens, rather than directly, once.

## Solution

The seam extends one step down the pipeline, and it splits along the `.server` boundary that
stopped spec 0008 where it stopped.

**`app/lib/chart-range.ts` gains `chartWindow`** — pure, no database, still in the client bundle.
It reads the requested range off the request, resolves it, and returns both the resolved window and
the payload block the range control and the chart consume. Everything it composes already lives in
this file. It takes the market time zone as an argument rather than reading configuration, which is
what keeps it pure and testable without a database; both routes already spell
`getConfig().MARKET_TIMEZONE` for `asOfView`, so nothing new appears in either.

**`app/lib/chart-series.server.ts` is new**, and owns the reads. Two entry points:

1. **`chartReach(scope)`** — how far this surface's chart can reach: the surface's own earliest
   recorded date, and the latest observed session. One `Promise.all`, so the surface rule (an
   account measures from its own first statement, never the household's) has one home.
2. **`chartSeries(scope, resolved)`** — picks the reader the window implies, applies the
   `coverage.total > 0` rule, and hands back plottable points.

`ChartScope` is the one value that says which surface is being read *and* what narrows it:

```ts
export type ChartScope =
  | { surface: "household"; reading: OwnerFilter }
  | { surface: "account"; accountId: string };
```

What stays in the loaders is what is genuinely asymmetric: the Overview's hand-typed prefix merge,
its `manualWithheld` note, and the rule that a filtered chart cannot reach behind the selected
owners' first statement — the account surface has no manual series at all. Each route keeps its own
404 or redirect gate, and its own clock line.

## User Stories

**1.** As a reader opening the Overview, I want the line to start where the household's history
starts, so that I am not shown a climb out of a zero nobody recorded. Unchanged on screen; the rule
that produces it now lives in one module, and a test names it directly instead of inferring it from
a dashboard's output.

**2.** As a reader opening an account page, I want its line to start at that account's own first
statement, so that it does not claim a past the account did not have. Unchanged on screen; the
account's earliest-date rule and the household's are two branches of one function rather than two
loaders that happen to call different readers.

**3.** As a reader picking 1D on either screen, I want the session drawn the same way on both, so
that the two screens cannot disagree about what a session is. Unchanged on screen; which reader a
session window implies is decided once, in the module that reads, rather than inferred from
`resolved.session` by each loader in turn.

**4.** As a reader narrowing the Overview to one owner, I want the same line and the same note
about withheld pre-app history, so that the refactor is invisible. The narrowing still travels as a
required, undefaulted argument a reviewer can see on the call line.

**5.** As whoever adds a third chart surface, I want to pay for one function's arguments rather
than for every step again, and I want to be unable to omit the coverage rule, because I do not
write the filter.

## Implementation Decisions

**`chartWindow` is pure and lives in `chart-range.ts`.** It takes the surface, the request, `today`,
the surface's earliest dates, the latest observed session and the market time zone; it returns
`{ resolved, controls }`. `resolved` is the existing `RangeWindow`, returned rather than hidden
because both loaders still need it — the Overview reads `resolved.since` for `netWorthChange` and
bounds its hand-typed prefix by it, and `resolved.session` decides whether that prefix is drawn at
all. It is named `resolved` and not `window` in both the return and the loaders, which is what they
call it today and which keeps a route module from shadowing the DOM global under `lib: ["DOM"]`.

**`controls` is the payload block, spread into each loader's return.** Its fields are `range`,
`custom`, `session`, `rangeOptions`, `customMin` and `customMax`, with exactly the names, types and
values both loaders return today — `custom` still `undefined` rather than absent off a custom
range, `customMax` still the `today` that was passed in. The payload contract does not change,
which is what keeps every existing route test honest about behaviour rather than about the refactor.

**`chartWindow` takes `Surface`, not `ChartScope`.** It reads nothing, so it narrows nothing, and a
required `reading` on it would claim a narrowing that never happens — the signature saying more
than the code does, which is worth less than saying nothing. The scope is for the module that reads.

**`chartReach` returns how far a surface's chart can reach.** `positionSet` is
`firstRecordedDate(scope.reading)` on the household surface and
`accountFirstRecordedDate(scope.accountId)` on the account one; `session` is
`latestObservedSession()`, which takes no filter and is the same value on both surfaces — an
account holding nothing the feed quotes still draws its flat line at the household's observed
instants (`valuation.server.ts` says so where `readSessionSeries` takes its instants from the log
as a whole).

**The Overview reads `manualNetWorth()` in the same wave as the reach, and this is why the module
has two entry points rather than one.** The Overview's `earliest.manual` is not an anchor: it is
`manualNetWorth()`'s first point, emptied when the filter is on, computed in the loader. So the
loader must have both `manual` and the reach before it can size a window, and it must get them in
one round trip:

```ts
const [manual, reach] = await Promise.all([manualNetWorth(), chartReach(scope)]);
```

That is a requirement on the loader, not an accident of it — written as two sequential `await`s it
is two waves where the code today has one. The account loader has no manual series and simply
awaits `chartReach(scope)`.

**`chartSeries` returns a promise the caller drops into its own `Promise.all`.** Both loaders create
their series promise before the `Promise.all` that gathers the rest of the page, so the read runs
beside three or four unrelated ones; `chartSeries(scope, resolved)` slots into that position
unchanged. Nothing about either loader's round-trip count moves.

**`chartSeries` is where the coverage rule lives, and it is stated once.** A private reader answers
the 2×2 table — household or account, dated or session — and normalises the dated shape into the
session one, because widening a date into an instant field is honest where narrowing an instant
would throw away the time of day the session line exists for. `chartSeries` then applies §6.3's
rule and renames the field the chart reads:

```ts
const points = await readPoints(scope, resolved);

return points
  .filter((point) => point.coverage.total > 0)
  .map((point) => ({ date: point.at, amount: point.amount }));
```

**`asSessionPoints` is deleted from `valuation.server.ts`.** Its body is the normalising `.map`
above and its only reason to be exported was to reconcile two loaders' ternaries. With one ternary
it has one caller, inside `chart-series.server.ts`, and belongs there. `SessionPoint` stays
exported — it is still the session readers' return type.

**The owner filter stays visible in review, and the documents that say how it travels must be
amended.** §4.2 says `owner-reading.server.ts` deliberately does not call the household-scoped
readers itself, leaving the obligation on callers "so whose money a loader reads stays visible in
review rather than hidden inside this one". That property is kept: `reading` is a required field of
a required argument,
`chartSeries({ surface: "household", reading }, resolved)` names it at the call site, and
TypeScript refuses the call without it. What changes, and what the documents must now say, is that
the filter travels as a *field of the scope* rather than as "a required first argument with no
default", and that three household-scoped reads — `firstRecordedDate`, `netWorthSeries` and
`netWorthSessionSeries` — are now made by a module the loader names its reading to, rather than by
the loader directly. "One module values holdings" is untouched: the new module compares
cardinalities and values nothing.

**`ChartPoint` and `SessionAxis` move down to `chart-range.ts`, and the file's remit is restated.**
`chartSeries` constructs the first and `chartWindow` constructs the second, and both are consumed by
`net-worth-chart.tsx`. Leaving them in the component would make a domain module type-import from a
component — no module in `app/lib` imports from `app/components` today, and this change should not
open that direction — while declaring the shapes again in the lib would be a second copy of each.
Moving them to the pure module both sides already depend on leaves every import pointing down.
`net-worth-chart.tsx` type-imports both and `tests/net-worth-chart.test.tsx` type-imports
`ChartPoint`; `import type` is erased under `verbatimModuleSyntax`, and no runtime edge to a
`.server` module appears anywhere. What `chart-range.ts` then holds is no longer the chart's *range*
vocabulary but its *time* vocabulary — a range, the window it resolves to, the points on that
window, and the axis that labels them — and both the file's own header and its Appendix A row have
to say so.

**The middleware export stays per-route; its docstring shrinks to a pointer.** React Router
requires `export const middleware` on the route module, so the export itself cannot be shared. The
duplicated lines above it can, and already do, point at `chartRangeMiddleware`'s own docstring —
one line each is enough.

**`isoDate` is exported from `chart-range.ts` and the other copies are deleted**, in both routes and
in the chart component. Deleting the routes' copies leaves their `type IsoDate` import from
`valuation.server.ts` with no user; it goes too.

**The empty note converges on its 1D branch only.** The sentence a session with one observed moment
renders is byte-identical in both routes, under a byte-identical inner guard, under a
separately-worded comment making the same argument. That branch becomes one component,
`ChartEmptyNote`, exported from `net-worth-chart.tsx`, taking the session, the point count, and each
route's own fallback as children. The *outer* guards stay in the routes and differ, correctly: the
Overview draws a line when its computed and hand-typed points together reach two, an account when
its computed points do. The fallbacks do **not** converge and must not: the Overview's speaks about
the instance and offers one remedy, the account's speaks about the range and offers two, and only
the account's is reachable with no points at all — the Overview's chart panel is not rendered on an
instance with no holdings. The issue's "the empty-note prose converges to one wording" is true of
the session sentence and false of the fallback; only the true half is done.

**Nothing about the numeric boundary changes.** No money value is parsed, summed or compared in
either module; amounts pass through as the decimal strings the readers return. `format.ts`'s
`toPlotValue` remains the one place a plotted value is floated, in the component (§5.6).

## Documents this change makes false

Each of these states, today, something that stops being true, and each is part of the change rather
than a follow-up:

- `docs/specs/README.md` — a row for this spec, in the table that carries one per numbered spec.
- `ARCHITECTURE.md` §4.2, the "Whose money a screen is reading" row — the owner filter is no longer
  "a required first argument with no default" on *every* household-scoped read; on the chart's three
  it is a required field of a required argument instead. §6.3 states the same rule again and needs
  the same amendment.
- `ARCHITECTURE.md` §4.2, the owner-reading row — the obligation it puts on callers, to take the
  filter by hand and pass it to the reader, is now discharged one step further out.
- `ARCHITECTURE.md` §6.3 — the screen/read/shape table, where the Overview's and the account page's
  chart series reads are attributed to the routes.
- `ARCHITECTURE.md` Appendix A — a row for `chart-series.server.ts`, and the `chart-range.ts` row,
  which describes a file that now holds more than a range vocabulary.
- `app/lib/chart-range.ts`'s module header, for the same reason.
- `app/lib/owner-reading.server.ts`'s module docstring, which says the household-scoped reads stay
  in the loader.

Appendix A's `owner-reading.server.ts` row is deliberately *not* on this list: a screen's own
`currentHoldings` and `netWorth` calls do stay in its loader, the Overview's included. Only the
chart's reads move.

## Testing Decisions

**A new `tests/chart-series.test.ts`, database-backed, is the read seam's own test file.** It seeds
through `tests/support/fixtures.ts` and wraps every body in `withDatabase`, per house style. It
asserts only what nothing asserts today:

- A date before the first position set is dropped from the line, on both scopes, and the point that
  survives carries the amount the reader reported. The reader-level half of this rule is already
  covered in `tests/dashboard-queries.test.ts`; what is not covered anywhere is that the assembly
  acts on it.
- An account scope draws that account's line and no other's.
- The window decides the reader: a seed where a session and a date range would answer differently,
  read both ways, gets the right answer each time. Asserted on output, because the house style has
  no spies.

The narrowing rules and the 1D window's own resolution are already tested at their own seams
(`tests/valuation-owner-filter.test.ts`, `tests/chart-range.test.ts`) and are not restated here.

**`chartWindow` is tested in `tests/chart-range.test.ts`**, which needs no database. One case per
surface that the returned `controls` is the block a loader spreads, including `session: null` off
1D and `customMin` measured from the surface's own earliest date.

**The existing route tests are not edited.** The loader payload keeps every key, name and value
shape it has today, so `tests/routes/overview.test.ts` and `tests/routes/account.test.ts` pass
untouched. That is the acceptance criterion that says this is a refactor: a green suite with zero
diff in those two files is evidence the screens did not move. Their assembly-level tests — the
manual-prefix overlap rules, the 1D session tests on both screens — stay where they are; they now
assert integration, which is what a route test is for.

**`ChartEmptyNote` gets one case.** The sentence it renders is asserted nowhere today, which is why
it could be duplicated without anything failing. A `renderToStaticMarkup` assertion in
`tests/net-worth-chart.test.tsx` that a session with one point renders the waiting sentence and a
session with none renders the caller's fallback closes that.

**`npm run build` is a required gate, not an optional one.** Vitest does not load the React Router
plugin, so a `.server` module pulled into the client graph is invisible until the build runs. The
type moves in this change are precisely the shape that would go unnoticed otherwise.

## Out of Scope

- **Any change to what a chart draws.** No new range, no new sampling, no change to how a session
  is priced or labelled. A screenshot before and after is identical.
- **The 1D labelling split.** `net-worth-chart.tsx` keeps `tickLabel` and `readoutDate` and keeps
  importing `market-hours.ts`. Moving presentation rules into a `.server` module would trade one
  split for a worse one; that 1D has one owner *on the read side* is the whole of what this ticket
  claims.
- **Issue #83** (a partially-priced past date drawn as an ordinary solid line). Coverage-adjacent,
  and easier to fix once the coverage rule has one home, but it is a behaviour change with its own
  ticket.
- **`netWorthChange`'s documented disagreement with the 1D line** over what `since` means. It stays
  exactly as documented; this ticket moves no arithmetic.
- **The account page's `uploadReceipt` read**, which is serial today and left so.
- **A CONTEXT.md entry for "coverage" or "series".** Terms are added when one is actually resolved.
  Nothing here resolves a dispute about either word.

## Further Notes

The deepening this ticket performs is the same one spec 0008 performed on the range vocabulary, one
step further down the pipeline, and it is worth naming why the first step stopped where it did:
`chart-range.ts` is pure and in the client bundle, so it could never hold a reader. Splitting the
work across that same boundary — the window assembly staying pure beside the vocabulary it is made
of, the reads going to a new `.server` module — is what lets the window keep a test that needs no
database, and is the reason this is two files rather than one.
