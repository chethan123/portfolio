# Stitch brief — the upload flow

*Paste this whole document into Google Stitch. It is self-contained; nothing here needs the
repository.*

---

## 0. Context

**The product.** A self-hosted, single-tenant web app tracking one household's portfolio and net
worth. No brokerage integration, no trading, nothing to sell. It reads statements the family
uploads, prices the holdings every 15 minutes during market hours, and answers what we have, how it
is allocated, and how it has moved. Two or three readers, on a desktop, occasionally on a phone.

**Constraints on every screen below.**

- **Desktop-first.** ≥1024px is the design target, and this flow is the reason DESIGN.md §11 gives
  for the rule: upload → mapping → resolution → diff is "a desktop-shaped workflow" with real
  screen-to-screen state. The phone still completes every step — nothing may be hidden on it — but
  no screen here earns a phone-specific layout (§8).
- **Light and dark are both first-class**, not a filter over one another. Draw every screen in both.
- **Inter only**, variable weight 400–700, self-hosted. **There is no monospace font in this app.**
  Numeric alignment comes from `font-variant-numeric: tabular-nums`, never from a mono family.
- **Icons are inline SVG**, 18–24px, stroked in `currentColor`. No icon font, no CDN.
- **There is no client-side JavaScript state.** No route in this app calls `useState`, `useEffect`,
  `useMemo` or `useRef`. Every control below is a form or an anchor, and
  every piece of flow state is a row in a server-side `upload_draft` table reached by a URL: each of
  the four steps is a real address over that draft, so the back button, a reload, a closed laptop
  and a bookmarked half-finished upload all behave, and every screen works with JavaScript off.
  Anything that would need a script to appear — a conditionally revealed control, a live re-render
  of sample rows — is instead always rendered, or is a form round-trip.
- **This is an existing design system.** Assemble every screen from the tokens and components in §1
  and §2. Do not invent a colour, a radius, a type size or a component shape; compose from what is
  here.

**What is being designed.** The **upload flow** — DESIGN.md §5.1's four screens, the destination of
the rail's one filled primary action, and today a 14-line stub. It is the application's only way to
populate a brokerage account, and it is **absent from the Stitch mock set entirely**: the screen
audit records "any Upload or Settings screen" as missing from all twelve
(`docs/research/2026-08-19-stitch-screen-audit.md:165`), and the same line records that the set
contains **no `<select>` and no dropdown of any kind** — so a flow that is mostly selects is new
ground drawn in an old language, assembled from the app's own established grammar rather than from
an extraction. Four screens, four URLs:

```
GET  /upload                        pick an open account, drop a CSV
POST /upload                        → creates an upload_draft, redirects to its first step
     /upload/:draftId/columns       map the columns   (prefilled when the fingerprint is known)
     /upload/:draftId/instruments   resolve first sightings  (skipped when there are none)
     /upload/:draftId/review        the diff, then commit
POST /upload/:draftId/review        → inserts the position_set, deletes the draft,
                                      redirects to /accounts/:id?uploaded=<setId>
```

**And one write, at the very end.** The first three steps write only to the draft. The commit is
one transaction — the immutable `position_set`, its holdings, the draft deleted — so nothing
partially applied can exist, and a misread column caught on the review screen has cost nothing.
The one declared exception is the instruments step (§5): resolving a first sighting writes the
instrument and its alias *there*, because an alias is a fact about vocabulary rather than about
this statement — an abandoned draft leaves the vocabulary behind and the next upload is quieter,
and nothing was recorded as held. Every other write waits for the last screen.

**Not redefined here.** The table grammar — header treatment, `.is-numeric` on `th` and `td`, the
group-header row, the em-dash rule, tabular figures — is `docs/design/holdings-ui-brief.md` §2 and
§5, and the diff table of §6 consumes it rather than reopening it. Coverage and staleness labelling
— "never priced", "price is stale", the amber, the em dash in a value cell — is
`docs/design/pricing-ui-brief.md` §4 and §7; where a removed holding was never priced, this brief
borrows those words and adds none of its own.

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

**The two borders are not interchangeable**, and the columns screen is where it bites hardest in
this flow. `--outline-variant` carries 1.5:1: it frames a panel and divides rows, and is *felt*
rather than read. `--outline` clears 3:1 and is what a control boundary uses. The drop screen holds
a `<select>` and the file input; the columns screen holds **seven** `<select>`s counting the
header-row choice, a radio pair and a checkbox; the instruments screen adds two more radio pairs
per unresolved string — controls drawn in `--outline-variant` are controls nobody can see the edge
of, which is a defect rather than a style.

Categorical sequence (fills only, never text): light `#0041c8`, `#007751`, `#505f76`, `#b6c4ff`,
`#c3c5d9`; dark `#0055ff`, `#10b981`, `#b6c4ff`, `#ef4444`, `#4edea3`. Nothing in this flow draws
from it — there is no chart on any of the four screens — but a diff group header must not invent a
colour either.

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
in this flow carries it** — a sample cell, a mapped quantity, both halves of a before-and-after
pair, every value on the diff, the ratio in the removal sentence, and the counts inside
`.panel-count`. Sub-captions inside a row (`.cell-sub`, `.coverage-note`) are 12px / 16px, weight
400, in `--on-surface-variant` — not uppercase.

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

**Breakpoints: 768px** (panel halves stack, `.panel-header` stacks, forms wrap to fewer columns per
line; only Holdings reflows its table to cards — the tables in this flow scroll sideways instead,
§8) and **1024px** (the rail appears). Below 1024px the rail is replaced by a fixed bottom bar — no
drawer, no hamburger anywhere in this app.

### 1.4 The shell every screen sits in

- ≥1024px: fixed 280px left rail (`--panel` ground, right hairline, 12px radius on its right
  corners) holding the brand tile "Portfolio / Self-hosted", the nav — Overview · Holdings ·
  Analysis · Income — with Settings at its foot, and one filled full-width "Upload statement" button
  below that. Canvas is offset by 280px, capped at 1152px, centred, 32px padding, 24px between page
  sections. **That filled button is this flow's front door**, and it stays exactly as it is: none of
  the step screens is a nav entry, because a step is reached only by working through the flow.
- <1024px: no rail. A 64px sticky top bar with the wordmark and an "Upload" button; a fixed bottom
  nav with the same items, icon over 12px label, active item on a `--primary-container` pill. Canvas
  gets 16px margins and 88px of bottom padding.
