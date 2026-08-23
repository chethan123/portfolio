# Research

Investigation output. **Nothing here is an approved slice** — approved work lives in
[`../specs/`](../specs/), and the authoritative design record is [`../../DESIGN.md`](../../DESIGN.md).
These documents exist so the reasoning behind a recommendation can be checked, and so a rejected
option is not rediscovered later.

## 2026-08-23 — Dependency audit

One document: [Dependency audit](./2026-08-23-dependency-audit.md) — every package in
`package-lock.json` checked for use, maintenance, advisories and tampering, against `2cea455`.

### The three things worth knowing without reading further

1. **`yahoo-finance2` was 65% of the production tree and none of it ran.** Version 4 declares the MCP
   server SDK, a Deno shim and a fetch-mocking library as runtime dependencies, for a subpath and two
   CLI bins this application never touches — dragging a second Express, plus Hono, jose, cors and ajv
   into the image. 59 packages now pruned in the Docker build, verified by booting the pruned tree.

2. **No advisories anywhere, and the zero was checked rather than trusted.** The endpoint `npm audit`
   queries was confirmed live against three known-bad versions first. One deprecated package
   (`tsconfck`, via `vite-tsconfig-paths`) has been removed; the tree now has none.

3. **No sign of tampering.** Every lockfile entry resolves to `registry.npmjs.org` with a `sha512`
   hash and a registry signature; only `esbuild` and `fsevents` run install scripts, both dev-only.
   The `chalk`/`debug` family is present but at clean versions.

### Status

The changes in §6 are applied. §7 lists what was deliberately left: an upstream issue on
`yahoo-finance2`, an OSV cross-check from an unrestricted network, Dependabot, and React Router 8.

## 2026-08-23 — Architecture review

One document: [Deepening opportunities](./2026-08-23-architecture-review.md) — ten candidates for
turning shallow interfaces into deep ones, reviewed against `f550132`.

### The three things worth knowing without reading further

1. **`rememberMapping` is the one correctness finding.** `had_first_sightings` is computed inside
   `saveMapping` from one alias query; the redirect target is chosen at `upload/columns.tsx:275` from
   a strictly later one. An alias inserted between them leaves the persisted step-strip bit
   disagreeing with the step the reader was sent to. `saveMapping`'s own header argues the premise —
   "this is the one moment the answer exists" — and stops one step short of the conclusion.

2. **Five findings were rejected, three of them initially rated Strong.** This codebase argues its
   decisions in module headers, so the dominant failure mode for a review like this is
   re-litigation. §4 records each rejection with the quote that killed it, including two that were
   at some point the review's top recommendation.

3. **No test in this repo imports a route.** There is no `@testing-library`, `happy-dom` or `jsdom`
   in `package.json`, so anything living in a route module is untestable by construction. That is a
   standing constraint on where logic can go, not a finding.

### Status

Nothing here is approved work. §3 suggests a sequence if any of it is taken; the two byte-identical
duplications (§2.3 `inTransaction`, §2.4 `labelOf`) are minutes each and independent of the rest.

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
