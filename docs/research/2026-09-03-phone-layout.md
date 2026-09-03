# Phone layout: what §11 decides, and where the phone work actually went

Investigation, against `a405806`. **Nothing here is approved.** Measured on the demo household
([`scripts/seed-demo.ts`](../../scripts/seed-demo.ts)) at 390×900 with `isMobile`, unmasked — the
width and device the committed phone shots already use.

This document has been through two adversarial grounding rounds and **both found it wrong in the
same direction**: toward a more dramatic finding than the evidence carried. A claimed read/write
inversion did not survive a consistent measurement, and a claim that the phone layout was never
designed did not survive reading the base rules. What follows is what is left, and the retractions
are kept in §6 rather than deleted, because a rejected option not written down gets rediscovered.

## The three things worth knowing without reading further

1. **§11 names the read pages as what the phone is for, and its "no mobile-specific layout
   investment" clause does not reach them.** That clause sits in the third bullet, whose subject is
   every mutation except the two §11 funds. Nothing in §11 says the read screens should be sparse.
   That is the whole of the textual claim — it does not follow that read-screen work is *mandated*,
   and the case for doing any rests on the measurements below.

2. **On the two screens where it is unarguable, the phone does not fit.** Holdings draws no holding
   at all in the first screenful, and Account detail's first figure lands at 143% of it. The wider
   ranking I first drew across all screens does not hold: the landmarks are not the same kind of
   thing screen to screen, and Analysis at 45% sits among the write screens.

3. **Phone work concentrates in two places and thins out everywhere else.** Of the 23 arrangement
   declarations in the twelve `max-width: 767px` blocks, 15 are the Holdings card reflow and 3 the
   owner filter; seven of the blocks hold none. The Holdings brief's method — one DOM, card reflow,
   lead with the pair the phone is opened to read, hide nothing, controls two to a row — transfers
   to every read screen unchanged and never has been.

## 1. What §11 decides

[`DESIGN.md`](../../DESIGN.md) §11 opens **"The phone is for reading, plus one-field writes"** and
splits three ways: **Read** — every read page; **Write** — manual balance updates and
single-position corrections; **Everything else** — "still renders on mobile and still works if you
are determined; it simply gets no mobile-specific layout investment. Not hidden — hiding it means
being stuck on a tablet."

"Everything else" is defined at `DESIGN.md:1000` as "Every mutation except balance editing and
position correction" — so it covers the settings forms as well as the upload flow, and the clause
is a real statement about investment, not merely about scope. §11 offers its reason for the upload
flow specifically: it "is four screens with real state, and designing it for a 390px viewport would
compromise the desktop version that will actually be used."

**The claim this document makes is narrow: none of that reaches the read pages.** §11 names them,
in its first bullet, as what the phone is for. It does not follow that read-screen work is thereby
required — §11 funds nothing — only that no document forbids it. Whether any is worth doing is a
question for the measurements, not for §11.

