# Codex review validation — independent audit

Validates the findings in `codex-review.md` against the **current tree** (HEAD `91f901d`), not
the commit the review was written against. Each claim was checked by reading the current code, and
the load-bearing ones were reproduced empirically against a migrated throwaway Postgres. This
document is a work-input, not a source of truth: `DESIGN.md`, `ARCHITECTURE.md`, and the migrations
remain authoritative.

## Method and framing

- **The review is stale by design.** `codex-review.md` says it was reviewed against `410a61f`
  (2026-08-24). HEAD is ~15k lines further on, including a large "1d chart" slice (PRs #100–#108)
  and the removal of in-app authentication. So a good number of its findings were *already fixed*
  between its base and HEAD — this audit separates "still real" from "already handled."
- **Auth is gone from the app.** Commit `8575ee5` ("Take authentication out of the application",
  an ancestor of HEAD) deleted the shared password, its signed cookie, the login page,
  `app/lib/auth.server.ts`, and the root auth middleware. Authentication is now a forward-auth
  Google gate (oauth2-proxy) in front of the app (ADR-0005). This **moots** the review's redirect
  finding (§7.1 item 2) as written and reframes every "attacker" question: the realistic threat
  model is an authenticated household member with a mangled URL or two browser tabs, on a
  trusted LAN — not an anonymous internet attacker.
- **HEAD is green.** `npm test` = 971 passed / 57 files against a live test Postgres. Nothing here
  is a failing test; these are gaps the suite does not cover (and in one case, a gap the suite
  actively pins green).
- Line numbers below are current-tree. The review's own line numbers are uniformly stale and are
  not repeated.

## Severity ordering (confirmed issues)

| # | Issue | Review § | Class | Severity | Priority |
|---|-------|----------|-------|----------|----------|
| 1 | Blank-instrument CSV rows dropped silently | 7.1.3 | Data loss | **High** | **Now** |
| 2 | Provider price → derived-product overflow, every screen 500s | 7.5 | Availability, no in-app recovery | **High** | **High** |
| 3 | Lost Postgres connection crashes the process | 7.1.1 | Availability (self-healing) | Medium | **High** (cheap fix) |
| 4 | Upload review ≠ commit (mapping-swap race) | 7.2 | Correctness / wrong data | Medium | Medium |
| 5 | Backdated statement: silent history rewrite, vanishing receipt | 7.1.4 | Correctness / UX | Medium | Medium |
| 6 | Charts & change figures draw unpriced as real $0 | 7.4 | Misleading numbers (transient) | Medium | Medium |
| 7 | One bad provider value aborts the whole refresh tick | 7.5 | Availability of pricing (self-healing) | Low-Med | Medium (bundle w/ #2) |
| 8 | Stale-flag / freshness gaps; `priceFreshness` has no caller | 7.3 / 4.3 | Misleading as-of | Low-Med | Medium |
| 9 | Over-range numeric IDs → 500 instead of 404 | 7.6 | Robustness | Low | Low-Med (cheap) |
| 10 | NUL bytes → raw 500 at three input seams | 7.7 | Robustness | Low | Low |
| 11 | No positive/range CHECK on price columns | 7.5 | Defense-in-depth | Low | Low (bundle w/ #2) |
| 12 | Applied migrations editable without detection | 7.12 | Integrity | Low | Low |
| 13 | Close-day: headline vs chart endpoint disagree | 7.9 | Correctness (1 day, self-heals) | Low | Low |
| 14 | Displayed cells don't sum to displayed total (1¢) | 7.10 | Cosmetic | Low | Low |
| 15 | Surviving open redirect in `safeReturn` (review missed) | — | Robustness (gated) | Low | Low |
| 16 | `MAX_UPLOAD_MB` never passed to app by compose | 7.14d | Config drift (runtime) | Low | Low |

---

## Confirmed issues — detail

### 1. Blank-instrument CSV rows are dropped silently — **High / Now**

`parseStatement` skips any row whose mapped instrument cell is blank, **even when the row carries a
real quantity**, and records nothing:

```
app/lib/statement.ts:398   if (instrument.trim() === "") continue;
```

The absent-*quantity* branch two lines down pushes a `skipped` entry; the blank-*instrument* branch
pushes nothing — not to `problems`, not to `skipped`. The only downstream guard
(`app/lib/uploads.server.ts`) refuses solely when *every* data row is blank under that column; one
surviving row defeats it. The review step renders `diff.skipped` only, so these rows have no
surface anywhere.

**Reproduced.** Parsing the shipped `tests/fixtures/statements/401k.csv` mapped to the `Ticker`
column yields `problems: []`, `skipped: []`, and **one** position — the two collective-trust rows
(≈95.9% of the file's value, no ticker) vanish. Mapping "Ticker" as the instrument column is the
natural first choice for a 401k export where funds have no symbol.

**The suite pins the bug green.** `tests/statement-parse.test.ts:288` asserts
`problems == []`, `positions` length 1, `skipped == []` for a blank-instrument-with-quantity row —
so any fix must change a test, and the current green suite is not evidence of safety here.

**Impact.** Silent data loss in a finance app: the upload commits, net worth is understated by the
dropped holdings, and nothing tells the reader. The worst failure class — a wrong number that looks
right. `docs/specs/0005-report-remediation.md` §4 already specifies the fix (refuse at the parser
seam, because the mapping must not be remembered after the refusal); it has not landed.

### 2. A single provider price can 500 every screen with no in-app recovery — **High / High**

The valuation view and function compute money without widening:

```
migrations/0006_annual_dividend.sql:149   cast(h.quantity * q.price as numeric(20,4)) as value
migrations/0006_annual_dividend.sql:251   (same, holding_valued_at)
```

`numeric(20,4)` holds 16 integer digits. Quantity writes are guarded against overflow *against the
quote that exists at write time* (`fitsTheMoneyColumn`, `app/lib/positions.server.ts:271`;
`app/lib/uploads.server.ts:1025`), but the **quote-write path never checks existing quantities**
(`app/lib/prices.server.ts` `writeQuote`/`refreshQuotes` read no holdings). So a later refresh can
store an individually-valid price whose product with an already-stored quantity overflows — and the
failure fires at **read time**, on the `cast`, on every dashboard (Overview, Holdings, Analysis,
Income, Account). The only position editor lives on Holdings, which itself 500s, so there is **no
in-app recovery** — the module comment says as much ("only psql would recover it",
`positions.server.ts:241`).

**Reproduced.** `cast(<1e12 qty> * <1e5 price> as numeric(20,4))` raises SQLSTATE 22003 in the
reader.

**Likelihood.** The product must reach 10^16. Realistic household quantities (up to ~10^5–10^6
fractional shares) need a price near 10^10–10^11; the worst recorded Yahoo glitch (BRK.A, 2021)
was ~4.3×10^9 — an order or two short, so implausible but not impossible. This is the *more*
probable outcome of a garbage price than #7 below, because it needs a smaller (individually
storable) value. Blast radius (whole app down, manual DB surgery) is disproportionate to the
trivial fix, which is why it ranks High.

**Fix direction (from review, sound).** Bound price magnitude at the provider boundary with tests;
widen the derived monetary output so a storable operand cannot overflow the product; add DB CHECKs
after auditing rows (see #11).

### 3. A lost Postgres connection crashes the Node process — **Medium / High (cheap fix)**

`createPool` returns a bare pool with no error handler:

```
server/db.ts:61   return new pg.Pool({ connectionString, connectionTimeoutMillis: 5_000, ... });
```

No `pool.on('error')` anywhere; grep for error/`process.on`/`uncaughtException` across `app/`,
`server/`, `scripts/` hits only docs. Verified against installed sources (pg 8.23.0, pg-pool
3.14.0): an unexpected backend termination emits `'error'`; **idle in pool** → pg-pool re-emits on
the pool, and an unlistened `'error'` on an EventEmitter throws → process exit; **checked out** →
pg-pool removes its idle listener at checkout (`pg-pool/index.js:344`), so the client has zero
listeners and its own emit crashes the process — `pool.on('error')` alone wouldn't even catch this
one. The poller checks out a client for the advisory lock and holds it across the provider network
fetch (`app/lib/price-poller.server.ts:159`→`170`, released `:192`), which is exactly the
checked-out window. The poller's `try/catch` cannot catch an out-of-band EventEmitter event.

**Impact.** Any Postgres restart/OOM/network reset during activity crashes the app. Mitigated by
`restart: unless-stopped` (`compose.yaml:76`) and atomic transactions — it self-heals in seconds
with no data corruption — so this is an availability blip, not data loss. But it is a real crash
with a one-line-plus-a-test fix (`docs/specs/0005-report-remediation.md` PR 2 already specifies it,
covering both states). Cheap enough that its priority is above its severity. No test simulates
connection loss today.

### 4. Upload review and commit can interpret the file differently — **Medium / Medium**

The review loader and the commit action each independently read the **mutable**
`upload_draft.mapping` and re-parse the file; nothing binds the commit to the interpretation shown
on screen. `CommitInput` carries no version/digest/token (`app/lib/uploads.server.ts:896`), and the
columns step overwrites the mapping freely (`rememberMapping`, `:392`). The transaction's leading
draft-delete (`:1063`) guards a concurrent *commit* (double-submit), not a mapping swap.

**Reproduced.** Tab A reviews `qty=10`; a second `rememberMapping` remaps the quantity column;
tab A's commit succeeds and writes `999` — no refusal. Also reachable single-tab: remap via "Back
to columns", browser-Back to the bfcached review, press Record. Incidental guards narrow the silent
window (a swap that fails to parse, raises new first sightings, or turns the diff majority-
destructive is caught), so only a swap to a valid, fully-resolvable, non-majority-removing mapping
commits silently.

**Note the precedent the review misses:** the instruments step already implements exactly the
optimistic-concurrency pattern the review proposes (hidden first-sighting list, refuse on change,
`app/routes/upload/instruments.tsx:100`). The fix has an in-tree template.

**Impact / recovery.** A well-formed set that was never on screen. Correctable in effect (re-upload
for the same as-of date; the `created_at desc, id desc` tie-break makes the correction win), but the
wrong set lingers unread — full removal needs psql (`docs/importing-history.md:205`).

### 5. Backdated statement: silent history rewrite, vanishing receipt — **Medium / Medium**

A statement dated behind the account's latest set is stored and silently governs every chart date
from its own date to the next set (`holding_valued_at` via `latest_position_set(account, d)`,
`migrations/0002`). But the review diff is always computed against *now*
(`assembleDiff` → `accountHoldings`, unbounded latest, `app/lib/uploads.server.ts:762`), and after
commit `uploadReceipt` returns `null` unless the set is the account's current latest (`:1167`), so
the account page shows no confirmation and unchanged holdings — the upload appears to have vanished.

**Reproduced.** Existing set 2026-08-15 (qty 5); commit as-of 2026-08-01 shows a diff `5→10` against
now, lands, returns a null receipt; `latest_position_set(now)` unchanged, `@2026-08-05` returns the
backdated set. The approved "filed-behind" UX (`docs/specs/0005-report-remediation.md` item 5) has
not landed. Append-only, so recoverable only as in #4.

### 6. Charts and change figures draw a wholly-unpriced portfolio as a real $0 — **Medium / Medium**

`readSeries` emits `coalesce(sum(value),0)` with a `coverage {known,total}` companion
(`app/lib/valuation.server.ts:538`), but both chart loaders filter on `coverage.total > 0` and then
**discard coverage** (`app/routes/overview.tsx:142`; `app/routes/account.tsx:169`); the chart
contract is `{date, amount}` only (`app/components/net-worth-chart.tsx:32`). A `known:0` point
renders as a real $0 vertex; if it's the last point the resting readout and `aria-label` announce
$0.00. `netWorthChange` coalesces both endpoints to 0 with no coverage (`:887`) — a first-day
quote against an unpriced window start reports the **entire portfolio as the period's gain** with
an up arrow (`overview.tsx:400`). The 1d-chart rewrite carried this pattern forward unchanged; the
session series has the same shape.

**Impact.** Brand-new install, first upload is all-securities, before the poller's first successful
refresh (or a provider outage on never-priced instruments). Self-corrects once prices arrive, so
transient — but a household's first impression is a false $0 line or a phantom gain. The seeded USD
1970 close means a *mixed* portfolio draws a deflated (not zero) line, equally unlabeled. Overview
account rows and allocation bars have the same coverage-dropping issue (`overview.tsx:279`, `:225`):
a fully-unpriced account reads $0.00 and vanishes from bars, though a page-level "X of Y holdings"
note and an allocation caption partly cover it. (Holdings/Account per-holding "never priced"/"stale"
notes are richer than the review credits.)

### 7. One out-of-range value aborts the whole refresh tick — **Low-Med / Medium (bundle with #2)**

Price passes provider validation with only a finite-and-positive check — it never goes through the
range ceiling that yield and dividend rate get (`app/lib/price-provider.server.ts:282` vs the
`inRange` at `:172`). A value ≥ 10^16 serializes fine (`toFixed(4)`) but overflows the column, and
because the whole refresh is one transaction (`app/lib/prices.server.ts:239`), it rolls back
**every** quote, close, and stale-mark for the tick. Reproduced end-to-end (one good + one 1e16
quote → good instrument's price discarded, zero observations, zero poll rows). The poller catches
it and the process survives (this is not #3), self-healing on the next sane tick.

**Timestamp taxonomy — the review is partly wrong here.** NaN/Infinity numeric timestamps are
*refused upstream* by Zod and cost only that one symbol (not an abort). The genuine hazards are
absurd **finite** timestamps: microseconds-as-seconds (1e15 → Invalid Date) aborts the tick like a
bad price; milliseconds-as-seconds (1.78e12 → a valid Date in year 58375) **silently writes wrong
history** and now also hijacks the append-only `price_observation` "latest session" the 1D chart
draws (migration 0009). Trigger is a unit-shifted timestamp from the unofficial endpoint — more
credible than the 10^16 price, still low.

### 8. Staleness and freshness gaps — **Low-Med / Medium**

- `is_stale = true` is written in exactly one place — the missing-symbol branch of a tick that
  actually runs (`app/lib/prices.server.ts:262`). If the poller never runs (process restarted
  outside market hours; it deliberately never fetches immediately, `price-poller.server.ts:206`),
  arbitrarily old quotes render with `is_stale = false`, and **no screen renders `quote.as_of` as
  an age** (grep of routes/components: nothing).
- `priceFreshness()` exists but has **no production caller** — only tests and docs reference it,
  including at HEAD after the new settings routes.
- The daily-close timestamp fallback to fetch time can file `price_daily` under the wrong calendar
  date, but only under a double fault (no Refresh-Now route + poller gates on market-open, so the
  calendar must also be wrong) — narrower than the review implies.

### 9. Over-range numeric IDs turn 404 into 500 — **Low / Low-Med (cheap)**

Digit-only regex validation then a bigint comparison: a 20-digit value passes `^\d+$` but exceeds
bigint range, raising 22003 that falls through to the generic 500 boundary. Confirmed end-to-end:
`GET /accounts/99999999999999999999` → 500; `/accounts/12345` → 404; `/accounts/abc` → 404. Present
at every site the review names **plus two it missed** (`app/lib/balances.server.ts:106`,
`app/lib/instrument-resolution.server.ts:323`). The safe pattern already exists in-tree
(`parseRowKey`, `app/lib/holdings-view.ts:867`, capped at 18 digits, with a comment naming this
exact 500). Auth-gated, no crash, no data leak — just a 500 where the honest answer is "not found",
violating the repo's own stated contract.

### 10. NUL bytes reach Postgres as a raw 500 — **Low / Low**

NUL is valid UTF-8, so it passes decoding and every trim/length check and reaches Postgres, which
raises 22021 → generic 500. Three unguarded seams: CSV parse (`app/lib/csv.ts:138`),
`requiredText`/`optionalText` (`app/lib/input.server.ts:83`), instrument resolution
(`app/lib/instrument-resolution.server.ts` symbol/name/classification). Rare trigger (corrupted
export, or crafted settings input on a single-household app). The current `ErrorPage` prints nothing
the throwing code wrote, so the review's "raw Postgres message on screen" is no longer true — it's a
generic dead-end, not an information leak. On the columns path the throw precedes any mapping write,
so nothing corrupting persists.

### 11. No positive/range CHECK on price columns — **Low / Low (bundle with #2)**

`quote.price` and `price_daily.close` (and the new `price_observation.price`) are `numeric(20,4)
not null` with no positivity/range CHECK (`migrations/0001:206,216`; `0009:56`). Provider parsing
rejects non-positive, but manual/restored/future writers can violate it. Defense-in-depth; add
after auditing existing rows, alongside #2.

### 12. Applied migrations can be edited without detection — **Low / Low**

The ledger stores filename + `applied_at` only (`server/migrations.ts:98`); the runner skips a
recorded filename without reading its content (`:140`), and `/healthz` compares filenames
(`app/routes/healthz.ts`). Editing an already-applied migration silently forks schema between fresh
installs (and CI, which runs on a fresh DB) and existing deployments, while `/healthz` stays green.
Culturally forward-only, so low likelihood — but with one production DB the drift is the
hard-to-notice kind. Fix is a SHA-256 column + fail-on-mismatch, a small extension of the runner.

### 13. Close-day: headline disagrees with the final chart point — **Low / Low**

Current valuation excludes an account the instant `closed_at` is set (`holding_valued`,
`where a.closed_at is null`); historical valuation includes it for the whole calendar day
(`holding_valued_at`, `where a.closed_at is null or a.closed_at > d`,
`migrations/0006:158,258`). Since closes are stamped mid-day, on the close date the Overview
headline and the final chart point disagree, and `netWorthChange` reports the closed value as a loss
the chart endpoint doesn't show. The 1D session reader adds a **third** surface with its own rule
(`valuation.server.ts:776`), documented as a known disagreement. Transient (self-heals next
calendar day), only when closing an account that still holds value. No invariant test.

### 14. Displayed cells don't sum to the displayed total — **Low / Cosmetic**

Products are stored/computed at 4dp; `formatMoney` renders 2dp (`app/lib/format.ts`). Totals are the
exact sum of 4dp values rounded once — so two rows of `10.0050` each display `$10.01` while the
`20.0100` total displays `$20.01` (cells appear to sum to `$20.02`). Sub-cent products are routine
with fractional shares. This is a display artifact — the stored arithmetic is exact and the total is
the *correct* rounding — not a money error. No largest-remainder reconciliation exists for money
(`allocateShares` is percentages only). Reproduced across screens by the exploratory report.

### 15. Surviving open redirect in `safeReturn` — **Low / Low (review missed this)**

The review's redirect finding (§7.1 item 2) is moot — `safeRedirectTarget` and the login page were
deleted with auth. But a same-class sink survives that the review never examined:
`app/routes/masking.ts:38` `safeReturn` checks only `/^\/(?!\/)/` and is used in
`redirect(safeReturn(redirectTo))` (`:53`). It lets through `/\evil.com` (leading backslash — the
deleted function actually blocked this) and `/\t/evil.com` (tab), both of which a browser resolves
off-origin; CR/LF/Unicode/NUL throw at the header layer → a 500 on that action. Reachable only by an
authenticated POST to `/masking` with an edited `redirectTo`, so it's CSRF-shaped — a phishing
pivot, no data exposure. Low, given the gate, but worth a one-line fix while nearby.

### 16. `MAX_UPLOAD_MB` is never passed to the app — **Low / Low**

`server/config.ts:95` reads it (default 10 MB) and the app enforces it, but `compose.yaml`'s app
environment block omits it, so the cap is pinned at 10 MB whatever an operator writes in `.env`.
The only doc-drift item with a runtime effect; harmless in practice (statements are tens of KB).
HEAD's `ARCHITECTURE.md:1779` already admits it; compose is still unpatched.

---

## Claims that are overstated, moot, or already fixed

- **§7.1 item 2 (login redirect safety) — MOOT.** Auth removed (`8575ee5`); no login page exists.
  See #15 for the live remnant the review didn't cover.
- **§7.8 (unexpected errors "unobservable") — OVERSTATED.** React Router 7.18's server runtime has a
  built-in default handler that `console.error`s every unhandled loader/action/render error to
  stderr (verified in `node_modules/react-router/.../index.js`, and empirically — a production 500
  dumps the full `DatabaseError` + stack to `docker compose logs app`). What is genuinely missing is
  correlation ids, structure, and the operator docs to match — not observability itself. The
  response body is correctly sanitized. Real but smaller than framed.
- **§7.15 (USD cash identity heuristic) — OVERSTATED.** The lookup is real
  (`current-statement.server.ts:80`, `where symbol='USD' and price_source='fixed'`), but
  `orderBy("id")` makes first-match deterministic (already true at review time), and the upload
  wizard cannot create a colliding row — it refuses `price_source='fixed'`
  (`instrument-resolution.server.ts:353`). A two-match state needs direct SQL or a restored dataset.
  The forward-looking recommendation stands; the present-day defect does not. (Residual worth noting:
  a user-created `(USD, feed)` instrument would be priced by Yahoo as the ETF ticker "USD".)
- **§7.14 doc/deployment drift — MOSTLY ALREADY FIXED.** The ~15k-line movement corrected most of
  it: `account_kind`→`kind` (CONTEXT.md), the auto-select claim (DESIGN.md), the PWA note (now
  labeled "not adopted"), the ARCHITECTURE.md race/poller-test/error-boundary passages. Still stale
  at HEAD: `docs/research/README.md:101` (says only the first fixes landed), the five
  `docs/specs/pricing/01–05` tickets (still `ready-for-agent` with 0 boxes checked despite shipped
  work; genuine spec-vs-code mismatches on currency-refusal data, immutable-day/timestamp rules, and
  refused counts), and the `operating.md` "every tick logs" sentence (contradicts its own
  closed-market note). Plus #16 above.
- **§7.11 management surface — DOC SIDE FIXED, gap real.** DESIGN.md now carries seven "not built
  yet" labels; the capabilities (classifications, instrument/manual-price, net-worth-history,
  reparse/undo) still have no routes, and `position_set.raw_file` / `manual_networth` still have no
  writer/reader respectively. This is scoped-future work, not a defect.
- **§7.13 duplication — PARTLY FIXED.** The chart-range primitives were centralized by the 1d slice
  (`app/lib/chart-range.ts`) exactly as recommended. Still open: three byte-identical
  `inTransaction` copies (`instrument-resolution.server.ts:256`, `prices.server.ts:161`,
  `uploads.server.ts:607`), inconsistent form-level account refusals, and ~16 open-coded
  `field-error` sites with no shared component. Low-risk cleanups, correctly deprioritized behind
  correctness work.

## Recommended sequence

Independently shippable, correctness/availability first:

1. **#1 blank-instrument refusal** — highest-value, smallest change; flips the pinned test. Ship first.
2. **#3 pool error listener** — one-line-plus-test crash fix; disproportionate value.
3. **#2 + #7 + #11 provider/price bounding** — one work-stream: bound price magnitude and finite
   timestamps at the provider seam (with tests), widen the derived product, add DB CHECKs after a
   row audit. Fixes the worst blast radius and the tick-abort together.
4. **#4 + #5 upload integrity** — bind review to a mapping digest (template exists in the instruments
   step); add the filed-behind state for backdated sets.
5. **#6 + #8 coverage & freshness** — carry `Coverage` through charts/change/rows/bars; give
   `priceFreshness` a caller and surface a quote age.
6. **#9 + #10 input hardening** — one bounded-id parser (`parseRowKey` grammar) reused across sites;
   NUL refusal at the CSV, form-text, and resolution seams.
7. **#12 migration checksums; #13 close-day rule + invariant test; #14 rounding contract;
   #15 `safeReturn`; #16 compose env** — low-severity, take when adjacent work touches them.
8. **Doc reconciliation** (`docs/research/README.md`, pricing tickets 01–05, `operating.md`) and the
   `inTransaction`/`FieldError` cleanups — alongside the behavior they describe.

Most of the review's §7.1 remediation set (`docs/specs/0005-report-remediation.md`) maps onto items
1–5 and already has grounded acceptance work.
