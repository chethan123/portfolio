# 03 — The control, the navigation carry, and Holdings reading it

_Part of [0013-owner-filter.md](../0013-owner-filter.md)._

**Superseded in part:** every `?owner=1,3` below, including in the Tests checklist, was written as
what the control emits for two or more ids; it never worked as that — [0013's
banner](../0013-owner-filter.md) has the finding and the fix. Canonical for two or more is the
repeated key `?owner=1&owner=3`; a comma-spelled address still redirects to it rather than being
read directly. The sequencing argument below is unaffected either way.

**What to build:** The shared owner control, the navigation change that carries the filter between
screens, and Holdings honouring the household filter instead of its own Owner select.

**Holdings is deliberately the first screen.** It is the one screen that already has an Owner
select, so the control *replaces* a control rather than appearing beside one — there is no moment in
the sequence where a person loses the ability to narrow by owner, and no moment where the control
can emit `?owner=1,3` on a screen whose parser only understands a single value. Building the control
against Overview first would have created both.

**Blocked by:** 01 and 02.

**Status:** ready-for-agent

**The roster — a `people.server.ts` change, not a filter on its output**

- [ ] `listPeople()` (`app/lib/people.server.ts:61-84`) returns `{id, name, accountCount}` and nothing
      more, and its `accountCount` contract at `:41` is *"Accounts owned, open and closed alike"* —
      depended on by `removePerson` (`:135-146`) and rendered by the People screen. It cannot be
      narrowed in place
- [ ] Add an **`openAccountCount` field** to `Person`, computed in the same query with a filtered
      count. Not a second reader: the People screen already pays for this query, `accountCount` keeps
      its "open and closed alike" meaning for `removePerson`, and one query with two counts beats two
      queries with one each
- [ ] The roster is owners of at least one **open** account: `holding_valued` excludes closed
      accounts, so an owner with only closed ones narrows every screen to nothing

**The control** (`app/components/owner-filter-control.tsx`)

- [ ] Checkboxes, one per roster member, plus an Apply button, rendered **inside
      `<div className="page-actions">` within the screen's `<header className="page-header">`** —
      the same slot `PriceFreshness` occupies on Holdings (`app/routes/holdings.tsx:542-557`). This
      is the placement on all four screens. Note Overview's `ChartRangeControl` is *not* in the
      header — it sits in the hero section (`app/routes/overview.tsx:424`) — so "beside the chart
      range" would name a different place on every screen. The header is the one slot they share
- [ ] It **reuses the `.filter-bar` CSS class and its layout conventions**, and extracts **nothing**
      from `Filters` (`app/routes/holdings.tsx:571-619`). `Filters` is a `<select>`-per-dimension
      bar; this is a checkbox list. They share a look, not a component. An adversarial reviewer will
      ask whether this is a near-copy: the answer is that the shared part is CSS, extracting a
      component from two controls with different inputs would be the more elaborate shape, and
      spec 0013 agrees
- [ ] `.filter-bar` (`app/app.css:2969`) styles `> div:not(.filter-actions)` (`:3008`) and `select`
      (`:3013`); there is no checkbox-group rule. Add one, matching the file's existing conventions
      — there is no formatter, so match what is around it
- [ ] Hidden fields re-emit the host screen's other non-default params, so applying a filter does not
      reset a sort or a range. The control takes them as a **`hidden: Record<string, string>` prop**
      supplied by each screen — Holdings passes `group`/`sort`/`dir`, Overview passes
      `range`/`start`/`end`. The control knows nothing about any screen's vocabulary
- [ ] `edit` and `saved` are **never** re-emitted: `app/routes/holdings.tsx:101-114` keeps them out
      of `HoldingsQuery` precisely so every control drops them, and narrowing while a row is open
      must not carry a half-typed correction
- [ ] (A React Router `<Form method="get">` replaces the query exactly as a native one does; the
      hidden fields are what preserve anything. What `<Form>` buys is client-side navigation)
