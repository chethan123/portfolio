# Stitch brief — the Holdings screen

*Paste this whole document into Google Stitch. It is self-contained; nothing here needs the
repository.*

---

## 0. Context

**The product.** A self-hosted, single-tenant web app tracking one household's portfolio and net
worth. No brokerage integration, no trading, nothing to sell. It reads statements the family
uploads, prices the holdings every 15 minutes during market hours, and answers what we have, how it
is allocated, and how it has moved. Two or three readers, on a desktop, occasionally on a phone.

**Constraints on every screen below.**

- **Desktop-first.** ≥1024px is the design target. The phone is for *reading* — not a reflow
  exercise, but nothing may be hidden on it.
- **Light and dark are both first-class**, not a filter over one another. Draw every screen in both.
- **Inter only**, variable weight 400–700, self-hosted. **There is no monospace font in this app.**
  Numeric alignment comes from `font-variant-numeric: tabular-nums`, never from a mono family.
- **Icons are inline SVG**, 18–24px, stroked in `currentColor`. No icon font, no CDN.
- **There is no client-side JavaScript state.** No route in this app calls `useState`, `useEffect`,
  `useMemo` or `useRef` — the grep returns nothing. Every control below is a form or an anchor, and
  every piece of screen state is a URL search param. **The inline editor of §6 obeys this rule
  rather than being excused from it**: a row opens because the URL says `?edit=12.7`, the same way
  the table groups because it says `?group=owner`. Nothing on this screen is "open" in a sense the
  address bar does not already contain.
- **This is an existing design system.** Assemble every screen from the tokens and components in §1
  and §2. Do not invent a colour, a radius, a type size or a component shape; compose from what is
  here.

**What is being designed.** The **Holdings screen** — DESIGN.md §8.1's "workhorse", which this
brief found as a 55-line stub rendering a count and a sentence, and which is now built (§10). It is the page that "absorbs what would otherwise be four
more pages": by person, by account, tax view, unrealized are the same table with the grouping
changed. It is also **absent from the Stitch mock set entirely** — all twelve screens are Dashboard,
Views Analysis and Account Details — and the set contains **no `<select>` and no dropdown of any
kind**, so the filter bar is new ground drawn in an old language. What the set *does* supply, and
what is kept here, is the **ticker badge tile**, the **classification sub-line**, and the **delta
pill**.

**And one write, on the table itself.** Holdings is a read surface with a single exception: the
**inline editor of DESIGN.md §5.4** (§6 below), which opens one row in place so a household can
correct a quantity or a cost basis between statements without going through the four-screen upload
flow. Stitch is being asked to draw that too — the trailing column it adds, the pencil that lives
in it, the open row, the sentence underneath and the receipt afterwards. There is nothing like it
in the mock set either, and it is assembled from the same §2 components as everything else.

**Not redefined here.** The as-of timestamp and the per-row stale treatment are already placed by
`docs/design/pricing-ui-brief.md` §3 and §4.2 — whose placement table already carries a "Holdings
table" row. This brief consumes those decisions; it does not reopen them.

**The dimension count, reconciled.** Three documents give three answers and the difference is a
decision, not a discrepancy. §8.1 grants **four** filter dimensions — person, account, tax
treatment, classification. §8.3's deferred view-builder types a `Dimension` union of **eight** —
`person · account · institution · kind · tax_treatment · classification · asset_class · instrument`.
The `holding_valued` view exposes all eight on every row already, so seven of them cost one `WHERE`
clause apiece and no new join. **This screen adopts seven: everything but `instrument`.** A filter
over the very thing each row *is* is not a filter, it is a search box — one row per instrument means
the control's only job is to find a row you could already see — and a search box is deferred,
for the same reason §13.7 refuses search over accounts.

---

## 1. Design tokens

### 1.1 Colour

Every value below is a live CSS custom property. Both columns are authoritative; a screen must use
the light column in light and the dark column in dark, with no other colours anywhere.

| Token | Light | Dark | Role |
|---|---|---|---|
| `--background` | `#f7f9fb` | `#0b1326` | The canvas |
| `--surface-container-lowest` | `#ffffff` | `#060e20` | Deepest well; the light panel |
| `--surface-container-low` | `#f2f4f6` | `#131b2e` | Row hover in light; the donut track |
| `--surface-container` | `#eceef0` | `#1e293b` | The dark panel |
| `--surface-container-high` | `#e6e8ea` | `#222a3d` | Table headers, row hover in dark, tiles |
| `--surface-container-highest` | `#e0e3e5` | `#2d3449` | Pressed |
| `--surface-bright` | `#f7f9fb` | `#31394d` | The tinted half of a split panel |
| `--on-surface` | `#191c1e` | `#f8fafc` | Primary text |
| `--on-surface-variant` | `#434656` | `#c3c5d9` | Labels, captions, secondary text |
| `--outline` | `#737688` | `#8d90a2` | Borders that must be *seen* (≥3:1): inputs, selects, focus |
| `--outline-variant` | `#c3c5d9` | `#434656` | The 1px structural hairline |
| `--primary` | `#0041c8` | `#b6c4ff` | Accent text, icons, the active nav item |
| `--primary-container` | `#0055ff` | `#0055ff` | The one solid accent fill, both themes |
| `--on-primary-container` | `#ffffff` | `#e3e6ff` | Text on that fill |
| `--secondary-container` | `#d0e1fb` | `#39485a` | The active tab / nav item's ground |
| `--gain` | `#005c3e` | `#10b981` | Positive movement, unrealized gain |
| `--loss` | `#ba1a1a` | `#f87171` | Negative movement, unrealized loss, destructive, field errors |
| `--warning` | `#92500e` | `#fbbf24` | **Stale price, partial coverage** |
| `--warning-surface` | `#fef3c7` | `#33280a` | The ground under a warning |

Derived roles: `--panel` = `--surface-container-lowest` in light, `--surface-container` in dark.
`--panel-hover` = `--surface-container-low` in light, `--surface-container-high` in dark.
`--gain-surface` = `rgb(0 92 62 / 0.10)` light, `rgb(16 185 129 / 0.12)` dark. `--loss-surface` =
`rgb(186 26 26 / 0.10)` light, `rgb(248 113 113 / 0.12)` dark.

**The two borders are not interchangeable**, and this screen is where it bites. `--outline-variant`
carries 1.5:1: it frames a panel and divides rows, and is *felt* rather than read. `--outline`
clears 3:1 and is what a control boundary uses. Seven `<select>` boxes drawn in `--outline-variant`
are seven controls nobody can see the edge of, which is a defect rather than a style.

Categorical sequence (fills only, never text): light `#0041c8`, `#007751`, `#505f76`, `#b6c4ff`,
`#c3c5d9`; dark `#0055ff`, `#10b981`, `#b6c4ff`, `#ef4444`, `#4edea3`. Nothing on Holdings draws
from it — there is no chart here — but a group header must not invent a colour either.

### 1.2 Type — Inter, one family

DESIGN.md §13.4 names a `--type-*` token per step. **Those custom properties do not exist in the
stylesheet**: `app.css` inlines the size, line height and weight on each component. The ramp below
is what is actually rendered, and it is the authority.

| Ramp step | Size / line | Weight | Tracking | Used for |
|---|---|---|---|---|
| display-lg | 48px / 56px | 700 | −0.02em | `.page-title`, the net-worth headline |
| headline-lg | 32px / 40px | 600 | −0.01em | A bare `h1` on a page with no header block |
| headline-sm | 24px / 32px | 600 | — | `.page-title` below 768px |
| title-md | 20px / 28px | 600 | — | `.panel-title`, `.empty-state-headline` |
| body-lg | 16px / 24px | 400 | — | `.page-subtitle` (14px / 20px below 768px) |
| body-sm | 14px / 20px | 400 | — | Body default, table cells, buttons, selects, `.empty-note` |
| label-md | 12px / 16px | 600 | 0.05em, uppercase | `th`, `.u-label`, `.panel-count`, `.segmented` |

`.u-label` *is* label-md in `--on-surface-variant`. `.u-data` is `tabular-nums` and **every figure
on this screen carries it** — quantity, price, value, cost basis, unrealized, every subtotal, the
grand total, and the counts inside `.panel-count`. Sub-captions inside a row (`.cell-sub`,
`.coverage-note`) are 12px / 16px, weight 400, in `--on-surface-variant` — not uppercase.

### 1.3 Space, shape, elevation

4px baseline grid. `--space-xs` 4px · `--space-base` 8px · `--space-sm` 12px · `--space-md` 16px ·
`--space-lg` 24px · `--space-xl` 40px.

