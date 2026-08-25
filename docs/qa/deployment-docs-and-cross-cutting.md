# Findings — deployment, config surface, cross-cutting UI (main agent, port 5173 / portfolio_dev)

## 1. `MAX_UPLOAD_MB` is silently ignored under Docker Compose — CONFIRMED
**Severity: Medium** (documented setting that cannot actually be set; an operator raising the
upload cap gets no error and no effect)

`server/config.ts:84` defines `MAX_UPLOAD_MB` and `.env.example` documents it as a supported
setting. It is the ONLY application setting absent from the `app.environment` block of
`compose.yaml` (compose.yaml:60-68). Docker Compose uses `.env` for *variable substitution* in the
compose file, but only passes into the container the keys explicitly listed under `environment:`.
So an operator who follows `.env.example` and sets `MAX_UPLOAD_MB=50` gets the built-in 10 MB
default, with no warning.

Repro:
```sh
cd /home/user/portfolio
MAX_UPLOAD_MB=99 PRICE_POLL_INTERVAL_MINUTES=7 docker compose config | sed -n '/^  app:/,/^  caddy:/p'
```
Observed: `PRICE_POLL_INTERVAL_MINUTES: "7"` is present (proving substitution works), and
`MAX_UPLOAD_MB` is absent from the resolved environment entirely.
Expected: `MAX_UPLOAD_MB: "99"` present alongside the others.

This also contradicts DESIGN.md §10.1's claim that every deployment setting is an environment
variable listed in `.env.example`, and `.env.example`'s own header ("Compose supplies working
defaults for everything except DATABASE_URL").

Cause: `compose.yaml:60-68` — add `MAX_UPLOAD_MB: ${MAX_UPLOAD_MB:-10}`.

Note the same class of bug does NOT affect the others: `PORT` is correctly threaded to Caddy as
`APP_PORT` (compose.yaml:97, Caddyfile:5), which I checked specifically.

---

## 2. No favicon — every page load logs a 404 — CONFIRMED
**Severity: Low**

`app/root.tsx` renders no `<link rel="icon">` and there is no `public/favicon.ico`, so every
browser page load issues an automatic request that 404s. Visible as a console error on every screen.

Repro:
```sh
curl -s -o /dev/null -w "%{http_code}\n" --noproxy '*' http://localhost:5173/favicon.ico   # 404
```
Also reproduced in Chromium: "Failed to load resource: the server responded with a status of 404"
on the overview. `public/` contains only `fonts/inter-latin-var.woff2`.

Expected: an icon, or an explicit empty-response route, so a clean load produces no console error.
Minor but it makes the browser console noisy enough to mask real errors during development, and
`root.tsx` already bothers to set `theme-color` meta tags (root.tsx:158-159), so the omission looks
accidental rather than deliberate.

---

## 3. The dark-theme override `data-theme` is dead code — CONFIRMED
**Severity: Low**

`app/app.css` defines `:root[data-theme="dark"]` (app.css:153) and a
`:root:not([data-theme="light"])` guard inside the `prefers-color-scheme: dark` block
(app.css:113). The CSS comment at app.css:38 explains the guard is "what lets an explicit light
choice beat a dark OS". But **nothing in the application ever sets `data-theme`**:

```sh
grep -rn 'data-theme' app/ server/ --include=*.ts --include=*.tsx   # no matches
```