Two constraints §11 does set that any change has to keep: nothing is hidden on a phone, and there
is no drawer or hamburger anywhere in the set (§13.5's breakpoints, 768 and 1024).

## 2. Measured

The usable first screenful at 390×900 is 771px, once the 64px sticky top bar and the bottom bar are
taken off. Two corrections are folded into every figure below, both of which moved the numbers when
they were found:

- **The ungated demo's open-instance banner is discounted** — a gated household never sees it. Its
  height only: the banner is a sibling of `.app-main` inside `.app-canvas`, which is not a flex
  container, so it brings no gap. Top bar 64 + banner 105 + `.app-main` padding 16 lands exactly on
  the first block on all nine screens, which is the check.
- **The household is unmasked**, for the reason `scripts/capture-screenshots.ts:81` states at
  length: the policy seeds masked and a fresh browser context has never been toggled, so without a
  cookie every screen measures as rows of dots.

**These distances are not a ranking, and the landmark column is why.** The screens are shaped
differently, and two earlier attempts to make one definition span all of them both produced
artifacts — asking each screen for "the thing it exists to show" counted Analysis's ring as
preamble while counting Overview's chart as content; a purely structural landmark put Account
detail at 8%, because that screen's first panel *is* its header block. The landmark is now named
per screen, and compared only where the comparison is like-for-like.

| Screen | To its landmark | | Landmark | To the first figure |
|---|---|---|---|---|
| Holdings | 838px | **109%** | the first holding | 109% |
| Account detail | 697px | 90% | the performance chart | **143%** |
| Overview | 462px | 60% | the trend line | — |
| Income | 463px | 60% | the first ring | 100% |
| Analysis | 347px | 45% | the first ring | 85% |
| Settings → Accounts | 320px | 42% | the first account row | 42% |
| Settings | 275px | 36% | the first setting | — |
| Upload | 244px | 32% | the first field | — |

**Two findings survive that.**

- **Holdings shows no holding in the first screenful**, and Account detail's first figure is at
  143% of one. Neither depends on a cross-screen comparison. `figures/holdings.png` is the whole
  argument: six filters reading their unfiltered defaults, a group-by strip, and the panel's top
  edge meeting the bottom bar.
- **Analysis and Income lead with a ring that carries no figures.** That is the route's own
  account of itself — `app/routes/analysis.tsx:33` says "the table is the screen, the ring a
  picture of it, so the table carries every figure and the ring none". The ring arrives at 45% and
  85% respectively; the figures arrive at 85% and 100%.

**Where the budget goes is arrangement, not spacing.** Gaps between top-level blocks total 24–48px
per screen: `.page` and `.app-main` both gap at `--space-lg` and neither is overridden on a phone
(`app/app.css:634`, `:495`), while `.panel-header`/`.panel-body` do drop 24→16 (`:828`). Real, but
48px of Holdings' 838px. The blocks are the cost — Holdings' filter bar is 314px, and Account
detail's header is 461px (derived: `measurements.json` records its 463px panel, less the 2px
border).

## 3. Where the phone work went

Counting declarations that change how a box is laid out or how many items share a line —
`flex-direction`, `display`, `grid-template-*`, `order`, `position`, `flex`, `flex-basis`,
`flex-wrap`. **The boundary is disclosed because it matters:** rules that apply to a phone live at
three breakpoints, not one.

| Where | Blocks | Declarations | What they are |
|---|---|---|---|
| `max-width: 1023px` | 1 | 10 | the phone's chrome: rail off, sticky top bar, fixed bottom nav (`app/app.css:505-627`) |
| `max-width: 767px` | 12 | 23 | 15 Holdings card reflow, 3 owner filter, 5 everything else |
| `min-width: 768px` | 3 of 4 | 7 | the desktop override; the phone keeps the base |

Within the twelve 767px blocks: **18 of the 23 sit in the single block at `app/app.css:3130`, and
three of those 18 are owner-filter rules sharing it** (`:3368`, `:3384`, `:3392`) rather than part
of the reflow. **Seven of the twelve blocks hold none** — though "they only change type and
padding" is true of only three of those seven; `:1161` steps the chart 20rem→13rem, and `:1622` and
`:1911` are measured cross-axis fixes this document cites approvingly in §4.

So the honest shape is: the phone's chrome was designed, Holdings was designed, and the rest got
one or two rules apiece.

## 4. Defect classes — each is one fix, many sites

Found while measuring. Bugs, not density, and independent of any redesign.

1. **A cross-axis property left standing after a phone `flex-direction: column`.** When a phone rule
   flips a flex container to a column, a `justify-content` set outside the query silently changes
   axis and goes inert. Three sites: `.page-header--bare`'s `flex-end` (`app/app.css:700`, defeated
   by `:705`); `.page-header`'s `space-between` (`:656`); and `.panel-header`'s `space-between`
   (`:788`), defeated twice, by `:836` and again by the `@container (max-width: 390px)` query at
   `:857`. A fourth of the same shape but a different property: `.page-header`'s `flex-wrap`
   (`:664`) becomes a block-axis wrap and does nothing. `.panel-header` is the highest-leverage —
   every panel on every screen.

