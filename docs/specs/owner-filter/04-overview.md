# 04 — Overview reads as an owner

_Part of [0013-owner-filter.md](../0013-owner-filter.md)._

**What to build:** Overview honours the filter — headline, delta, chart, accounts rollup and
allocation — plus the two consequences that bite only here: the hand-typed prefix disappears, and the
chart's reachable past shortens.

It is separate from ticket 03 because none of that is about the control. It is Overview's loader, the
chart's reach, and the one screen whose headline number a filter silently redefines. Ticket 03 proved
the control on a screen that already had one; this proves the filter on the screen where getting it
wrong is worst.

**Blocked by:** 00 (range links must stop replacing the query before a filtered chart exists) and 03
(the control and the nav carry).

**Status:** ready-for-agent

**The loader**

- [ ] The filter is read from the URL and canonicalised — **roster-free**, so a non-canonical `owner`
      redirects before any database work, exactly as `app/routes/holdings.tsx:121-123` does
- [ ] Overview already exports `chartRangeMiddleware` (`app/routes/overview.tsx:95`), whose body is
      `const response = (await next()) as Response` and then appends `Set-Cookie`
      (`app/lib/chart-range.ts:611-622`). This ticket gives Overview its **first thrown redirect**.
      Order the two explicitly and test it: the canonical `owner` redirect is decided before the
      range is read, so the middleware never appends a cookie header to a redirect
- [ ] Every household reader call passes the resolved filter

**The figures**

- [ ] Headline, delta, accounts rollup and allocation all narrow, as exact decimal strings
- [ ] The owners are named beside the headline — never a chip alone

**The chart**

- [ ] The manual prefix is not drawn. The loader decides — `const manual = isFiltered(owners) ? [] :
      await manualNetWorth();` — with the §7 rule 3 citation on that line, rather than the reader
      lying about what it read
- [ ] The screen says the pre-app series is not shown while narrowed, rather than leaving a
      suspiciously short line unexplained. DESIGN.md §7 rule 3 asks for exactly this
- [ ] **`chart-range.ts` is not touched.** `surfaceEarliestDate` (`:191-192`) returns
      `earliest.positionSet` outright for the account surface, so a filtered household is that
      surface with a narrowed earliest date. The loader supplies it. Adding a third `Surface` member
      would force a branch in `resolveRange`, `isRangeDisabled`, `rangeOptions` and `customRangeMin`
      for a case already expressible
- [ ] The narrowed earliest date comes from `firstRecordedDate`, which reaches through
      `position_set` and therefore counts **closed** accounts — so an owner holding nothing today may
      still have a reachable past. That asymmetry is deliberate and documented in ticket 02
- [ ] Presets that cannot be drawn disable as `<span aria-disabled="true">`, never dead links
- [ ] **All** under a filter spans the owners' own history

**Empty states**

- [ ] The early return at `app/routes/overview.tsx:367-381` currently fires on `holdingCount === 0`
      and renders **no header strip** — so under a filter it would leave no control and no way to
      clear. It moves below the header, and the three states are told apart as in ticket 03: nothing
      uploaded; the filter names an owner no longer recorded; the filter names owners who hold
      nothing. Only the first may say *"Nothing has been uploaded to this instance yet"*, which is a
      false statement in the other two

**Tests** (extending `tests/routes/overview.test.ts`)

- [ ] Narrowed, headline, delta, rollup and allocation show one owner's figures as exact decimal
      strings; two owners sum to the household total
- [ ] Narrowed, the manual series is absent and the explanation is present; unnarrowed it is exactly
      what it is today
- [ ] The reachable range shortens to the owners' history, and a preset beyond it is disabled
- [ ] A range click preserves the filter, and applying a filter preserves the range
- [ ] A non-canonical `?owner=` redirects, and the redirect carries no `Set-Cookie`
- [ ] A single-person household renders no control
- [ ] Each of the three empty states, with the control present in the latter two
