# Research

Investigation output. **Nothing here is an approved slice** — approved work lives in
[`../specs/`](../specs/), and the authoritative design record is [`../../DESIGN.md`](../../DESIGN.md).
These documents exist so the reasoning behind a recommendation can be checked, and so a rejected
option is not rediscovered later.

## 2026-09-04 — Platform facts under the price worker

One document: [Price worker platform facts](./2026-09-04-price-worker-platform-facts.md) — the
Docker, PostgreSQL 17, `yahoo-finance2`, `pg`, Node 24, oauth2-proxy and Caddy behaviour the
price-worker slice rests on, gathered against `5e21ab7` and, where it could be, executed against a
live PostgreSQL 17.10. It is the evidence under [spec 0018](../specs/0018-price-worker.md), which is
authoritative for the design itself; its PostgreSQL facts served the table-shaped channel 0018's
§2.5 set aside on 2026-09-04, and stand as the record of what it would have cost.
Its §8, added the same day, carries the unix socket's and the tmpfs volume's facts under the channel
that replaced the table: the mount option string, who can connect, the mode Node creates a socket
at, the stale-file `EADDRINUSE`, the three connect errors, and what `node:http`'s timeouts do and
do not close.

### The three things worth knowing without reading further

1. **Docker Engine 26 accepts the option the isolation rests on and ignores it, in silence.**
   `gateway_mode_ipv4: isolated` does not exist before 28.0, and 26's label parser is a `switch`
   with no `default` branch — so the network comes up as a plain internal bridge that still holds a
   host address, and every obvious smoke assertion (external DNS fails, no default route) still
   passes, because those follow from `internal` alone. 27 refuses the option loudly. Only the
   daemon's own record separates them: under `isolated` no gateway address is allocated, so
   `docker network inspect` shows an empty IPAM `Gateway` and the bridge carries no `inet` — on 26
   both are present, and a connect to the gateway is the wrong assertion on 28.

2. **The grants hold, and the one thing that would undo them is a view.** Under `SET LOCAL ROLE`
   on a live 17.10, `SELECT` plus five column `UPDATE`s carry every statement the worker makes and
   every household table is denied. But `holding_valued` runs with its owner's privileges — no
   `security_invoker`, and no migration in this repo contains a single `GRANT` — so one grant on it
   would hand over every account, person, holding and position-set row with no table grant to show
   for it. The two SQL functions are already callable by anyone and fail *inside*, on `account`.

3. **The grants bound confidentiality, not availability.** A role holding no grants at all can take
   the two advisory locks this app uses — freezing every refresh and hanging `migrate.ts` — create
   temp tables and create large objects, each verified with a bare role and each closed by a REVOKE
   that was tested — twenty-one advisory functions, both the `pg_advisory_*` and `pg_try_advisory_*`
   families, and `TEMP` revoked from PUBLIC, not from the role, which holds it only through PUBLIC.
   The advisory REVOKE rides `pg_dump` (settled from `pg_dump.c`: a catalog function's ACL is dumped
   when it differs from `pg_init_privs`, and those functions have no row there), which is why a
   restore by a non-superuser needs `pg_restore -L` or `--no-acl`.

### Status

Nothing here is approved work; the spec is [0018](../specs/0018-price-worker.md). Several doc sites
are egress-blocked from the research sandbox — `docs.docker.com`, `www.postgresql.org`,
`node-postgres.com`, `caddyserver.com` among them — so those facts were read from the repositories
that generate those pages, and are cited that way. There is no Docker daemon in that sandbox, so
nothing in the Docker section was executed. §7 lists what could not be checked and must not be
treated as settled.

## 2026-09-01 — Why the Overview takes eleven seconds with 1D selected