| Token | Value |
|---|---|
| `--canvas-margin` | 32px desktop, 16px below 1024px |
| `--rail` | 280px fixed sidebar, ≥1024px only |
| `--content-max` | 1152px, centred |
| `--control-h` | **40px** — every button, input, select |
| `--radius` | 4px — chips, ticker badges |
| `--radius-lg` | 8px — buttons, selects, rows |
| `--radius-xl` | 12px — panels |
| `--radius-full` | 999px — dots, pills, `.segmented` chips |

**Shadow is `0 1px 2px rgb(0 0 0 / 0.05)` in light and `none` in dark.** Depth everywhere else is a
tonal step plus a 1px `--outline-variant` border: canvas → panel → panel header → table header.
Hover lifts a row's ground one tonal step; it never raises it.

**Breakpoints: 768px** (panel halves stack, `.panel-header` stacks, `.segmented` starts scrolling
sideways, the table reflows to cards) and **1024px** (the rail appears). Below 1024px the rail is
replaced by a fixed bottom bar — no drawer, no hamburger anywhere in this app.

### 1.4 The shell every screen sits in

- ≥1024px: fixed 280px left rail (`--panel` ground, right hairline, 12px radius on its right
  corners) holding the brand tile "Portfolio / Self-hosted", the nav — Overview · Holdings ·
  Analysis · Income — with Settings at its foot, and one filled full-width "Upload statement" button
  below that. Canvas is offset by 280px, capped at 1152px, centred, 32px padding, 24px between page
  sections.
- <1024px: no rail. A 64px sticky top bar with the wordmark and an "Upload" button; a fixed bottom
  nav with the same items, icon over 12px label, active item on a `--primary-container` pill. Canvas
  gets 16px margins and 88px of bottom padding.
- A page-level banner — the open-instance warning, the first-run prompt, the stale-price banner of
  the pricing brief §4.1 — sits **between the top bar and the main canvas**, full-bleed, above the
  1152px content column. Holdings never draws one itself; it inherits whatever the shell shows.

---

## 2. Existing components to reuse

Draw these exactly; they already exist in code under these names.

