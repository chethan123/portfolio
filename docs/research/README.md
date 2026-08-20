# Research

Investigation output. **Nothing here is an approved slice** — approved work lives in
[`../specs/`](../specs/), and the authoritative design record is [`../../DESIGN.md`](../../DESIGN.md).
These documents exist so the reasoning behind a recommendation can be checked, and so a rejected
option is not rediscovered later.

## 2026-08-19 — Stitch screens and the FIRE audience

Four documents from one investigation: what the Stitch mock actually contains, what the audience
needs, what to build, and how the data layer would work.

| Document | What it answers |
|---|---|
| [Stitch screen audit](./2026-08-19-stitch-screen-audit.md) | What is really in the twelve mock screens — **and four corrections to DESIGN.md §13** |
| [Market analysis](./2026-08-19-market-analysis.md) | What comparable tools do, what FIRE practitioners track, and which metrics a positions-only schema can honestly support |
| [Screen recommendations](./2026-08-19-screen-recommendations.md) | Changes to the three existing screens, three new ones, and what must be refused |
| [FIRE data-layer design](./2026-08-19-fire-data-layer-design.md) | Schema, module signatures, exact-decimal rounding, coverage semantics, test cases |

### The four things worth knowing without reading further

1. **DESIGN.md §13's dark palette came from the wrong screens.** The "dark" mocks are not dark
   variants — they are an older design generation, branded *WealthArch* with an *Invest Now* CTA, a
   time-weighted-return annotation and a risk gauge. §13.7 already refuses all four of those without
   noticing they share a generation, and that the generation is the source of the dark column.

2. **There is a real bug in `allocation.ts` today.** `USD` is classified `Cash` → `asset_class =
   'cash'`, and a liability is a negative `USD` quantity — so a mortgage is currently filed **into
   the cash slice**. Harmless on Analysis, money-losing on a rebalance page: a $300k mortgage against
   a 5% cash target would say *buy $315k of cash*.

3. **Positions-only is not the handicap §14.2 treats it as.** The Mad Fientist's flow and the
   Bogleheads quarterly balance sheet are both balances-only, and Portfolio Performance's FIRE widget
   simply asks the user for the FIRE number. One typed scalar — annual expenses — unlocks most of the
   FIRE metric set.

4. **Rebalancing is the unclaimed position.** Ghostfolio has FIRE framing, no rebalancing at all, and
   Premium-gates its FIRE page even in the self-hosted build. Portfolio Performance has the reference
   implementation and is a Java desktop app. Nobody combines the two on the web.

### Evidence

[`stitch-2026-08/`](./stitch-2026-08/) holds five rendered screenshots at full resolution — the
primary evidence for the audit's corrections, since the earlier HTML-only extraction could not see
any chart, donut or gauge. These are mock screens from Stitch; screenshots of **this app** live in
[`../screenshots/`](../screenshots/).

> Reproducing: screenshot URLs from the Stitch MCP `list_screens` call serve **512px thumbnails** by
> default. Append `=s2560` for full resolution.

### Status

The two assumptions in the recommendations were resolved without an answer from the user and are
flagged at the top of that document: typed scalars are acceptable, and DESIGN.md §3 stands
(contribution inference deferred).