2. **Only `.data-table--holdings` gets the card reflow** (`app/app.css:3131-3341`). Account detail
   renders a plain `.data-table` (`app/routes/account.tsx:496`) with no `data-label` attributes, so
   its table overflows the 356px scroll box —
   [`2026-08-24-exploratory-test-report.md`](./2026-08-24-exploratory-test-report.md) measured the
   content at 503px there; this harness measures no table width, so 503px is that report's figure
   and not a second confirmation. The upload review diff is the same case: it takes Holdings' table
   grammar deliberately (`app/routes/upload/review.tsx:219`) but gets none of the reflow, so the
   household scrolls sideways to read the value column on the screen where a statement is
   committed.

3. **24px padding surviving into the phone** on `.detail-header` (`:1803`) and `.breakdown-chart`
   (`:1458`), already fixed for `.filter-bar` (`:3343`) with the argument written out: "a step in
   the phone's left margin running the length of the page".

4. **`label.choice` has `align-items: center` and no phone rule** (`app/app.css:2154-2158`). Its
   longest sentence — the close-account acknowledgement — wraps to about five lines at 324px,
   putting the checkbox beside line three. The identical failure was diagnosed and fixed for
   `.cell-stack` (`:1608-1621` diagnosis, `:1622-1633` fix).

5. **No `scroll-margin-top` anywhere in the stylesheet.** The account page's set-balance shortcut is
   an in-page anchor and the top bar is sticky at 64px below 1024px, so the jump parks the panel
   header underneath it. Desktop is unaffected — the bar does not exist there. This one is on a
   §11-funded write.

6. **The 88px bottom reserve is short on a notched phone.** `app/app.css:512` hardcodes 88px while
   the bar's own padding adds `env(safe-area-inset-bottom)` — about 99px on a modern iPhone, so the
   last ~11px of the page sits under the bar, and on every write screen the last element is the
   submit button. Playwright does not emulate the inset, so no screenshot catches this.

**The method these would follow already exists.** The Holdings brief
([`holdings-ui-brief.md`](../design/holdings-ui-brief.md), shipped at `app/app.css:3131-3341`) sets
five rules: one DOM rather than two, because a separate mobile tree is "two renderings of one query
that can disagree, and it is the disagreement — not the layout — that is expensive"; draw at 390px;
lead with the pair the phone is opened to read; hide nothing, because "hiding it would make an
absence look like a field that does not exist"; and controls two to a row, because "seven stacked
full-width controls is most of a phone screen consumed before the table they filter has started".
Rule 3 is the one no other screen has an answer to.

## 5. Ideas, graded by what they cost in documents

**Unconstrained.** A phone arrangement for `.panel-header` — currently a stacked title, count and
note on every panel, where the count usually restates the row count below it. Ordering the ring
after its table on the breakdown screens, which is DOM order and named in no document. All six
defects in §4.

**Contradicts a document.** Moving the refresh control to a panel header:
[`specs/pricing/06-refresh-now-control.md:17`](../specs/pricing/06-refresh-now-control.md) sends the
reader to [`pricing-ui-brief.md`](../design/pricing-ui-brief.md) for visual design, and that brief's
placement table puts the as-of line directly under the figure on Overview — though the same table
already puts it in `.panel-header`'s right slot on Holdings, so the shape is the brief's own.
Constraints either way: the timestamp stays adjacent to the button, and a text label stays while
busy, because `app/app.css:3556` turns the spinner off under `prefers-reduced-motion`.

**Contradicts a document, and the reason is stronger than it first looks.** Pairing the owner filter
with the range strip. [`specs/0013-owner-filter.md:196`](../specs/0013-owner-filter.md) reads: "Not
beside the chart range: Overview's range control lives in the hero section, not the header, so
'beside the range' would name a different place on each screen." An earlier draft of this document
quoted only the first half and called the remainder an observation rather than a principle. The
second half is the principle, and it stands. The alignment defect (§4.1) is separable and fixable
on its own.

