# One series assembly for both chart surfaces

Canonical here. Published to the tracker as [issue #156](https://github.com/chethan123/portfolio/issues/156)
so an agent can pick it up from there; when the two disagree, this file wins.

See [ADR-0003](../adr/0003-anchored-geometric-chart-sampling.md) for the sampling that picks the
dates, [ADR-0006](../adr/0006-intraday-quotes-are-an-observation-log.md) for why 1D is a second
front rather than a finer grid, and [ADR-0008](../adr/0008-the-owner-filter-is-a-household-wide-view.md)
for why every household-scoped read names whose money it is reading.

## Problem Statement

`app/lib/chart-range.ts` deepened once already: spec 0008 pulled the range vocabulary out of two
routes and made `Surface` a parameter. Everything *downstream* of the window that module resolves
is still written twice, step for step, in `app/routes/overview.tsx` and `app/routes/account.tsx`.

Both routes: declare a private `isoDate` (a third copy lives inside `chart-range.ts`, a fourth
inside `net-worth-chart.tsx`); register the range middleware under an identical four-line
docstring; call `readChartRange` and clock `today`; read their earliest date and the latest
observed session in a `Promise.all`; call `resolveRange`; branch on `resolved.session === undefined`
to pick between a date-series reader and a session-series reader; filter the result on
`coverage.total > 0` and rename `at` to `date`; and assemble the same six-field payload block
(`range`, `custom`, `session`, `rangeOptions`, `customMin`, `customMax`).

Two of those are worse than repetition.

**The coverage filter is a domain rule stated as route code.** ARCHITECTURE.md §6.3 ends: "An
account with no position set at or before a date contributes **no rows** — not a zero. Callers read
`coverage.total` rather than the amount to decide where a line begins, so a chart starts where
history starts instead of climbing out of a fictional zero." That sentence is the whole reason the
filter exists, and it is spelled character-for-character in two loader bodies with a
separately-worded comment above each. A third chart surface would spell it a third time, or forget
to, and draw a fictional climb out of zero with nothing failing.

**Nobody owns 1D.** `chart-range.ts` decides whether 1D resolved; the two loaders decide which
reader that implies; `valuation.server.ts` decides how a session is priced; `net-worth-chart.tsx`
decides how a session instant is labelled, importing `market-hours.ts` for it. `asSessionPoints`
exists in `valuation.server.ts` for no reason except to make the two loaders' ternaries type-check,
and its own docstring says why — "a rule copied into two loaders drifts" — which is the argument
that has not yet been applied to the ternary it serves.

The consequence for tests is the one `docs/developing.md` already names: "If what you want to test
lives inside a loader body, the fix is to move it out." Today the assembly is reachable only
through full loader invocations in two separate route test files, so the rule that a line starts
where history starts is asserted incidentally, by two screens, rather than directly, once.

## Solution

A new domain module, `app/lib/chart-series.server.ts`, owns everything between "a request arrived
on a chart screen" and "here are the points to plot, and the fields the range control needs". Both
loaders become thin callers of it.

The module is entered three times, in the order a loader needs, because the loaders' concurrency is
real and must survive:

1. **`chartAnchors(scope)`** — the two reads the window is sized from: the surface's own earliest
   recorded date, and the latest observed session. One `Promise.all`, so the surface rule (an
   account measures from its own first statement, never the household's) has one home.
2. **`chartWindow(scope, opts)`** — synchronous, no database. Reads the requested range off the
   request, resolves it against the anchors, and returns both the resolved window (which the caller
   still needs for its own reads) and the payload block the range control and the chart consume.
3. **`chartSeries(scope, window)`** — picks the reader the window implies, applies the
   `coverage.total > 0` rule, and hands back plottable points. Returns a promise the caller drops
   into its own `Promise.all`, exactly as the loaders create `points` today.

`ChartScope` is the one value that says which surface is being drawn *and* what narrows it:

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

**1. A reader opens the Overview and the line starts where the household's history starts.**
Unchanged on screen. The rule that produces it now lives in one module, and a test names it
directly instead of inferring it from a dashboard's output.

**2. A reader opens an account page and the line starts at that account's first statement.**
Unchanged on screen. The account's earliest-date rule and the household's are two branches of one
function rather than two loaders that happen to call different readers.

**3. A reader picks 1D on either screen.** Unchanged on screen. Which reader a session window
implies is decided once, and the accompanying invariant — a 1D window carries an empty `dates`
array on purpose, so a caller that misses `session` draws nothing rather than the wrong thing — is
enforced by the module that reads, not left to two callers to remember.

**4. A reader narrows the Overview to one owner.** Unchanged on screen, including the note
explaining the withheld pre-app history. The narrowing still travels as a required, undefaulted
argument that a reviewer can see on the call line.

**5. A future third chart surface.** Pays for one function's arguments, not eight duplicated steps
— and cannot omit the coverage rule, because it does not write the filter.

## Implementation Decisions

**The module is `app/lib/chart-series.server.ts`, and it is `.server`.** It value-imports
`valuation.server.ts` and `server/config.ts`, so it cannot be anything else (§4.3). `chart-range.ts`
stays exactly what it is — pure range vocabulary, in the client bundle, imported by
`chart-range-control.tsx` after hydration. The new module imports it; the dependency never runs the
other way.

**`chartAnchors(scope)` returns `{ positionSet, session }`.** `positionSet` is
`firstRecordedDate(scope.reading)` on the household surface and
`accountFirstRecordedDate(scope.accountId)` on the account one; `session` is
`latestObservedSession()`, which takes no filter and is the same value on both surfaces — an
account holding nothing the feed quotes still draws its flat line at the household's observed
instants (ADR-0006). The Overview's third read, `manualNetWorth()`, stays in the loader: it is
unfiltered by design, it feeds the manual prefix as well as the window, and only one surface has
it.

**`chartWindow` takes the `Request`, and `today` as an argument.** Folding `readChartRange` in
removes a duplicated line; clocking `today` inside would make the function untestable without
injecting a clock, and `account.tsx` needs `today` in its payload anyway for the balance form's
date control. So each loader keeps one `const today = isoDate(Date.now())` and passes it. The
private `isoDate` in `chart-range.ts` is exported and the other three copies are deleted.

**`chartWindow` returns `{ window, controls }`.** `window` is `chart-range.ts`'s `RangeWindow`,
returned rather than hidden because both loaders still need it: the Overview reads `window.since`
for `netWorthChange` and bounds its manual prefix by it, and `window.session` decides whether the
prefix is drawn at all. `controls` is the payload block, spread into the loader's return:
`{ range, custom, session, rangeOptions, customMin, customMax }`. The field names and value shapes
are exactly what both loaders return today — the payload contract does not change, which is what
keeps every existing route test honest about behaviour rather than about the refactor.

**The module reads `MARKET_TIMEZONE` itself.** `controls.session` is
`{ timeZone: getConfig().MARKET_TIMEZONE }` on a session window and `null` otherwise. The rule it
encodes — the zone is the market's, never the reader's — is a domain rule, and a domain module
reading config directly has precedent (`uploads.server.ts` reads `MAX_UPLOAD_MB`). The alternative,
passing the zone from each route, keeps a third spelling of `getConfig().MARKET_TIMEZONE` in the
payload block this ticket exists to collapse.

**`chartSeries` is where the coverage rule lives, and it is stated once.** The body is the branch
the loaders spell twice —

```ts
const points =
  window.session === undefined
    ? await readDateSeries(scope, window.dates)
    : await readSessionSeries(scope, window.session);

return points.filter((point) => point.coverage.total > 0).map(({ at, amount }) => ({ date: at, amount }));
```

— with §6.3's argument as its comment, in one place. The two private readers are the 2×2 table
(household/account × date/session) that the loaders currently spell as two ternaries.

**The owner filter stays visible in review.** §4.2 says `owner-reading.server.ts` deliberately does
not call the household-scoped readers itself, so that whose money a loader reads stays on the
loader's own call line. That rule is honoured here rather than broken: `reading` is a required
field of a required argument, `chartSeries({ surface: "household", reading }, window)` names it at
the call site, and TypeScript refuses the call without it. What is hidden is *which reader* the
window implies, which is not a question about whose money is being read.

**`ChartPoint` moves to the new module.** `net-worth-chart.tsx` currently declares
`{ date: string; amount: string }` with the note that `date` holds a calendar date on every range
but 1D, where it holds a full ISO instant. That type is what `chartSeries` constructs, so it moves
beside the rule that constructs it and the component type-imports it. `import type` is erased under
`verbatimModuleSyntax`, and a browser-reachable module type-importing a `.server` one is already
the established shape (`chart-range-control.tsx` type-imports `IsoDate` from `valuation.server.ts`).

**`asSessionPoints` stops being exported.** It exists to reconcile two loaders' ternaries; with one
ternary it is an implementation detail of `chartSeries`. It stays in `valuation.server.ts` beside
the readers it adapts, but private — or, if that leaves it with no in-module caller, it moves into
`chart-series.server.ts`. Whichever, no route imports it afterwards.

**The middleware export stays per-route; its docstring shrinks to a pointer.** React Router
requires `export const middleware` on the route module, so the export itself cannot be shared. The
four duplicated lines above it can, and already do, point at `chartRangeMiddleware`'s own docstring
— one line each is enough.

**The empty note converges on its 1D branch only.** The sentence a session with one observed moment
renders is byte-identical in both routes, under a byte-identical guard, under six lines of
separately-worded comment. That branch becomes one component, `ChartEmptyNote`, exported from
`net-worth-chart.tsx`, taking the session, the point count, and each route's own fallback as
children. The fallbacks do **not** converge and must not: the Overview's speaks about the instance
and offers one remedy, the account's speaks about the range and offers two, and the account's is
the branch a zero-point account falls into while the Overview's screen is unreachable with no
holdings at all. The issue's "the empty-note prose converges to one wording" is true of the
session sentence and false of the fallback; only the true half is done.

**Nothing about the numeric boundary changes.** No money value is parsed, summed or compared in
this module; amounts pass through as the decimal strings the readers return. `format.ts`'s
`toPlotValue` remains the one place a plotted value is floated, in the component (§5.6).

## Testing Decisions

**A new `tests/chart-series.test.ts`, database-backed, is the seam's own test file.** It seeds
through `tests/support/fixtures.ts` and wraps every body in `withDatabase`, per house style. What it
asserts, and what today can only be inferred from a dashboard:

- A date before the first position set is dropped from the line on both scopes, and the point that
  survives carries the amount the reader reported — the §6.3 rule, named directly.
- A household scope narrows to its reading; the same seed read as one owner and as everyone
  produces different lines.
- An account scope draws that account's line and no other's.
- A session window reads the observation log on both scopes, one point per observed instant, and
  never touches the date-series reader; a date window never touches the session reader.
- A window whose range is 1D but whose `session` is absent cannot happen — `chart-range.ts`
  resolves that to the default range — and a window carrying a session plots instants, not the
  empty `dates` array beside it.
- `chartWindow` returns the payload block a loader spreads, for both surfaces, including
  `session: null` off 1D and `customMin` measured from the surface's own earliest date.

**The existing route tests are not edited.** The loader payload keeps every key, name and value
shape it has today, so `tests/routes/overview.test.ts` and `tests/routes/account.test.ts` pass
untouched. That is the acceptance criterion that says this is a refactor: a green suite with zero
diff in those two files is evidence the screens did not move. Their assembly-level tests —
the manual-prefix overlap rules, the 1D session tests on both screens — stay where they are; they
now assert integration, which is what a route test is for, rather than standing in for a unit test
that had nowhere to live.

**`tests/chart-range.test.ts` is not edited either**, except to cover `isoDate` if exporting it
warrants a case. Nothing in the range vocabulary changes.

**`npm run build` is a required gate, not an optional one.** Vitest does not load the React Router
plugin, so a `.server` module pulled into the client bundle — the exact hazard of moving
`ChartPoint` and adding a `.server` import to a component's type graph — is invisible until the
build runs.

## Out of Scope

- **Any change to what a chart draws.** No new range, no new sampling, no change to how a session
  is priced or labelled. A screenshot before and after is identical.
- **The 1D labelling split.** `net-worth-chart.tsx` keeps `tickLabel` and `readoutDate` and keeps
  importing `market-hours.ts`. Moving presentation rules into a `.server` module would trade one
  split for a worse one; that 1D has one owner *on the read side* is the whole of what this ticket
  claims.
- **Issue #83** (a partially-priced past date drawn as an ordinary solid line). It is
  coverage-adjacent and will be easier to fix once the coverage rule has one home, but it is a
  behaviour change and belongs to its own ticket.
- **`netWorthChange`'s documented disagreement with the 1D line** over what `since` means
  (`chart-range.ts`, DESIGN.md §14). It stays exactly as documented; this ticket moves no
  arithmetic.
- **A CONTEXT.md entry for "coverage" or "series".** Terms are added when one is actually resolved.
  Nothing here resolves a dispute about either word.

## Further Notes

The deepening this ticket performs is the same one spec 0008 performed on the range vocabulary, one
step further down the pipeline, and it is worth naming why the first step stopped where it did:
`chart-range.ts` is pure and in the client bundle, so it could never hold a reader. The seam moved
here is the first one that has to be `.server`, which is why it needed its own module rather than
another export on the one that already exists.
