# Research

Investigation output. **Nothing here is an approved slice** — approved work lives in
[`../specs/`](../specs/), and the authoritative design record is [`../../DESIGN.md`](../../DESIGN.md).
These documents exist so the reasoning behind a recommendation can be checked, and so a rejected
option is not rediscovered later.

## 2026-08-28 — External review, validated line by line

Two documents: an external (Codex) data-model and architecture review, and the validation pass that
checked every claim in it against the tree the next day.

| Document | What it answers |
|---|---|
| [Codex review](./2026-08-28-codex-review.md) | An outside reading of the domain model, schema, dataflows and risks, with a ranked improvement list — against `410a61f`, a tree from before the auth gate replaced the in-app password |
| [Validation](./2026-08-29-codex-review-validation.md) | Which of those findings hold on the current tree: sixteen confirmed — fifteen of the review's, plus one of the validation's own that the review missed — and the rest rejected or downgraded with the evidence |

### The three things worth knowing without reading further

1. **Sixteen findings confirmed**, the sharpest being a statement row with a quantity but a blank
   instrument cell dropped without a word, a derived-product overflow that can take every money
   screen down at once, and a lost Postgres connection killing the process — which a pool-level
   error listener alone does not fix, as the remediation spec's own measurements show. Where they
   overlap the exploratory report below, they are the same defects seen twice.
2. **The review's auth findings were moot on arrival**: it read a tree from before the forward-auth
   gate ([ADR-0005](../adr/0005-auth-is-a-forward-auth-gate.md)) deleted the password machinery it
   analysed.
3. **The validation's own finding — the open-redirect residue in `safeReturn` — has since been
   closed**: the guard was rebuilt as `app/lib/return-path.ts`, resolving the posted path against a
   throwaway origin, after the validation's stated HEAD (`91f901d`).

### Status

The validation is the document to act from; the review is kept as its input. Nothing in either is
approved work by itself — where a finding became approved work it did so as the exploratory
report's version of the same defect, through
[`../specs/0005-report-remediation.md`](../specs/0005-report-remediation.md), below.

## 2026-08-25 — Upload workflow UX review

Two documents from one investigation: what the statement workflow costs a household, and how the
columns screen could stop asking them to do the mapping by hand.

| Document | What it answers |
|---|---|
| [Upload UX review](./2026-08-25-upload-ux-review.md) | What day one costs, what the quarter after costs, and the thirteen findings between them |
| [Broker header aliases](./2026-08-25-broker-header-aliases.md) | If the columns screen should arrive with a proposed mapping — **matched how?** — and why not fuzzily |

### The four things worth knowing without reading further

1. **Adding a second account silently copies the first one's owner, kind, tax treatment and account
   number.** The add form keeps every value after a *successful* add — the action returns `null`
   precisely so the fields reset, and an uncontrolled input does not reset on a re-render. Filing an
   account under the wrong tax treatment is wrong on every screen that reads the taxable/sheltered
   split, and nothing anywhere suggests it happened.

2. **A first run done at a weekend ends at `$0.00` net worth.** The poller has no immediate first
   tick — deliberately — and returns early whenever the market is shut, so a household that sits down
   on a Sunday finishes a correct onboarding and is shown a headline of `$0.00` over four accounts of
   `$0.00` until Monday. The account page already refuses that figure under a rule naming this exact
   case; the Overview's headline prints it. `DASH-3` covers the per-account rows and says so; the
   headline is uncovered.

3. **A repeat upload asks almost nothing, and the design intent holds.** Day one costs 130
   interactions across 36 screens; the same account the next quarter costs 11. Every column choice
   and the header row come back filled, and the instruments step dims to *· none*. The never-skipped
   columns screen costs one glance, not one decision.

4. **Fuzzy-matching the column names would make things worse, and not for the obvious reason.** The
   abbreviations such a matcher exists to catch sit *further away* than the collisions it must avoid:
   normalised by length, `qty` → `quantity` is 0.625 while `units` → `unit price` is 0.600 and
   `shares` → `share price` is 0.545, and this repository's own `401k.csv` carries the first pair. A
   curated table instead — which also carries what a matcher cannot, since a cost-basis header usually
   names whether it is per share or per position, and that is the control `UX-5` shows recording a
   fifty-fold error on its default.

