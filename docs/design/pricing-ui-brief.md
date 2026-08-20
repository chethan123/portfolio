# Stitch brief — the pricing slice

*Paste this whole document into Google Stitch. It is self-contained; nothing here needs the
repository.*

---

## 0. Context

**The product.** A self-hosted, single-tenant web app tracking one household's portfolio and net
worth. No brokerage integration, no trading, nothing to sell. It reads statements the family
uploads, prices the holdings every 15 minutes during market hours, and answers what we have, how it
is allocated, and how it has moved. Two or three readers, on a desktop, occasionally on a phone.

**Constraints on every screen below.**

- **Desktop-first.** ≥1024px is the design target. The phone is for *reading* plus one single-field
  write — not a reflow exercise, but nothing may be hidden on it.
- **Light and dark are both first-class**, not a filter over one another. Draw every screen in both.
- **Inter only**, variable weight 400–700, self-hosted. **There is no monospace font in this app.**
  Numeric alignment comes from `font-variant-numeric: tabular-nums`, never from a mono family.
- **Icons are inline SVG**, 18–24px, stroked in `currentColor`. No icon font, no CDN.
- **This is an existing design system.** Assemble every screen from the tokens and components in §1
  and §2. Do not invent a colour, a radius, a type size or a component shape; compose from what is
  here.

**What is being designed.** The *pricing slice* — everything the interface says about where a number
came from and how old it is: the as-of timestamp, the stale-price banner and its per-row twin, the
"Refresh now" control, the Settings → Instruments tab, and coverage labelling. The existing screen
set has no settings screen, no stale indicator, no loading state, no error state and no refresh
control, so four of the five are new ground drawn in an old language.

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
| `--outline` | `#737688` | `#8d90a2` | Borders that must be *seen* (≥3:1): inputs, focus |
| `--outline-variant` | `#c3c5d9` | `#434656` | The 1px structural hairline |
| `--primary` | `#0041c8` | `#b6c4ff` | Accent text, icons, the active nav item |
| `--primary-container` | `#0055ff` | `#0055ff` | The one solid accent fill, both themes |
| `--on-primary-container` | `#ffffff` | `#e3e6ff` | Text on that fill |
| `--secondary-container` | `#d0e1fb` | `#39485a` | The active tab / nav item's ground |
| `--gain` | `#005c3e` | `#10b981` | Positive movement |
| `--loss` | `#ba1a1a` | `#f87171` | Negative movement, destructive, field errors |
| `--warning` | `#92500e` | `#fbbf24` | **Stale price, partial coverage** |
| `--warning-surface` | `#fef3c7` | `#33280a` | The ground under a warning |

Derived roles: `--panel` = `--surface-container-lowest` in light, `--surface-container` in dark.
`--panel-hover` = `--surface-container-low` in light, `--surface-container-high` in dark.
`--gain-surface` = `rgb(0 92 62 / 0.10)` light, `rgb(16 185 129 / 0.12)` dark. `--loss-surface` =
`rgb(186 26 26 / 0.10)` light, `rgb(248 113 113 / 0.12)` dark.

Charts: line `#0055ff` (3px), area a vertical gradient from the line colour at 0.25 alpha to
transparent, grid horizontal only, 1px `--outline-variant`, `stroke-dasharray: 4 4`.

Categorical sequence (fills only, reused from position 1 in every breakdown): light `#0041c8`,
`#007751`, `#505f76`, `#b6c4ff`, `#c3c5d9`; dark `#0055ff`, `#10b981`, `#b6c4ff`, `#ef4444`,
`#4edea3`. Every 12px legend dot carries a 1px `--outline-variant` ring.

### 1.2 Type — Inter, one family

| Ramp step | Size / line | Weight | Tracking | Used for |
|---|---|---|---|---|
| display-lg | 48px / 56px | 700 | −0.02em | The net-worth headline, an account's total |
| headline-lg | 32px / 40px | 600 | −0.01em | Page title on a detail screen |
| headline-sm | 24px / 32px | 600 | — | Page title on mobile |
| title-md | 20px / 28px | 600 | — | Panel titles |
| body-lg | 16px / 24px | 400 | — | Page subtitle, nav links |
| body-sm | 14px / 20px | 400 | — | Body default, table cells, buttons, inputs |
| label-md | 12px / 16px | 600 | 0.05em, uppercase | Eyebrows, column headers, chips |

