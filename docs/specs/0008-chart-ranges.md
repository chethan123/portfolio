# Chart ranges — a wider set of presets for the net worth trend line

Canonical here. Published as [issue #70](https://github.com/chethan123/portfolio/issues/70) so an
agent can pick it up from the tracker; when the two disagree, this file wins.

Vocabulary is `CONTEXT.md`'s: a **chart range** is the named span of time a chart plots — one of the
fixed presets or a custom start/end pair — and which dates a range can reach differs by screen, per
the glossary entry this design work added.

## Problem Statement

Overview and the account detail page each offer the same four chart ranges — 1M, 3M, 1Y, All — and
nothing shorter than a month, nothing between one and thirty years, and no way to look at an
arbitrary span. Someone who wants to see this week's movement, this calendar year so far, the last
five years, or "since I started this job" has no way to ask for it. The two screens also compute
these ranges from two independently duplicated copies of the same logic, which `ARCHITECTURE.md`
already flags as debt: a future change to one is not guaranteed to reach the other.

## Solution

Both screens gain the same eight-option control: **1W, 1M, 3M, YTD, 1Y, 5Y, All, Custom**. The first
seven are fixed presets computed the same way the existing four already are — a trailing span from
today, or (for YTD) from the first of the calendar year. Custom opens a small date-range picker,
clamped to what that screen can actually show, and once set, the control displays the chosen span
instead of the word "Custom."

The two screens' range logic moves into one shared module, so the two can no longer drift apart the
way `ARCHITECTURE.md` warns they could. That module also carries forward — and now applies
consistently to every preset, not just "All" — the existing rule that Overview's range may reach into
the household's hand-typed pre-app net worth history while an account's range never does, because
that history was never any one account's.

A person's last-chosen range is remembered per browser (a lightweight cookie, not a stored setting),
but an explicit `?range=` in the URL always wins — a bookmarked or shared link still works exactly as
it does today.

## User Stories

1. As someone viewing Overview, I want to see net worth over the last week, so that I can check how
   this week's market moved my current holdings.
2. As someone viewing Overview, I want to see net worth over the last month, so that I can catch a
   shorter-term trend than a year gives me.
3. As someone viewing Overview, I want to see net worth over the last three months, so that I can
   watch a quarter's movement, which is also roughly how often I upload a statement.
4. As someone viewing Overview, I want to see net worth year-to-date, so that I can answer "how has
   this calendar year gone" without doing the date math myself.
5. As someone viewing Overview, I want to see net worth over the last five years, so that I can see a
   longer arc than the existing one-year cap allowed.
6. As someone viewing Overview, I want to see net worth over a custom span I pick myself, so that I
   can answer a question the fixed presets don't, like "since I started this job."
7. As someone viewing an account's own page, I want the identical set of ranges as Overview, so that
   muscle memory carries over between the two screens.
8. As someone who bookmarked or shared a `?range=` URL before this change, I want that link to keep
   working exactly as it did, so that nothing I saved breaks.
9. As someone whose account is newer than a preset's span — eight months old, looking at 5Y — I want
   that preset shown disabled rather than silently doing the same thing "All" already does, so that
   I'm not left guessing why nothing changed when I click it.
10. As someone opening the app on January 1st or 2nd, I want YTD to show whatever thin data exists
    rather than being hidden, so that the control behaves the same way "All" already does for a
    brand-new account.
11. As someone who picks a custom start and end date, I want the chart to wait until both are set
    before it changes, so that I never see a chart drawn from half a selection.
12. As someone opening the custom date picker, I want it to refuse dates before my earliest data or
    after today, so that I can't select a span that can only fail.
13. As someone who has picked a custom range, I want the control to show the actual dates I chose
    instead of the word "Custom," so that I can tell at a glance what I'm looking at.
14. As someone browsing with JavaScript disabled, I want every range — including custom — to still
    work, so that this feature doesn't regress the "no JavaScript needed" promise the control already
    makes.
15. As someone who picked a range on my last visit, I want a fresh visit with no `?range=` in the URL
    to reopen on that same range, so that I'm not reset to 1Y every single time.
16. As someone who clicks a link carrying `?range=1y` today, I want that to win over whatever I had
    picked on an earlier visit, so that an explicit choice in the URL is never silently overridden by
    a remembered one.
17. As someone viewing the household-level Overview chart, I want every applicable range — not only
    "All" — to be able to reach into my hand-typed pre-app net worth history, so that the chart
    doesn't quietly shrink to only what the app itself has recorded.
18. As someone viewing a single account's page, I want its ranges to never pull in the household's
    hand-typed pre-app figures, so that one account's chart isn't inflated by data that was never that
    account's.
19. As a developer adding a ninth range later, I want one shared module to be the only place a
    range's boundaries are computed, so that Overview and the account page cannot drift apart the way
    they had before this change.
20. As a developer reading the code later, I want the reason 3M survived alongside the newer presets
    written down, so that nobody "cleans it up" as an apparent leftover of the old four-option set.
21. As a developer testing this, I want the range-resolution math tested without a database, so that
    the many preset and edge-case combinations run fast and don't need Postgres to prove a date
    calculation is right.
22. As a developer testing the route, I want the existing "the range in the query string" test block
    extended rather than replaced, so that prior coverage of the invalid-key fallback isn't lost.
23. As someone with a very young account, all of whose data sits inside the last month, I want the
    sample count to keep working exactly as it does today, so that nothing about the shorter presets
    breaks the existing "25 evaluations, deduped by day" approach.
24. As someone reading the chart's accessible label, I want it to keep naming the active range the
    same way it does today, so that a screen reader user gets an equivalent update for every one of
    the new presets, not only the old four.
25. As a household member who uses the 3M preset today, I want it to keep existing, so that a view I
    already rely on doesn't disappear.
26. As someone on a phone, I want eight presets plus Custom to stay usable in the space the existing
    segmented control has, so that the wider set doesn't break on a small screen.

## Implementation Decisions

**Presets and order.** `1W, 1M, 3M, YTD, 1Y, 5Y, All, Custom`, identical set and order on Overview
and the account page. 3M is kept deliberately — it predates this change and was a live decision to
retain it, not an omission — and is worth a code comment saying so, the way the existing `RANGES`
comment already explains "All"'s reasoning.

**Boundary semantics.** Every fixed preset is a trailing span from *today's* calendar date, exactly
as the existing four already compute it — never from the most recent snapshot. 1M and 3M are trailing
calendar month/quarter (today back to the same day-of-month one or three months prior), matching how
1Y and 5Y already work. YTD is January 1st of the current year through today.

**One shared range-resolution module, replacing the duplicated pair.** `windowDays`/`sampleWindow`/
`sampleDates` currently exist twice, once per route, and `ARCHITECTURE.md` already names the
duplication as debt with one caveat: the two were not safely shareable before this change because
"All" quietly meant different things on each screen. This spec removes that caveat by making the
difference an explicit parameter — which surface's data-source rule applies — so one module now
serves both routes, and adding, removing or changing a preset happens once.

**The per-surface data-source rule now applies to every preset, not only "All."** Overview's window
may be measured from whichever is earlier: the earliest position-set date, or the earliest hand-typed
manual point. The account page's window is measured from that one account's own earliest position-set
date only, and never considers manual points, matching the existing, deliberate distinction for "All."

**Disabled state.** A preset whose start boundary falls before the earliest date available *to that
surface* is disabled rather than clamped or silently redirected. On the account page, this requires
knowing that account's own earliest date — which no existing query exposes; today's account-page "All"
falls back to the household-wide earliest date instead. This spec adds an account-scoped earliest-date
query, alongside the account-scoped queries that already exist, so the account page's disabled state
(and its own "All") are measured against that account's real history rather than the household's.

**Sampling is unchanged.** The existing fixed 25-sample, deduped-by-calendar-day approach is reused
as-is for every preset, including Custom, regardless of span length — no new bucketing strategy for
longer or shorter windows.

**Persistence is a new, lightweight, per-browser cookie — not a stored setting.** Distinct in name
from the masking cookie. An explicit `range` (or, for Custom, `start`/`end`) query parameter always
wins and is what gets written back to the cookie; its absence falls back to the cookie's stored value;
absence of both falls back to the existing hardcoded default (1Y). No `app_setting` column, no
Settings → Display entry — this is a remembered convenience, not a household policy, and the gap
between those two is why masking's heavier mechanism doesn't apply here. The cookie is not
session-scoped: unlike masking's safety-first default, there's no reason a lower-stakes preference
should forget itself between sessions.

**Custom range is a native date form, not a JavaScript-only control.** Two `<input type="date">`
fields — the same element the account page's existing "Set balance" form already uses for `asOf`,
with the same `min`/`max` pattern — submitted via a GET that produces `?start=&end=` (or an
equivalent), so the base contract needs no JavaScript, matching the rest of this control today. A
script may enhance the same form into a nicer popover, but the underlying GET form must keep working
with it disabled. `min`/`max` reflect that surface's own earliest-available date and today; the loader
independently re-validates and clamps both on the server, the same defensive posture the existing
`Object.hasOwn` guard already takes against a hand-edited `range` parameter. Once a custom range has
been applied, the control's own label shows the formatted span rather than the literal word "Custom."

**Short ranges need no special handling for upload cadence.** 1W and 1M will, by construction, mostly
show price movement on unchanged positions between quarterly statement uploads rather than new
contributions — that's the expected, accepted behavior discussed during design, not a gap to work
around.

## Testing Decisions

A good test here asserts the date math and the observable control, not the SVG drawing underneath
them — the existing chart component's own tests already cover the line, the grid and the masking
boundary, and nothing about this change touches how a point becomes a pixel.

**One pure seam: the shared range-resolution module.** Given a fixed "today," a fixed "earliest
available" date (or dates, for Overview's manual/computed pair), and a surface, this is pure
date-in/date-out logic — cheap to exhaust across eight presets and their edge cases in a way a
database-backed render would be slow to repeat, the same reasoning spec 0007 gives for testing its
resolver standalone rather than only through rendered pages. What's pinned:

- Each preset's boundary against a fixed "today," including 1M/3M's calendar-month/quarter behavior
  and YTD's January 1st boundary.
- The disabled-state rule: a preset whose start predates the earliest available date for that
  surface is disabled; a preset whose start lands exactly on it is not.
- The per-surface data-source rule (manual-aware for Overview, real-data-only for the account page)
  applied identically across every preset, not special-cased for "All."
- The existing "25 fixed samples, deduped by calendar day" behavior, preserved for both a short (1W)
  and a long (5Y/All) window.
- 3M resolving as an ordinary, first-class preset rather than dead code.

**One behavioural seam: the route, extending what's already there.** `tests/routes/overview.test.ts`
and `tests/routes/account.test.ts` already drive their loaders directly with `?range=...` and already
have a `"the range in the query string"` block covering the invalid-key fallback — that block is
extended with the new keys rather than replaced, and gains cases for:

- Explicit `?range=`/`?start=&end=` winning over a cookie that names a different range.
- A cookie's stored range being used when the URL carries none.
- The hardcoded 1Y default applying when neither is present.
- The loader's response setting or updating the persistence cookie whenever the request carried an
  explicit range.
- A full render marking a disabled preset appropriately, without a working link.
- A full render of an applied custom range showing the formatted span, not the word "Custom."
- The custom form's date inputs carrying the right `min`/`max` for that surface, and the loader
  falling back to the default rather than erroring on an out-of-bounds or incomplete custom pair.
- The account page's disabled state and window using the new account-scoped earliest-date query
  rather than the household-wide one.

**Not tested: the JavaScript-only popover chrome.** There is no browser in this suite — the same
carve-out spec 0007 makes for its client-side cookie write — and the thing worth pinning is the
underlying GET-form contract, which the route seam above already covers.

## Out of Scope

- **Any change to masking or to what's masked.** A chart range is a date and a label, never an
  amount; `CONTEXT.md`'s masking rules are untouched by this work.
- **A settings-page entry or a stored household policy for range preference.** The lightweight cookie
  from the Implementation Decisions is the whole persistence mechanism; the heavier, masking-style
  option was considered and rejected during design.
- **Any chart besides Overview's and the account page's.** No other trend or period chart exists in
  the app today.
- **A responsive redesign of the segmented control itself.** Whether eight presets plus Custom need a
  wrap, a scroll, or a narrower label set on a phone is left to whoever builds this, to be checked
  against a real small-screen viewport rather than decided here.
- **An ADR for the per-surface data-source rule.** Raised during design as a candidate — hard to
  reverse, non-obvious, a real rejected alternative — but not confirmed; the `CONTEXT.md` glossary
  entry this design work already added is treated as sufficient for now.
- **Any change to `holding_valued_at` or the valuation query layer itself.** This is a
  presentation-layer feature built on the existing valuation queries, plus the one new account-scoped
  earliest-date query named above.

## Further Notes

**The persistence cookie's write path needs grounding before code is written.** Whether it's set from
the loader's own response headers or via a small client script (and the exact React Router 7 API for
the former) should be checked against the framework's current documentation rather than assumed —
the same caution spec 0007 flagged for its own router dependency.

**3M's survival was a deliberate call, against the recommendation raised while designing this.**
Worth restating in code, not just here, so a future pass doesn't read it as an accidental leftover of
the old four-preset set.

**Mobile layout for eight options is a genuine open question**, not a decided behavior — flagged in
Out of Scope and worth a real look on a phone-sized viewport before this is called done, per this
project's own standard for UI changes.
