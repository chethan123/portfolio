# Phone layout: what §11 decides, and what the stylesheet actually does

Investigation, against `a405806`. **Nothing here is approved.** Measured on the demo household
([`scripts/seed-demo.ts`](../../scripts/seed-demo.ts)) at 390×900 with `isMobile`, the width and
device the committed phone shots already use.

The question that started it: the Overview spends most of a phone's first screenful before the
trend line begins. Is that a decision this project made, or drift? The answer is neither, and the
gap between the two is the whole of this document.

## The three things worth knowing without reading further

1. **§11 already decides the phone is for reading — and the read screens are the ones that do not
   fit.** Four of the five cost more than four fifths of the first screenful before their content
   starts; Holdings costs more than all of it. The three write screens §11 explicitly declines to
   invest in are the cheapest on the phone, none of them past two fifths. The declaration and the
   layout point in opposite directions.

2. **Phone layout exists in this stylesheet twice, and both times on Holdings.** Of fifteen
   declarations across the twelve `max-width: 767px` blocks that genuinely re-arrange the box tree,
   thirteen are in the Holdings card reflow. Nine of the twelve blocks contain none at all —
   they change type size and padding. There is no third place where the phone gets a different
   arrangement rather than a smaller one.

3. **The method is already written down and shipped; it was never generalised.**
   [`holdings-ui-brief.md`](../design/holdings-ui-brief.md) argues card reflow, one DOM, lead with
   the pair the phone is opened to read, hide nothing, and controls two to a row. Every one of
   those transfers to the other read screens unchanged. Most of what follows is "apply the
   argument this project already accepted".

## 1. What §11 decides, and the clause that gets misread

[`DESIGN.md`](../../DESIGN.md) §11 opens **"The phone is for reading, plus one-field writes"** and
splits three ways:

- **Read** — every read page.
- **Write** — manual balance updates, and single-position corrections on Holdings.
- **Everything else** — "still renders on mobile and still works if you are determined; it simply
  gets no mobile-specific layout investment. Not hidden."

The "no mobile-specific layout investment" clause is attached to the **third** bullet. It is about
the desktop-shaped write flows, and §11 gives a specific reason for them: upload → mapping →
resolution → diff → commit "is four screens with real state, and designing it for a 390px viewport
would compromise the desktop version that will actually be used." That argument is still sound and
nothing here disputes it.

What it is not is a decision that the read screens should be sparse. §11 names them as what the
phone is *for*. **Work on the read screens executes §11; work on the write flows reverses it.**
That line decides which ideas below need an ADR and which do not.