### Evidence

[`upload-ux-2026-08/`](./upload-ux-2026-08/) holds screenshots of the real application taken during
the walk — the first-sighting columns screen, the cost-basis mistake as it reaches review, the
unpriced first statement, the remembered mapping, both removal valves, and the `$0.00` overview that
ends a correct first run. Every finding that has a picture links to it in place.

### Status

Nothing here is approved work. Three frictions were confirmed as **deliberate** and are recorded as
decisions rather than findings — a refusal on the drop screen costs the file pick, a header-row
change discards unsaved column choices, and a reordered export costs one re-map. The phone was
measured and the accepted limitation holds: nothing is hidden at 390px. `UX-4`, `UX-5` and `UX-6` now
belong in one spec, because one alias table answers all three.

Both documents were reviewed adversarially before landing and **both had to give ground**. The review
withdrew its claim that a `$0.00` first run was guaranteed rather than a weekend case, and one
recommendation that was arithmetically wrong. The alias document withdrew the proof of its own central
argument — which was false under raw edit distance — and a cost-basis convention it had proved using
two of this repository's fixtures while calling them independent; its §10 records all three, because
each is the intuitive answer and will otherwise be rediscovered. Its evidence is graded, and what could
not be verified is listed and must not be encoded: NetBenefits, Principal and Empower headers among
them, so this repo's `401k.csv` stays a model rather than a format.

## 2026-08-24 — Exploratory test pass

One document: [Exploratory test report](./2026-08-24-exploratory-test-report.md) — 67 findings from
running the application and attacking every feature, against `b7f94f3`. **Nothing was fixed when it
was written**; each entry is written to be picked up as a task. `SET-1` and `SET-5`, the
`SET-2`/`SET-3` date floor and the `SEC-1`/`SEC-3` return path have since been fixed, each
annotated in place.

### The four things worth knowing without reading further

1. **One click can wipe an account, and nothing in the app undoes it.** Change a brokerage's **Kind**
   to *Bank* or *Loan* and the Set-balance form appears on it; one submission records a single `USD`
   row, which under "a missing row means sold" sells every security in it. `balances.server.ts:24-27`
   writes the invariant out in full — a kind edit walks straight around it. That is the only Critical.

2. **`docker compose restart db` kills the app process.** `createPool` never attaches
   `pool.on('error')`, so `node-postgres`'s idle-client error is an uncaught exception. Verified with
   a real Postgres restart on both a dev server and a production build; `restart: unless-stopped`
   turns it into a flap rather than an outage, which is what has hidden it.

3. **Two of the app's own stated rules are broken by the screens that state them.** The printed money
   columns do not add up to the printed total on nine measured screens, against the rule written at
   `allocation.ts:435-449`; and no screen anywhere says how old a price is, against DESIGN.md §11's
   "non-negotiable" — while `priceFreshness()` already computes the answer and has zero callers.

4. **The upload flow's safety valve does not hold.** The review screen and the commit are two
   independent reads of a mutable draft, so a second tab makes the commit write figures the reader
   never saw; and a data row with a blank instrument cell is dropped with no mention on the review
   screen at all — 96% of the repo's own `401k.csv` fixture, mapped the obvious way.

### Status

Eight of these findings, over five sequenced pull requests, became approved work after the report
landed:
[`../specs/0005-report-remediation.md`](../specs/0005-report-remediation.md) sequences the date
floor (`SET-2`/`SET-3`), pool resilience (`LEAD-8`/`LEAD-6`), the sign-in return path
(`SEC-1`/`SEC-3`), the nameless-quantity refusal (`ING-4`) and the filed-behind statement
(`ING-1`). Fixed on the tree so far, each annotated in place: `SET-1` — the critical one — with
`SET-5` beside it, the date floor (`earliestRecordableDate` in `app/lib/input.server.ts`), and the
return-path guard, rebuilt post-gate as `app/lib/return-path.ts`. The report opens with the seven
worth doing first and a duplicate table, so the same bug is not filed four times. The whole suite,
`npm run typecheck` and `npm audit` were clean throughout — these are things the automated gates
structurally cannot see.

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