One document: [The Overview's 1D latency](./2026-09-01-overview-1d-latency.md) — the diagnosis of a
reported eleven-second Overview, measured against `46d65df` on a local PostgreSQL 16.13 with the
demo household scaled to 21 accounts, 97 holdings and 98 feed instruments. The fix it argues for is
approved as [spec 0016](../specs/0016-session-series-running-total.md).

### The three things worth knowing without reading further

1. **An instant is per instrument, not per poll — and that is the term the cost model missed.**
   `as_of` is the moment the provider says a price was struck (ADR-0006), so one poll of ninety-eight
   instruments records up to ninety-eight of them. At the seeded fifteen-minute cadence a session
   holds 1,620 instants where `ARCHITECTURE.md` §10 costed 27, and the 1D query pairs every one of
   them with every holding: 157,140 inner rows and about 1.47 million buffer hits for one render.
   The demo seed hid it by giving every instrument the same grid of instants.

2. **The whole of the time is one statement, and nothing else on the page is slow.** Timing the
   Overview loader's own reads puts every other query at or under about 45 ms and the 1Y line at
   about 120 ms, against 3.5 s for the session series at fifteen minutes, 10.1 s at five and 48 s at
   one. Indexes, memory settings and a cache were each measured or argued and rejected — covering
   indexes made it slower (4.5 s against 3.5 s), the plan reports zero disk reads, and a cache is
   invalidated by every poll.

3. **The same line as a running total is 20 ms, and the one trap is where the span's bounds go.**
   Joined in from a `bounds` CTE they reach the scan as a join condition, which the planner does
   not turn into an index condition, and the whole log is scanned — materialised or not: 89 ms on a
   year of sessions and growing with it. Written as scalar subqueries they are init-plan
   parameters, which do become an index condition: 16 ms on the same log. `except` both ways
   returns zero rows on four datasets.

### Evidence

[`2026-09-01-overview-1d-latency/harness/`](./2026-09-01-overview-1d-latency/harness/) holds the
scaling scripts, both statements, the equivalence check and the loader timer, with the command
sequence that reproduces every number from an empty database. The two scripts that write refuse any
database whose name does not mark it throwaway. The report carries a second run of the whole
sequence, from scratch, beside the first run's figures.

### Status

The rewrite is approved work ([spec 0016](../specs/0016-session-series-running-total.md)). What the
report deliberately leaves open is the point count: 1D draws one point per observed instant, which
is 1,620 points and 97,201 bytes of loader data at the seeded cadence and about 1.4 MB at a
one-minute cadence. Making the points cheap to compute does not decide how many there should be.

## 2026-08-30 — Account picker conventions

One document: [Account picker conventions](./2026-08-30-account-picker-conventions.md) — how
established apps label accounts in pickers, and how their import flows map an uploaded file to an
account, against `5aa2fb2`. Background for the upload dropdown, which renders two same-named
accounts as two identical rows because the loader narrows away the owner, institution, kind and
number that `listAccounts` already returns.

### The three things worth knowing without reading further

1. **The label anatomy converges wherever it is documented: person-meaningful name first,
   institution and type as secondary text, masked last-4 as the tiebreaker.** Plaid's
   `name` / `official_name` / `type`+`subtype` / `mask` decomposition is the industry template, and
   every part already exists on this repo's `account` table — the dropdown's poverty is a
   projection choice, not a data gap.

2. **Where households exist, the owner is a structured per-account label, never a naming
   convention.** Monarch attaches a member (or "Shared") to every account and prompts for it at
   connect time; single-owner brokers fake it with nicknames — Schwab's own help says nicknames
   exist "to replace account number in the Select Account pull-down menu".

3. **No surveyed app auto-detects the target account from identifiers inside the file** — the
   behavior `SET-11`'s wrong field note describes has no precedent anywhere. The two proven
   preselects are *the page you came from* (YNAB, Simplifi, Lunch Money, Sharesight and Snowball
   all open the account first) and *last time* (Portfolio Performance remembers the account per
   detected bank and shows it in an editable dropdown). The ingest brief's invariant 4 matches the
   industry, not just caution.

### Evidence

[`picker-2026-08-30/`](./picker-2026-08-30/) holds screenshots of the real application, taken
while driving the fix this research fed: the two identical "Schwab" rows the old picker drew, the
owner-grouped adaptive labels that replaced them, and the columns step's enriched identity strip.

### Status

Nothing here is approved work. Evidence is graded in place — ● read directly (source code, specs,
manual sources), ◐ the owner's page reached only through search excerpts, since most commercial
help centers are egress-blocked from the research environment. What could not be verified is
listed in the Method section and must not be treated as settled.

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
`SET-5` beside it, `SET-11` (the account-number field's wrong note), the date floor
(`earliestRecordableDate` in `app/lib/input.server.ts`), and the return-path guard, rebuilt
post-gate as `app/lib/return-path.ts`. The report opens with the seven worth doing first and a
duplicate table, so the same bug is not filed four times. The whole suite, `npm run typecheck` and
`npm audit` were clean throughout — these are things the automated gates
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