`.u-label` *is* label-md in `--on-surface-variant`. `.u-data` is `tabular-nums` and every figure
carries it. Sub-captions inside a row (`.cell-sub`, `.coverage-note`) are 12px / 16px, weight 400,
in `--on-surface-variant` — not uppercase.

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
| `--radius-lg` | 8px — buttons, inputs, rows |
| `--radius-xl` | 12px — panels |
| `--radius-full` | 999px — dots, pills, avatars |

**Shadow is `0 1px 2px rgb(0 0 0 / 0.05)` in light and `none` in dark.** Depth everywhere else is a
tonal step plus a 1px `--outline-variant` border: canvas → panel → panel header. Hover lifts a
row's ground one tonal step; it never raises it.

**Breakpoints: 768px** (panel halves stack, tables begin to scroll) and **1024px** (the rail
appears). Below 1024px the rail is replaced by a fixed bottom bar — no drawer, no hamburger
anywhere in this app.

### 1.4 The shell every screen sits in

- ≥1024px: fixed 280px left rail (`--panel` ground, right hairline, 12px radius on its right
  corners) holding the brand, the nav — Overview · Holdings · Income · Upload · Settings — and one
  filled full-width "Upload statement" button at its foot. Canvas is offset by 280px, capped at
  1152px, centred, 32px padding, 24px between page sections.
- <1024px: no rail. A 64px sticky top bar with the wordmark and an "Upload" button; a fixed bottom
  nav with the same five items, icon over 12px label, active item on a `--primary-container` pill.
  Canvas gets 16px margins and 88px of bottom padding.
- A page-level banner (§4) sits **between the top bar and the main canvas**, full-bleed, above the
  1152px content column.

---

## 2. Existing components to reuse

Draw these exactly; they already exist in code under these names.

| Class | Shape |
|---|---|
| `.panel` | `--panel` ground, 1px `--outline-variant`, 12px radius, light shadow, `overflow: hidden` |
| `.panel-header` | Row, space-between, 24px padding, bottom hairline. Stacks to a column below 768px, 16px padding |
| `.panel-title` | title-md, optional 20px leading icon in `--on-surface-variant` |
| `.panel-count` | Right side of a panel header: label-md, tabular, e.g. "12 INSTRUMENTS" |
| `.panel-body` | 24px padding (16px below 768px) |
| `.panel-form` / `.record-form` | Flex wrap, `align-items: flex-end`, 16px gap, 24px padding — a row of labelled fields ending in a button |
| `.data-table` | Full width, no vertical rules. `th`: label-md on `--surface-container-high`, bottom hairline, nowrap. `td`: 16px padding, top hairline, middle-aligned. Row hover `--panel-hover`. Wrapped in `.data-table-scroll` for horizontal overflow |
| `.is-numeric` | On a `th`/`td`: right-aligned, tabular, nowrap; on a `td` also weight 600 |
| `.cell-stack` | Row inside a cell: 12px gap, centred — badge + text block |
| `.cell-sub` | 12px / 16px caption under a cell's primary line, `--on-surface-variant` |
| `.cell-change` | Inline-flex, right-aligned, 4px gap — arrow + figure in a numeric cell |
| `.badge` | Ticker chip: min-width 40px, height 32px, 8px inline padding, 4px radius, `--surface-container-high` ground, `--primary` text, 12px/700 |
| `.delta` | Pill: 4px/12px padding, full radius, 12px/600, 0.03em, 14px arrow. `--gain` / `--loss` text on `--gain-surface` / `--loss-surface`. `--bare` drops the pill for in-table use; `--flat` is `--on-surface-variant` |
| `.button` | 40px tall, 0/16px padding, 8px radius, `--primary-container` fill, `--on-primary-container` text, 14px/600, 18px icon, 8px gap |
| button modifiers | `--quiet`: transparent, 1px `--outline-variant`, `--primary` text, hover `--panel-hover` / `--outline`. `--text`: no box, `--primary`, underlines on hover. `--danger`: transparent, 1px `--loss`, `--loss` text, `--loss-surface` on hover. `--block`: full width |
| inputs / selects | 40px tall, 12px inline padding, 8px radius, `--panel` ground, **1px `--outline`** (not `--outline-variant`), 14px text. Focus: 2px `--primary` outline and border |
| `label` | Column, 4px gap, 14px text above its control |
| `.open-instance-banner` | **The warning precedent.** Full-bleed row, 12px/16px padding, 8px gap, `--warning-surface` ground, `--warning` text, bottom hairline, 14px/20px |
| `.first-run` | `--secondary-container` ground, 1px `--outline-variant`, 12px radius, 16px/24px padding — informational, not a warning |
| `.empty-state` | `--panel` ground, **1px dashed** `--outline-variant`, 12px radius, 40px/24px padding, centred column: 20px/600 headline, then prose ≤52ch |
| `.empty-note` / `.coverage-note` | A bare paragraph in `--on-surface-variant` for a small emptiness; the note is 12px / 16px, and is the caption under a figure |
| `.record` / `.record-list` | A settings row: flex, space-between, 16px padding, top hairline; first row has none. `.field-error` / `.form-error` are 14px / 20px in `--loss` |
| `.settings-tabs` | Flex, 8px gap, wrap, 12px bottom padding, bottom hairline. Each tab: 8px/16px padding, 8px radius, 600, `--on-surface-variant`; hover `--panel-hover`; **current tab `--secondary-container` ground with `--primary` text** |
| `.page-header` | Title block left, `.page-actions` right, 24px bottom padding, bottom hairline. Stacks below 768px. `.breadcrumb` above it: 14px, `--on-surface-variant`, "/" separators |
| `.segmented` | Range chips: 32px tall, full radius, 1px `--outline-variant`; current chip `--primary-container` / `--on-primary-container`. Scrolls sideways below 768px |