- [ ] A Clear affordance returning to the whole household, linking to `.` when the resulting search
      would be empty — the `|| "."` idiom at `app/routes/holdings.tsx:366`
- [ ] **Not drawn** when fewer than two people own an open account
- [ ] The checkbox labels are the owners' names — that is the control naming them. The narration
      sentence below is a **second, separate** element beside the figure; do not treat the checkbox
      labels as satisfying it

**Saying so in words**

- [ ] A narrowed screen states the owners beside the figure they narrow — ADR-0008's condition on the
      filter surviving navigation
- [ ] Masked-safe: it names people, and a name is never an amount (`CONTEXT.md`, **Masked**)

**The navigation carry**

- [ ] Each `NAVIGATION` link becomes `to={{ pathname, search }}` where `search` is **the canonical
      owner param alone** — never `location.search`, which would drag `range`, `start`, `sort` or a
      half-typed `edit` row key onto a screen that does not own it, and would bounce every nav click
      through Holdings' canonical redirect
- [ ] `NavItems` (`app/root.tsx:129`) renders **four** times: `NAVIGATION` for the desktop rail
      (`:199`) and the bottom bar (`:240`), and `FOOTER_NAVIGATION` for Settings (`:202`, `:241`).
      The first two carry; the last two must not. So the carry is a **prop**, not a change inside
      `NavItems`
- [ ] The brand tile (`app/root.tsx:153`, rendered at `:197` and `:219`) carries it too — it is a nav
      item in all but name, and is the most-clicked way to lose the filter otherwise
- [ ] `NavLink`'s active state is unaffected: it resolves on pathname alone, so `end: true` on `/`
      and the `aria-current="page"` behaviour are unchanged. A `search` of `""` collapses to a bare
      path, so an unfiltered instance's URLs stay clean

**Holdings: the dimension**

- [ ] `owner` is removed from the filter dimensions (`app/lib/holdings-view.ts:133-209`); the filter
      bar no longer offers an Owner select
- [ ] `owner` remains a **grouping** — grouping by owner is a different act from narrowing to one,
      and stays useful under a multi-owner filter
- [ ] Grouping by owner still drops the Owner column (`app/routes/holdings.tsx:310-315`)
- [ ] `DIMENSIONS` maps to exactly `["account", "institution", "kind", "tax", "classification",
      "assetClass"]`, asserted as that literal list rather than as a count

**Holdings: three safeguards the SQL narrowing would silently break**

Each has a comment in the code saying it must not be broken. Narrowing `currentHoldings` at the
source removes all three unless this ticket handles them:

- [ ] **`availableFilters` must still be built from every holding**, not the narrowed set —
      `app/routes/holdings.tsx:129-131`: *"options that vanished as you narrowed would leave no way
      to widen again."* Keep an unfiltered read, or build the facets from a separate query
- [ ] **`hasHoldings` / `totalHoldings` must still distinguish "nothing uploaded" from "this filter
      matched nothing"** — `:153-154` calls them *"two states that must not share a screen"*
- [ ] **The `· filtered from N` notice must appear when only the owner filter is on.** `filtered` is
      `active.length > 0` (`:348`), which counts `query.filters` — once `owner` leaves `DIMENSIONS`
      that is zero, and the notice vanishes. Its comment at `:400-402` is ADR-0008's honesty
      condition in the code already: *"Without this a filtered table looks like the whole portfolio
      to anyone who did not set the filter — including you, a day later, following your own
      bookmark."*
- [ ] **N is the household total** — every holding in the instance, as it means today. Not the
      count before the dimension filters but after the owner filter, which would make the same
      number mean two things depending on which control you had touched
- [ ] **Clear filters** (`:366`, `:581`) clears this screen's own dimension filters and **leaves the
      owner filter alone**. It is a screen-local control and the owner filter is household-wide;
      clearing it from here would reach out and change what Overview shows next. The owner control
      carries its own clear, which is where "show everyone again" lives. Say so in the button's
      surroundings if the distinction is not obvious on screen