- A page-level banner — the open-instance warning, the stale-price banner of the pricing brief
  §4.1 — sits **between the top bar and the main canvas**, full-bleed, above the 1152px content
  column. **The first-run prompt is not a banner**: the shell renders it as a rounded `.first-run`
  card at the head of the content column, inside `.app-main`, on every page including `/upload`.
  The upload flow never draws either itself; it inherits whatever the shell shows, and everything
  it has to say is said inside its own panels.

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
| `.panel-count` | Right side of a panel header: label-md, tabular, e.g. "1 ADDED · 3 UPDATED · 1 REMOVED" |
| `.panel-body` | 24px padding (16px below 768px) |
| `.panel-form` / `.record-form` | Flex wrap, `align-items: flex-end`, 16px gap, 24px padding — a row of labelled fields ending in a button. **`.panel-body + .panel-form` drops the form's top padding** so prose and the form it captions close up |
| `.form-intro` | A `.panel-body` that is a form's caption: flex column, 12px gap, so an explanation, a confirmation and a refusal read as separate statements rather than one run-on paragraph |
| `.data-table` | Full width, `border-collapse: collapse`, no vertical rules. `th`: label-md on `--surface-container-high`, bottom hairline, nowrap. `td`: 16px padding, top hairline (none on the first row of a `tbody`), middle-aligned. Row hover `--panel-hover` |
| `.data-table-scroll` | `width: 100%; overflow-x: auto` — the wrapper that keeps a wide table from widening the page. **Every table in this flow sits inside one**, because a brokerage export's width is not this app's to choose |
| `.is-numeric` | On `th` **and** `td`: right-aligned, tabular, nowrap; on a `td` also weight 600. Both get it or the column does not line up |
| `.cell-stack` | Row inside a cell: 12px gap, centred — badge + text block |
| `.cell-sub` | 12px / 16px caption under a cell's primary line, `--on-surface-variant`, 2px above it |
| `.row-group` | A body row holding one `th[scope="rowgroup"][colspan]`: body-sm 600 on `--surface-container-high`, hairlines above and below, no hover — it is not a row anyone can act on. The diff's Added / Updated / Removed headings |
| `.badge` | Ticker tile: min-width 40px, height 32px, 8px inline padding, **4px radius — not a circle**, `--surface-container-high` ground, `--primary` text, 12px / 700. Never drawn for an instrument with no public ticker |
| `.button` | 40px tall, 0/16px padding, 8px radius, `--primary-container` fill, `--on-primary-container` text, 14px/600, 18px icon, 8px gap |
| button modifiers | `--quiet`: transparent, 1px `--outline-variant`, `--primary` text. `--text`: no box, no height, `--primary`, underlines on hover. `--danger`: 1px `--loss`, `--loss` text. `--block`: full width |
| `select` / `input` | 40px tall, 12px inline padding, 8px radius, `--panel` ground, **1px `--outline`**, 14px text. Focus: 2px `--primary` outline and border |
| `input[aria-invalid="true"]` | 2px `--loss` border — the already-shipped second channel for a refusal. The sentence stays the carrier; the border thickens as well as changing hue, so it survives greyscale |
| `label` | **`display: flex; flex-direction: column; gap: 4px`**, 14px — the caption sits 4px above its control, and the whole pair is one hit target. Controls nest inside their `<label>`; nothing is paired by `for`/`id` alone |
| `.field-note` / `.form-note` | 12px / 16px in `--on-surface-variant` — what a control means, or what a form is about to do, said *before* it is submitted |
| `.field-error` / `.form-error` | 14px / 20px in `--loss`, `role="alert"` — a field's refusal under its control, a form's above the row |
| `.coverage-note` | 12px / 16px in `--on-surface-variant` — the caption under a figure or a table |
| `.empty-state` | `--panel` ground, **1px dashed** `--outline-variant`, 12px radius, 40px/24px padding, centred column: `.empty-state-headline` 20px/600 then `.empty-state-detail` prose ≤52ch |
| `.empty-note` | A bare paragraph in `--on-surface-variant`, 14px / 20px, ≤52ch — a small emptiness inside a panel |
| `.first-run` | `--secondary-container` ground, 1px `--outline-variant`, 12px radius, 16px/24px padding — informational, not a warning, not dismissible. Already built, already worded |
| `.open-instance-banner` | The warning precedent: full-bleed row, `--warning-surface` ground, `--warning` text, bottom hairline, 14px / 20px. **There is no generic `.banner` class in the stylesheet**, and this flow gives no reason to add one — nothing here is a page-level warning |
| `.danger-zone` | A block at a panel's foot: flex row, space-between, 24px padding, **top hairline** — the weight a destructive decision is drawn at. Settings → Accounts closes an account with it; §6.5 borrows it for the removal confirmation |
| `.record-row--closed` | `opacity: 0.6` — the one dimming precedent in the app, used on a closed account's row. §2.1's skipped step borrows it |
| `.segmented` | Chip strip of anchors, 32px tall, full radius — the range and group-by control. **Cited here as the precedent §2.1 rejects**, not as a component this flow uses |
| `.breadcrumb` | 14px, `--on-surface-variant`, "/" separators, links underline on hover — the text-grammar precedent §2.1 builds on |
| `.u-data` / `.u-label` | `tabular-nums` / label-md in `--on-surface-variant` |
| `.visually-hidden` | Clipped, not `display:none` — for a caption assistive technology needs and the layout does not |

### 2.1 The one new shell element — the step indicator

**`.upload-steps`** — the only genuinely new component in this flow, rendered on **every** step
screen, `/upload` included, because the drop screen *is* step one. A `<nav aria-label="Upload">`
holding an `<ol>` of the four steps:

> **1 Account & file · 2 Columns · 3 New instruments · 4 Review**

It sits **between the page title and the first panel**, where the reader's eye lands after the
title and before the work.

**States, and who may be a link.**

- **Completed steps 2 and 3 are anchors.** Going back is free — the draft holds every answer, so
  returning to Columns from Review costs nothing and loses nothing — and a step already passed is
  therefore a place, not a promise. Each links to its own URL over the same draft.
- **Step 1 is the exception: once passed, it is plain completed text, never a link.** `/upload` is
  draft-less — it is the screen that *creates* a draft — and no URL reopens account-and-file for a
  draft that exists. An anchor there would silently start a new upload from the middle of this one,
  which is the same failure the future-step rule below forbids, wearing a friendlier face.
- **The current step is plain text carrying `aria-current="step"`**, set in `--on-surface` at
  weight 600. Everything else in the strip is `--on-surface-variant` at weight 400, so the one
  place the reader is standing is the one thing that reads at full strength.
- **Future steps are plain text, never links.** A later step needs the earlier answers — Review
  cannot render before the columns are mapped — so an anchor there would be a link to a refusal.
  A control that cannot work is not drawn as a control.
- **When the file has nothing unresolved, "New instruments" is dimmed, not removed**: the entry
  keeps its place at `opacity: 0.6` (the `.record-row--closed` precedent, the app's one dimming
  treatment) with a quiet "· none" after its label. The count of steps never shifts underfoot — a
  flow that is four steps on one upload and three on the next reads as a different flow, and the
  reader's sense of "how much is left" is the thing the strip exists to hold steady.

**Visual grammar: quiet text, not chips.** The closest interactive precedent is `.segmented`, and
it is the wrong one: a chip claims clickability, and at any moment most of these entries are
deliberately not clickable — at best two of the four are ever links, and a strip of chips where
half are dead is a control that lies with every dead one. The right precedent is `.breadcrumb`:
14px text in `--on-surface-variant`, anchors that underline only on hover, separated by
**middots** — the house enumeration grammar, and the numbers already carry the ordering a chevron
would restate. The numbers are part of each item ("1 Account & file"), set tabular so the strip
does not shimmer between steps.