---

## 3. Screen 1 — the "as of" timestamp

**Purpose.** Say how old every figure is. *Silently showing yesterday's net worth as though it were
live is the one genuinely dangerous failure mode in a finance app.* Non-negotiable, and it appears
**wherever a figure appears** — Overview headline, Analysis breakdowns, Account detail total,
Holdings table.

**Content.** `As of 20 Aug 2026, 4:31 PM` — an absolute date and time, never a bare relative
string. A relative gloss may follow in parentheses past an hour: `As of 19 Aug 2026, 4:00 PM
(yesterday)`.

**Unresolved conflict — decide it in the design.** The one existing mock carrying a timestamp reads
**"As of Today, 4:00 PM EST"** — market time, weekday-relative date. The app's own rule is that the
database stores UTC, `America/New_York` is used only for market-hours logic, and **display is
browser-local**. Draw the version you recommend and label it. This brief recommends *browser-local,
absolute date, no timezone abbreviation*: a household reading from two timezones should each see
their own clock, and "EST" is wrong for half the year. If you keep market time, the abbreviation
must be rendered and must be correct (EST/EDT).

**Treatment.** `.u-label` — 12px / 16px, 600, 0.05em, uppercase, `--on-surface-variant` — timestamp
itself in `.u-data`. Not a chip, not coloured: it is a caption, and it takes colour only when stale
(§4).

**Placement.**

| Where | Desktop ≥1024px | Mobile <768px |
|---|---|---|
| Overview headline | Directly under the 48px figure, above the delta pill row | Same, under the 36px figure |
| Analysis breakdown panels | Once per page, in `.page-header`'s right slot beside "Refresh now" | Under the page subtitle, left-aligned |
| Account detail | Inside `.detail-total`, under the figure and above the coverage note | Same; the whole total block is left-aligned |
| Holdings table | In the `.panel-header`'s right slot, in place of `.panel-count` where both would collide | Panel header stacks; the timestamp is the second line |

One timestamp per surface. Repeating it per row is noise — a per-row treatment exists only for the
rows that *disagree* with the page timestamp, which is §4.

---

## 4. Screen 2 — the stale-price banner and the per-row stale flag