| Class | Shape |
|---|---|
| `.page` | The page column: flex, 24px gap between sections |
| `.page-header` | Title block left, `.page-actions` right, 24px bottom padding, bottom hairline. Stacks to a column below 768px |
| `.page-title` / `.page-subtitle` | display-lg (headline-sm below 768px) / body-lg in `--on-surface-variant`, 4px under the title |
| `.panel` | `--panel` ground, 1px `--outline-variant`, 12px radius, light shadow, `overflow: hidden`. **No padding of its own**, which is what lets a table bleed to its edge |
| `.panel-header` | Row, space-between, 24px padding, bottom hairline. Stacks to a column below 768px, 16px padding |
| `.panel-title` | title-md, optional 20px leading icon in `--on-surface-variant` |
| `.panel-count` | Right side of a panel header: label-md, tabular, e.g. "42 HOLDINGS · 6 ACCOUNTS" |
| `.panel-body` | 24px padding (16px below 768px) |
| `.panel-form` / `.record-form` | Flex wrap, 16px gap, 24px padding — a row of labelled fields ending in a button. `.panel-form` aligns to `flex-start`, so the row lines up on its **controls**: above a control is a fixed 24px (`--field-caption`, a caption line plus `label`'s gap) and below it is annotation — a `.field-note`, a `.field-error` — which must not move it. It rests on captions being one line. The row's un-captioned members (the button, a `.form-note` standing where a field would) drop by `--field-caption` to reach that line; a `fieldset`, a `label.choice` and a `.form-error` take the whole line. Below 768px: 16px padding (`.record-form` too), one field per line, every control full width, and the drop goes to 0 for the button and the note alike. `.record-form` sets no alignment — it is only ever worn with `.record`, which centres. **`.panel-body + .panel-form` drops the form's top padding** so prose and the form it captions close up |
| `.data-table` | Full width, `border-collapse: collapse`, no vertical rules. `th`: label-md on `--surface-container-high`, bottom hairline, nowrap. `td`: 16px padding, top hairline (none on the first row of a `tbody`), middle-aligned. Row hover `--panel-hover` |
| `.data-table-scroll` | `width: 100%; overflow-x: auto` — the wrapper that keeps a wide table from widening the page |
| `.is-numeric` | On `th` **and** `td`: right-aligned, tabular, nowrap; on a `td` also weight 600. Both get it or the column does not line up |
| `.cell-stack` | Row inside a cell: 12px gap, centred — badge + text block |
| `.cell-sub` | 12px / 16px caption under a cell's primary line, `--on-surface-variant`, 2px above it |
| `.cell-change` | Inline-flex, right-aligned, 4px gap — arrow + figure **inside** a numeric cell, never on the `td` |
| `.row-edit` | A row's own Correct control: an 18px `EditIcon` centred in a 32×32 inline-flex target, `--radius` corners, `--on-surface-variant`. **`opacity: 0` until its row is hovered or the control itself is focused**; forced to 1 under `@media (hover: none)`. Hover: `--surface-container-high` ground, `--on-surface` icon |
| `.badge` | Ticker tile: min-width 40px, height 32px, 8px inline padding, **4px radius — not a circle**, `--surface-container-high` ground, `--primary` text, 12px / 700 |
| `.delta` | Pill: 4px/12px padding, full radius, 12px/600, 0.03em, 14px arrow. `--gain` / `--loss` text on `--gain-surface` / `--loss-surface`. **`--bare` drops the pill** for in-table use; `--flat` is `--on-surface-variant` |
| `.button` | 40px tall, 0/16px padding, 8px radius, `--primary-container` fill, `--on-primary-container` text, 14px/600, 18px icon, 8px gap |
| button modifiers | `--quiet`: transparent, 1px `--outline-variant`, `--primary` text. `--text`: no box, `--primary`, underlines on hover — it keeps `.button`'s 40px so a text action stands on the line of the button beside it. `--danger`: 1px `--loss`. `--block`: full width |
| `select` / `input` | 40px tall, 12px inline padding, 8px radius, `--panel` ground, **1px `--outline`**, 14px text. Focus: 2px `--primary` outline and border |
| `.cell-input` | The same `input`, inside a table cell: full width of its column, `min-width: 6rem`, **32px tall** rather than `--control-h`, right-aligned, `tabular-nums`. Border, radius and focus ring inherited unchanged |
| `label` | **`display: flex; flex-direction: column; gap: 4px`**, 14px — the caption sits 4px above its control, and the whole pair is one hit target |
| `.segmented` | Chip strip of **anchors**: 32px tall, full radius, 1px `--outline-variant`, `--panel` ground, label-md in `--on-surface-variant`. `[aria-current="true"]` → `--primary-container` ground, transparent border, `--on-primary-container` text. Below 768px: `flex-wrap: nowrap; overflow-x: auto`, 4px gap |
| `.empty-state` | `--panel` ground, **1px dashed** `--outline-variant`, 12px radius, 40px/24px padding, centred column: `.empty-state-headline` 20px/600 then `.empty-state-detail` prose ≤52ch |
| `.empty-note` | A bare paragraph in `--on-surface-variant`, 14px / 20px, ≤52ch — a small emptiness inside a panel |
| `.coverage-note` | 12px / 16px in `--on-surface-variant` — the caption under a figure or a table |
| `.form-note` / `.field-note` | 12px / 16px in `--on-surface-variant` — what a form is about to do, said *before* it is submitted |
| `.field-error` / `.form-error` | 14px / 20px in `--loss` |
| `.first-run` | `--secondary-container` ground, 1px `--outline-variant`, 12px radius — informational, not a warning |
| `.open-instance-banner` | The warning precedent: full-bleed row, `--warning-surface` ground, `--warning` text, bottom hairline, 14px / 20px |
| `.u-data` / `.u-label` | `tabular-nums` / label-md in `--on-surface-variant` |
| `.breadcrumb` | 14px, `--on-surface-variant`, "/" separators |
| `.visually-hidden` | Clipped, not `display:none` — for a `th` that has no visible label |

---

## 3. Screen 1 — the filter bar

**Purpose.** Cut the table down to the question being asked. Seven dimensions, one `<select>` each,
all seven optional and all seven combinable.

**Shape.** A `.panel` whose only child is `<form method="get" class="filter-bar">`. **No panel
header** — seven labelled controls announce themselves, and a "Filters" title above a row of things
plainly labelled *Owner*, *Account*, *Brokerage* is a word explaining a word. The form follows
`.panel-form`'s rule set exactly: flex, wrap, 16px gap, 24px padding, every
control 40px tall so that a wrapped second line still aligns with the first. `.filter-bar` keeps its
own `align-items: flex-end`, which it can because no filter carries a note under it — the bottom of
a filter *is* the bottom of its control.

Each control is a `<select>` **nested inside its `<label>`**, not paired by `for`/`id` — the house
convention, and the reason the caption sits exactly 4px above its box with no extra rule. Draw the
caption in body-sm `--on-surface`, the box with a **1px `--outline`** border, 8px radius, `--panel`
ground, and the native disclosure arrow in `currentColor`.

| Dimension | Caption | Options are |
|---|---|---|
| person | "Owner" | Every person who owns at least one held account |
| account | "Account" | Every open account holding at least one position |
| institution | "Brokerage" | Every distinct institution across those accounts |
| kind | "Account type" | Brokerage · Workplace plan (401k, 403b) · IRA · Bank · Loan or other liability |
| tax_treatment | "Tax treatment" | Taxable · Tax-deferred · Tax-free |
| classification | "Classification" | The household's own labels — "Large blend", "Target-date 2045" |
| asset_class | "Asset class" | Equity · Bonds · Cash · Other |

Every list carries a leading `All owners` / `All accounts` / … option, which is the no-filter state
and the value the "Clear filters" link restores.

**The rule that shapes this bar: a filter is only rendered if its dimension has at least two
distinct values in the data.** A one-person household never sees an Owner select. A family that
banks entirely at Fidelity never sees Brokerage. A select with one option cannot discriminate — it
is a control whose every setting produces the same table — and drawing it costs a row of vertical
space, a tab stop and a moment's reading to conclude it is useless. **This is the constructive
answer to §13.7's refusal of account search**, which is stated there as "a filter over twelve rows
is a control that costs more than it saves": the principle is not *never filter*, it is *a control
that cannot discriminate is not drawn*.

**Every option list is built from the data actually present**, not from the schema's enum, so **no
single filter can select an empty result**. Draw the bar twice, side by side: a household with two
people at three brokerages gets seven selects; a single person with one taxable brokerage account
gets **three** — Classification, Asset class, and nothing else — and the panel is one line tall.

**Actions.** A `.filter-actions` group closes the row: a filled `.button` reading "Apply", and —
**only when at least one filter is set** — a `.button--text` reading "Clear filters" pointing at
the bare `/holdings` URL. The two are grouped so they wrap as a unit; "Clear filters" orphaned onto
its own line reads as a page-level action rather than this form's escape hatch.

**Why a submit button at all, when a `<select>` could submit on change.** On change needs
JavaScript. This form works with JavaScript off, and it also lets someone set three filters before
the page reloads once instead of three times.

**State lives in the URL.** Applying writes `?owner=…&account=…&class=…`; the selects render their
`selected` option from those params on the way back. That is the same contract the range control on
Overview already establishes, and the same reason: *a chosen range survives a reload and can be
bookmarked*. A filtered Holdings URL is a shareable answer — "here is everything of Sam's in the
401k" — and no client state can be that.

---

## 4. Screen 2 — the group-by strip and the grouped table

### 4.1 The strip

A `.u-label` reading "GROUP BY" and, under it, `<nav class="segmented" aria-label="Group by">` — the
**existing range control**, chip for chip. Anchors, never buttons; each writes a `group=` search
param onto the current URL, preserving every filter param; the active chip carries
`aria-current="true"` and takes the `--primary-container` fill.

Eight chips: **None · Owner · Account · Brokerage · Type · Tax · Classification · Asset class.**
"None" is the default and links to the URL with `group` removed rather than to `?group=none`, so
the default state has one canonical URL.

The strip sits **on the canvas between the filter panel and the table panel**, not inside a
`.panel-header`. Eight chips beside a `.panel-title` is a header that wraps to three lines at
1024px; Overview and Account Details each put four there, and four is the width that slot holds.

Below 768px the strip **scrolls sideways and never wraps** — `flex-wrap: nowrap; overflow-x: auto`,
4px gap — exactly as `.segmented` already behaves. Draw it at 390px with "Classification" and
"Asset class" cut off at the right edge, because that is what it does.

### 4.2 Grouping renders in-table, never as separate panels

**One `<tbody>` per group**, each opening with a group header row and closing with a subtotal row.
The `<thead>` is drawn once, at the top, and never repeated.

*Why not a panel per group.* Separate tables get independent column widths. Eight panels each
sizing "Asset" to its own longest instrument name gives eight tables whose Value columns start at
eight different x-positions, and the one thing a reader does with a grouped financial table is run
their eye down a column comparing figures. One table, many `tbody`s, one set of column widths.

**Group header row** — `<tr class="row-group">` holding a single `<th scope="rowgroup">` spanning
every column of the table, §6's trailing actions column included. Inside it, the group's name in
body-sm weight 600 on a `--surface-container-high` ground, with a `.cell-sub` count beside it
("7 holdings"). It carries **no figures**. Every number the group reports lands on the subtotal
row, under its own column; money on a header row appears at a different x-position from the same
money on every other row.

**Subtotal row** — `<tr class="row-subtotal">`, a tonal step up from the body rows and separated by
a 1px `--outline-variant` top border:

- `<th scope="row" colspan="5">` spanning Asset · Account · Owner · Quantity · Price, reading
  "Fidelity Brokerage subtotal", with a `.cell-sub` under it carrying **the group's share of the
  filtered total** — "18.4% of $1,204,880 in gross assets".
- Then three `.is-numeric` cells: **Value · Cost basis · Unrealized**, each under its own column,
  and one empty `.is-actions` cell after them so the row reaches the table's right edge (§6.2).

Quantity and Price are inside the colspan and deliberately have no subtotal. Summing quantities
across instruments adds shares of VTI to shares of a bond fund, and averaging prices is a figure
nothing in the schema means. A blank cell would invite someone to fill it.

**Groups are ordered largest subtotal first**, ties broken on the label so two equal groups cannot
swap places between one render and the next. Sorting a column sorts **within** each group; it never
reorders the groups themselves, because the group order is a fact about size and the column sort is
a question about rows.

**The column you grouped by is dropped from the table.** Grouping by owner puts the owner's name in
the heading above the group, so repeating it on all fourteen rows underneath says nothing and costs
the Asset column width it badly needs — draw the grouped-by-owner variant with **seven** columns,
not eight. The same applies to grouping by account. No other dimension has a column of its own:
brokerage rides as a sub-line under the account, classification as a sub-line under the instrument,
and account type, tax treatment and asset class have no column at all, so those five groupings keep
all eight columns. This is why the group header row's colspan and the subtotal's are drawn from the
column count rather than written as `8` and `5` — and why adding §6's actions column changed the
first of them and neither of the two rules above.

### 4.3 The share, and what it is a share of

**Shares are of gross assets, not of the net total**, and the note must say which denominator it
used. This is `allocation.ts`'s rule: the net total fails twice. Where debts nearly cancel assets
the shares explode — a $500k house against a $490k mortgage makes the house 5,000% of the portfolio
— and for a household in net debt the denominator itself goes negative and every asset reports a
negative share. So the denominator is the **sum of the positive groups**. Consequences, all
intended and all visible in the drawing:

- The positive groups' shares sum to 100%, so nothing needs a residual row.
- **A liability's share is negative** — "−12.4% of gross assets" — a finite, signed figure that
  keeps its meaning as net worth crosses zero. Draw a mortgage group showing exactly this.
- When nothing in the filtered set is positive there is no base to be a fraction of; every share
  reads `—` and the amounts stand alone.

The denominator is named once, in the `.coverage-note` under the table, not repeated on every row.

### 4.4 The `<tfoot>` grand total

`<tr class="row-total">` inside `<tfoot>`: `<th scope="row" colspan="5">Total</th>` then Value, Cost
basis and Unrealized aligned under their columns, then an empty `.is-actions` cell, weight 600,
`--surface-container-high` ground, a 1px `--outline-variant` top border. In `<tfoot>` and not as a last `<tbody>` row, so a screen reader
announces it as a summary, and so no future sort can move it into the middle of the table.

The grand total is the **filtered** total. When a filter is active the `.panel-count` says so:
"12 holdings · 2 accounts · filtered from 42".

---

## 5. Screen 3 — the table itself, column by column

`div.data-table-scroll > table.data-table`, a **direct child of `.panel`** with no `.panel-body`
between them, so the cells' own 16px padding reaches the panel edge and the header row's
`--surface-container-high` ground runs corner to corner.

The panel header carries `h2.panel-title` "Holdings" and, on the right, `.panel-count` reading
**"42 holdings · 6 accounts"**. Where the as-of timestamp of the pricing brief §3 would collide with
it, the timestamp wins the slot and the count moves under the title.

| Column | Content | Class |
|---|---|---|
| Asset | `.cell-stack`: `.badge` ticker tile, then the instrument name over a `.cell-sub` reading `classification · asset class`, plus `· never priced` or `· price is stale` when either applies | |
| Account | A `Link` to `/accounts/:id` in `--primary`, over a `.cell-sub` reading `institution · account kind` | |
| Owner | The person's name, plain text | |
| Quantity | `145.234` — trailing storage zeros trimmed, thousands grouped, U+2212 for a negative | `.is-numeric` |
| Price | `$482.10`, or `—` when never priced | `.is-numeric` |
| Value | `$70,017.31`, or `—` | `.is-numeric` |
| Cost basis | `$61,596.81`, or `—` when the statement carried none | `.is-numeric` |
| Unrealized | `.cell-change` inside the cell: 14px arrow + `+$8,420.50 (13.6%)` in `.delta .delta--bare`, or `—` | `.is-numeric` |
| *(no heading)* | One `.row-edit` Correct control per body row, and nothing at all on a group header, a subtotal or the grand total. The `th` carries a `.visually-hidden` "Correct" | `.is-actions` |

`.is-numeric` goes on the **`th` and the `td`**. The `th` rule supplies the right alignment; the
`td` rule supplies alignment, tabular figures and weight 600. Put it on one and the header sits over
the wrong edge of its own column.

**The trailing column is the editor's, and it is a column like any other.** `.is-actions` goes on
the `th` and the `td` for the same reason `.is-numeric` does, and takes `width: 1%` — the table
idiom for "as narrow as your content" — 8px of left padding, right-aligned and nowrap, so every
other column keeps the width it had. It has **no visible heading** and **no sort link**: it holds a
control rather than data. **The group header row's colspan counts it, and the subtotal rows and the
`<tfoot>` total each carry one empty cell in it**, so the columns line up to the last row of the
table. Everything the column does is §6.

**No badge for an instrument with no public ticker** — a 401k collective investment trust, a
hand-entered fund. The `.cell-stack` simply starts with the name. A placeholder inside a
ticker-shaped chip reads as a ticker.

**The Asset sub-line is the app's existing string, extended.** Account detail already renders
`asset class · never priced` / `asset class · price is stale`, middot-joined; Holdings prepends the
classification, giving `Large blend · Equity · price is stale`. Dress that string; do not reword it,
and do not invent a second vocabulary for the same two states.

**Column headers are sort links.** Each `th` holds an `<a>` carrying the column's label and writing
`?sort=value&dir=desc` onto the current URL, preserving every filter and the group. The active
column's `th` takes **`aria-sort="ascending"` or `aria-sort="descending"`**, sets its label in
`--on-surface` rather than `--on-surface-variant`, and shows a **12px caret** in `currentColor`
after the label. Inactive columns show **no caret at all** — a dimmed caret on all eight reads as
eight active sorts. **Default is Value, descending**, which is the order the question "what do we
hold" is actually asked in.

**Draw these five row states side by side**, in one table, so every treatment is visible at once:

1. **Fully priced, with cost basis** — VTI · badge · "Vanguard Total Stock Market ETF" ·
   `Large blend · Equity` · 145.234 · $482.10 · $70,017.31 · $61,596.81 · `↑ +$8,420.50 (13.6%)` in
   `--gain`.
2. **Priced, with NO cost basis** — a 401k position: no badge, "Vanguard Target Retirement 2045
   Trust II" · `Target-date 2045 · Other` · 812.400 · $52.41 · $42,577.88 · **`—`** ·
   **`—`**. This is the ordinary case, not an error: a workplace statement routinely prices a
   holding and omits what it cost.
3. **Stale price** — BND · `Aggregate · Bonds · price is stale`, the sub-line in `--warning` with a
   14px warning glyph. The price and value cells stay `--on-surface`: the figure is old, not wrong,
   and colouring it says the wrong thing. Per-row treatment is the pricing brief §4.2 and is not
   redefined here.
4. **Never priced** — no badge, `Private fund · Other · never priced`, and `—` in Price, Value,
   Cost basis and Unrealized. It is in the table and out of every total, and the coverage note under
   the table is what says how many.
5. **A liability, with a negative quantity** — "Mortgage — 123 Maple St" · `Loan · Other` ·
   **−1.000** · $412,880.00 · **−$412,880.00** · `—` · `—`. The minus is **U+2212**, not a hyphen,
   in the quantity and in the money alike.

**Three rules the row set exists to prove.**

- **A zero and an absence never look alike.** A null price, value, cost basis or unrealized renders
  **`—`** (em dash). Never `$0.00`. A zero on a finance page is a claim.
- **Never coerce a null cost basis to zero.** Doing so reports the entire untracked position as
  gain: a $42,577 holding with no recorded basis becomes a $42,577 profit. That is not a rounding
  problem, it is a fabricated number at full size.
- **Never colour alone.** Every unrealized figure carries its **sign first** (U+2212 for a loss, not
  a hyphen), **then the direction arrow**, **then the hue**. Read in greyscale, the column still
  says everything it needs to.

**Why `.delta--bare` and not the pill.** The tinted `.delta` pill is for a header, where one figure
carries the page. Forty tinted pills stacked down a column is a striped table nobody can read the
figures out of. And the arrow-plus-figure goes in `.cell-change` **inside** the `td`, never on the
`td` itself: `display: flex` on a table cell drops it out of the table layout and un-aligns the
whole column.

**Coverage sentences** live in a `.panel-body > p.coverage-note` beneath the table — see §7.3. On
a table this wide, `.data-table-scroll` is what handles overflow between 768px and about 1100px; the
page body never scrolls sideways.

---

## 6. Screen 4 — correcting one position, in place

**Purpose.** A statement arrives quarterly and a position changes weekly. Between the two is a gap
the upload flow is too heavy to fill: a 401k contribution added eleven units to one fund, and
mapping columns across four screens to say so is more ceremony than the fact deserves. DESIGN.md
§5.4's answer is **one row of this table, opened in place, with two boxes in it** — the only write
on this screen and its only per-row control.

**Nothing here is a new component.** The boxes are the app's `input`, the buttons are
`.button--quiet` and `.button--text`, the sentence beneath is `.form-note` and a refusal is
`.field-error` — every one of them already in §2. What is new is only that they occur inside a
table row, and everything below is about where they sit rather than about what they look like.

**What saving does, because it decides every word of the copy.** The write **appends; it never
edits.** Correcting a figure in place would silently restate every net-worth figure back to the
date of the statement the number landed in — March would move because an August typo was fixed,
with nothing on any screen saying so. So a correction records a **new statement for that account,
dated today, carrying every other position in it forward unchanged**, and the statement it corrects
stays exactly where it is, still speaking for its own dates. That is not what "edit" usually means,
which is why §6.5 says it out loud before the click rather than after it.

### 6.1 How it opens, and how it closes

One search param: **`?edit=<accountId>.<instrumentId>`** — `?edit=12.7`. "Editable cells" would be a
piece of client state per row and a table where any figure is one mis-click from being overwritten;
`?edit=12.7` is a **link**. It opens exactly one row, it survives a reload, it works with
JavaScript off, and §0's no-client-state constraint holds with no exception carved for it.

`edit`, and its companion `saved`, are **deliberately not part of the canonical query** that the
filter bar, the group-by strip and the sort headers build. Every one of those controls is an anchor
built from that query, so every one of them drops both params: **touching any control on the screen
closes the editor.** Filtering while a row is open must not carry a half-typed correction into a
different view.

Which means there is nothing to warn anybody about. Draw **no** unsaved-changes badge, no
confirm-on-leave, no dirty-state dot — §9.

Cancel is an **anchor** back to the bare view. Save is the form's submit. There is no third control,
and there is no way to open a second row without closing this one.

### 6.2 The trailing column, and the control at rest

The table gains **one more column at the right-hand end** — a ninth, or an eighth under the two
groupings of §4.2 that drop a column. It sorts by nothing and sums to nothing.

Its `th` has **no visible heading**: a `.visually-hidden` "Correct" and nothing else. A word over a
column of icons is a heading for a control rather than for data, and on the phone the head row is a
strip of sort links (§8) where it would read as a ninth one. The column takes `.is-actions` on the
`th` **and** the `td`, exactly as `.is-numeric` does: `width: 1%` — the table idiom for "as narrow
as your content", since a `td` will not go below its content's width — **no** left padding,
right-aligned, nowrap. Every pixel this column takes comes out of the Asset column, which is the one
that wraps, so it takes the control's width and the table's own right margin and nothing else.

**Every row carries one, including the rows with nothing to put in it.** The group header row's
colspan counts it, and the subtotal rows and the `<tfoot>` grand total each hold an empty trailing
cell. Draw them. A column that stops three rows from the bottom is a table whose columns stop
lining up at exactly the point a reader is comparing a subtotal against the rows above it.

**The control.** A pencil — `EditIcon`, an 18px inline SVG stroked in `currentColor`, §0's icon
rule unchanged — centred in a 32×32 `.row-edit` target with `--radius` corners, drawn in
`--on-surface-variant`. It is **`opacity: 0` at rest** and fades to 1 on **row hover** and on
**`:focus`** — over 120ms, the only transition on this screen. A pencil printed on all forty rows is
forty pieces of chrome competing with the figures the table exists to show. Note `:focus` and not
`:focus-visible`, and the distinction is the whole accessibility of the control: `:focus-visible`
decides whether to paint a ring on something already on the screen, whereas here the reveal *is* the
control, so a heuristic that withholds it leaves the pencil focused, operable by Enter, and
invisible. On hover the target takes a `--surface-container-high` ground and the icon goes to
`--on-surface`.

**Under `@media (hover: none)` it is always visible.** Touch has no hover, and the phone is the one
device DESIGN.md §11 permits a write on; a fade there is a control nobody can find.

Draw the column twice, side by side: a table at rest, with **no pencil anywhere**, and the same
table with the pointer on the third row, with **exactly one**.

### 6.3 The open row, column by column

**Exactly one row is open, ever.** It keeps its `--panel-hover` ground **even when the pointer is
elsewhere** — it is the row being acted on, and losing the tint on mouse-out would make the one row
that is different look like every other.

Two cells become boxes, **in their own columns**:

| Column | While the row is open |
|---|---|
| Asset · Account · Owner | Unchanged — badge, links and sub-lines exactly as §5 draws them |
| Quantity | `input.cell-input`, autofocused, prefilled with what the cell was printing |
| Price | **Unchanged.** The stored figure stays on screen |
| Value | **Unchanged** |
| Cost basis | The same `input.cell-input`, placeholder `per share` |
| Unrealized | **Unchanged** |
| *(actions)* | Empty. The pencil is the resting state of this cell and an open row has no pencil; Save and Cancel are in the line beneath (§6.5) |

`.cell-input` is §2's `input` inside a cell: full width of its column, `min-width: 6rem`, **32px
tall rather than the standard 40px `--control-h`**, right-aligned, `font-variant-numeric:
tabular-nums`. The border stays 1px `--outline` and the focus ring stays 2px `--primary`; nothing
about the control's identity changes, only its height and its alignment. **The 32px is load-bearing
and not a style**: a row that grew by 40px on open would shove the rest of the table down the
screen at the moment the reader is looking at it.

**The digits being typed line up with the digits above and below them.** That is the whole reason
the editor sits in the columns rather than in a panel underneath the table: a correction is checked
against its neighbours, and a quantity in a left-aligned box on a card somewhere is a number with
nothing to be checked against.

**The box opens on exactly the string the cell was printing** — `145.234`, never
`145.23400000`. A liability opens carrying its sign: the mortgage row of §5 opens on **`−1.000`**,
and a five-figure one opens on **`−14,500`**, thousands separator and all. The minus is **U+2212**
inside the box for the same reason it is U+2212 in the cell (§9); the parser was written to take
back the spelling the column prints.

**Never `type="number"`.** The box is `type="text"` with `inputMode="decimal"`, so a phone still
gets a numeric keypad. A number input silently discards what it cannot parse, so a pasted
`1,250.00` arrives as an empty string and the household is told a quantity is required.

**The asymmetry worth drawing.** The Cost basis column prints the **whole position's** basis; the
box takes **one share's**. The figure in the box will not match the figure that was in the cell,
and nothing else on the row explains that — which is why this box alone carries a `per share`
placeholder and why its `aria-label` says "per share" as well.

**Price, Value and Unrealized keep their stored figures while the row is open.** They are the
reference the correction is being made against. Blanking them, or projecting them from a half-typed
quantity, would replace the reference with a guess at the exact moment it is being read.

### 6.4 Why the boxes and the `<form>` are in different rows

The one genuinely unusual piece of markup on this screen, and the design has to know about it
because it decides where things sit.

**A `<form>` cannot wrap a `<tr>`.** The table content model forbids it — the only legal place for
a form inside a table is inside a cell. And putting the whole editor into a single cell would take
the quantity out of the Quantity column and out of its right-aligned tabular figures, which is most
of what §6.3 is for.

So the `<form>` sits **in the line beneath the open row** (§6.5), and the two boxes join it from
their own cells by the HTML **`form="revise-position"`** attribute, which associates a control with
a form regardless of where either sits in the document. Draw three cells across two rows that
behave as one control. Do not "fix" this by collapsing the editor into one cell, by drawing a form
outline around the row, or by adding a hidden field naming the row — the row's identity is in the
URL the form posts back to.

**Why not the actions cell**, which is where the buttons started. That column is sized by
`width: 1%` to the 32px control it holds at rest, and two buttons in it widen the table past its
panel — which puts the whole screen into a horizontal scroll to reach a Save button, on the one
interaction that is supposed to be quick. The line beneath is already full width, so the buttons
cost nothing there.

And note what `.row-actions` is not: the inline-flex is on the **`<form>`**, never on the `td`
(§9).

### 6.5 The line under an open row

Directly beneath the open row, a **full-width row** — `.row-note`, one `td` spanning every column —
sharing the open row's `--panel-hover` ground with **`border-top: 0`**, so the two read as one
block rather than as a row and its neighbour. A caption inside the actions cell was not an option:
the sentence is about the whole correction and the cell is 32px wide.

**It is the editor's footer, and it has two halves.** A `.row-editor` flex row: the words on the
leading edge, taking the room they need (`flex: 1 1 20rem; min-width: 0`, so a long refusal wraps
rather than pushing the buttons off the table), and on the trailing edge the `<form>` itself,
carrying **Save** (`.button--quiet`) and **Cancel** (`.button--text`, an anchor back to the bare
view) in a `.row-actions` inline-flex. Both halves sit inside the one `td`, never on it (§9).

The words are one of the following.

**The explanation, before the click** — a `.form-note`, 12px / 16px in `--on-surface-variant`:

> "Saving records a new statement for **Fidelity Brokerage**, dated **20 Aug 2026**, carrying every
> other position in it forward unchanged. The current one is kept on its own date, so nothing
> already recorded moves."

Said **before** the click and not after it. A reader expecting one number to be overwritten would
not expect a statement dated today carrying every other position in the account, and the moment to
say so is while the choice is still open. The date is today's, read from the server rather than
from the reader's clock, so the sentence names the date the write will actually carry.

**Or every refusal**, as `.field-error` paragraphs — 14px / 20px in `--loss`, `role="alert"` —
**replacing** the note rather than sitting under it, in a fixed order: the form-level one first,
then Quantity, then Cost basis. Form-level refusals are about the account rather than about the
figures: *"Fidelity Brokerage is closed, and a closed account's history does not change."* and
*"Fidelity Brokerage changed while this form was open, so nothing was recorded."* Per-field ones
are about a box: *"A quantity must be a number, like 120.5 — or −8,000 for something owed."* One is
about the pair: a quantity and a cost basis can each be a legal figure while their product is one no
column in this application can hold, and the refusal says so rather than letting the write succeed
and the page break.

Draw the longest one. *"That cost basis multiplied by this quantity is a larger figure than this
application can hold. Check both boxes — a cost basis is what one share cost, not what the whole
position did."* is three lines at this width, and the footer has to hold it without pushing Save off
the table.

**Per-field refusals go here too, not under their own box**, and the reason is the layout: the
boxes are in table columns, and *"A quantity must be a number, like 120.5 — or −8,000 for something
owed."* set in a 6rem-wide Quantity column either wraps to five lines or widens the column and
shifts every figure in the table sideways — and it does whichever it does at the moment the reader
is trying to read it. The full-width line has room for the sentence.

**What keeps a message attached to its box** is therefore not proximity. The refused box carries
`aria-invalid="true"` and an `aria-describedby` pointing at its own message, and it is drawn with a
**2px `--loss` border** — the one new global rule this screen adds, and the second channel §9's
never-colour-alone rule asks for, since the border thickens as well as changing hue. The focus ring
still wins while the box is focused: where the cursor is, is the more urgent of the two facts.

**A refusal never costs the entry**: the boxes re-render carrying the submitted strings, not the
stored ones.

### 6.6 The receipt

After a successful save the row **closes** and the URL becomes **`?saved=12.7`**. A `.row-note` row
carrying `role="status"` appears beneath the now-closed, now-updated row:

> "Recorded. **Fidelity Brokerage** now reads **156.234** of Vanguard Total Stock Market ETF."

**Every figure in that sentence is read back out of the database**, never taken from the URL.
`?saved=` names *which* row was written and says nothing about what was written to it, so a
hand-typed parameter can only ever produce a sentence describing what the account actually holds —
the same guarantee Account detail's `?recorded=` has. The quantity is set in `.u-data`, because it
is a figure.

A receipt **supersedes** an editor rather than sitting beside one: after a save there is no open
row, and the pencil is back where it was.

No toast, no modal, no green flash, no row that pulses and fades (§9). The confirmation is a
sentence in the place the thing happened, and it stays there until the next navigation.

### 6.7 The seven states to draw

In one table, so every treatment is visible at once:

1. **At rest** — forty rows, the actions column present and **empty of any visible mark**.
2. **Hovered** — one pencil, on one row.
3. **Focused by keyboard** — the same pencil, at full opacity, carrying the app's focus ring, with
   the pointer nowhere near it.
4. **Open, clean** — VTI: two boxes in their own columns, Price · Value · Unrealized still printing
   their figures, the last cell empty, and beneath it the footer — the `.form-note` sentence on
   the left, Save and Cancel on the right.
5. **Open, refused per-field** — the Quantity box carrying its 2px `--loss` border and the typed
   figure it was refused for, and the sign-flip message in the footer **in place of** the note,
   with Save and Cancel still beside it.
6. **Open, refused at form level** — the same footer, carrying an account-level `.field-error`
   instead, and both boxes drawn normally.
7. **Saved** — the row closed and reading its new quantity, the receipt beneath it, no boxes
   anywhere on the table.

And one more beside them: **a liability open**, with `−1.000` in the Quantity box, to prove that the
minus survives into the control.

---

## 7. Screen 5 — the three empty and partial states

**The empty result of a filter is not the empty state of the app.** These are three different
sentences about three different situations, and drawing one of them for another is a lie the reader
has no way to check.

### 7.1 Nothing uploaded at all

The existing `.empty-state`: dashed `--outline-variant` panel, 40px/24px padding, centred,
`.empty-state-headline` reading **"There is no data yet."** and a `.empty-state-detail` reading
"Every position across every account is listed here, grouped and filterable. Nothing has been
uploaded to this instance yet."

**No filter bar and no group-by strip are drawn at all.** There is nothing to discriminate between,
and §3's rule applies to the whole bar as much as to one select. No table, no header row, no zeros.

### 7.2 Holdings exist, but the filter matched none

The filter bar and the strip stay exactly as they are, with their settings intact — the reader has
to be able to see what they asked for in order to undo it. The table panel keeps its
`.panel-header`, and its body is a `.panel-body` containing a `.empty-note` and a `.button--text`
"Clear filters":

> **"No holding matches these filters."** 42 holdings are recorded, across 6 accounts. Owner *Sam
> Taylor* and Brokerage *Fidelity* have no account in common.

**No table header row over nothing** — a header row is a promise of rows. And this must **not** say
"There is no data yet", which would be false and alarming in exactly the way §8.4's zero-versus-empty
rule is written to prevent.

This state exists despite §3's option-list rule because no *single* filter can select nothing but a
*combination* can — Sam owns accounts, Fidelity holds accounts, Sam has no Fidelity account. The
sentence names the pair rather than saying "no results", because the pair is what has to change.

### 7.3 Partial coverage — three coverages, not one

**Value coverage and cost-basis coverage are different counts, and both are different from the row
count.** A 401k holding is routinely priced *and* has no cost basis, because the statement omits
it. Reporting one number for "coverage" merges two unrelated doubts.

**Each summed figure carries its own count directly beneath it**, as a `.cell-sub` on the subtotal
and total cells — "11 of 18" under a partial cost basis, nothing under a complete column. This is
not a duplicate of the sentence below the table; it is the same fact at the point where it is
needed. The three totals sit side by side and invite subtraction, and a cost basis summed over
eleven holdings printed flush against a value summed over seventeen reads as a $428,000 gain that
nothing in the database supports. Draw the caption on the partial columns only: a caption under
every cell is noise, and its absence is the claim that nothing is missing.

**Where the figure itself is `—`, the caption is omitted** — the dash already says nothing is
known, and "0 of 1" beneath it says it twice. The caption exists for the *partial* case, which is
the one a dash cannot express.

The `.coverage-note` under the table, 12px / 16px in `--on-surface-variant`, states each separately:

> **"Value is 40 of 42 holdings. Unrealized is 31 of 42 — the rest have no cost basis recorded.
> Shares are of $1,204,880 in gross assets."**

Draw it in all four combinations: full value and full basis (**the note is absent entirely** — a
line saying "42 of 42" is noise); full value, partial basis; partial value, partial basis; and
nothing valued at all. Coverage is a **caption, not a warning**: it is normal, expected and quiet,
and it takes `--on-surface-variant` rather than the amber. Staleness is the warning, it takes
`--warning`, and when both apply the coverage line comes first and the stale line second. Never
merge them into one amber sentence; they are two different doubts.

### 7.4 A group whose holdings are all unpriced

The fourth state, and the one that catches people: a group can be non-empty and still have nothing
to sum. **Its subtotal renders `—`, not `$0.00`**, and its share renders `—` too, because it has no
value to be a fraction of. The group header still reports its row count, so the group has not
apparently vanished, and the rows inside it are drawn normally with their own dashes.

Draw a "Bank" group of four never-priced holdings directly above a fully valued group, so the
difference between *nothing here* and *nothing yet known here* is visible in one glance.

---

## 8. Component 6 — the mobile card reflow

**<768px, the table reflows to cards by CSS, on the same markup.** One DOM tree, not two. `table`,
`thead`, `tbody`, `tr` and `td` take `display: block`; each `tr` becomes a card divided from the
next by a 1px `--outline-variant` rule inside the panel, 16px padding; each `td` becomes a labelled
row whose caption comes from a `data-label` attribute rendered in a `::before` at 12px / 16px in
`--on-surface-variant`.

**`<thead>` stays visible, as a wrapped strip of sort links** on a `--surface-container-high`
ground at the head of the panel — it is not clipped away. Hiding it would be the tidier rule and it
would take sorting off the phone entirely, which is exactly where "what is my largest position" is
most likely to be asked. The headings stop being a row and become what they are on a phone: the
controls. Draw them as a two-line wrapped strip, `Asset · Account · Owner · Quantity · Price ·
Value ▼ · Cost basis · Unrealized`, with the active one carrying its caret. **Eight labels, not
nine**: the actions heading of §6.2 is `.visually-hidden` and contributes nothing to the strip,
because it never named data and there is nothing to sort by.

**Why not a second component.** A separate mobile tree is two renderings of one query that can
disagree, and it is the disagreement — not the layout — that is expensive. It also builds the sort
links, the group headers and the subtotals twice.

**Draw the card at 390px.**

- **The card leads with the asset and the value**, side by side: the `.badge` and instrument name
  on the left, the value right-aligned at body-lg weight 600. That is the pair a phone is opened to
  read.
- Under it, the `.cell-sub` classification line, full width, wrapping under the name.
- Then the remaining fields as labelled rows, label left in `--on-surface-variant`, figure right in
  `.u-data`: **Account · Owner · Quantity · Price · Cost basis · Unrealized**. A field whose value
  is null still draws its row, with `—`; hiding it would make an absence look like a field that
  does not exist.
- **Group header rows and subtotal rows keep their block treatment** rather than becoming cards: the
  header is a full-width `--surface-container-high` strip with the group name and count, and the
  subtotal is a strip below the last card carrying Value, Cost basis, Unrealized and the share as
  labelled rows. The `<tfoot>` total does the same, one tonal step up.
- The filter bar goes **two fields to a row**, not one. Seven stacked full-width controls is most
  of a phone screen consumed before the table they filter has started; two-up halves it to four
  rows, and a `select` is legible at half of 390px. `.filter-actions` loses its `margin-left: auto`
  and wraps in as the last cell.
- `.panel-header` stacks, so the title sits over the count.

**The correction, on a card.** The phone is the one device DESIGN.md §11 permits a write on, so the
editor is not dropped at 767px — it is re-laid-out.

- **The pencil is always visible** (`@media (hover: none)`, §6.2). There is no hover on a touch
  screen, and a control that appears on approach appears never.
- **The actions cell loses its `data-label` and its right edge and becomes the card's last line**,
  which is where a card's actions belong. An empty one — on a subtotal, on the grand total — is
  `display: none`, so it opens no gap under the figures.
- **Each box takes a line of its own, with its label above it rather than beside it, and goes
  left-aligned.** A box sharing its line with its label would be a third of a phone wide. This is
  the one place the right-aligned tabular rule of §6.3 is dropped, and it is dropped because the
  column it aligned against no longer exists: the card is one field per line.
- **The note becomes the card's own last line rather than a row of its own.** At 390px the sentence
  is four lines, and the padding between two cards would read as a break in the middle of one
  correction. Same `.form-note` type, same ground, no border between it and the card above it.
- The receipt does the same, under the card whose figure it is confirming.

**Tap-to-expand is deferred, and the brief says so rather than drawing a control that does not
exist.** §8.1 asks for "a card list with a few fields visible and tap-to-expand". `<details>` cannot
wrap a `<tr>` — the table content model forbids it, and reflowing to `display: block` does not
change what the parser built — and the app has **no client JavaScript** to open a card with. So
every card shows every field. The cost is a taller scroll; the alternative is either a second DOM
tree or the app's first client hook, and neither is worth it for a screen whose primary use is a
desktop one. Revisit it when something else in the app forces client JS.

---

## 9. Do not

1. **Never render a figure where a value is missing.** A null price, value, cost basis, unrealized
   or subtotal renders `—`. No `$0.00`, no "N/A", no blank cell that could be read as a zero.
2. **Never coerce a null cost basis to zero.** It reports a fake gain equal to the whole untracked
   position, at full size, in the same colour as a real one.
3. **Never carry gain, loss or staleness in colour alone.** Sign, then arrow, then hue — in that
   order. The minus is U+2212, never a hyphen. Every stale thing carries the word "stale".
4. **Never say "There is no data yet" for a filter that matched nothing.** Three states, three
   sentences, and the middle one names the filter pair that produced the emptiness.
5. **Never draw a filter whose dimension has fewer than two values**, and never populate an option
   list from the schema instead of from the data. A control that cannot discriminate is not drawn.
6. **No search box** — not over accounts, not over instruments, not over holdings. §13.7 refuses it
   and §0 explains why `instrument` is the one dimension of the eight this screen does not filter on.
7. **No client-side filtering, sorting or grouping.** Every one of those is a URL. A state that
   cannot be bookmarked, reloaded or linked to is a state this app does not keep.
8. **No separate panel per group**, ever. Independent column widths defeat the only thing a grouped
   financial table is for.
9. **Never put `display: flex` on a `td`.** It drops the cell out of the table layout and un-aligns
   the whole column. `.cell-change` exists precisely so the arrow and figure can be a flex row
   *inside* the cell.
10. **Every figure is `tabular-nums`** — `.u-data` or `.is-numeric`. Proportional digits do not
    align, and a figure that changes width as it updates makes the whole row twitch.
11. **No `--outline-variant` on a control boundary.** It is 1.5:1 and it is for hairlines. Selects,
    inputs and focus rings take `--outline`.
12. **No invented columns.** No "Today's Change" — `holding_valued` exposes today's price and
    nothing to compare it against. No time-weighted return, no risk score, no after-tax value, no
    target allocation. If a number cannot be traced to a stored column, it is not drawn.
13. **No hardcoded hex anywhere.** Every fill and stroke resolves from the tokens in §1.1 so that a
    theme change recolours the screen for free.
14. **No monospace.** There is no mono family in this app; `code` in prose is the only exception.
15. **No brokerage furniture.** No notification bell, no avatar menu, no "Add Funds", "Invest Now",
    "Deposit", "Transfer", no export button, no help icon. Single-tenant and self-hosted: there is
    no user account to hang an avatar on and nothing to buy.
16. **No toast system, no modal dialogs, no disabled buttons as an explanation.** Confirmations and
    refusals are inline text in place. A dead control explains nothing.
17. **Never open more than one row at a time.** No "edit all", no bulk save bar, no checkbox
    column, no second set of boxes anywhere on the table. One row, one correction, one URL.
18. **No dirty state, ever.** No unsaved-changes badge, no confirm-on-navigate, no Save that is
    disabled until something is typed. Every control on the screen closes the editor by design
    (§6.1), and a warning about it would be the app's first client-side state.
19. **Never draw a figure the application cannot hold.** A quantity and a cost basis can each be
    legal while their product overflows the column the value is stored in, and the write refuses the
    pair. Placeholder data must stay inside plausible household figures; a mock showing a
    sixteen-digit cost basis is drawing a state the app refuses.
20. **The editor cannot add or remove an instrument.** Which instruments an account holds is what a
    statement is for; adding one means resolving a name nobody has seen against the alias table,
    and that is the upload flow's job. No "Add holding" button on a row, no delete icon beside the
    pencil.
21. **Never let a correction flip a sign.** The sign lives in the quantity, so turning something
    held into something owed moves household net worth by twice the figure while reading as an
    ordinary correction. It is refused, with the Quantity box marked invalid and the reason in the
    line beneath the row (§6.5). Recording zero first
    and the other direction second is the deliberate two-step, and it is the only way through.
22. **A quantity of zero is stored as zero and the row stays.** It is not dropped, greyed out or
    struck through: a dropped row is unreachable from a table that no longer prints it, and only a
    fresh statement could bring it back.
23. **No date field on the editor.** A correction is about now. A past date is a statement, and a
    statement is the upload flow's job.
24. **Never blank Price, Value or Unrealized while a row is open**, and never recompute them from
    the half-typed quantity. They are the reference the correction is being checked against.
25. **Do not lift figures from the existing mock set.** Its numbers contradict each other screen to
    screen — the same ticker carries different values on desktop and mobile. Use plausible,
    internally consistent placeholder data, including at least one liability, one unpriced holding
    and one null cost basis.
26. **No third-party fonts, icon fonts or CDN assets.** The app is offline-capable and holds a
    household's finances.

---

## 10. Reconciliation notes — for the engineer syncing this back

**This screen is built.** Holdings ships with its filter bar, its group-by strip, its sortable
table, its `<768px` card reflow and — since DESIGN.md §5.4 — the single-row editor of §6. Nothing
below is a proposal any longer; it is what `app/routes/holdings.tsx` and `app/app.css` already do,
and a generated design is being reconciled *against* it rather than the other way round. Where the
two disagree, the shipped behaviour is the specification and the drawing is the thing that moves.

**The two things a generated design gets wrong, in order of likelihood.**

1. **The trailing actions column.** It is dropped, or it is drawn as an icon floating over the row
   rather than as a cell. It is a real `<td>` in a real column, and **every** row has one: the
   group header's colspan counts it, and the subtotal rows and the `<tfoot>` total each carry an
   empty one. A design that omits it on the summary rows produces a table whose columns stop lining
   up exactly where a reader is comparing a subtotal against the rows above it.
2. **The `form=` attribute.** The two boxes sit in the Quantity and Cost basis cells; the `<form>`
   sits in the line beneath; they are joined by `form="revise-position"` and by nothing else. A
   `<form>` cannot wrap a `<tr>`, so the tidy-looking fix — collapsing the editor into one cell —
   takes the quantity out of its column and out of its tabular figures, which is most of what makes
   an inline correction readable. If a generated design shows one merged editor cell, that is the
   thing to change, not the markup.

**Two things Stitch's output must not introduce**, whatever it looks like on the canvas. Both would
be the app's first piece of client-side state, and both are refused in §9: a **dirty state** — an
unsaved-changes badge, a confirm-on-navigate, a Save disabled until something is typed, an
autosave — and a **multi-row edit mode** — a second open row, an "edit all", a checkbox column, a
bulk save bar. The editor is one URL parameter naming one row, and every other control on the
screen closes it for free precisely because there is nothing to keep.

**Reuse, do not rename.** These class names already exist in `app/app.css` and are referenced by
built routes. Stitch output that renames them creates a duplicate design system:

`.page` · `.page-header` · `.page-title` · `.page-subtitle` · `.page-lede` · `.page-actions` ·
`.panel` · `.panel-header` · `.panel-title` · `.panel-count` · `.panel-body` · `.panel-form` ·
`.form-intro` · `.data-table` · `.data-table-scroll` · `.is-numeric` · `.cell-stack` · `.cell-sub` ·
`.cell-change` · `.badge` · `.delta` (+ `--gain` `--loss` `--bare` `--flat`) · `.button` (+
`--quiet` `--text` `--danger` `--block`) · `.segmented` · `.empty-state` (+ `-headline` `-detail`) ·
`.empty-note` · `.coverage-note` · `.field-note` · `.form-note` · `.field-error` · `.form-error` ·
`.breadcrumb` · `.first-run` · `.open-instance-banner` · `.legend-dot` · `.u-data` · `.u-label` ·
`.visually-hidden` · `.no-scrollbar` · and, from §6, `.is-actions` · `.row-edit` · `.row-editing` ·
`.cell-input` · `.row-editor` · `.row-actions` · `.row-note`.

**Already true in code, so match it rather than redesigning it:**

- **`.segmented` is the group-by control, unchanged.** Overview and Account detail both render it as
  `<nav className="segmented">` over `<Link>`s with `aria-current={key === range ? "true" :
  undefined}` and `preventScrollReset`. The group-by strip is that component with different labels
  and a different param; it needs no new CSS and no new behaviour, including the <768px
  sideways-scroll rule which is already in the stylesheet.
- **The row note string is now one helper.** `holdingNote()` produced `asset class · never priced` /
  `asset class · price is stale` inside `app/routes/account.tsx`; it has moved to
  `app/lib/holdings-view.ts` and both screens import it, so they cannot drift on which words a stale
  price gets. Holdings prepends `classification` at the call site. Stitch output that spells either
  phrase differently is changing shipped copy, not proposing a label.
- **`—` for a null figure is already the rule**, applied per cell in `account.tsx` for price and
  value. Extend the same conditional to cost basis and unrealized; do not centralise it into a
  formatter that could start returning `"0.00"`.
- **The gross-positive denominator is implemented.** `app/lib/allocation.ts` computes `share`
  against the sum of the positive buckets and documents why the net total is refused; the digit-level
  helpers now live in `app/lib/money.ts`. Subtotal shares must come from that code path, not from a
  second division written in the route.
- **Coverage as `{ known, total }`** is already the shape every total carries, and `analysis.tsx`
  and `account.tsx` already render "Based on N of M holdings". Holdings needs a **second** coverage
  count for cost basis; it is a new count, not a new pattern.
- **`label` already wraps its control**, and `select` already takes `--outline` at 40px. The filter
  bar inherits both with no new rules.
- **`.data-table th` is `--surface-container-high`, uppercase, nowrap** and `.data-table td.is-numeric`
  is the only rule that adds weight 600. A sort link inside the `th` must inherit that type, not
  restate it.
- **`?edit=` and `?saved=` are not part of the view object.** They are re-appended to whatever
  canonical search string the filter, group and sort state produces, and every link on the screen
  is built from that string without them — which is what makes each of those controls close the
  editor at no cost. Do not add either to the query the controls submit.
- **The editor reuses, and does not restyle, five existing things**: `input` (as `.cell-input`),
  `.button--quiet`, `.button--text`, `.form-note` and `.field-error`. The only genuinely new
  properties anywhere in it are a height, an alignment, an opacity and a `width: 1%`.
- **The refusals are `positions.server.ts`'s, word for word** — the sign flip, the closed account,
  the account that changed while the form was open. They are shipped copy with reasons behind each
  clause; output that paraphrases them is rewriting the product, not labelling a mock.
- **The receipt is rendered from a database read, not from the URL**, exactly as Account detail's
  `?recorded=` is. Any figure drawn in that sentence has to come from the row as it now stands.

**Genuinely new to this screen, and now carrying their own rules in the stylesheet:**

| New thing | Suggested name | Note |
|---|---|---|
| The filter form | `.filter-bar` | Was the same rule set as `.panel-form`; the two have since diverged, and the divergence is the answer to the question this row asked. `.filter-bar` keeps `align-items: flex-end`, which it can because no filter carries a note under it, and below 768px it goes two filters to a row at `calc(50% - 16px)` while `.panel-form` goes one field to a row at 100% and drops its padding to 16px. Folding one into the other would now cost more than it saves |
| The Apply / Clear pair | `.filter-actions` | Inline-flex, 12px gap, `align-items: center`, `margin-left: auto` at ≥768px so the pair sits at the row's end and wraps as a unit |
| Sortable column header | `.sortable` | The `<a>` inside a `th`: inherits the `th`'s type, `text-decoration: none`, `color: inherit`, 4px gap to a 12px caret in `currentColor`. Active state keys off `th[aria-sort]`, not a second class |
| Group header row | `.row-group` | Single `th[scope="rowgroup"][colspan]`, `--surface-container-high` ground, body-sm/600, count in `.cell-sub`. **No hover** — it is not a row you can act on |
| Group subtotal row | `.row-subtotal` | One tonal step up, 1px `--outline-variant` top border, weight 600, share in a `.cell-sub` inside the label cell. No hover |
| Grand total row | `.row-total` | `<tfoot>` only. Same treatment as `.row-subtotal` plus a heavier top border |
| Coverage under a summed figure | — | A `.cell-sub` inside the `.row-subtotal` / `.row-total` money cells reading "11 of 18", omitted where the figure itself is a dash. No new class; the existing `.cell-sub` in a place it has not been used before |
| Explicit ARIA roles on the table | — | `role="table" / rowgroup / row / columnheader / rowheader / cell`, matching the implicit roles exactly. Not decoration: the <768px reflow sets `display: block`, and a browser drops a table's implicit roles when it does, taking `scope` and `aria-sort` with them |
| The account link in a row | `.cell-link` | Inline-flex, `color: inherit`, `text-decoration: none` until hover, with a 16px `ChevronRightIcon` in `--on-surface-variant`. A column of permanently underlined account names competes with the figures the row exists for |
| The trailing actions column | `.is-actions` | On the `th` **and** the `td`, as `.is-numeric` is: `width: 1%`, 8px left padding, right-aligned, nowrap. Present on every row, empty on the summary ones |
| The row's Correct control | `.row-edit` | 32×32 inline-flex around an 18px `EditIcon`, `--radius`, `opacity: 0` until `tbody tr:hover` or `:focus` (**not** `:focus-visible` — the reveal is the control, not a ring on it), forced to 1 under `@media (hover: none)`. The fade is scoped to `.data-table--holdings tbody` so it cannot dim a control on one of the app's other tables |
| The open row | `.row-editing` | `--panel-hover` on its cells, restated under `:hover` so the tint does not drop when the pointer leaves the row being acted on |
| A box in a cell | `.cell-input` | `width: 100%`, `min-width: 6rem`, **32px** tall, right-aligned, `tabular-nums`. Border, radius and focus ring inherited from the bare `input` — and they must stay inherited, or the editor becomes a second control |
| The open row's footer | `.row-editor` · `.row-actions` | A flex row inside the note cell: the words leading (`flex: 1 1 20rem; min-width: 0`), the `<form>` trailing with Save and Cancel at an 8px gap. Both are **on elements inside the cell**, never on the `td`. This is not an exception to the no-flex-on-a-`td` rule; neither one is the cell |
| A refused box | `input[aria-invalid="true"]` | 2px `--loss` border. The one rule here that is **not** scoped to Holdings: every form in the application already sets the attribute and none of them drew it, and this screen is where the message and its box stop being adjacent |
| The line under an open row | `.row-note` | A `tr` whose single `td` spans the table: `padding-top: 0`, `border-top: 0`, the open row's ground, `white-space: normal`. Carries a `.form-note`, a `.field-error` `role="alert"`, or the `role="status"` receipt — one of the three, never two |
| The <768px card reflow | `.data-table--holdings` | A `@media (max-width: 767px)` block scoped by a modifier on the table, so the other three tables in the app keep scrolling sideways: `display: block` down the tree, `td::before` from `data-label`, and `thead` kept — **not** hidden — as a wrapped strip of sort links. **The largest new rule set in this brief**, and the only one with no precedent in the stylesheet. It also carries §8's editor rules: the actions cell as the card's last line, `td.is-actions:empty { display: none }`, a box on a line of its own with its label above it, and the note folded into the card rather than left as a row |

**What is deliberately not built:** tap-to-expand on mobile (§8 — `<details>` cannot wrap a `<tr>`
and there is no client JS), an instrument filter (§0 — that is a search box), and a saved-view
persister (DESIGN.md §8.3, deferred).

**The per-row action, which used to be on that list, now exists** — and its boundaries are the part
most likely to be quietly widened. The editor changes **numbers, never membership**: it cannot add
an instrument to an account, cannot remove one, cannot flip a quantity's sign, and has no date
field. A quantity of zero is stored as zero and its row keeps printing. Everything outside that is
still the upload flow's job (§9, items 19–22), and a drawing that adds a delete icon beside the
pencil or a date picker beside the boxes is proposing a different feature.

**Three token-level things to verify on sync:** every new figure carries `.u-data` or `.is-numeric`;
no new rule hardcodes a hex; and both the `prefers-color-scheme: dark` block and the
`:root[data-theme="dark"]` block are updated together, since they are duplicated by design so the
explicit toggle can beat the OS setting.