Draw the strip four times side by side: on step one (nothing completed, three futures); on step two
(step 1 behind it as plain completed text — **zero links**, two futures); on step four with **two**
links behind it (Columns and New instruments, step 1 completed as text); and on step four with
"3 New instruments · none" dimmed in the middle, leaving Columns as the strip's one link.

**Each step titles its own document.** "Upload · Portfolio", "Columns · Upload · Portfolio",
"New instruments · Upload · Portfolio", "Review · Upload · Portfolio" — four URLs must not share
one history label, because the back button's menu and the browser tab are the strip's off-screen
twins, and four entries all reading "Upload" make the draft's own history unnavigable.

---

## 3. Screen 1 — the drop screen (`/upload`)

**Purpose.** Pick which account this statement describes, hand over the file, land on the mapping
step. One decision and one control; everything hard comes later, and this screen should look like
that is true.

**Page header.** `.page-title` "Upload a statement", `.page-subtitle` "A statement lands as one
photograph of what the account holds. Nothing is recorded until the last step." The title and
subtitle are the same on all four screens — the step strip beneath them is what changes, and a
title that mutated per step would fight the strip for the same job.

**Shape.** One `.panel`. Its `.panel-body form-intro` says what the flow does, in three sentences,
because this is the screen a person is standing on when they decide whether to trust it:

> Map the file's columns once per institution — the mapping is remembered and applied to every
> later export with the same header. Anything the file names that has never been seen before is
> resolved once, then remembered forever. The last step shows exactly what this statement changes —
> every removal listed in full — and nothing is recorded until it is committed there.

Then a `.panel-form` (`multipart/form-data` — the app's first), closing up under the intro via the
`.panel-body + .panel-form` rule:

- **"Account"** — a `<select>` over **open accounts only**, ordered as the Settings account list
  orders them, so the two screens never disagree about what the household's accounts are called or
  which comes first. A closed account is **absent, not disabled**: a closed account's history does
  not change — the same refusal `setBalance` already makes — and a disabled option is a question
  ("why can I see it and not choose it?") the select cannot answer. **Every open account kind is
  offered, not just brokerage**: a liability statement listing what is owed and an overdrawn bank
  export carrying its own minus sign are both legitimate uploads — and the overdraft in particular
  is recordable only through an upload or by recasting the account as a `liability`, because the
  set-balance form cannot take a sign (DESIGN.md §14.8).
- **"Statement file"** — a native file input accepting `.csv,text/csv`, drawn with the standard
  40px control treatment. **If a drag-and-drop target is drawn, it is decoration over this same
  input** — a dashed `--outline-variant` region echoing `.empty-state`'s border grammar, with the
  input alive inside it — never a dependency: the form posts with JavaScript off, and a drop zone
  that is the only way in is a form that stopped working.
- A `.field-note` under the file input naming the size limit **in words read from configuration**,
  not restated by hand: *"Statements up to 10 MB."* The limit is `MAX_UPLOAD_MB` and defaults to
  10; a hardcoded "10 MB" in the template is wrong the day an operator changes the knob. A
  brokerage CSV is tens of kilobytes — the cap bounds an accident, not real use, and the note's
  tone should match that.
- A filled `.button` **"Continue to columns"**. Filled, because it is this page's one primary
  action and the rail's filled button is what brought the reader here.

**Refusals, all field-level.** A missing file or no account chosen renders a `.field-error` under
its own control, the way every form in the app renders one. An **empty file** is refused as empty —
"This file has no content" — not as a parse error, because a zero-byte download is a fact about the
download. A file that is **not decodable as UTF-8 text** is refused with a sentence about the file
— "This does not read as a text file. Export the CSV version of the statement" — never a driver
error; a leading BOM is not a decode failure and is stripped silently. A file **over the size
limit** is refused naming the limit. In every refusal the account selection is re-rendered as
chosen — but **the chosen file is always lost**: a browser will not refill a file input, so every
refusal on this screen costs the file pick, and the copy should assume the reader is picking it
again rather than pretend otherwise. The account choice is what survives.

**The two account-less states are §7.1 and §7.2** — the first-run prompt and the every-account-
closed empty state — and in both of them the form is not drawn at all: a select over nothing and a
file input that can lead nowhere are dead controls, and a dead control explains nothing.

**Draw this screen twice**: the ordinary state with four accounts in the select and a file chosen,
and the refused state with "This does not read as a text file…" under the file input and the 2px
`--loss` border on it.

---

## 4. Screen 2 — the columns screen (`/upload/:draftId/columns`)

**Purpose.** Say which column is which, once per institution. This is the novel screen of the four,
and its whole job is to be **readable**: a household maps by looking at *values*, not names — the
sample rows are the feature, not decoration. Every later export with the same header fingerprint
arrives with this screen already filled in; **it still renders, every time** (§4.1).

**Shape.** One `.panel`, four things stacked inside it, in this order: the intro (§4.1), the
header-row choice (§4.3), the preview table (§4.2) bleeding edge to edge, and the mapping form
(§4.4). One panel, not four: the samples are what every control on the screen is answered against,
and splitting them into a separate card puts the evidence in a different box from the question.

### 4.1 The intro, and where the mapping came from

A `.panel-body form-intro` opening with the file and the account, because a draft survives a closed
laptop and the reader may be resuming cold: **"Positions_2026-06-30.csv · Fidelity Brokerage."**

**When a saved mapping matched the header fingerprint**, a second sentence says so: *"These columns
were mapped when a previous Fidelity statement was uploaded; the choices below are that mapping.
Check them against the sample rows."* The screen is never skipped on a match — a changed export
must be *visible* rather than silently reapplied, and the cost of visibility is one glance at a
screen that is already correct. Silence here is the failure mode: a brokerage that quietly swapped
two columns would otherwise be applied at full confidence.

**When the saved mapping names a column the file no longer has**, that control opens unselected and
a sentence names the loss: *"The saved mapping used a column called 'Average Cost Basis', which
this file does not have."* Naming the missing column matters because the reader's next move — remap
it, or mark it not in this file — depends on knowing whether the brokerage renamed it or dropped
it.

With no mapping found, every control opens unselected and the intro says only the file and account.

### 4.2 The preview

A `.data-table` inside `.data-table-scroll`, a **direct child of the panel** with no `.panel-body`
between them, so the header row's `--surface-container-high` ground runs corner to corner. The
chosen header row is drawn as the table's `<thead>` — the file's own words, exactly as written —
and the **first three data rows** beneath it, every cell verbatim, dollar signs, thousands
separators, `n/a` and all: the reader is choosing columns by these values, so laundering them would
remove the evidence. Numeric-looking columns are **not** right-aligned here — the preview does not
yet know which columns are numbers; that is what the screen is deciding.

Draw it with **the file this brief threads through §4, §5 and §6** —
`Positions_2026-06-30.csv`, a Fidelity-shaped export of five data rows (VTI · BND ·
CASH & CASH INVESTMENTS · FXNAX · VXUS), preamble skipped, header at row 4, first three data rows
shown:

> **Symbol · Description · Quantity · Last Price · Current Value · Average Cost Basis · As of**
> VTI · Vanguard Total Stock Market ETF · 156.234 · $482.10 · "$75,320.41" · $424.12 · 06/30/2026
> BND · Vanguard Total Bond Market ETF · 210.000 · $72.61 · "$15,248.10" · $71.05 · 06/30/2026
> CASH & CASH INVESTMENTS · -- · 4,210.55 · $1.00 · "$4,210.55" · n/a · 06/30/2026

These are the **file's** figures, not the account's: the account still holds 145.234 of VTI until
the commit, and the gap between the preview's 156.234 and the table on Holdings is exactly what the
review screen will state as an update. A wide file scrolls sideways **inside the panel**; the page
never scrolls horizontally. Three sample rows, not ten: three is enough to see what a column holds,
and the mapping form below must stay on the same screenful as the evidence.

### 4.3 The header-row choice

Above the preview, its own small form: a labelled `<select>` — caption **"Header row"** — over the
candidate rows the CSV reader detects, each option the row number plus its first few cells
(*"Row 4 — Symbol · Description · Quantity · …"*), defaulted from candidate detection, with its own
`.button--quiet` submit reading **"Re-read with this header row"**.

**Why a form round-trip and not a live control.** Changing the header row changes what the preview
shows and what every mapping select offers — and this app has no client state to re-render either
with. A submit re-renders the screen from the draft — the file itself is never at risk, because the
draft holds it — but **mapping selections not yet saved are lost with the round trip**, and rightly:
the header row decides what the selects offer, so a choice made against the old header may not even
exist against the new one. This is why the header-row control sits first, above the controls it
resets. It is also the screen where a two-line preamble is fixed — by pointing at the real header,
not by editing the CSV.

### 4.4 The mapping controls

A `.panel-form` of six labelled `<select>`s, each over the file's header cells:

| Control | Caption | Required | The "Not in this file" option |
|---|---|---|---|
| instrument | "Instrument" | **Yes** | No — a statement without instruments is not a statement |
| quantity | "Quantity" | **Yes** | No |
| name | "Name" | No | Yes — used only when a new instrument is created |
| costBasis | "Cost basis" | No | Yes — the 401k case: absent basis lands as null, never zero |
| asOf | "As-of date" | No | Yes — the review screen asks for the date instead |
| accountNumber | "Account number" | No | Yes — a guard, never a selector (§9.12) |

The four optional selects carry **"Not in this file"** as an explicit option rather than an empty
one, because "unset" and "deliberately absent" are different answers and only one of them should
survive a save. **Instrument or Quantity left unchosen is a field-level refusal** through
`parseInput`, rendered under its own control the way every other form in the app renders one — not
a disabled submit, which would explain nothing. **The same column may not be chosen twice**: a
duplicate is a field-level refusal on the second control — *"'Quantity' is already mapped to
Quantity"* — since a column that is two things is a parse whose output cannot be checked against
anything.

**Below Cost basis, a two-way radio: "Per share / Total for the position."** Brokerages report the
two about equally often, and the wrong guess is off by a factor of the position size in a direction
nothing on screen would flag — which is why this is a control and not an inference. It is **always
rendered**, even when no cost basis column is mapped, with a `.field-note` saying so: *"Applies
only when a cost basis column is mapped."* Conditional showing needs JavaScript, and the note costs
one line.

**A checkbox: "This file lists what is owed on Fidelity Brokerage as a positive number."** —
naming the account, defaulted from the account's kind (ticked for a loan, unticked for a brokerage
or bank). This is where a liability's sign is decided: the file states a number, the box states its
direction, and an unticked box keeps the file's own sign — which is exactly how a bank export
carrying a genuine negative balance records the overdraft (DESIGN.md §14.8). Draw the liability
variant with the account name "Mortgage — 123 Maple St" in the sentence.

