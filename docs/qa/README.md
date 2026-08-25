# QA report — exploratory test pass, 2026-08-25

A black-box and white-box test pass over the running application, hunting for defects rather than
fixing them. **Nothing in the application was changed**; the only files added are the ones in this
directory.

- **Commit tested:** `b7f94f3` on `claude/amazing-hypatia-k9dcfy`
- **Runtime:** Node 24.19.0 (`engines` requires `>=24.12.0`), Postgres 16.13, React Router 7.18.2,
  Kysely 0.29.5, Zod 4.4.3
- **Baseline health:** `npm test` 51 files / **746 tests passing** (twice, no flakes);
  `npm run typecheck` clean; `npm run build` clean; migrations idempotent;
  `npm run db:types -- --verify` reports the committed types match the schema.

**56 distinct defects: 1 Critical, 11 High, 19 Medium, 25 Low.**

The suite passing while 56 defects sit underneath it is the useful summary. Almost everything here
lives in a gap the tests do not cover: values that are legal in `numeric` but not in the code's
assumptions, ids that are legal digits but not legal `bigint`, and screens that state a coverage
figure they never computed.

## Detailed findings

Each file below carries full reproduction steps, observed vs expected, evidence, and a `file:line`
cause for every finding, plus a "tried and did NOT break" section and a
"documented limitations, not bugs" section.

| Area | File | Findings |
|---|---|---|
| Statement upload / CSV ingest | [`ingest-and-upload.md`](ingest-and-upload.md) | 14 |
| Overview, Holdings, Analysis, Income, account detail | [`dashboards-and-reads.md`](dashboards-and-reads.md) | 15 |
| Settings, people, accounts, auth gate, config | [`settings-auth-and-config.md`](settings-auth-and-config.md) | 13 |
| Money/numeric core, pricing, migrations, schema | [`money-pricing-and-schema.md`](money-pricing-and-schema.md) | 10 |
| Deployment, docs, and cross-cutting UI | [`deployment-docs-and-cross-cutting.md`](deployment-docs-and-cross-cutting.md) | 8 |

Two defects were found independently by more than one area and are consolidated below (the
`bigint` overflow, reported in four files; the NUL byte, reported in two).

---

## Fix these first

### C1 — A sub-cent quote price is stored as `$0.0000`, marked priced and fresh
**Critical · `app/lib/price-provider.server.ts:105-107` and `:237-242`**

`decimal()` runs `value.toFixed(4)` *after* the `price > 0` guard has tested the unrounded float.
Any price in `(0, 0.00005)` therefore passes "a non-positive price is not a price" and lands in
`quote.price` and `price_daily.close` as exactly `0.0000`, with `is_stale = false` and
`is_priced = true`.

```
0.00004999 -> price="0.0000"      0.00005 -> price="0.0001"
0          -> REJECTED (null)     -1      -> REJECTED (null)
```

Driven end to end through the real `refreshQuotes`, a 130.67-share position fell to `$0.00`, net
worth dropped **$23,974.57**, the coverage line still read *"17 of 18 holdings"*, and a **real past
close (2026-08-24, `183.4711`) was overwritten with `0.0000`** in the table ARCHITECTURE.md calls
the immutable spine. This is the one place the project's "`numeric` is never round-tripped through a
JavaScript number" claim actually fails, and it fails on money, silently, with permanent corruption.

**Fix:** `decimal()` should return `null` when `toFixed(scale)` rounds a positive input to zero. The
caller already handles "no usable price" — keep the last price, mark stale.

### H1 — Two accounts' quantities are silently summed into one on upload
**High · `app/lib/statement.ts:574` vs `app/lib/uploads.server.ts:974`**

A statement whose rows disagree about the account number is correctly refused — unless the
disagreeing rows share an instrument. `AAPL,10,111-AAA` plus `AAPL,20,222-BBB` commits as **30 units
in one account**, capturing `111-AAA`. Row combining discards the second row's account number before
the guard that exists for exactly this case can see it. This is the project's headline risk —
statements that must not be double-counted — landing wrong money with no warning.

### H2 — Post-login open redirect via a tab character
**High · `app/lib/auth.server.ts:153-158`**

`safeRedirectTarget` blocks `//`, `/\` and absolute URLs, but not `/%09/evil.example`. The tab
survives into `Location`; the browser strips it per the URL spec, leaving `//evil.example`:

```js
new URL("/\t/evil.example", "http://victim.local").href   // -> "http://evil.example/"
```

Confirmed end to end in Chromium on both dev and a production build: an unauthenticated victim who
enters the correct password lands on the attacker's origin.

### H3 — A dropped idle database connection kills the whole server process
**High · `server/db.ts:61-70`**

The `pg` Pool has no `error` listener, so a connection terminated while idle raises
`Unhandled 'error' event` and takes the process down:

```
throw er; // Unhandled 'error' event
error: terminating connection due to administrator command    code: '57P01'
```

