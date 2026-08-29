# 03 — The control, and Overview reading as an owner

_Part of [0013-owner-filter.md](../0013-owner-filter.md)._

**What to build:** The shared `OwnerFilterControl`, mounted first on Overview, with Overview honouring
the filter end to end — headline, delta, chart, rollup, allocation, and the two consequences that
only bite here: the hand-typed prefix disappears, and the chart's reachable past shortens.

Overview goes first because it is the hardest screen and the one that proves the design. It is the
only screen with the manual series, the only one whose headline is the number a stale filter would
silently redefine, and the one where the chart-range control's habit of replacing the whole query
would eat the filter outright.

**Blocked by:** 00, 01 and 02.

**Status:** ready-for-agent

**The control** (`app/components/owner-filter-control.tsx`)

- [ ] A `<form method="get">` of checkboxes plus an Apply button — the `Filters` bar's shape
      (`app/routes/holdings.tsx:571-619`) — a React Router `<Form method="get">`, not a raw
      `<form>` — which is how a GET form changes one thing without resetting the others. The shared
      parts are **extracted from** that bar, not written beside it
- [ ] Works with no JavaScript, like `ChartRangeControl`'s custom-range disclosure
- [ ] Hidden fields re-emit the screen's other non-default params, so applying a filter does not
      reset a chart range or a sort
- [ ] A clear affordance returning to the whole household, linking to `.` when the resulting search
      would be empty — the `|| "."` idiom at `app/routes/holdings.tsx:366`
- [ ] Labelled by what it does; the checked owners are named in the control, not only implied
- [ ] **Not drawn at all** when fewer than two people own an **open** account — the spirit of
      `availableFilters`' rule at `app/lib/holdings-view.ts:508`, not its code: that rule counts
      distinct values among the holdings on screen, and this one counts people, so it stays stable
      across four screens rather than vanishing where an owner happens to hold nothing
- [ ] Roster is `listPeople()` (`app/lib/people.server.ts:61-84`) kept to owners of an open account.
      `accountCount` spans closed accounts, so it cannot be used unfiltered — an owner whose accounts
      are all closed would be selectable into a blank screen that nothing explains

**Saying so in words**

- [ ] A narrowed screen states the owners beside the figure they narrow — not a highlighted chip
      alone. This is ADR-0008's condition on the filter surviving navigation
- [ ] With one owner it reads as that name; with several it reads as a list in the roster's order
- [ ] The sentence is masked-safe: it names people, and a name is never an amount
      (`CONTEXT.md`, **Masked**)

**Overview's loader**

- [ ] `ownerFilterMiddleware()` is mounted beside `chartRangeMiddleware()`
      (`app/routes/overview.tsx:95`)
- [ ] The filter is resolved, normalised against the roster by source, and a non-canonical `owner`
      param redirects before any database work — the pattern at `app/routes/holdings.tsx:121-123`
- [ ] Every reader call passes the resolved filter
- [ ] An `owner` id from the **URL** that names nobody leaves the screen empty, with a state saying
      the filter names an owner who is no longer recorded and a link that clears it
- [ ] The same id from the **cookie** is dropped and the household is shown

**The chart under a filter**

- [ ] The manual prefix is not drawn. The loader decides — `const manual = isFiltered(owners) ? [] :
      await manualNetWorth();` — with the §7 rule 3 citation on that line, rather than the reader
      lying about what it read
- [ ] The screen says the pre-app series is not shown while narrowed, rather than leaving a
      suspiciously short line unexplained (DESIGN.md §7 rule 3 asks for exactly this)
- [ ] **`chart-range.ts` is not touched.** `Surface` (`app/lib/chart-range.ts:75`) encodes two rules
      — consider the manual series or do not — and a filtered household is the second one with a
      narrowed earliest date. The loader supplies the narrowed `SurfaceEarliest` and the account-
      shaped surface; adding a third member would force a branch in `surfaceEarliestDate`,
      `resolveRange`, `isRangeDisabled`, `rangeOptions` and `customRangeMin` for a case already
      expressible
- [ ] The narrowed earliest date comes from `firstRecordedDate`, which counts closed accounts — so an
      owner holding nothing today may still have a reachable past
- [ ] Presets that cannot be drawn disable as `<span aria-disabled="true">`, never as dead links,
      which is `ChartRangeControl`'s existing rule
- [ ] **All** under a filter spans the owners' own history

**The trap to fix here**

- [ ] Nothing — ticket 00 fixed it. This ticket only relies on it, and its own tests confirm a range
      click preserves the filter

**Tests** (extending `tests/routes/overview.test.ts`)

- [ ] Narrowed, the headline, delta, rollup and allocation show one owner's figures as exact decimal
      strings
- [ ] Narrowed, the manual series is absent and the explanation is present
- [ ] Unnarrowed, the manual series is exactly what it is today
- [ ] The reachable range shortens to the owners' history, and a preset beyond it is disabled
- [ ] A range click preserves the filter, and a filter apply preserves the range
- [ ] A single-person household renders no control
- [ ] An unknown id from the URL empties the screen and explains; from the cookie it does not