**Purpose.** A failed price fetch keeps the last known price and marks that instrument stale. The
figure is still shown — never zeroed, never nulled into a sum — so the interface must say that a
number it is displaying is older than it looks.

**The hard rule: never colour alone.** Amber says *something*; the words say *what*. Every stale
signal carries the literal phrase, and the amber is the redundant channel. This is for
colour-vision deficiency and for greyscale printing, and it is not negotiable.

### 4.1 Page-level banner

Follows `.open-instance-banner` exactly — the only existing consumer of the warning tokens, and
therefore the visual precedent: full-bleed row above the content column, 12px/16px padding, 8px
gap, ground `--warning-surface` (`#fef3c7` light / `#33280a` dark), text and `<strong>` in
`--warning` (`#92500e` light / `#fbbf24` dark), 1px `--outline-variant` bottom hairline, 14px / 20px,
optional 18px leading icon in `currentColor`. Not dismissible: staleness is a standing fact about
the data, not an alert to acknowledge once.

Copy: **"3 prices are stale."** Prices last updated 19 Aug 2026, 4:00 PM. Totals on this page use
the last known price for those holdings. — then a `.button--text` reading **"Review in Settings →
Instruments"**. Draw three variants: one stale instrument (singular copy), several, and *all* prices
stale — the provider-outage case, whose copy names the outage rather than the instruments.

### 4.2 Per-row treatment

Inside a table the amber ground is wrong — a striped table of warning rows is unreadable. Instead:

- The row's existing `.cell-sub` caption gains the phrase, joined by a middot to what is already
  there: `Equity · Large blend · price is stale`. That exact string is **already rendered by the app
  today** and must not be reworded.
- Set that caption in `--warning` instead of `--on-surface-variant`, prefixed by a 14px warning
  glyph in `currentColor`.
- The price cell stays `--on-surface`. Colouring the figure implies it is wrong; it is merely old.
- **Never priced** is a different state: the caption reads `never priced` and both the price and
  value cells hold an em dash `—`. Never a zero.

Draw four row states side by side: fresh; stale; never priced; and **refused for currency** — an
instrument the provider quotes in something other than USD, whose caption reads `not priced —
quoted in GBP, and this app sums USD only`. That last one must not read as an ordinary failure; it
is a permanent refusal and its fix is in Settings → Instruments.

On mobile the banner wraps to two or three lines with the link on its own line; the row caption
wraps under the instrument name.

---

## 5. Screen 3 — the "Refresh now" control

**Purpose.** Background polling runs every 15 minutes during market hours; this is the mandated
manual override. The app has **no loading state and no error state anywhere today**, so all four
states below are new ground.

**Shape.** `.button--quiet` — 40px tall (`--control-h`), 8px radius (`--radius-lg`), 1px
`--outline-variant`, `--primary` text, 14px / 600, 18px circular-arrow icon at 8px gap. Quiet, not
filled: the shell's one filled button is "Upload statement", and a page keeps one obvious primary.

**Placement, and why.** In `.page-actions` at the right of `.page-header`, immediately beside the
as-of timestamp it acts on — the control and the fact it changes must be readable in one glance.
The rail is the wrong home: it separates action from evidence and does not exist below 1024px. Same
slot on Settings → Instruments.

| State | Draw |
|---|---|
| **Resting** | Icon + "Refresh now". Beside it, the as-of line from §3 |
| **In-flight** | Label becomes "Refreshing…" and the control stops accepting input — it must not be pressable twice — but keeps full text contrast rather than the browser's grey disabled look, which reads as forbidden rather than busy. The icon becomes an 18px indeterminate arc: 2px `currentColor` stroke over a 270° sweep, rotating 1s linear. **There is no spinner precedent in this app**, so this defines it, and it needs a reduced-motion fallback: a static arc plus the "Refreshing…" label, which alone is sufficient |
| **Success** | Control returns to resting; the **as-of line updates and is the confirmation**. Beside it, one `.coverage-note` line reporting the outcome in full: "Updated 11 prices · 2 marked stale · 1 refused." No toast, no green tick — the app has no toast system |
| **Failure** | Control returns to resting; the figures already on screen stay exactly as they were. A `.form-error` line (14px / 20px, `--loss`) under the header: "Refresh failed — the price provider did not respond. Showing last known prices from 19 Aug 2026, 4:00 PM." If the failure marks instruments stale, the §4.1 banner appears too; draw the pair together once so they do not stack awkwardly |