Verified: after `pg_terminate_backend` on the idle pooled connections, both `/` and `/healthz`
return nothing at all. Because `/healthz` dies with the process, the documented "non-200 when the
database is down" behaviour never happens — the container's healthcheck sees a dead port instead,
and any Postgres failover, restart or admin disconnect becomes an app outage.

### H4 — Editing an account's kind defeats the set-balance guard and destroys a valuation
**High · `app/lib/accounts.server.ts:198-240` vs `app/lib/balances.server.ts:56-70`**

`kind` is freely editable with no warning. Change a brokerage to a bank, use "Set balance", and a
**$211,471.57 portfolio becomes $1.00**. Reverting the kind does not restore it, and no UI can
delete the manual position set — recovery requires `psql`.

### H5 — `?range=all` reports the household's entire net worth as the period's gain
**High · `app/lib/valuation.server.ts:672-690`, consumed at `app/routes/overview.tsx:414-417`**

The All-range delta is measured against `netWorthAt('2019-12-30')`, which is `0.0000` over **zero
rows** — "nothing was recorded yet", not "the household had nothing". The headline reads
**`+$690,469.21`** above a chart that starts the household at $180,297.21. The honest figure is
**+$510,172.00**. The chart's own loader already filters uncovered points (`overview.tsx:187`)
precisely so this fiction is not drawn; the headline has no coverage to filter on. 1M, 3M and 1Y are
all correct.

### H6 — Analysis presents partial slices as complete
**High · `app/routes/analysis.tsx:259-281`**

Every breakdown row prints an amount and a percentage with no coverage note, while Holdings labels
the identical grouping:

| Group | Analysis | Holdings | Truth |
|---|---|---|---|
| Other | `$14,176.79  2.1%` | `$14,176.79  **1 of 2**` | 1 of 2 priced |
| Workplace plan | `$355,415.12  50.4%` | `$355,415.12  **5 of 6**` | 5 of 6 priced |
| Jordan Rivera | `$129,799.48  18.8%` | `$129,799.48  **3 of 4**` | 3 of 4 priced |

`AllocationSlice.coverage` is computed on every slice (`allocation.ts:90`) and never read. This is
the project's headline claim — "every total says what it was computed from" — not holding on the
one screen whose entire job is breakdowns.

### H9 — Any id-bearing URL or field 500s on a `bigint` overflow *(found independently 4×)*
**High · eight call sites**

Every id guard tests digit *shape* but not magnitude, so `9223372036854775808` passes and Postgres
raises `22003`. Confirmed in a production build across `/accounts/:id`, `/settings/accounts/:id`,
`/upload/:draftId`, `/upload/:draftId/columns`, `/upload/:draftId/review`, and the
`POST /settings/accounts` write path — all **500** where the in-range control correctly **404**s.

The correct pattern already exists in this codebase: `parseRowKey`
(`app/lib/holdings-view.ts:745`) caps at 18 digits with
`/^(0|[1-9]\d{0,17})\.(0|[1-9]\d{0,17})$/`. The other sites — `valuation.server.ts:359`,
`accounts.server.ts:172,92,286`, `uploads.server.ts:255`, `balances.server.ts:144`,
`instrument-resolution.server.ts:323`, `routes/upload/draft.tsx:57` — use a bare `/^\d+$/`.
`isAccount`'s own doc comment names this exact failure and then guards only the non-digit half of it.

---

## Everything else

Full detail is in the per-area files. Ordered by severity within each area.