The form ends in a filled `.button` **"Save mapping and continue"**. Submitting writes the mapping
to the draft, saves it against the institution and header fingerprint for next quarter, and
redirects — to the instruments step when the file carries first sightings, straight to review when
it does not.

### 4.5 Parse problems land here, not later

An unparseable quantity, rows that disagree on the as-of date, an instrument column that is empty
on every row — all of these render **on this screen**, as `.field-error` paragraphs above the
mapping form, each naming the row and column that caused it:

> *"Row 17, Quantity — 'See disclosures below' is not a number."*
> *"Rows disagree on the as-of date: 2026-06-30 and 2026-07-31. A statement carries one date."*

They belong here because **remapping is the fix** — a disclaimer line under the symbol column is
cured by moving the header row or the column choice, not by anything a later screen offers. An
error two screens downstream from its cure is a round trip nobody asked for.

**Draw this screen three times**: unfilled (first upload from an institution); prefilled with the
provenance sentence; and refused, with the row-17 sentence above the form and the Quantity select
carrying its 2px `--loss` border.

---

## 5. Screen 3 — new instruments (`/upload/:draftId/instruments`)

**Purpose.** Every distinct string in the instrument column is looked up **byte-exact** against the
alias table — no trimming, no case folding, because the column is `collate "C"` and a heuristic
that "helpfully" merged two near-identical strings would attach a holding to the wrong fund
silently. The misses land here, each resolved once and remembered forever; the same brokerage's
next export passes through in silence. **Reached only when there is at least one miss** — otherwise
the flow redirects straight to review and the step dims in the strip (§2.1).

**The intro states the count plainly**, in a `.form-intro`: **"2 of 5 holdings in this file have
not been seen before."** — the two being `Positions_2026-06-30.csv`'s VXUS row, genuinely new, and
its cash row, which this quarter's export spells `CASH & CASH INVESTMENTS` where the last one wrote
`FCASH`: byte-exact lookup rightly treats a respelling as a first sighting even when the instrument
is old news. Then one sentence of consequence, because this step is the flow's one early write:
*"Resolving writes the name down as vocabulary — the statement itself is still not recorded until
the last step."*

### 5.1 One bounded group per unresolved string

Each first sighting is a **bordered sub-section inside the panel** — full width, 24px padding, a
1px `--outline-variant` top hairline separating it from the one before (none on the first) — so
that a screen with five strings reads as five questions, not one form with twenty stray fields.

At the group's head, **the raw string exactly as the file wrote it**, prominent: body-lg weight
600, verbatim — `CASH & CASH INVESTMENTS` — because the byte-exact string *is* the thing being
resolved, and prettifying it would show the reader something other than what will be written to the
alias table. Beneath it, `.cell-sub`-grade context, enough to recognise the holding without opening
the file: the mapped name column's value when one is mapped, and the row's quantity — for the VXUS
group, *"Description: Vanguard Total International Stock ETF · 120.000 units"*; for the cash group,
whose Description cell is `--` and maps to nothing, the quantity alone: *"4,210.55 units"*.

### 5.2 The two paths, both always visible

A radio pair chooses the path, and **both branches render their controls at all times** — greying
or collapsing the unchosen branch needs JavaScript, and a reader deciding between the two needs to
see what each asks before choosing. Fields in the unchosen branch are simply ignored on submit.

**"This is an instrument already listed."** A `<select>` of existing instruments by symbol and
name — *"VTI — Vanguard Total Stock Market ETF"*, *"USD — Cash"* — which is how a second spelling
of a fund already held gets attached to it. Draw this branch chosen for the
`CASH & CASH INVESTMENTS` group, pointed at the existing Cash instrument: the alias lands beside
`FCASH`, both spellings now silent forever — and aliases are global, so a third institution using
either spelling inherits the answer too. The everyday case for this path.