So the explicit-choice branch can never be taken; the app follows the OS only (which matches
README's "the app follows your system's"). Either a theme toggle was planned and dropped, or the
guard and the `[data-theme="dark"]` block should go. Worth a decision either way — as it stands a
reader of the CSS is told about a feature that does not exist.

---

## Verified GOOD (no defects found — recorded so coverage is known)
- **Accessibility**: audited `/`, `/holdings`, `/analysis`, `/income`, `/upload`, `/settings`,
  `/settings/people`, `/settings/accounts`, `/settings/tax` in Chromium for: images without `alt`,
  form controls with no label/aria-label, buttons and links with no accessible name, duplicate DOM
  ids, `<h1>` count, heading-level jumps, and `<main>` landmark count. **All nine screens clean**,
  `lang="en"` set, exactly one `<main>` per page.
- **Responsive**: no horizontal overflow on any of those nine screens at a 375x667 mobile viewport
  (compared `documentElement.scrollWidth` against `clientWidth`).
- **Render integrity**: no `NaN`, `Infinity`, `undefined`, `null`, `[object Object]` or
  `Invalid Date` in the rendered text of any of those screens; no uncaught page errors; no failed
  requests other than the favicon above.
- **Unknown route** `/this-does-not-exist` returns a clean **404** (not a 500), with a short error
  page and no stack trace.
- **Web font** `/fonts/inter-latin-var.woff2` serves 200 (48256 bytes) and is correctly referenced
  from `app.css:29`.
- **Caddy/Compose port wiring**: `PORT` → `APP_PORT` → `reverse_proxy app:{$APP_PORT:3000}` is
  consistent; changing `PORT` does not break the proxy. (I checked this expecting a bug; there
  isn't one.)
- **Baseline suite**: `npm test` = 51 files / 746 tests, all passing on Node 24.19.0.
- Migrations apply cleanly from empty (5 migrations), and `scripts/seed-demo.ts` runs and reports
  its cuts as documented.

## Observations, not bugs
- **`POSTGRES_PASSWORD` footgun**: `compose.yaml:26` lets the operator change the database password,
  but the `DATABASE_URL` default (compose.yaml:61) hardcodes `portfolio:portfolio`. Setting only
  `POSTGRES_PASSWORD` on a fresh volume yields an app that cannot authenticate. This IS documented
  in both `.env.example` and a compose.yaml comment, so it is a footgun rather than a defect — but
  a `${POSTGRES_PASSWORD:-portfolio}` interpolated into the DATABASE_URL default would remove it.

---

## 4. README and docs/developing.md give contradictory setup instructions — CONFIRMED
**Severity: Low** (documentation; no data loss, but it puts a new contributor's dev data in the
database the next `down -v` destroys)

`README.md` §"Working on it" tells a new developer to run the dev server against **`portfolio_test`**:
```sh
DATABASE_URL=postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_test npm run dev
```
`docs/developing.md` §"Getting a working checkout" tells them to create and use **`portfolio_dev`**,
and explains why: "`compose.test.yaml` creates exactly one database, `portfolio_test`. Every other
database — a development one, a demo one, a scratch one — you create by hand."
`compose.test.yaml`'s own header states the principle: "tests must never run against an instance
holding real data."

So the README's quickstart puts development data in the test database, which the README's *next*
code block then destroys with `docker compose -f compose.test.yaml down -v`.

I checked whether this is actually destructive mid-session and it is not: the suite runs in
rolled-back transactions, and the one test that commits (`tests/migrations.test.ts:185`) creates a
uniquely-named scratch table and drops it in a `finally`. So the harm is limited to the documented
`down -v` and to the confusion of two documents disagreeing — but in a repo that treats its docs as
a deliverable, the two should be reconciled (README should say `portfolio_dev`).

---

## 5. `TRACE` on any route returns 500 instead of 405 — CONFIRMED IN PRODUCTION
**Severity: Low** (no information leak in production; noisy and wrong status)

Every other unsupported method is handled cleanly — `PUT`, `DELETE`, `PATCH` → 405, `OPTIONS` → 204,
`HEAD` → 200. `TRACE` alone produces a 500 whose body is Vite's error overlay containing a stack
trace with absolute filesystem paths.

Repro:
```sh
curl -s -X TRACE --noproxy '*' http://localhost:5173/           # 500 + stack trace in body
curl -s -o /dev/null -w '%{http_code}\n' -X TRACE --noproxy '*' http://localhost:5173/healthz   # 500
```
Observed: `{"message":"'TRACE' HTTP method is unsupported.","stack":"    at new Request
(node:internal/deps/undici/undici...)  at fromNodeRequest
(/home/user/portfolio/node_modules/@react-router/dev/dist/vite.js:1446:10) ..."}`
Expected: 405, consistent with the other unsupported methods.

**I checked this against a real production build and it is NOT dev-only.** Serving
`npm run build` output via `react-router-serve` with `NODE_ENV=production`, `TRACE /` still returns
**500**, thrown from `@react-router/express/dist/index.mjs:71` (`createRemixRequest`) where undici's
`new Request` rejects the method:

```
TypeError: 'TRACE' HTTP method is unsupported.
    at new Request (node:internal/deps/undici/undici:12223:21)
    at createRemixRequest (.../@react-router/express/dist/index.mjs:71:10)
```

The good news, verified: the **production** response body is a bare
`<pre>Internal Server Error</pre>` with no stack trace, no paths and no connection string — only the
dev server renders the Vite overlay with absolute paths. So the leak is dev-only, but the wrong
status code and the per-request unhandled `TypeError` in the log are real in a deployment.

The throw is in `@react-router/express`, not in this repo's code, so the fix is a method allow-list
in front of the handler (or at Caddy) rather than a change to a route.

---

## Also checked, behaving correctly
- `POST` to read-only routes returns 405 (`/`, `/analysis`, `/income`, `/settings`). `/holdings`
  returns 400 rather than 405 — a cosmetic inconsistency only, and it is still a clean refusal.
- An 8 KB query string and a 16 KB request header are both handled without error.
- `/holdings` strips unknown query parameters with a 302 to the canonical URL (`?q=abc` → `/holdings`).
  I initially read this as a URL-length failure; it is deliberate normalisation at any length, and
  correct.
- CI (`.github/workflows/ci.yml`) reproduces locally and is sound: `npm run typecheck` clean,
  migrations idempotent on re-run ("nothing pending"), and
  `npm run db:types -- --verify` reports "Generated types are up-to-date!" — so the committed
  `app/lib/database.generated.ts` genuinely matches the migrated schema. `--verify` is a real
  kysely-codegen flag, so that CI guard is not a no-op.

---

## 6. The overview caption claims a coverage figure for the chart line that it never computes — LATENT (not reachable in the shipped app)
**Severity: Medium if manual pricing is ever added; currently latent.** Reported because the
mechanism is real and the guard is one line of SQL.

The overview renders one sentence covering two different numbers:

> "The figure and the line are 17 of 618 holdings. The rest have never been priced."

But the headline figure and the chart line are computed from **different price tiers**:

- **The figure** comes from the `holding_valued` view (`migrations/0002_holding_valued.sql:77`),
  which prices from `quote.price` — `is_priced` is literally `(q.price is not null)`.
- **The line** comes from `holding_valued_at(d)`, which the same file's header comment says uses
  "the greatest `price_daily` close at or before `d`" instead of `quote.price`.

The "N of M" count is derived from the current view only, then applied to both in the caption.
Whenever an instrument has `price_daily` history but no `quote` row, the two disagree and the
sentence is false about the line.

Demonstrated on `portfolio_dev` by inserting 600 instruments with daily closes but no quote rows:

```sql
-- what the headline figure covers (quote-based)
select count(*) total, count(*) filter (where is_priced) priced, sum(value) from holding_valued;
--  total | priced |     sum
--    618 |     17 | 690469.2082

-- what the line covers at the same moment (price_daily-based)
select count(*) total, count(*) filter (where is_priced) priced, sum(value)
from holding_valued_at('2026-08-25'::date);
--  total | priced |  line_value
--    618 |    617 | 1726432.9105
```

The UI then says "17 of 618" while plotting a line covering **617 of 618** and worth **2.5x the
headline** — visible in the browser as a chart whose y-axis tops out at 1.8M above a "$690,469.21"
total. Screenshot evidence: the rendered overview reads `$690,469.21` with axis labels
`1.8M / 1.1M / 390.4K`.

**Reachability — the important caveat.** I could not find any application code path that produces
`price_daily` rows without a `quote` row, so **this is not reproducible through the UI today**:
`refreshQuotes` writes the quote, the quote type and the daily close inside one transaction
(`app/lib/prices.server.ts:202-204`), and there is no manual price-entry screen — the `'manual'`
matches in `app/lib/positions.server.ts:390` and `balances.server.ts:221` are `position_set.source`,
a different column. I reached the state with direct SQL.

It matters anyway because the schema already anticipates the case that breaks it: `instrument.price_source`
has a CHECK allowing `'manual'`, and the demo household **ships an instrument with
`price_source='manual'`** (id 17, "Principal LifeTime 2045 Collective Investment Trust"). The moment
someone implements typing a price in by hand — which that column exists for, and which
`app/lib/prices.server.ts:75` describes ("Its price is typed in by hand") — every manually-priced
holding lands in the line but not the figure, and the caption starts lying without anything else
changing.

Suggested fix for whoever picks this up: compute the coverage count for the line from
`holding_valued_at` rather than reusing the current view's count, or word the caption so it only
claims what it measured.

---

## 7. Performance at volume — VERIFIED GOOD, no defect
Scaled `portfolio_dev` from the demo's 16 instruments / 11k price rows / 280 holdings to
**617 instruments / 662,062 price rows / 880 holdings** and re-measured warm server-render times:

| Screen | demo scale | at volume |
|---|---|---|
| `/` overview | 0.088 s | 0.082 s |
| `/holdings` | 0.095 s | 0.139 s |
| `/analysis` | 0.043 s | 0.022 s |
| `/income` | 0.025 s | 0.010 s |
| `/accounts/1` | — | 0.456 s |

No N+1 explosion, no timeout, no error, and the schema is properly indexed for these reads
(`position_set_account_as_of_idx` on `(account_id, as_of_date DESC, created_at DESC, id DESC)`,
`price_daily` PK on `(instrument_id, date)`, `holding_one_row_per_instrument` on
`(position_set_id, instrument_id)`). The account page at 0.46 s is the slowest path and the only one
worth watching if a household ever holds hundreds of positions.

**Note for whoever picks this up:** `portfolio_dev` is left holding this synthetic volume data
(600 instruments with symbols like `QA1`..`QA600`). Drop and reseed it before using it for anything
else:
```sh
psql -h 127.0.0.1 -p 55432 -U portfolio -d postgres -c 'drop database portfolio_dev' \
  -c 'create database portfolio_dev'
DATABASE_URL=postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_dev node ./server/migrate.ts
DATABASE_URL=postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_dev node ./scripts/seed-demo.ts
```

---

## 8. Clicking the default range button ("1Y") puts `/?index` in the address bar — CONFIRMED
**Severity: Low** (cosmetic; the rendered data is correct)

The range control is four links. Three carry an explicit range, the default one carries a bare path:

```
A text="1M"  href="/?range=1m"
A text="3M"  href="/?range=3m"
A text="1Y"  href="/"          aria-current="true"     <-- the default
A text="All" href="/?range=all"
```

Pointing the default at `/` is a reasonable choice (the default range gets a clean URL), but
clicking it lands the user on **`/?index`** rather than `/` — React Router appends its internal
`?index` parameter when a link resolves to the index route from the index route. Reproduced in
Chromium: clicking 1M, then 3M, then 1Y gives address bars `/?range=1m`, `/?range=3m`, `/?index`.

`/?index` returns 200 and renders the correct default (1Y) view, so nothing is broken — but the
README sells this control as a bookmarkable URL ("The range control is a URL, so a chosen range
survives a reload and can be bookmarked"), and `?index` is a framework internal leaking into a URL a
user is invited to bookmark and share.

Expected: clicking 1Y produces `/` (or `/?range=1y`).

---

## 9. Interactive navigation — VERIFIED GOOD, no defect
Clicked through the entire app in Chromium rather than fetching URLs, and exercised browser history:
- Every nav link (`/holdings`, `/analysis`, `/income`, `/settings`, `/upload`, `/`) navigates
  client-side to the right path with the right `<h1>`.
- Three `goBack()`s then two `goForward()`s all land on the correct path with matching heading —
  history is consistent, no stale render.
- Account drill-down from the overview (`/accounts/2` → `h1="Empower 401(k)"`) and back to `/` works.
- Range selection reloads correctly and **the range survives a reload** as documented.
- **Zero page errors and zero console errors** across the whole click-through.

**Methodology note for whoever repeats this:** a first version of this test appeared to show every
nav click landing on the *previous* page. That was a false positive — `waitForLoadState('networkidle')`
returns before a client-side transition commits, so the URL was read one navigation behind. Using
`page.waitForURL(...)` showed the navigation is correct. Anyone re-testing SPA routing here should
wait on the URL, not on the network.

---

## 10. Any id-bearing URL returns 500 (not 404) when the id exceeds bigint range — CONFIRMED IN PRODUCTION
**Severity: Medium** — an unauthenticated, trivially-reachable 500 on five routes. Systemic: one
shared validation pattern, several call sites.

Every route that takes a database id in its path answers a **500** when the id is all digits but
larger than a Postgres `bigint`, where the same route correctly answers **404** for an in-range id
that matches no row.

Verified against the **production** build (`npm run build` + `react-router-serve`, `NODE_ENV=production`,
port 5190) and reproduced identically on the dev server:

| URL | out-of-range id `9223372036854775808` | control: `999999` |
|---|---|---|
| `/accounts/:id` | **500** | 404 |
| `/settings/accounts/:id` | **500** | 404 |
| `/upload/:draftId` | **500** | 404 |
| `/upload/:draftId/columns` | **500** | 404 |
| `/upload/:draftId/review` | **500** | 404 |

The boundary is exactly `bigint` max:
```sh
curl -s -o /dev/null -w '%{http_code}\n' --noproxy '*' http://localhost:5190/accounts/9223372036854775807  # 404  (bigint max)
curl -s -o /dev/null -w '%{http_code}\n' --noproxy '*' http://localhost:5190/accounts/9223372036854775808  # 500  (max + 1)
```

**Root cause.** The id guard checks that the string is digits, but not that it fits the column:

- `app/lib/accounts.server.ts:172` — `if (!/^\d+$/.test(id)) throw new NotFoundError(...)`
- `app/lib/balances.server.ts:144` — `if (!/^\d+$/.test(accountId)) return null;`
- `app/lib/uploads.server.ts:255` — `if (!/^\d+$/.test(draftId)) return undefined;` — this is the
  one behind all three `/upload/:draftId*` rows in the table above (`upload_draft.id` is `bigint`)
- `app/lib/instrument-resolution.server.ts:323` — same pattern
- `app/routes/upload/draft.tsx:57` — same pattern again, on a route param
- `app/lib/accounts.server.ts:92` — same pattern on a submitted `ownerId`. **Confirmed by driving
  it**, so this is a sixth entry point and the first one that is a write path:

  ```sh
  # out-of-range owner id -> 500, and the dev body leaks "out of range"
  curl -s -o /dev/null -w '%{http_code}\n' --noproxy '*' -X POST \
    -d 'name=QA Overflow' -d 'institution=QA' -d 'kind=brokerage' \
    -d 'ownerId=9223372036854775808' -d 'taxTreatment=taxable' -d 'externalAccountNumber=' \
    http://localhost:5173/settings/accounts                      # 500

  # in-range, nonexistent owner id -> 200 with the correct field message
  ...  -d 'ownerId=999999' ...                                   # 200, "Choose an owner."
  ```

  The contrast is the point: the form already has a correct, friendly refusal for an owner that does
  not exist ("Choose an owner."), and the overflow bypasses it into a 500. Verified that **neither
  request wrote a row** (`select id,name from account where name like 'QA %'` returns nothing), so
  there is no data-integrity consequence — it is a crash, not a corruption.

`9223372036854775808` satisfies `/^\d+$/`, so the guard passes it through to Postgres, which raises
`22003 numeric_value_out_of_range`. Nothing catches it, so it surfaces as a 500. Confirmed from the
server log:
```
  severity: 'ERROR',
  code: '22003',
```

**Why it matters beyond tidiness.** `tests/routes/account.test.ts:80` already frames the threat
model for this exact route — "what a crawler or a truncated link produces. Neither may reach a
query" — and the suite covers the non-numeric cases (`accountTotal("1; drop table account")` →
null, `"'; drop table holding; --"` → null). The overflow case is the one variant that slips the
guard, so the intent is established and the coverage just has a hole in it. A crawler appending
digits, or a truncated/mangled link, produces an unauthenticated 500 rather than the intended 404.

**An eighth site, and the fix pattern already exists in this repo.** `app/lib/valuation.server.ts:359`
(`isAccount`) has the same `/^\d+$/` test, and its doc comment names this exact failure:

> "an id taken from a URL path that is not digits would fail inside Postgres — a 500 where the
> honest answer is 'no such account'"

So the author identified the failure mode precisely and guarded only the *non-digit* half of it.
Meanwhile `app/lib/holdings-view.ts:745` (`parseRowKey`) already does it correctly:

```js
/^(0|[1-9]\d{0,17})\.(0|[1-9]\d{0,17})$/
```

— an 18-digit cap, which is exactly what keeps a value inside `bigint`. The correct pattern is
already in the codebase; it just is not the one the other eight sites use.

**Suggested fix**: tighten the shared guard to reject anything outside `bigint` — reuse
`parseRowKey`'s 18-digit bound, or add `BigInt(id) <= 9223372036854775807n` — in one place rather
than at each `/^\d+$/` site.
Good regression test: assert 404 for `9223372036854775808` on each of the five routes above.

**Note**: `/accounts/1e30` correctly 404s (not all digits), as do `abc`, `0`, `-1` — the guard is
only wrong about magnitude.

---

## 11. Documented backup/restore procedure — VERIFIED WORKING, no defect
`docs/operating.md` §"Restoring" is the disaster-recovery path, so it is worth knowing it actually
works rather than assuming. I ran it end to end against the demo database (substituting a direct
`psql`/`pg_dump` for `docker compose exec db ...`, since the Postgres image could not be pulled in
this environment — the SQL-level procedure is identical):

```sh
pg_dump  -h 127.0.0.1 -p 55432 -U portfolio -d portfolio_dev --format=custom -f portfolio.dump
createdb -h 127.0.0.1 -p 55432 -U portfolio -O portfolio portfolio_restore
pg_restore --exit-on-error --single-transaction -h 127.0.0.1 -p 55432 -U portfolio \
  -d portfolio_restore portfolio.dump      # exit 0, no errors
```

The restored database is byte-for-byte equivalent on every dimension I could check:

| | original | restored |
|---|---|---|
| base tables / views / functions | 15 / 1 / 2 | 15 / 1 / 2 |
| `holding` / `price_daily` rows | 280 / 11,062 | 280 / 11,062 |
| `sum(value)` from `holding_valued` | 690469.2082 | 690469.2082 |
| coverage from `holding_valued` | 17/18 priced | 17/18 priced |
| `holding_valued_at('2026-08-21')` | 691499.9996 | 691499.9996 |

Both the `holding_valued` **view** and the `holding_valued_at` **function** survive the dump/restore
and return identical figures — worth stating explicitly, because a derived view that silently failed
to restore is exactly the failure a custom-format dump can hide, and money agreeing to the cent
after a round trip is the claim that matters here.

`--exit-on-error --single-transaction` behaves as the document says. No defect found.