**High.** NaN is legal in every money and quantity column, with no CHECK anywhere — one NaN quantity
makes Overview report `$0.00` while still claiming "17 of 18 holdings", and 500s Holdings and
Analysis (`money-pricing-and-schema.md` #3). The Overview 500s with `numeric field overflow`
whenever net worth has grown more than ~10,000x over the chart range, including on the default 1Y
(#2). A NUL byte 500s the ingest flow and every settings text field — one missing input-boundary
strip, two entry points (`ingest-and-upload.md` #2, `settings-auth-and-config.md` #6). An instrument
cell over ~2,700 bytes 500s the instruments step on a btree index limit, reachable from an
unterminated quote in a real export (`ingest-and-upload.md` #3).

**Medium (19).** Silent ingest data loss — rows dropped for a blank instrument cell are never
reported, `DD/MM/YYYY` dates are read as `MM/DD`, a mis-sniffed delimiter is unrecoverable, and a
commit captures an account number without the bound the Settings form enforces, permanently bricking
that account's edit form. Coverage and zero-handling on the dashboards — `$0.00 / 0.0%` printed for
a group nothing could be priced in, an unvaluable account shown as `$0.00` on the Overview while its
own page refuses the figure, and a subtotal share whose denominator changes with the grouping.
Schema gaps — no `check (price > 0)`, so a negative price silently subtracts from net worth; and an
unguarded aggregate cast that 500s two screens. `seed-demo.ts` **destroys real data** once its marker
exists (verified: a person and account added after seeding were wiped, exit 0, no warning),
contradicting its own "must never become a way to lose a real portfolio". The tax rate accepts
`1,00` and stores **100%**. Any write route 500s on a non-form `Content-Type`.
`MAX_UPLOAD_MB` is silently ignored under Compose — the only setting missing from the `app.environment`
block, so an operator following `.env.example` gets the 10 MB default with no error.

**Low (25).** Mostly copy, formatting and polish: coverage sentences ungrammatical in the singular,
`formatCompact` with no suffix past `B` ("1,000.0B"), a zero change rendering as a green up-arrow
(the one thing `money-cell.tsx` was written to avoid), asset-class rows summing a cent off the
stated total, "shares sum to 100%" printing 100.1%, no favicon (a 404 on every page load), a dead
`data-theme` CSS branch nothing sets, `TRACE` returning 500 instead of 405, and the README pointing
development at the *test* database where `docs/developing.md` says to create `portfolio_dev`.

---

## Verified working — do not re-test

Recorded so the next person does not spend time here. All of this was attacked and held.

- **Double-counting could not be achieved.** Four concurrent commits on one draft yield one position
  set and three 404s; three identical committed statements leave one set. Both commit-time guards,
  step gating, the 24-hour sweep and the fingerprint all hold.
- **Stored money precision.** Exact past `MAX_SAFE_INTEGER` and at 28 digits; rounding symmetry;
  weighted lot basis exact; no float anywhere in the ingest path; aggregates agree under adversarial
  fractional data.
- **Cross-screen totals reconcile to the cent** — Overview, Holdings, Analysis and all six account
  pages, including the negative liability and every partial coverage count.
- **Auth, where it is implemented.** Cookie forgery rejected (unsigned, tampered, borrowed
  signature); every route gated including `.data` single-fetch routes and POSTs, with no data leak;
  no XSS surface (`dangerouslySetInnerHTML` appears nowhere); SQL injection refused everywhere.
- **URL and form tampering** — prototype-pollution range keys, duplicated params, unicode, 8 KB
  values, NUL in query strings, traversal, every sort/group/filter permutation, and the exact bigint
  boundary `…807`. Clean 200/302/404 throughout.
- **Migrations**: idempotent over three runs, whole-file rollback on failure with nothing leaked.
- **Provider failure**: outage, junk payload and a real Yahoo call failing through the proxy are all
  a clean no-op — no blanked or corrupted prices.
- **`market-hours.ts`**: every boundary, DST transition and holiday checked.
- **Backup/restore** (`docs/operating.md`): round-trips exactly — identical row counts, and the
  `holding_valued` view and `holding_valued_at` function both survive and return figures identical
  to the cent.
- **Accessibility and responsive layout**: nine screens audited for alt text, control labels,
  accessible names, duplicate ids, heading order and landmarks — all clean, no mobile overflow.
- **Interactive navigation**: every nav link, browser back/forward, account drill-down and range
  persistence — correct, with zero console or page errors.
- **Performance**: scaled to 617 instruments / 662,062 price rows / 880 holdings — Overview 0.08 s,
  Holdings 0.14 s, account page 0.46 s. No N+1.

## Deliberately not reported

Both agents and I checked DESIGN.md and `docs/operating.md` before filing. Set aside as **documented
limitations, not defects**: Income being a placeholder; the nine security properties listed in
`docs/operating.md` §"Five things the code does not do" (no rate limiting, no CSRF token, no security
headers, unconditional `X-Forwarded-*` trust and the rest); no migration checksums; the entire
pricing UI being unbuilt ticket `pricing/05`; a negative slice having no donut wedge; the chart
carrying positions forward between statements; `toPlotValue` using floats for pixel geometry only;
and "two dashboards can disagree", which DESIGN §14 names as the design's weakest point — though the
instances where it *actually happens* are reported rather than waved off.

One thing initially suspected and then cleared: the Playwright launch failure in this sandbox is a
local Chromium build mismatch, **not** a repo defect — `scripts/capture-screenshots.ts:457` already
accepts `CHROMIUM_EXECUTABLE` and `docs/developing.md:376` documents it.

## Rebuilding this environment

Docker could not pull `postgres:17-alpine` through this network, so Postgres 16 was run locally.
Everything else is the documented path.

```sh
source /opt/nvm/nvm.sh && nvm install 24.19.0 && nvm use 24.19.0
npm install

# Postgres on :55432 (substitute the documented compose.test.yaml where the image can be pulled)
initdb -D <datadir> -U portfolio --auth=trust
pg_ctl -D <datadir> -o '-p 55432 -c timezone=UTC -c fsync=off' start
createdb -h 127.0.0.1 -p 55432 -U portfolio portfolio_dev

export DATABASE_URL=postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_dev
node ./server/migrate.ts
node ./scripts/seed-demo.ts
npx react-router dev --port 5173
```

A shell `DATABASE_URL` overrides `.env`, which is what lets several isolated instances run at once —
useful, since several findings need their own database.

Playwright: launch with an explicit binary, since the pinned version's browser is not installed here.

```js
chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE })
```