**Needs an ADR.** Phone layout investment on the write screens, which is what §11's third bullet
declines. Note the bar is not absolute in practice: `app/app.css:2616` gives every settings and
upload field its own line, and its comment justifies it as restoring function rather than adding
polish — a select that rendered 684px in a 308px column, "arrow cut off, nothing to scroll to reach
it", against the same bullet's promise that everything "still works if you are determined". That is
the seam to argue on, and it is narrower than an earlier draft of this document claimed.

## 6. Rejected, and retracted

Kept so they are not rediscovered.

- **Tighten `--space-lg` globally.** 24px is right at 1280px, and §2 shows the rhythm is 48px of
  Holdings' 838px.
- **A second mobile component tree.** Rejected in the Holdings brief: two renderings of one query
  can disagree, and the disagreement is the expensive part.
- **Hide anything on a phone.** §11 and the brief refuse it from opposite directions.
- **Shrink the Overview headline figure.** It is the page's title (`app/routes/overview.tsx:52`).
- **A phone-specific spacing scale.** The cost is arrangement, not tokens.
- **RETRACTED — "the read screens all cost more than the write screens".** An artifact of measuring
  different landmarks on different screens. Analysis is 45%, below every write screen's figure-row
  distance. What survives is the two screens in §2.
- **RETRACTED — "the phone is not designed; it receives what the desktop rule stopped
  overriding".** False for every block it was claimed of. `.breakdown` declares
  `flex-direction: column` in its base (`app/app.css:1447-1450`) under a comment that states the
  phone outcome as intent — "Below 768px the two stack and the hairline turns horizontal"
  (`:1442-1445`) — and `.detail-header` does the same (`:1799-1804`), with its own measured 390px
  phone rule at `:1928`. What is genuinely unargued is only the *order within* the stack: nothing
  names ring-before-table.
- **RETRACTED — "§11's bullets are a scope list, not an investment schedule".** The bullet says "no
  mobile-specific layout investment"; the sentence contradicted its own quotation.

## Figures

Each is one 390×900 viewport, unmasked, against the demo household.

| | | |
|---|---|---|
| ![Overview](./2026-09-03-phone-layout/figures/overview.png) | ![Holdings](./2026-09-03-phone-layout/figures/holdings.png) | ![Holdings grouped](./2026-09-03-phone-layout/figures/holdings-grouped.png) |
| Overview — trend line at 60% | Holdings — no holding in frame | Holdings, grouped |
| ![Analysis](./2026-09-03-phone-layout/figures/analysis.png) | ![Income](./2026-09-03-phone-layout/figures/income.png) | ![Account detail](./2026-09-03-phone-layout/figures/account-detail.png) |
| Analysis — ring first, figures at 85% | Income — figures at 100% | Account detail — figures at 143% |
| ![Settings](./2026-09-03-phone-layout/figures/settings.png) | ![Settings accounts](./2026-09-03-phone-layout/figures/settings-accounts.png) | ![Upload](./2026-09-03-phone-layout/figures/upload.png) |
| Settings — 36% | Settings → Accounts — 42% | Upload — 32% |

## Reproducing

[`2026-09-03-phone-layout/harness/measure-phone.ts`](./2026-09-03-phone-layout/harness/measure-phone.ts)
walks the box tree of each screen at 390×900 and writes the captures and
`figures/measurements.json`. It measures rather than reading a screenshot, because at a 2x device
pixel ratio counting pixels off an image is guesswork. Its per-screen landmarks are declared in one
table at the top, with the reason each was chosen. Stand a demo instance up as
[`scripts/capture-screenshots.ts`](../../scripts/capture-screenshots.ts) documents, then:

```sh
CHROMIUM_EXECUTABLE=… node ./docs/research/2026-09-03-phone-layout/harness/measure-phone.ts
```

It reads no database of its own — only `BASE_URL` and `CHROMIUM_EXECUTABLE`.