**"This is new."** Four decisions, each a labelled control:

- **Symbol** — text input, optional. `.field-note`: *"Leave empty for an instrument with no public
  ticker."* — the collective investment trust case.
- **Name** — text input, **required**, prefilled from the mapped name column, or from the raw
  string when no name column is mapped. Prefilled because the statement usually already says it,
  and required because an instrument with no name is unfindable on every other screen.
- **Price source** — a radio pair, **Feed** (quoted automatically) and **Manual** (typed by hand),
  and only those two: `fixed` belongs to the seeded USD row alone, and a second fixed-price
  instrument is not a thing this screen makes. Feed **requires** a symbol — there is nothing to
  quote without one — and manual allows none. `.field-note`: *"A manual price is typed from the
  statement and carries forward until it is changed."*
- **Classification** — a `<select>` of the household's existing classifications plus a **"New
  classification…"** option, with a name field and a four-way asset-class select (Equity · Bonds ·
  Cash · Other) beside it, always rendered, `.field-note`: *"Used only when 'New classification…'
  is chosen."* On a first run the only seeded classification is Cash, so this inline path is the
  road every equity takes. A new name colliding with an existing classification is a field-level
  refusal naming it.

Draw the "This is new" branch filled in for the `VXUS` group: symbol *"VXUS"*, name prefilled
*"Vanguard Total International Stock ETF"* from the mapped Description column, price source Feed,
and "New classification…" chosen with *"International blend"* → Equity. The collective-investment-
trust case — symbol empty, price source Manual — is the field-notes' subject rather than this
file's: it belongs to a 401k's first upload, whose review is the "14 ADDED" variant of §6.5.

### 5.3 One form, one submit, no skip

The whole screen is **one form with one filled `.button`, "Save and continue"**. Every string must
be resolved before the step passes — there is deliberately **no "skip this one"**, because a
skipped row is a holding silently missing from the statement, and §5.2's "a missing row means sold"
turns that silence into a sale. An unresolved group on submit gets a field-level refusal in place,
and everything already chosen is re-rendered chosen.

**The USD probe, and the one refusal it adds.** Creating a `feed` instrument asks the price
provider for its symbol once, at this moment, because this is the only moment the household can act
on the answer. A quote in any currency other than USD refuses the creation with a field-level
sentence on the symbol, naming both: *"VWRL is quoted in GBP. This instance holds USD only, so it
was not created."* — the refresh-time guard's shipped sentence with only its tail adapted ("…so the
price was not stored" becomes "…so it was not created"), because two spellings of one refusal are
two rules. A
provider that fails to answer — timeout, outage, unknown symbol — does **not** block creation: the
instrument is created and the next refresh marks it stale, exactly as it would any symbol that
stopped quoting. A network hiccup must not hold a statement hostage.

---

## 6. Screen 4 — review (`/upload/:draftId/review`)

**Purpose.** The safety valve, and the only write. §5.2's "a missing row means sold" is what makes
a filtered export dangerous: a file showing 2 of 30 positions is a *valid* statement that silently
sells 28 holdings, and nothing downstream would flag it. This screen exists so that the consequence
is read before it is recorded.

**Shape.** One `.panel`: header, intro, the diff table bleeding edge to edge, then the commit form
at the foot. The `.panel-header` carries the title **"What this statement changes"** and, in the
`.panel-count` slot, **the summary line in §5.1's shape: "1 ADDED · 3 UPDATED · 1 REMOVED"** — the
counts each naming what they counted, set tabular, and reading in **the table's own group order**,
so the line is the table's index rather than a second sequence to reconcile against it (§5.1's
"3 updated · 1 added · 1 removed" supplies the format, not the ordering). A first statement for an
account reads **"14 ADDED"**, not a diff against nothing: there is nothing to have updated or
removed, and three zero counts would dress an ordinary first upload as a strange one.

The `.form-intro` beneath restates the frame in a sentence — *"Compared against what Fidelity
Brokerage holds now. 1 row is unchanged and is not listed."* — because unchanged rows are
deliberately absent from the table: listing rows that do nothing buries the five that do, and the
count is all an unchanged row has to say. In the worked file that one row is the cash position,
`4,210.55` in the file and `4,210.55` in the account.

### 6.1 The diff table

One `.data-table` inside `.data-table-scroll`, in Holdings' table grammar throughout — this brief
adds no second vocabulary for a table. Row groups via `.row-group` headers, in this order:
**Added**, **Updated**, **Removed** — additions first because they read fastest, removals last
because they are the reason the screen exists and the eye rests where the reading ends.

| Column | Content | Class |
|---|---|---|
| Instrument | `.cell-stack`: `.badge` when the instrument has a public ticker, then the name over a `.cell-sub` carrying the row's own note when it has one — "3 rows combined", "never priced", "cost basis no longer reported" | |
| Quantity | `50.000` — or, on an updated row, `145.234 → 156.234`, the before half in `.diff-was`, U+2212 for a negative | `.is-numeric` |
| Cost basis / share | `$424.1200`, `— → $71.0500`, `$52.4100 → —`, or `—` when the statement carries none. **Per share, and the heading says so**: the whole-position basis moves whenever the quantity does, so printing it would mark the basis changed on every quantity update — the per-share figure is the one the statement actually restated | `.is-numeric` |
| Value | `$8,500.00` at the current quote — context, not part of the write — or `—` when never priced | `.is-numeric` |

**Updated rows show before → after in the cell for whatever changed** — quantity, basis, or both —
with the unchanged cell printing its single figure. The before half is set in `--on-surface-variant`
at weight 400 (`.diff-was`) so the eye lands on what will be true, not what was; the arrow is
U+2192 in `currentColor`. A basis **appearing** reads `— → $71.0500` and a basis **disappearing**
reads `$52.4100 → —`, and in the disappearing case the row's `.cell-sub` says it in words — *"cost
basis no longer reported"* — because a dash on the right of an arrow is quiet in exactly the place
it should not be.

**Rows the parser combined carry their own note line**: *"3 rows combined"* as the instrument
cell's `.cell-sub` — the lot-level statement listing VTSAX three times lands as one row of 412.5
units, and combining must be visible *before* it is recorded, never discovered after.