**Mobile <768px.** `.page-header` stacks, so the control drops below the title block. Give it
`.button--block` on the Instruments tab (where it is the page's main action) and keep it
intrinsically sized on read-only pages, sitting left-aligned under the as-of line.

---

## 6. Screen 4 — Settings → Instruments

**Purpose.** This tab carries real weight; it is not inline editing on a table row. It is the only
place that answers **"which manual-priced instruments have gone stale?"** — a question revisited on
a schedule, because manually priced instruments do not update themselves. It is also where a ticker
change is applied and where a bad alias gets repointed.

**It slots into the existing tab strip**, today *Overview · People · Accounts*, which gains
*Classifications · Instruments · History*. Draw the strip with **six** tabs, Instruments current
(`--secondary-container` ground, `--primary` text). Page header: title "Instruments", subtitle "What
the household holds, how each one is priced, and what a statement's wording maps to."
`.page-actions` carries the "Refresh now" control from §5.

### 6.1 Stale manual prices — first panel, and first for a reason

A `.panel`, header "Stale manual prices" with a `.panel-count` of "3 INSTRUMENTS", and a
`.coverage-note` opening line: "A manual price carries forward until it is changed. These have not
been updated in over 30 days."

Then a `.data-table`: **Instrument · Last price · As of · Age · (action)**, with Last price and Age
`.is-numeric`. The Age cell reads `69 days` in `--warning` with the warning glyph — words *and*
colour. The action cell holds a `.button--quiet` "Set price" opening the form in §6.4. Empty state:
**`.empty-note`, no table, no zero** — "No manual price is more than 30 days old."

### 6.2 The instrument list

A `.panel` titled "All instruments" with a `.panel-count`. Inside `.data-table-scroll`:

| Column | Content | Class |
|---|---|---|
| Symbol | `.badge` with the ticker, or **nothing at all** when the instrument has no public ticker — a placeholder in a ticker-shaped chip reads as a ticker | `.cell-stack` |
| Name | Instrument name, with `.cell-sub` carrying `quote type · classification` and, when stale, `· price is stale` in `--warning` | |
| Price source | Plain text: `Feed`, `Fixed`, or `Manual` | |
| Last price | `$482.10`, or `—` when never priced | `.is-numeric` |
| As of | `19 Aug 2026` with a `.cell-sub` giving the age in words (`2 days ago`, `69 days ago`); amber and glyphed when stale | `.is-numeric` |
| | `.button--text` "Edit" | |

Draw at least these five rows so every state is visible: a fed ETF with a ticker; a mutual fund; a
**collective investment trust** with no ticker at all, price source Manual, price 69 days old and
flagged stale; a fixed-price instrument (cash, `$1.0000`); and one never-priced instrument showing
em dashes.

### 6.3 The edit form

A `.panel` titled "Edit instrument", body `.panel-form` — a wrapping row of `label`-wrapped
controls, all 40px tall, ending in a filled `.button` "Save" and a `.button--quiet` "Cancel".

- **Symbol** — text input, may be left empty. `.field-note` under it: "Leave empty for an
  instrument with no public ticker. Changing a symbol keeps all history attached to this
  instrument."
- **Price source** — `<select>` with exactly three options: **Feed** (quoted automatically),
  **Fixed** (a constant, e.g. cash at 1.0000), **Manual** (typed by hand). `.field-note`: "Manual
  instruments never refresh on their own."
- **Classification** — `<select>` over the household's own labels, each rolling up to an asset
  class. Show the rollup as a `.field-note`: "Target-date 2045 → other."
- **Aliases pointing here** — a read-only list inside the edit panel, so the row's aliases are
  visible without leaving it. The full alias table is §6.5.
- Field-level refusals render as `.field-error` under the offending control; a whole-form refusal
  as `.form-error` above the row.

### 6.4 Manual price entry — for CITs

Its own `.panel`, "Set a manual price", because this is a recurring chore rather than a one-time
edit. A `.panel-body` caption above the form: "A workplace plan often holds a collective investment
trust — *Vanguard Target Retirement 2045 Trust II* — which has no public ticker and no quote on any
retail source. Its price is typed from the statement and carries forward until it is changed."

Form (`.panel-form`): **Instrument** (`<select>`, manual-priced only) · **Price** (text input,
right-aligned, tabular, 4 decimals) · **As of** (date input, defaults to today, no future dates) ·
filled `.button` "Save price". After a write, a `.coverage-note` confirmation: "Recorded $52.4100 for
Vanguard Target Retirement 2045 Trust II as of 20 Aug 2026."

### 6.5 Aliases

A `.panel` titled "Aliases", `.panel-body` caption: "What a brokerage calls an instrument in its
CSV. Aliases are global — Fidelity's `CASH` and Schwab's `Cash & Cash Investments` can both point at
the same instrument."

A `.data-table`: **Alias (as written in the file) · Points at · Source seen · (action)**. The alias
string is raw text, unaltered. "Repoint" (`.button--text`) turns the "Points at" cell into an
in-place `<select>`; "Remove" (`.button--danger`) renders an explanation rather than a disabled
button when removal is refused.

### 6.6 Layout

- **≥1024px.** Single 1152px column: tab strip, page header, then the five panels stacked 24px
  apart in the order above — stale first, because it is the question the tab exists to answer.
- **768–1023px.** Identical minus the rail; bottom nav present, 88px of canvas bottom padding.
- **<768px.** Panel padding 16px. Every `.data-table` scrolls horizontally inside
  `.data-table-scroll` rather than reflowing to cards. `.panel-form` goes one full-width field per
  line, buttons full width at the foot. `.panel-header` stacks title over count.

---

## 7. Component 5 — coverage labelling

**Purpose.** Cost basis is optional and prices can be missing, so a group's figure may be partial.
The rule is **sum what is known and label the coverage**: *"unrealized $47k, based on 8 of 12
holdings"*. Never coerce a missing value to zero — that reports a fake gain equal to the whole
untracked position.

Coverage and staleness share the warning role and must be resolved together, since both can land on
one figure. The resolution to draw:

- **Coverage is a caption, not a warning.** `.coverage-note`, 12px / 16px, `--on-surface-variant`,
  directly under the figure it qualifies. Normal, expected, quiet.
- **Staleness is a warning** and takes the amber. When both apply, the coverage note comes first and
  the stale line second, in `--warning` with its glyph. Never merge them into one amber sentence;
  they are two different doubts.
- **A withheld figure beats a wrong one.** When *nothing* in a group is priced there is no figure at
  all — no `$0.00`, no dashed placeholder at figure size. The slot holds prose: "None of this
  account's 4 holdings has ever been priced, so there is nothing to value yet."

Draw the four combinations on one Account detail header: full coverage and fresh; full coverage and
stale; partial coverage and fresh; nothing valued.

---

## 8. Do not

1. **Never carry gain, loss or staleness in colour alone.** Every gain and loss carries its sign and
   a direction arrow; every stale thing carries the word "stale". The screens must survive greyscale.
2. **Never render a figure in an empty state.** A zero and an absence must not look alike. No `$0.00`
   placeholder, no ghost chart, no axis with no line.
3. **No sub-daily range chips.** No `1D`, no `1W`, no intraday. Mutual funds strike one NAV a day, so
   a 1D chart is two points. The one range set is **1M / 3M / 1Y / All**.
4. **No invented metrics.** No risk gauge, no "Target Risk 8.0 / 10", no time-weighted return, no
   after-tax net worth, no projected anything. If a number cannot be traced to stored data, it is
   not drawn.
5. **No hardcoded hex anywhere**, charts included. Every fill and stroke resolves from the tokens in
   §1.1 so that a theme change recolours the trend line for free.
6. **Every figure is `tabular-nums`.** Proportional digits do not align, and a figure that changes
   width as it updates makes the whole row twitch.
7. **No monospace.** There is no mono family in this app; `code` in prose is the only exception.
8. **No brokerage furniture.** No notification bell, no avatar menu, no "Add Funds", "Invest Now",
   "Deposit", "Transfer", no search over accounts, no help icon. Single-tenant and self-hosted:
   there is no user account to hang an avatar on and nothing to buy.
9. **No toast system, no modal dialogs.** Confirmations are inline text; refusals are `.form-error`
   and `.field-error` in place. Nothing that disappears before it is read.
10. **No disabled buttons as an explanation.** A refused action renders its reason in words; a dead
    control explains nothing.
11. **Do not lift figures from the existing mock set.** Its numbers contradict each other screen to
    screen. Use plausible, internally consistent placeholder data.
12. **No third-party fonts, icon fonts or CDN assets.** The app is offline-capable and holds a
    household's finances.

---

## 9. Reconciliation notes — for the engineer syncing this back

**Reuse, do not rename.** These class names already exist in `app/app.css` and are referenced by
built routes. Stitch output that renames them creates a duplicate design system:

`.panel` · `.panel-header` · `.panel-title` · `.panel-count` · `.panel-body` · `.panel-form` ·
`.data-table` · `.data-table-scroll` · `.is-numeric` · `.cell-stack` · `.cell-sub` · `.cell-change` ·
`.badge` · `.delta` (+ `--gain` `--loss` `--bare` `--flat`) · `.button` (+ `--quiet` `--text`
`--danger` `--block`) · `.open-instance-banner` · `.first-run` · `.empty-state` (+
`-headline` `-detail`) · `.empty-note` · `.coverage-note` · `.record` · `.record-list` ·
`.record-form` · `.record-note` · `.field-error` · `.form-error` · `.field-note` · `.form-note` ·
`.settings-tabs` · `.settings-summary` · `.breadcrumb` · `.page-header` · `.page-title` ·
`.page-subtitle` · `.page-actions` · `.detail-header` · `.detail-total` · `.detail-figure` ·
`.detail-meta` · `.detail-actions` · `.kpi` · `.kpi-eyebrow` · `.kpi-figure` · `.segmented` ·
`.u-data` · `.u-label` · `.visually-hidden` · `.danger-zone`.

**Already true in code, so match it rather than redesigning it:**

- The string **"price is stale"** is already produced per holding row on the Account detail screen,
  appended to the row's `.cell-sub` after the asset class with a middot. The design must dress that
  existing string, not replace it.
- `--warning` and `--warning-surface` exist in all three token blocks (`:root`, the
  `prefers-color-scheme: dark` block, and `:root[data-theme="dark"]`) and today have exactly one
  consumer: `.open-instance-banner`.
- The settings tab strip is a layout route rendering `NavLink`s with **no class of their own** —
  the current tab is styled off `aria-current="page"`. New tabs are entries in that list, not new
  CSS.
- Withheld figures and coverage notes are already implemented on the Account detail total.

**Genuinely new, and needing new CSS:**

| New thing | Suggested name | Note |
|---|---|---|
| Page-level stale banner | `.stale-banner` | Same rule set as `.open-instance-banner`. Consider factoring both onto a shared `.banner` + `.banner--warning` — but only in the same change that updates `root.tsx`, since `.open-instance-banner` is live |
| The as-of line | `.as-of` | Composes `.u-label` + `.u-data`; may need nothing beyond a flex row with `--space-base` |
| Inline stale marker in a row caption | `.cell-sub--warning` (modifier) | Colour swap plus a 14px glyph; the only new colour usage in a table |
| The in-flight spinner | `.spinner` | **No precedent exists.** 18px, 2px `currentColor` arc, 1s linear rotation, with a `prefers-reduced-motion` branch that stops the animation |
| Instruments tab routes | — | New route files under `app/routes/settings/`; the tab strip's `TABS` array grows |
| Manual price form | reuse `.panel-form` | No new CSS expected |

**Three token-level things to verify on sync:** every new figure carries `.u-data`; no new rule
hardcodes a hex; and both the `prefers-color-scheme: dark` block and the `:root[data-theme="dark"]`
block are updated together, since they are duplicated by design so the explicit toggle can beat the
OS setting.