Two further constraints §11 sets that any change has to keep: nothing is hidden on a phone, and
there is no drawer or hamburger anywhere in the set (§13.5's breakpoints, 768 and 1024).

## 2. Measured

Preamble is the distance from the bottom of the sticky top bar to the top of the first element the
screen exists to show — the first holding row, the chart, the first field. The usable first
screenful at 390×900 is 771px once the 64px top bar and the bottom bar are taken off. The demo
instance runs ungated, so the open-instance banner it draws is discounted from every figure.

The write screens are the control group, and their selector means the same thing as the read
screens': the first content *inside* a panel, past its header. Measuring them to the panel's own
top edge instead would have flattered them by a panel header apiece and exaggerated the gap this
report is about.

| Screen | Preamble | Of the first screenful | §11 class |
|---|---|---|---|
| Holdings | 814px | **106%** | read |
| Income | 745px | 97% | read |
| Account detail | 673px | 87% | read |
| Analysis | 629px | 82% | read |
| Overview | 438px | 57% | read |
| Settings → Accounts | 296px | 38% | write |
| Settings | 251px | 33% | write |
| Upload | 220px | 29% | write |

**The ordering is the finding.** The screens §11 says the phone exists for are the expensive ones;
the screens §11 says to leave alone are the cheap ones. On Holdings the first holding is entirely
below the fold — a phone opened to the screen that answers "what do we hold" shows a filter bar and
a sort strip, and no holding.

Two figures behind those totals are worth separating, because they are different problems:

- **Rhythm.** The gaps between top-level blocks total 24–48px per screen. `.page` and `.app-main`
  both gap at `--space-lg` and neither is overridden on a phone (`app/app.css:634`, `:495`), while
  `.panel-header`/`.panel-body` do drop 24→16 (`app/app.css:828`). Padding compresses on a phone;
  the rhythm between blocks does not. Real, but small — it is not where the 814px goes.
- **Blocks.** The panel header alone costs 174–411px per screen. That is where the budget goes,
  and it is an arrangement problem, not a spacing one.

## 3. The stylesheet's own account of itself

Twelve `@media (max-width: 767px)` blocks. Counting only declarations that genuinely re-arrange the
box tree — `flex-direction`, `display`, `grid-template-*`, `order`, `position`:

- **15 such declarations in total.**
- **13 of them are in the Holdings card reflow** (`app/app.css:3130`).
- **9 of the 12 blocks contain none.** The remaining two are one `flex-direction: column` each, on
  `.page-header` (`app/app.css:703`) and `.panel-header` (`:827`) — "stack it".

Outside Holdings, the phone rules shrink type, shrink padding, and stack. That is the mechanism
behind every number in §2, and it is one sentence: **the phone layout is the desktop layout with
`flex-wrap` doing the work.**

## 4. The method already exists

Two places have real phone design, and both state their reasoning.

**The Holdings card reflow** ([`holdings-ui-brief.md`](../design/holdings-ui-brief.md), shipped at
`app/app.css:3130-3394`, the one phone block that does real work) establishes five rules:

1. **One DOM, not two.** A separate mobile tree is "two renderings of one query that can disagree,
   and it is the disagreement — not the layout — that is expensive". The reflow is `display: block`
   on the table plus `::before { content: attr(data-label) }` for the labels.
2. **Draw at 390px.**
3. **Lead with the pair the phone is opened to read** — on Holdings, asset and value, side by side.
4. **Hide nothing.** A null value still draws its row with an em dash, because "hiding it would
   make an absence look like a field that does not exist". This is §11's "Not hidden" as a
   component rule.
5. **Controls go two to a row, not one** — "seven stacked full-width controls is most of a phone
   screen consumed before the table they filter has started".

**The Holdings correction** (`app/app.css:3269-3320`, inside that same block) is the second: the input takes the whole row
with its label at the leading edge, because "a box sharing its line with the label would be a third
of a phone wide". This is the §11-permitted write, and it works.

Rule 3 is the one with no answer anywhere else. Holdings knows what pair its reader opens it for.
Overview, Analysis, Income and Account detail have never been asked the question.

## 5. What each read screen spends it on

Cited to `a405806`. The per-screen detail behind the table in §2.

**Overview** — 438px. Six stacked full-width rows before the panel: owner chip, eyebrow, figure,
as-of, refresh button, outcome note, then the range strip. None shares a line at 390px. `.kpi`
(`app/app.css:869`) has no phone rule at all; on desktop the range strip sits right of the headline
and on a phone it simply wraps.

**Holdings** — 814px. The filter bar is 314px (six selects, two-up, plus an actions line that always
wraps alone because a third item never fits beside two at `calc(50% - 16px)`). The group-by strip
adds 52px, the panel header 81px, the sort strip 65px. Every select reads its unfiltered default on
a pristine screen.

**Analysis** — 629px, and the composition is the problem rather than the total: `.breakdown` is a
column below 768px (`app/app.css:1447`) so the 200px donut is drawn **above** its table, four times
over. `app/routes/analysis.tsx:33` says the table is the screen and the ring is a picture of it —
on a phone the thing carrying no figures is what you see first.

**Income** — 745px. Same donut inversion, plus a coverage note that runs to about six lines at
390px; its `max-width: 60ch` cap is wider than the phone, so the cap never engages.

**Account detail** — 673px. `.detail-header` is roughly 545px: identity block, total, freshness
pair, and three action buttons that each take their own line because two do not fit in 310px.
`.detail-header` also keeps 24px padding on a phone (`app/app.css:1803`) — the exact defect
`app/app.css:3343` was written to fix for `.filter-bar`, quoted there as "a step in the phone's
left margin running the length of the page". `.breakdown-chart` (`:1458`) has it too.

## 6. Defect classes — each is one fix, many sites

Found while measuring. These are bugs, not density, and several are independent of any redesign.

1. **`justify-content` left standing after a phone `flex-direction: column`.** When a phone rule
   flips a flex container to a column, the `justify-content` set outside the query silently changes
   axis and goes inert. Four sites: `.page-header--bare`'s `flex-end` (`app/app.css:700` vs `:704`)
   — whose own comment says the control "stays in the same place on all four screens", which on a
   phone it does not; `.page-header`'s `space-between` (`:656`); `.panel-header`'s `space-between`
   (`:788`), defeated twice over, by `:836` and again by the `@container (max-width: 390px)` query
   at `:857`; and `.page-header`'s `flex-wrap` (`:664`). `.panel-header` is the highest-leverage —
   every panel on every screen.

2. **Only `.data-table--holdings` gets the card reflow** (`app/app.css:3130-3394`). Account detail renders a plain
   `.data-table` (`app/routes/account.tsx:496`) with no `data-label` attributes, so its four
   columns measure about 490px in a 356px canvas and scroll sideways. The upload review diff is
   the same: it takes Holdings' table grammar deliberately (`app/routes/upload/review.tsx:219`) but
   gets none of the reflow, so the household scrolls horizontally to read the value column on the
   screen where a statement is committed.

3. **24px padding surviving into the phone** on `.detail-header` (`:1803`) and `.breakdown-chart`
   (`:1458`), already fixed for `.filter-bar` (`:3343`) with the argument written out.

4. **`label.choice` has `align-items: center` and no phone rule** (`app/app.css:2154`). Its longest
   sentence — the close-account acknowledgement — wraps to about five lines at 324px, putting the
   checkbox beside line three. This is the identical failure already diagnosed and fixed for
   `.cell-stack` at `:1623`.

5. **No `scroll-margin-top` anywhere in the stylesheet.** The account page's own set-balance
   shortcut is an in-page anchor, and the top bar is `position: sticky` at 64px below 1024px, so
   the jump parks the panel header underneath it. Desktop is unaffected — the bar does not exist
   there. This one is on a §11-supported write.

6. **The 88px bottom reserve is short on a notched phone.** `app/app.css:512` hardcodes 88px while
   the bar's own padding adds `env(safe-area-inset-bottom)` — about 99px on a modern iPhone, so the
   last ~11px of the page sits under the bar, and on every write screen the last element is the
   submit button. Playwright does not emulate the inset, so no screenshot catches this.

7. **Known and never filed.** [`2026-08-24-exploratory-test-report.md`](./2026-08-24-exploratory-test-report.md)
   already recorded the non-Holdings tables overflowing at 390px; nav labels overflowing their box
   below ~365px and badges sitting low at exactly 768px were both recorded as "found, not fixed" in
   merged pull requests. None became an issue. There is no `mobile`, `ui` or `design` label in the
   tracker, and no issue that amounts to "the phone layout is too sparse" — phone work here has
   only ever arrived as defect fixes inside other work.

## 7. Ideas, and the ones already rejected

Graded by what they cost in documents rather than in code, because that is what decides whether
they can start.

**Free — nothing written down constrains these.**

- Give `.panel-header` a phone arrangement. It is the single largest block on every screen
  (174–411px) and is currently a stacked title, count and note, where the count usually restates
  the row count below it.
- Move the refresh control into the panel header's right slot. That slot exists and is empty on
  Overview; [`specs/pricing/06-refresh-now-control.md`](../specs/pricing/06-refresh-now-control.md)
  fixes the control's content, timezone and behaviour and specifies **no placement at all**. Keep
  the timestamp adjacent — that pairing is the point of the component — and keep a text label while
  busy, because `app/app.css:3556` turns the spinner off under `prefers-reduced-motion` and the
  label is what carries the state for those users.
- Draw the donut beside its table, or below it, on a phone. Analysis and Income both put a
  figure-free ring above the table that carries every figure.
- All seven defects in §6.

**Needs a spec change.**

- Pairing the owner filter with the range strip. [`specs/0013-owner-filter.md`](../specs/0013-owner-filter.md)
  places the control inside `.page-actions` and states that is the placement on all four screens;
  it explicitly rejects putting it beside the range control, on the grounds that Overview's range
  control sits in the hero. That reason is an observation, not a principle, and no document
  requires the range control to stay there — but changing it is a spec edit, not a CSS edit. The
  alignment half of the problem (defect 1) is fixable on its own without touching the spec.

**Needs an ADR.**

- Any phone layout work on the upload flow or the settings forms. That reverses §11's third bullet,
  and [`docs/README.md`](../README.md) scopes ADRs to decisions that are hard to reverse and the
  result of a real trade-off. Note this is not needed for the *defects* on those screens — fixing a
  checkbox that floats beside line three is not layout investment.

**Rejected, with reasons, so they are not rediscovered.**

- **Tighten `--space-lg` globally.** 24px is right at 1280px. The problem is a phone problem and
  §2 shows the rhythm is 24–48px of the 814px anyway — this would cost desktop and buy almost
  nothing.
- **A second mobile component tree.** Already rejected in
  [`holdings-ui-brief.md`](../design/holdings-ui-brief.md): two renderings of one query can
  disagree, and the disagreement is the expensive part.
- **Hide anything on a phone.** §11 and the Holdings brief both refuse it, from opposite
  directions.
- **Shrink the Overview headline figure.** It is the page's title —
  `app/routes/overview.tsx:52` argues the figure sits on the canvas rather than in a panel exactly
  so it does not read as one card among several.
- **A phone-specific spacing scale.** Not proposed here. §2 shows the cost is in arrangement, not
  in the tokens, and a second scale is a second thing to keep in step.

## 8. Open questions

- **What is the pair each screen is opened to read?** Holdings answered it. Overview is probably
  the net worth and its change; Analysis, Income and Account detail have no answer. This is the
  question that decides every arrangement below it, and it is not a CSS question.
- **The type ramp's in-between rule is the stylesheet's, not the design record's.** §13.4 names
  seven steps but does not forbid sizes between them; `app/app.css:720` and `:904` assert that it
  does. There is a live disagreement underneath: `pricing-ui-brief.md` documents the phone Overview
  headline at 36px and the code overrides it to 32px, calling 36px invented. One of the two should
  change.
- **`--canvas-margin`'s breakpoint is in no authoritative document.** §13.5 gives it as 16px→32px
  mobile→desktop without saying where; only a stale brief names 1024px, which is what the code does.
- **Should the range strip still scroll sideways?** `specs/0008-chart-ranges.md` left the phone
  layout of eight presets explicitly open. Pull request #221 made the Custom picker reachable and
  bounded the strip to its parent, so the open question is now narrower — it scrolls, and that
  works — but it is the only sideways-scrolling control in the app.

## Reproducing

[`2026-09-03-phone-layout/harness/measure-phone.ts`](./2026-09-03-phone-layout/harness/measure-phone.ts)
walks the box tree of each screen at 390×900 and writes both the captures and
`figures/measurements.json`. It measures rather than reading a screenshot, because at a 2x device
pixel ratio counting pixels off an image is guesswork. Stand a demo instance up as
[`scripts/capture-screenshots.ts`](../../scripts/capture-screenshots.ts) documents, then:

```sh
CHROMIUM_EXECUTABLE=… node --env-file=.env.demo \
  ./docs/research/2026-09-03-phone-layout/harness/measure-phone.ts
```