**A zero-quantity row is shown, and stored as zero** — `12.000 → 0.000` under Updated — never
dropped: a dropped row is unreachable from the table that no longer prints it, and only a fresh
statement could bring it back (§5.4's reasoning, applied here).

Draw the table with these five rows, so every treatment is visible at once:

1. **Added** — VXUS, badge, "Vanguard Total International Stock ETF" · 120.000 · $58.2000 ·
   **`—`** with `.cell-sub` `never priced` — the instrument §5 created one step ago, with no quote
   until the next refresh. The em dash and the words are the pricing brief's §4.2; do not invent a
   third spelling.
2. **Updated, quantity** — VTI · `145.234 → 156.234` · $424.1200 · $75,320.41.
3. **Updated, basis appearing** — BND · 210.000 · `— → $71.0500` · $15,248.10.
4. **Updated, both** — FXNAX · `1,050.000 → 1,112.400` · `$11.8200 → $11.9400` · $13,181.94.
5. **Removed** — AAPL · 50.000 · $141.2000 · $8,500.00 — see §6.2.

### 6.2 Removals, in full

**Every removed position is listed individually — instrument, quantity, last known value — never
as a count.** The count is the summary line's job; the table's job is to make each sale readable as
the specific thing it is, because "1 removed" is recognisable as the AAPL sale only when AAPL is
printed. A removed holding that was **never priced** shows its quantity and says so in the words
the app already uses — `.cell-sub` `never priced`, `—` in the value cell — rather than printing
`$0.00`, which would claim the household sold something worthless.

### 6.3 The as-of date

Two cases, and **the screen says plainly which happened** — the reader should never have to infer
from the presence of a control whether the file was dated.

- **The file carried a date** (the mapping named an as-of column): a static sentence in the commit
  form's leading edge — *"The statement dates itself: 2026-06-30."* — and **no control**. The date
  is printed as the ISO string the application stores and prints everywhere else; this brief adds
  no date-formatting grammar. The statement said it; offering an editor here would invite
  overriding a fact with an opinion.
- **The file carried none**: a labelled date input, caption "Statement date", defaulting to today,
  with the app's recordable-date bound as its `max` — the same rule the refusal states, because a
  control and its validator quoting two different rules is two rules. The sentence beside it:
  *"This file does not date itself."*

### 6.4 The majority-removal confirmation

**When the file removes more than half of what the account holds, the commit requires a tick
against a sentence stating the ratio in those words:**

> **"This file removes 12 of the 15 positions this account holds."**

Drawn with the weight of the danger-zone grammar — a block above the commit row with a top
hairline and 24px padding, the sentence in body-sm weight 600 `--on-surface` with the figures
tabular, the checkbox on its leading edge, the pair one `<label>` so the sentence is the hit
target. Not amber, not a banner: this is a decision being put to the reader, not a standing fact
about the data, and the danger-zone treatment — the one the app already uses for closing an
account — is the house weight for "this is the destructive one".

Unticked, the commit is **refused and nothing is written**: the screen re-renders with a
`.form-error` above the commit row — *"Nothing was recorded. Confirm the removals to record this
statement."* — and everything else intact. **A file that removes everything says so in those
words**: *"This file removes every position this account holds — all 15."* The general sentence's
arithmetic is technically true there too, and is exactly the phrasing that would soften the one
case that most deserves plain speech.

A first statement, and any file removing half or less, draws no confirmation at all — a tick that
is always demanded is a tick nobody reads.

### 6.5 Commit, and the receipt

The commit row closes the panel: a filled `.button` **"Record this statement"** — the flow's one
write, filled for the same reason the drop screen's continue is — beside a quiet `.button--text`
anchor **"Back to columns"**, because the misread-column story ends here: see every quantity a
thousand times too large, walk back, remap, return. Nothing was written, because nothing is written
before the commit.

**Three more refusals fire at the moment of the write, and all three render as a `.form-error`
above the commit row** — the house grammar for a refusal about the whole form rather than one
control:

- **A product the money column cannot hold.** Every row is checked with the exported
  `fitsTheMoneyColumn` — `quantity × cost_basis_per_share`, and the same product against the
  instrument's current price where one exists, since the valuation view casts that too. One row
  failing refuses the **whole** commit and names the instrument; nothing partially applied.
- **An account-number disagreement.** When the mapping named an account-number column and the
  account already has one recorded, a mismatch refuses the commit **naming both numbers** — this is
  the silent-collision failure first-class accounts exist to prevent, caught at the moment it would
  happen.
- **A closed account** — closed while the draft sat open — refuses in `setBalance`'s words: a
  closed account's history does not change.

**Success lands on the account** — `/accounts/:id?uploaded=<setId>` — with a `role="status"`
receipt. It needs a stated home, because a brokerage, 401k or IRA page has no set-balance panel to
host a confirmation: the sentence sits **directly under the account page's header, above the first
panel**, in the page's own type —

> "Recorded. **Positions_2026-06-30.csv** landed as 1 added · 3 updated · 1 removed, as of
> **2026-06-30**. Fidelity Brokerage now holds **5 positions**."

**Every figure in that sentence is read back from the database, never from the URL.** `?uploaded=`
names *which* set was written and says nothing about what is in it, so a hand-typed parameter can
only ever produce a sentence describing what the account actually holds — the same guarantee the
`?recorded=` receipt on this page already has. No toast, no green flash: the confirmation is a
sentence in the place the thing happened, and it stays until the next navigation.

**A committed draft posted again** — the back button pressed after success, a resubmitted tab —
renders the already-recorded page of §7.4 with a link to the account. The link is possible only
because the review form carries the account id as a hidden field: the draft the id would be read
from is gone, and the hidden field feeds that one link, never a write. Not a second set, not a 500.

**Draw this screen four times**: the ordinary diff above; the first statement ("14 ADDED", one
group, no confirmation, the VTSAX "3 rows combined" note visible); the majority-removal state with
the tick unticked and the refusal showing; and the removes-everything wording.

---

## 7. The empty and partial states

Eight, and each is its own sentence about its own situation — drawing one for another is a lie the
reader has no way to check. Draw them side by side.

### 7.1 No accounts at all

**The shell has already said everything.** When the household is empty, `root.tsx` renders the
existing first-run prompt — the `.first-run` card, `--secondary-container` ground, not
dismissible, already worded, pointing at Settings → People then Accounts — at the head of the
content column on every page, `/upload` included. The drop screen therefore draws **no prompt of
its own and no form at all**: a second prompt would double the one voice the app deliberately
keeps single, and a select over nothing and a file input that can lead nowhere are dead controls.
The page is its header, the step strip, and the shell's card above them.

### 7.2 Accounts exist, but every one is closed

An `.empty-state`: dashed border, centred, headline **"Every account is closed."**, detail *"A
statement lands in an open account, and a closed account's history does not change. Reopen or add
one under Settings → Accounts."* This must **not** be the first-run prompt — the household is set
up, and "start here" would be false — and must not be a bare refusal on the select, because there
is no select to refuse on.

### 7.3 An empty or undecodable file

A field-level `.field-error` on the drop screen's file input (§3), the account selection kept. The
flow does not advance — a draft over a file with nothing in it would carry the failure three
screens further from its fix.

### 7.4 An expired or already-committed draft

Any step URL over a draft that is gone — swept after 24 hours, already committed, or belonging to
an account since closed — renders the flow's not-found page: title **"This upload has expired or
was already recorded."**, a sentence of detail, and a link back to `/upload`. A committed draft
and a swept one are the same absence in the database, so **a GET cannot tell them apart and gets
exactly this page, with the `/upload` link only** — the title's "or" is honest about what is
knowable. The one richer case is the **re-POST of the review form** (§6.5): the form carries the
account id as a hidden field — feeding a link, not a write — so the already-recorded page reached
that way adds a link to the account, because "already recorded" means the reader most likely wants
to see the result. Never a 500: a bookmark that outlived its draft is ordinary behaviour, not an
error in anything.

### 7.5 Nothing unresolved

The instruments step is **skipped by redirect** — an empty screen saying "nothing to do" is a step
that charges a click for no decision — and the step strip shows **"3 New instruments · none"**
dimmed in place (§2.1), so the count of steps holds still and the skip is visible rather than
mysterious.

### 7.6 A saved mapping whose column disappeared

The columns screen, prefilled everywhere except the control whose column is gone, which opens
unselected under the sentence naming the disappearance (§4.1). Draw it with Cost basis unselected
and *"The saved mapping used a column called 'Average Cost Basis', which this file does not
have."* in the intro.

### 7.7 The majority-removal state

§6.4's confirmation block, drawn unticked with the refusal above the commit row.

### 7.8 The removes-everything state

§6.4's final wording — *"This file removes every position this account holds — all 15."* — with
the same tick, the same weight, and no extra ornament: the sentence is the alarm.

---

## 8. Mobile

**Everything reflows; nothing is withheld.** DESIGN.md §11's rule for this flow is specific:
upload is the canonical desktop-shaped workflow, the phone is for reading plus one-field writes,
and yet "not hidden — hiding it means being stuck on a tablet". So every screen here renders below
768px with the CSS the app already has, every control works, and the file input works on a phone —
a statement downloaded to a phone's files is a legitimate way in. What the flow does **not** get is
mobile-specific layout investment, and the brief says so rather than half-designing one:

- **The preview table and the diff table scroll sideways inside `.data-table-scroll`**, exactly as
  every non-Holdings table in the app already does. **There is deliberately no card reflow for the
  mapping table** — the card treatment exists once, as `.data-table--holdings`, built for a screen
  used daily on every device; building a second one for a preview read quarterly, on a screen §11
  classes as desktop work, is the "compromise the desktop version" trade §11 refuses. A sideways
  scroll inside the panel is the honest answer, and the page body still never scrolls
  horizontally.
- `.panel-form` controls wrap to full-width lines as the flex wrap dictates; the `.panel-header`
  stacks; the panel padding drops to 16px — all existing rules, nothing new.
- **The step strip wraps to two lines** at 390px rather than scrolling: it is text, not chips, and
  a hidden fourth step is exactly the "how much is left" information the strip exists to keep in
  view.
- The commit button and the confirmation checkbox remain full-size touch targets by the existing
  40px control rule; nothing in this flow needs `@media (hover: none)` treatment, because nothing
  in it hides behind hover.

Draw the columns screen at 390px once — the intro, the header-row form, the preview mid-scroll
with three of seven columns visible, and the mapping selects stacked beneath — and no other mobile
variant.

---

## 9. Do not

1. **Never render a figure where a value is missing.** A null cost basis, an unpriced value, an
   absent before-figure renders `—` (em dash). No `$0.00`, no "N/A", no blank cell that could be
   read as a zero. A zero on a finance page is a claim.
2. **Never coerce a null cost basis to zero.** It reports a fake gain equal to the whole untracked
   position. The 401k file with no basis column lands as null and is drawn as `—`, and that is the
   ordinary case, not an error.
3. **Never state removals as a count.** "1 removed" in the summary line is a count *beside* the
   table that lists AAPL, 50 sh, $8,500 in full. A count alone is how 28 holdings get sold by a
   filtered export nobody read.
4. **Never auto-select the account from the file.** The account is chosen first, by a person; a
   mapped account-number column is a *guard* that refuses a mismatch on commit, never a selector.
   Auto-selection is the silent collision first-class accounts exist to prevent.
5. **Never skip the columns screen, even when the mapping is prefilled.** A changed export must be
   visible, not silently reapplied. The saved mapping fills the controls; it does not pass the
   step.
6. **Nothing is written before the final commit**, with the one declared exception of §5's
   vocabulary — instruments, classifications and aliases created on the instruments step. No
   partial position set, no draft flag on a real table, no write on the columns screen.
7. **Never put a cell through `parseFloat`.** Numbers are decimal strings end to end —
   `$1,234.56`, `(1,234.56)` and `n/a` normalise to a decimal string or to null, never through a
   JavaScript number. Placeholder figures in the mock must be plausible decimal strings; a
   `0.30000000000000004` anywhere in a drawing is depicting a bug.
8. **No skip on the instruments screen.** Every first sighting is resolved or the step refuses. A
   skipped string is a holding silently missing from the statement.
9. **No drag-and-drop dependency.** A drop zone, if drawn, is decoration over the same native file
   input. The form posts with JavaScript off.
10. **No client state.** Every step is a URL over the server-side draft; back, reload and bookmark
    all work. No wizard state in memory, no dirty-state warning, no unsaved-changes badge — leaving
    a step loses nothing, because the draft holds the answers.
11. **No progress bar and no spinner.** The post is a navigation and the file is bounded at
    single-digit megabytes; the app has no loading state and this flow does not introduce one.
12. **No toast, no modal, no disabled-button-as-explanation.** Confirmations are inline sentences
    in place; refusals are `.field-error` and `.form-error` where they happened; a refused action
    renders its reason in words. A dead control explains nothing — which is also why closed
    accounts are absent from the select rather than disabled inside it.
13. **No editing figures on the review screen.** Review is read-only plus the date and the tick.
    A wrong figure is fixed by walking back to columns, because the figure is wrong in the mapping,
    not in the diff.
14. **The step count never changes.** Four entries, always; a step with nothing to do dims and
    says "· none". A flow that is sometimes three steps reads as a different flow.
15. **No hardcoded hex anywhere.** Every fill and stroke resolves from the tokens in §1.1 so a
    theme change recolours the flow for free. Draw every screen in both themes.
16. **No monospace, and every figure is `tabular-nums`.** There is no mono family in this app;
    `code` in prose is the only exception. The minus is U+2212, never a hyphen, in cells and in
    prefilled inputs alike.
17. **No brokerage furniture and no third-party assets.** No notification bell, no avatar, no
    "Import from your broker", no CDN fonts or icons. Single-tenant, self-hosted, offline-capable:
    the CSV arrives by hand on purpose.
18. **Do not lift figures from the existing mock set.** Its numbers contradict each other screen
    to screen. Use plausible, internally consistent placeholder data — including at least one
    liability, one never-priced holding, one null cost basis and one combined-lots row, all of
    which appear in §3–§6.

---

## 10. Reconciliation notes — for the engineer syncing this back

**Nothing in this flow exists yet beyond the stub.** `/upload` is a 14-line `StubPage`; the four
screens, the draft table and every rule above are the ingest spec (`docs/specs/0004-ingest.md` and
`docs/specs/ingest/01`–`05`), and a generated design is reconciled against *that spec* — where a
drawing and the spec disagree, the spec is the specification and the drawing is the thing that
moves.

**The three things a generated design gets wrong here, in order of likelihood.**

1. **A wizard with client state.** Stitch will want a stepper that advances in-page. Every step is
   a real URL over a server-side draft row; the step indicator is an `<ol>` of anchors and text,
   not a component with a "current step" prop. Output that keeps flow state anywhere but the URL
   and the draft is proposing a different application.
2. **Removals as a count, or a diff of coloured rows.** The removed group lists every position in
   full, in the table's ordinary type — no red row washes, no strikethrough. The confirmation
   sentence, not a colour, is what carries the danger.
3. **A drop-zone-first upload.** The native file input is the mechanism; the dashed target, if
   drawn at all, wraps it as decoration.

**Reuse, do not rename.** These class names already exist in `app/app.css` and are referenced by
built routes. Stitch output that renames them creates a duplicate design system:

`.page` · `.page-header` · `.page-title` · `.page-subtitle` · `.page-actions` · `.panel` ·
`.panel-header` · `.panel-title` · `.panel-count` · `.panel-body` · `.panel-form` · `.record-form` ·
`.form-intro` · `.data-table` · `.data-table-scroll` · `.is-numeric` · `.cell-stack` · `.cell-sub` ·
`.row-group` · `.badge` · `.button` (+ `--quiet` `--text` `--danger` `--block`) · `.field-note` ·
`.form-note` · `.field-error` · `.form-error` · `.coverage-note` · `.empty-state` (+ `-headline`
`-detail`) · `.empty-note` · `.first-run` · `.open-instance-banner` · `.danger-zone` ·
`.record-row--closed` · `.breadcrumb` · `.segmented` · `.u-data` · `.u-label` · `.visually-hidden`.

**Already true in code, so match it rather than redesigning it:**

- **The first-run prompt is built, worded and placed** (`app/components/first-run-prompt.tsx`,
  rendered by `root.tsx` inside `.app-main` as a card at the head of the content column — not a
  full-bleed banner). The shell already draws it on `/upload` when the household is empty; §7.1's
  whole job is to withhold the form, never to render a second prompt.
- **The closed-account refusal wording exists** — `setBalance`'s "a closed account's history does
  not change" — and §3 and §7.2 borrow it rather than paraphrasing.
- **The currency refusal's sentence is `CurrencyRefused`'s**
  (`app/lib/price-provider.server.ts:84`): "*{symbol} is quoted in {currency}. This instance holds
  USD only, so the price was not stored.*" §5.3 adapts only its tail. Note that
  `docs/design/pricing-ui-brief.md:239-240` coined a second spelling — "…and this app sums USD
  only" — before the guard shipped; that brief should be reconciled to the shipped words on its
  next sync, not the other way round.
- **`holdingNote()` in `app/lib/holdings-view.ts`** is the single producer of "never priced" and
  "price is stale". The review's removed-but-unpriced row and the added-but-unquoted row both
  borrow it; output that spells either phrase differently is changing shipped copy.
- **`—` for a null figure is already the per-cell rule** on Account detail and Holdings; the diff
  table extends the same conditional, and the `— → figure` pair is that rule appearing on one side
  of an arrow.
- **`input[aria-invalid="true"]` at 2px `--loss` is a shipped global rule.** Every refused control
  in this flow gets it for free by setting the attribute; no new error styling.
- **`.form-intro` and the `.panel-body + .panel-form` close-up are shipped** (the set-balance panel
  uses exactly this structure, confirmation and refusal included). The drop screen and every intro
  above are that structure reused.
- **The receipt-from-the-database pattern is shipped** as Account detail's `?recorded=`;
  `?uploaded=` is the same contract with a set id, and the receipt's figures come from a read of
  the set as committed, never from the URL.
- **Non-Holdings tables already scroll sideways on a phone** — `.data-table-scroll` is the whole
  mobile answer for the preview and the diff; there is nothing to build for §8.
- **`recordedDate` and `latestRecordableDate()` exist** (`app/lib/input.server.ts`); the review's
  date input carries the bound as its `max` so the control and the refusal state one rule.
  `effectiveDate` is §5.4's and is not used anywhere in this flow.
- **`formFields()` assumes string fields.** This is the application's first multipart form; the
  file handling and the size bound are new server ground (spec 01), not a design question — but
  the design must not assume a second submit while a file re-uploads, because a browser will not
  re-fill a file input programmatically. The draft holding the bytes is what makes every later
  step an ordinary string form.

**One deliberate deviation from the tickets, recorded so sync does not "fix" it.** Ticket 03 says
`costBasisIs` is "shown only when a cost basis column is chosen"; §4.4 renders it always, with the
`.field-note` saying when it applies — because a reveal that reacts to another control in the same
form needs JavaScript, and the note costs one line where the script would cost the app its first
piece of client state. The ticket's line is amended by this brief, not violated by it.

**Genuinely new, and needing new CSS:**

| New thing | Suggested name | Note |
|---|---|---|
| The step indicator | `.upload-steps` | `<nav aria-label="Upload">` over an `<ol>`. Text grammar from `.breadcrumb` (14px, `--on-surface-variant`, anchors underline on hover), middot separators, numbers tabular. Current step keys off `aria-current="step"` (`--on-surface`, 600); future steps — and completed step 1, which has no URL to return to (§2.1) — are plain `<span>`s; one modifier dims the skipped entry at `opacity: 0.6` — `.record-row--closed`'s precedent, not a new opacity |
| One first sighting's group | `.resolve-item` | A column at 24px padding with a top `--outline-variant` hairline (none on the first) — `.danger-zone`'s bounding without its row layout. The raw string at body-lg 600; everything inside it is existing controls |
| The before half of an updated cell | `.diff-was` | `--on-surface-variant`, weight 400, inside an `.is-numeric` cell that keeps weight 600 for the after figure; the arrow is U+2192 in `currentColor`. One class, because the old figure must recede without a second table grammar |
| Checkbox and radio controls | — | **The app has no checkbox or radio anywhere today**, and the shared `input` rule sizes every input at `--control-h` (40px). This slice needs the carve-out — `input[type="checkbox"], input[type="radio"]` at intrinsic size with an accent from `--primary-container` — plus an inline-row `label` variant (suggested `.choice`: inline-flex, 8px gap, control before caption), since the global `label` stacks its caption above the control and a radio's caption belongs beside it |
| The removal confirmation | reuse `.danger-zone` | The block is `.danger-zone`'s rule set holding a `.choice` label; the sentence's weight is inline type, not a new class. No new CSS expected beyond the checkbox work above |
| The drop-zone decoration | — | Only if the decoration is drawn: a dashed `--outline-variant` region wrapping the native input, borrowing `.empty-state`'s border grammar. Skippable entirely |
| Upload routes | — | New route files for the four URLs; no nav entry — the rail's existing filled button is the only way in, and the step screens are reached only through the flow |
| The expired-draft page | — | A **route-level `ErrorBoundary` on the upload layout route** (`routes/upload/draft.tsx`), owning the title of §7.4 and its links (`/upload` always; the account only on the review re-POST, from the hidden field). Not a change to the root boundary: today a route throwing `Response(404)` gets root's generic "404 Not Found" title and no link, which is the wrong page for an expired draft and the right page for everything else |

**Three token-level things to verify on sync:** every new figure carries `.u-data` or
`.is-numeric`; no new rule hardcodes a hex; and both the `prefers-color-scheme: dark` block and the
`:root[data-theme="dark"]` block are updated together, since they are duplicated by design so the
explicit toggle can beat the OS setting.