**Holdings: carrying the param through every link**

- [ ] `toSearch` (`app/lib/holdings-view.ts:438-453`) emits `owner`, taking it as **its own
      argument** rather than as a member of `HoldingsQuery` — a param `toSearch` writes but
      `parseQuery` refuses to read is a seam with a hole in it
- [ ] **`owner` is emitted first**, before the dimensions, then `group`, `sort`, `dir`. The order is
      fixed here because `toSearch` is the single definition of canonical spelling and the redirect
      at `:121-123` compares against it. A control whose form serialises the fields in a different
      order is fine — it costs one bounce through the redirect, which is already how every GET form
      on this screen behaves (`ARCHITECTURE.md` §4.4)
- [ ] **Test that canonicalisation is idempotent** — `toSearch` applied to its own output is
      unchanged. If it is not, `url.search !== canonical` is permanently true and every request to
      Holdings 302s forever. This is the highest-consequence failure in the ticket and it is silent
      until someone opens the screen
- [ ] Omitted entirely when the filter is off, so an unfiltered table's URL stays `/holdings`
- [ ] The canonical redirect (`app/routes/holdings.tsx:121-123`) accounts for `owner`, roster-free
- [ ] The filter bar's hidden fields carry `owner` alongside `group`, `sort`, `dir` (`:585-589`)
- [ ] `edit` and `saved` keep working, and the action's redirect (`:246`) preserves the filter by
      reading `owner` from the **request URL** — the action already builds its target from
      `toSearch(parseQuery(url.searchParams))`, so it reads the filter from the same URL and passes
      it as `toSearch`'s new argument. No hidden field on the correction form

**Holdings: narrowing, and the empty states**

- [ ] The loader passes the resolved filter to `currentHoldings`; `applyFilters` no longer sees an
      owner key
- [ ] Summary line and group subtotals reflect the narrowed set, as exact decimal strings
- [ ] Three empty states, told apart — and in the two filtered ones the **header strip and the
      control still render**, or the filter cannot be cleared from the screen it emptied. The early
      return at `:376-386` must therefore move below the header:
      1. **nothing uploaded to the instance** — today's `EmptyState` and today's words, unchanged.
         Only this state may say nothing has been uploaded;
      2. **the filter names an owner you cannot filter by** — not recorded at all, or recorded but
         owning no open account, which is the same sentence to a reader and the same fix. Covers the
         hand-typed id and the owner whose accounts have all been closed;
      3. **the filter names owners who hold nothing** — they are in the roster and this is not an
         error, so the words must not sound like one
- [ ] Write the copy yourself; no ticket dictates wording, because `docs/README.md` forbids documents
      transcribing strings the code owns. `EmptyState` (`app/components/empty-state.tsx`) supplies
      the fixed headline and takes the detail sentence as `children`, so all three states go through
      it — this is a copy change, not a component change. Holdings' current detail at `:378-380` is
      the register to match
- [ ] States 2 and 3 each carry a link that clears the filter

**Tests** (`tests/routes/holdings.test.ts`, `tests/holdings-view.test.ts`, and the nav assertion
through `renderThroughLayout` in `tests/support/render.tsx` — `tests/support/routes.ts` drives
loaders only and cannot see the shell's markup)

- [ ] The filter bar offers no Owner select; the dimension ids match the literal list
- [ ] Group-by owner still works, still drops the column, and works under a multi-owner filter
- [ ] A bookmarked `?owner=3` narrows exactly as the old dimension did; `?owner=1,3` narrows to two
- [ ] Sorting, grouping and filtering by another dimension all preserve `owner`
- [ ] The `filtered from N` notice appears when only the owner filter is on — the reproducing case
- [ ] `availableFilters` still offers a dimension value that the current owner filter excludes
- [ ] Each of the three empty states, and that the control renders in the latter two
- [ ] A nav link carries only `owner`, not `sort` or `edit`; the Settings link carries nothing
- [ ] A row correction under a filter returns to the narrowed view
