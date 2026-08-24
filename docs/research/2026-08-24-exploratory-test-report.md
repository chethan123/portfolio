# Exploratory test report — 2026-08-24

An adversarial pass over the whole running application, done by driving the real app rather than by
reading it. **Nothing was fixed when this was written**, and two entries — `SET-1` and `SET-5` —
have since been annotated where they were fixed. Every entry is written so someone else can pick it
up as a task: what happens, what should happen and why, a verified reproduction, and the evidence.

- **67 findings**: 1 critical, 11 high, 20 medium, 35 low.
- Six testers worked in parallel, each with its own application instance and its own database, so
  one tester's writes could never explain another's reading.
- Every finding was reproduced before it was written down. Where something looked wrong and turned
  out to be right, it is recorded under **Non-issues investigated** in its area — those sections are
  worth as much as the findings, because they are the dead ends nobody now has to re-walk.

---

## How to read this

Findings are grouped by the area that was tested and keep their tester's prefix, so an id is stable:

| Prefix | Area | Instance it was found on |
|---|---|---|
| `LEAD` | cross-cutting: resilience, scale, deployment, docs-vs-code | own instance + a production build |
| `ING` | statement upload and ingest, end to end | seeded demo household |
| `SET` | everything that writes outside the upload flow | seeded demo household |
| `DASH` | the read screens and the numbers on them | seeded demo household |
| `SEC` | the login gate, HTTP hardening, first run and empty state | empty DB, gate **on** |
| `PRC` | pricing, the in-process poller, the automated suite | seeded demo household |

Severity is used as follows. **Critical** — data loss, corruption, or a security compromise.
**High** — wrong money on screen, a broken core flow, or the whole process going down.
**Medium** — a broken edge case, a contradiction between two screens, a 500 where a message belongs.
**Low** — polish, wording, dead code, documentation drift.

---

## Start here — the seven that matter

If only a handful get picked up, these are the ones, in this order.

1. **[SET-1] Changing an account's kind wipes it, irrecoverably.** — **fixed; see the entry.** Switch
   a brokerage holding seven securities to *Bank* or *Loan*, and the Set-balance form appears on it.
   One submission records a single `USD` row, which under "a missing row means sold" sells
   everything. $211,007.64 → −$1.00, and **nothing in the application can undo it**. The invariant is
   written out in `balances.server.ts:24-27` — a kind edit walked straight around it.
   *The only Critical.*
2. **[LEAD-8] A Postgres restart kills the server process.** `createPool` (`server/db.ts:62`) never
   attaches `pool.on('error')`, and `node-postgres` emits `error` on idle clients when the backend
   goes away. `docker compose restart db` — or a minor-version upgrade, or an OOM kill — exits the
   Node process with code 1. Verified on both the dev server and a production build.
3. **[ING-5] The commit writes a different statement than the one reviewed.** The review screen and
   the commit are two independent reads of a mutable `upload_draft.mapping`. A second tab that
   remaps the columns makes the commit write figures the reader never saw — and the commit-time
   guards are evaluated against the new mapping, so they do not catch it either.
4. **[ING-4] Rows are dropped from a statement silently.** A data row whose mapped instrument cell
   is blank is discarded with no entry on the review screen. With the repo's own `401k.csv` fixture
   mapped the obvious way, **96% of the file's value** vanishes and the review screen says nothing.
5. **[DASH-2] The printed columns do not add up to the printed total.** Every read screen: values
   are stored at `numeric(20,4)` and rounded to cents at render, so adding the cells a reader can
   see gives a different answer from the total under them — one cent out, on nine measured screens.
   The codebase already states the rule it is breaking, in `allocation.ts:435-449`.
6. **[PRC-1] No screen ever says how old a price is.** The only freshness signal is `is_stale`,
   which is written **only** when a refresh ran and a symbol did not come back. A poller that never
   starts leaves every quote `is_stale = false` for ever, and a seven-year-old price is
   indistinguishable from a live one. DESIGN.md §11 calls the "as of" timestamp *non-negotiable*;
   `priceFreshness()` already computes exactly what is needed and has zero callers.
7. **[SEC-1] Open redirect in the login gate.** `next=/%09/evil.example.com` survives
   `safeRedirectTarget` — the browser strips the tab, leaving a protocol-relative URL. It fires on
   the POST too, so a visitor lands on the real login page, types the real password, and is sent
   off-origin **after** a successful login.

---

## Duplicates and overlaps — file one task, not four

Several testers found the same thing independently. Fix once; the corroborating detail is worth
keeping, so each tester's entry is left in place.

| One task | Reported as | Note |
|---|---|---|
| **Missing favicon → console error + a stack trace per request** | `LEAD-2`, `ING-11`, `DASH-7`, `SEC-11` | `LEAD-2` has the fullest evidence, including the production log |
| **All-digit id past `bigint` range 500s with a raw error** | `DASH-1`, `SEC-2`, `SET-8`, `ING-3` | four different call sites, one missing bound: `valuation.server.ts:359` (`isAccount`), `accounts.server.ts:87,172,282`, `uploads.server.ts:findDraft`. `holdings-view.ts:740` already does it right and says why |
| **Settings → Accounts prints raw enum slugs** | `SET-10`, `SEC-9` | same two lines |
| **Value column vs total off by a cent** | `DASH-2`, `ING-10` | `DASH-2` measures it across nine screens |
| **No lower bound on a recorded date** | `SET-2` (the finding), `ING-1` (notes) | one missing floor in `input.server.ts:241`, two ways in |

---

## What was actually done

Not a read of the code — the application was run and used.

- **Two full statement uploads walked to commit** and verified digit-for-digit against Postgres,
  then the flow attacked: malformed CSVs, NUL bytes, invalid UTF-8, a PNG and a PDF renamed `.csv`,
  a 20 MB file, `(500)` negatives, `$1,234.56`, 30-decimal quantities, `31/02/2026`, deep links past
  steps, two tabs on one draft, six simultaneous commits of the same draft.
- **Every write path exercised and then attacked**: 10,000-character and 1 MB fields, emoji, RTL
  text, zero-width characters, `<script>alert(1)</script>`, `'; drop table account; --`, NUL bytes,
  ids that are `abc` / `0` / `-1` / `1e10` / bigint+1, two tabs racing one save.
- **Every figure on every read screen cross-checked against `psql`** — the headline, each account
  subtotal, all three allocation panels, the holdings table, the gains table and the tax estimate.
- **The login gate probed on every route** in `app/routes.ts`, as a page, as a `.data` single-fetch
  request, as a legacy `?_data=` request and as an action POST; the session cookie tampered with,
  truncated, forged and replayed under a rotated secret; the config gate driven through every
  invalid value it claims to catch.
- **The pricing path driven with the provider genuinely unreachable**, plus zero, negative, NULL,
  future and seven-year-old prices injected by SQL; `isMarketOpen` tested across weekends, both
  DST transitions, five years of NYSE holidays and four time zones.
- **Resilience and scale**: 30 concurrent requests; the connection pool starved; every backend
  connection terminated; Postgres restarted underneath a running app; the data inflated to 66
  accounts / 1,038 priced holdings / 54,974 daily prices.
- **The automated suite run twice** (746 tests, all passing, no flakes), `npm run typecheck`,
  `npm audit`, `npm run build`, a production server, and a `pg_dump`/restore round-trip.
- **Browser-level checks**: `console` and `pageerror` captured on every screen at 1440×1000 and
  390×900, contrast measured against WCAG AA in both themes, and every read screen re-walked with
  JavaScript disabled.

## How to reproduce the environment

Docker was not available, so the stack was stood up directly. Postgres 16 on `:55432` with
databases per tester; `.env` per instance; `node ./server/migrate.ts`; `node ./scripts/seed-demo.ts`;
then `npx react-router dev --port <n>`, plus `npm run build` + `react-router-serve` for the
production checks. Playwright drove Chromium from `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`.

**Caveats, so nothing here is mistaken for a defect of the app:**

- **Node v22.22.2**, where `package.json` requires `>=24.12.0` (`npm install` warns `EBADENGINE`).
  **Postgres 16**, where the deployment uses **17**. The suite, the typecheck and every runtime
  probe passed on this pairing, and **no finding is attributable to either skew** — checked
  explicitly.
- **Docker was unavailable**, so `compose.yaml`, the `Dockerfile`, the Caddy ingress and
  `scripts/smoke-test.sh` were reviewed but **never run**.
- **Outbound HTTPS goes through a proxy** that blocks Yahoo's cookie/crumb handshake, so the live
  price provider is unreachable here. That turned out to be useful — it exercised the
  provider-is-down path for real — and every entry says where the sandbox is the cause.
- Screenshots and probe scripts were written to a session-local scratch directory that does not
  survive the session. Paths to it appear below as `«session scratch»/`; the substantive evidence
  is quoted inline.

---
## Every finding, most severe first

| Severity | ID | Finding |
|---|---|---|
| Critical | `SET-1` | Changing an account's kind to `bank`/`liability` re-opens the Set-balance form on an account full of securities, and one submission wipes it — irrecoverably |
| High | `DASH-1` | `/accounts/<19+ digit id>` returns 500 with the raw Postgres error on the page |
| High | `DASH-2` | The printed money columns do not add up to the printed total (one cent out, on every read screen) |
| High | `ING-1` | A statement dated before the account's latest set commits into a black hole — the review's diff and its removal confirmation describe changes that never happen, and no receipt is shown |
| High | `ING-2` | A NUL byte anywhere in the instrument column crashes the columns step with a raw Postgres error on screen |
| High | `ING-4` | Data rows whose mapped instrument cell is blank are discarded silently — the review screen never mentions them |
| High | `ING-5` | "Record this statement" commits the draft's *current* mapping, not the one the review was rendered against — a second tab writes numbers the reader never saw |
| High | `LEAD-8` | The whole server process exits when Postgres closes a pooled connection — no `pool.on('error')` handler |
| High | `PRC-1` | No screen ever says how old a price is; `is_stale` is the only signal and a dead poller never sets it |
| High | `PRC-2` | One malformed quote in a batch rolls back the whole refresh and leaves every price flagged fresh |
| High | `SEC-1` | Open redirect: a tab in `next=` escapes `safeRedirectTarget` and sends a freshly-logged-in browser off-origin |
| High | `SET-2` | A single-character typo in the balance date (`1026` for `2026`) permanently destroys the "All" net-worth chart, with no way back |
| Medium | `DASH-3` | Overview lists an account with nothing recorded as `$0.00`; its own page refuses to |
| Medium | `DASH-4` | Account-detail holdings table scrolls sideways on a phone: Value is off-screen, Price is clipped mid-figure |
| Medium | `ING-3` | A numeric-but-out-of-bigint-range id in the URL 500s with a raw Postgres error instead of the documented 404 |
| Medium | `ING-6` | Double-clicking "Record this statement" records the statement but leaves the reader on the "expired or already recorded" page |
| Medium | `ING-7` | The documented closed-account commit refusal is unreachable; the reader gets the generic expired page instead |
| Medium | `ING-8` | The instruments step will create a second instrument with a symbol that already exists, with no warning |
| Medium | `ING-9` | After committing a statement that legitimately holds no positions, the account page says "Nothing has been recorded for this account yet" — directly under a receipt saying it was recorded |
| Medium | `LEAD-1` | The PWA specified in DESIGN.md §11 does not exist at all |
| Medium | `LEAD-2` | No favicon — and each `/favicon.ico` request writes a 7-line stack trace to the server log |
| Medium | `LEAD-5` | An outdated schema makes `/healthz` report 503 while the app keeps serving pages |
| Medium | `PRC-3` | A zero or negative price is counted as a known value and summed into every total |
| Medium | `PRC-4` | The Overview's per-account figures omit unpriced holdings without saying so |
| Medium | `PRC-5` | `yahooPriceProvider()` cannot be tested — the live batch loop is the one uncovered money path |
| Medium | `SEC-2` | Any account id past `bigint` range 500s instead of 404ing |
| Medium | `SEC-3` | A `next=` containing `%0A` or `%0D` throws an unhandled 500 out of `redirect()` |
| Medium | `SET-3` | `asOf=0000-01-01` is accepted by the validator and 500s in the driver |
| Medium | `SET-4` | Closing an account leaves the overview headline and its own chart disagreeing by that account's value for the rest of the day |
| Medium | `SET-5` | `setBalance`'s form-level refusal is thrown, caught, and rendered nowhere — the submission is a silent no-op |
| Medium | `SET-6` | A NUL byte in any text field is a 500 with a driver stack trace instead of a refusal |
| Medium | `SET-7` | `personId` is never checked for id shape — any non-numeric or oversized value 500s |
| Low | `DASH-5` | A stray hairline runs under the first cell only of every total and subtotal row |
| Low | `DASH-6` | "Value is all 1 holdings" — the coverage sentence is not pluralised |
| Low | `DASH-7` | `/favicon.ico` 404s: a console error on every page load and a server stack trace per request |
| Low | `DASH-8` | Leading-zero account ids resolve, giving unlimited duplicate URLs for one account |
| Low | `DASH-9` | Selecting the default range navigates to `/?index` rather than `/` |
| Low | `DASH-10` | `/analysis` heads its share column "% of total" beside a "Total" it is not a share of |
| Low | `DASH-11` | Grouped by asset class, the subtotal shares shown sum to 99.9% under a note promising 100% |
| Low | `DASH-12` | The "shares sum to 100%" note is printed on a grouped table whose every share is a dash |
| Low | `DASH-13` | The Income empty state gives a reason that is no longer true |
| Low | `ING-10` | The account total and the holdings table's rounded row values disagree by a cent |
| Low | `ING-11` | `/favicon.ico` 404s, so every page load logs a console error |
| Low | `LEAD-3` | The overview range parameter is case-sensitive and silently ignores the casing its own buttons display |
| Low | `LEAD-4` | `/holdings` renders every holding with no pagination or virtualisation |
| Low | `LEAD-6` | ARCHITECTURE.md §4.2's `file:line` citations have drifted — three of seven point at the wrong line |
| Low | `LEAD-7` | ARCHITECTURE.md §4.2's "reading the environment" invariant omits a fourth caller that breaks it |
| Low | `LEAD-9` | `app/components/stub-page.tsx` is dead code its own comment says should be gone |
| Low | `PRC-6` | Chart axis labels are money figures computed from floats, which `format.ts` and ARCHITECTURE §5.6 both forbid |
| Low | `PRC-7` | The poller logs nothing at all outside market hours, so a dead loop and a quiet one look identical |
| Low | `PRC-8` | `isMarketOpen` has no holiday data before 2026 or after 2030, and none for half-days |
| Low | `SEC-4` | Root middleware and root loader never run for unmatched paths — 404s are ungated and carry no open-instance banner |
| Low | `SEC-5` | Two router endpoints answer unauthenticated beyond the documented open list |
| Low | `SEC-6` | No `<title>` on any error page |
| Low | `SEC-7` | Non-upload actions read an unbounded request body |
| Low | `SEC-8` | `SESSION_SECRET` is accepted at any length ≥ 1 |
| Low | `SEC-9` | Settings → Accounts prints raw enum values where every other screen prints labels |
| Low | `SEC-10` | There is no way to sign out |
| Low | `SEC-11` | Every unmatched URL writes a stack trace to the production log |
| Low | `SET-8` | An id that is all digits but larger than `bigint` 500s on account create, edit and view |
| Low | `SET-9` | The Holdings editor will store a negative balance on a bank account, which the Set-balance form refuses outright |
| Low | `SET-10` | The Settings → Accounts table prints raw enum slugs where every other screen prints labels |
| Low | `SET-11` | The account-number field's own help text says the opposite of the guide and of the code |
| Low | `SET-12` | Two tabs editing one account: the second save silently reverts the first, including a tax treatment |
| Low | `SET-13` | A name consisting only of zero-width characters is accepted, producing an invisible person |
| Low | `SET-14` | A rejected 1MB field is echoed back to the browser twice, in a 2.2MB response |
| Low | `SET-15` | `23,8` in the tax-rate box is refused as "cannot be more than 100%", and `1,5` is silently stored as 15% |

**67 findings** — 1 critical, 11 high, 20 medium, 35 low.

---

## Findings in full

Grouped by the area they were found in. Each area closes with the dead ends its tester walked.

---

## Cross-cutting — resilience, scale, deployment, docs-vs-code


Instance: dev on :5178 and production build on :5189, both against `portfolio_e`
(demo seed, then inflated to 66 accounts / 1,038 priced holdings / 32,920 holding rows /
54,974 daily prices to probe scale).

#### [LEAD-1] The PWA specified in DESIGN.md §11 does not exist at all
- **Severity:** Medium (spec drift, not a runtime defect)
- **Where:** `DESIGN.md:3`, `DESIGN.md:673`, `DESIGN.md` §11; `package.json`; `vite.config.ts`; `public/`
- **What happens:** DESIGN.md opens with "Browser-first with an installable PWA" and §10.2's stack
  table lists `vite-plugin-pwa` for "Manifest, service worker, precaching". None of it is built:
  - `vite-plugin-pwa` is not in `package.json` and not referenced in `vite.config.ts`.
  - `public/` contains exactly one file, `fonts/inter-latin-var.woff2`. No manifest, no icons.
  - `GET /manifest.json`, `/manifest.webmanifest`, `/sw.js`, `/apple-touch-icon.png` all 404.
  - §11's "stale-while-revalidate on the three read pages" and "if the server is unreachable you
    see last-known numbers rather than an error page" cannot happen with no service worker.
  - §11 calls the "as of" timestamp "non-negotiable" for the offline case — there is no offline case.
- **What should happen:** either the feature exists, or DESIGN.md marks §11 and the §10.2 stack row
  as not-yet-built. `.env.example:52` compounds it by explaining the HTTPS *precondition* for PWA
  install, which reads as though install works once TLS is added. It would not.
- **Repro:** `curl -s -o /dev/null -w '%{http_code}' http://localhost:5189/manifest.webmanifest` → 404
- **Notes:** Cheap to resolve either way, but a reader currently cannot tell built from planned.
  Worth a general sweep of DESIGN.md for the same problem.

#### [LEAD-2] No favicon — and each `/favicon.ico` request writes a 7-line stack trace to the server log
- **Severity:** Medium
- **Where:** `public/`, `app/root.tsx` (no `<link rel="icon">`)
- **What happens:** `GET /favicon.ico` → 404. Two consequences, and the second is the reason this is
  not merely cosmetic:
  1. Chromium logs a console error on every navigation and the tab shows a placeholder icon.
  2. React Router has no route for it, so **each request prints a full stack trace to stdout** —
     `Error: No route matches URL "/favicon.ico"` plus six frames — in the *production* server too.
     A browser requests the favicon on every fresh visit, so the operator's one log stream
     (ARCHITECTURE.md §10.1 makes "one place to read logs" a design goal) fills with stack traces
     that mean nothing. It also trains an operator to ignore stack traces in that log.
- **What should happen:** a favicon, or at minimum an inline SVG data-URI icon in `root.tsx`, so the
  app is identifiable in a tab strip and the console is clean.
- **Repro:** truncate the server log, then `curl -s -o /dev/null http://localhost:5189/favicon.ico`.
  The log gains 8 lines:
  ```
  Error: No route matches URL "/favicon.ico"
      at getInternalRouterError (…/react-router/dist/development/chunk-62JRHF6Z.mjs:5503:5)
      at Object.query (…/chunk-62JRHF6Z.mjs:3505:19)
      at handleDocumentRequest (…/chunk-ZA36QIGN.mjs:1428:38)
      at requestHandler (…/chunk-ZA36QIGN.mjs:1288:24)
      at requestHandler (…/chunk-ZA36QIGN.mjs:1342:12)
      at …/@react-router/express/dist/index.mjs:28:28
  GET /favicon.ico 404 - - 3.353 ms
  ```
  Confirmed in both dev (:5178) and the production build (:5189).
- **Notes:** Same root cause as LEAD-1 (no icon assets were ever produced).

#### [LEAD-3] The overview range parameter is case-sensitive and silently ignores the casing its own buttons display
- **Severity:** Low
- **Where:** `app/routes/overview.tsx`, URL `/?range=…`
- **What happens:** the control renders labels `1M`, `3M`, `1Y`, `All` but links to lowercase values
  (`/?range=1m`, `/?range=3m`, `/?range=all`). Passing the *displayed* casing — `?range=1M`,
  `?range=ALL` — is byte-for-byte identical to `?range=bogus` and to no parameter at all: it falls
  back to the 1Y default with no error, no correction, and no visual cue that the request was
  rejected. A user who hand-edits or hand-types the URL to what the button says gets a different
  time range than they asked for and is not told.
- **What should happen:** parse the range case-insensitively (it is a closed set of four values), or
  reject unknown values visibly. README claims the range "is a URL, so a chosen range survives a
  reload and can be bookmarked" — that promise is what makes hand-edited URLs a real path.
- **Repro:**
  1. `curl -s 'http://localhost:5189/?range=all' | md5sum` → `86b4f6f4…`, axis `Dec 2019|Apr 2023|Aug 2026`
  2. `curl -s 'http://localhost:5189/?range=All' | md5sum` → `a461ba57…`, axis `Aug 2025|Feb 2026|Aug 2026`
  3. `curl -s 'http://localhost:5189/?range=bogus' | md5sum` → `a461ba57…` — identical to step 2.
- **Evidence:**
  ```
  '?range=1m'    -> 75482B md5:f7e36830
  '?range=3m'    -> 75722B md5:6cf7f9c0
  '?range=1y'    -> 75803B md5:a461ba57
  '?range=all'   -> 74801B md5:86b4f6f4   axis:[Dec 2019|Apr 2023|Aug 2026]
  '?range=1M'    -> 75803B md5:a461ba57   <- same as default
  '?range=ALL'   -> 75803B md5:a461ba57   <- same as default
  '?range=bogus' -> 75803B md5:a461ba57   <- same as default
  ```
- **Notes:** the silent fallback itself is defensible (never 500 on a bad param). The defect is that
  the app's own button labels are not accepted values.

#### [LEAD-4] `/holdings` renders every holding with no pagination or virtualisation
- **Severity:** Low (only bites at volumes a household will not reach; recorded because it is
  unbounded by construction, not because the demo data is slow)
- **Where:** `app/routes/holdings.tsx`
- **What happens:** the loader returns and the route renders every holding row. At 1,038 priced
  holdings the production server emits **2.2 MB of HTML** for one page, 26,995 DOM nodes, ~2.6 s to
  browser `load`. Server time is fine (0.32 s); the cost is payload and DOM. Nothing caps it, so the
  page degrades linearly for ever.
- **What should happen:** at minimum a documented ceiling. The other screens are all bounded by
  account count; this one is bounded by nothing.
- **Repro:**
  1. Seed a database, then inflate: 60 extra accounts × monthly position sets × all instruments.
  2. `curl -s -o /dev/null -w '%{size_download}' http://localhost:5189/holdings` → 2212951
  3. Playwright `goto('/holdings', {waitUntil:'load'})` → 2587 ms, `tbody tr` count 1038,
     `document.getElementsByTagName('*').length` → 26995, zero page errors.
- **Evidence:** by comparison `/analysis` 24 KB, `/income` 12 KB, `/accounts/1` 25 KB at the same volume.
- **Notes:** no client-side error and no server strain — purely a payload/DOM ceiling. Deliberately
  filed Low: DESIGN.md scopes this to a household.

#### [LEAD-5] An outdated schema makes `/healthz` report 503 while the app keeps serving pages
- **Severity:** Medium
- **Where:** `app/lib/db.server.ts` (`checkHealth`), `app/routes/healthz.ts`, `compose.yaml`, `Caddyfile`
- **What happens:** with the code at migration 0005 and the database only migrated to 0002,
  `/healthz` correctly returns 503 `{"status":"unhealthy","migrations":"pending",…}` — but every
  other route keeps answering. Some 500 with the raw Postgres error, some return 200 and render
  *plausible but wrong* pages:
  ```
  /healthz      -> 503   (pendingMigrations: 0003, 0004, 0005)
  /             -> 500
  /analysis     -> 500
  /settings/tax -> 500
  /holdings     -> 200   <-- serves against the stale schema
  /income       -> 200   <-- serves against the stale schema
  /settings     -> 200
  /upload       -> 200
  ```
  The 500 page renders the internal error verbatim to the browser:
  `function holding_valued_at(date) does not exist`.
- **What should happen:** `docker-entrypoint.sh` states the intent — "no request is ever served
  against a half-migrated schema" — and enforces it *at boot only*. Nothing enforces it once the
  process is up. Since `caddy` only gates on `service_healthy` at startup, an app that goes
  unhealthy later keeps receiving traffic. A pending-migration check in the root loader (or a 503
  from the root route) would make the invariant hold at request time, not just at boot time.
- **Repro:**
  1. `createdb portfolio_old`; run the migrator with only `0001` and `0002` present in `migrations/`.
  2. Start the app against it: `DATABASE_URL=…/portfolio_old npx react-router dev --port 5179`
  3. `curl -s http://localhost:5179/healthz` → 503, and `curl -o /dev/null -w '%{http_code}'
     http://localhost:5179/holdings` → 200.
- **Notes:** the entrypoint makes this unreachable on a *clean* Compose deploy. It is reachable when
  the database is restored from an older `pg_dump` behind a running app, or when a deploy rolls the
  image forward and the migration is reverted. The raw-error leak on the 500 path was observed in
  dev mode; whether production leaks the same string is SEC's call.

#### [LEAD-6] ARCHITECTURE.md §4.2's `file:line` citations have drifted — three of seven point at the wrong line
- **Severity:** Low (documentation), but disproportionately annoying
- **Where:** `ARCHITECTURE.md` §4.2 "Single-site invariants"
- **What happens:** §4.2 is the table a contributor is told to read before changing anything, and it
  navigates by `file:line`. Checked every reference in it against the current tree:

  | ARCHITECTURE.md says | Actually at | Verdict |
  |---|---|---|
  | `server/db.ts:62` — pool construction | 62 | correct |
  | `app/lib/price-provider.server.ts:303` — importing `yahoo-finance2` | 302 | off by 1 |
  | `app/routes/upload.tsx:50` — the multipart body is read | 50 | correct |
  | `app/routes/login.tsx:33` — the `formFields` exception | 33 | correct |
  | `app/lib/prices.server.ts:356` — `priceFreshness` | 357 | off by 1 |
  | `app/lib/positions.server.ts:239` — "rounds the overflow-guard product inline" | 251 | off by 12 |
  | `app/lib/uploads.server.ts:554` — `valueAt` | 614 | **off by 60** |

  `positions.server.ts:239` and `uploads.server.ts:554` land inside unrelated prose comments and a
  type literal respectively, so a reader following them sees something that looks deliberate and
  wrong rather than obviously stale.
- **What should happen:** the claims themselves are all still true (verified below) — only the
  numbers rotted. Either cite symbols rather than lines, or add a check that resolves them.
  `AGENTS.md` instructs contributors to "Point at `file:line` instead of pasting long code", which
  makes the repo's own navigation aid the thing most likely to be trusted blindly.
- **Repro:** `sed -n '554p' app/lib/uploads.server.ts` → `  currentCount: number;`
  (`valueAt` is declared at 614). `sed -n '239p' app/lib/positions.server.ts` → `* would wave through.`
- **Notes:** All three structural invariants themselves **do** hold — see Non-issues below.

#### [LEAD-7] ARCHITECTURE.md §4.2's "reading the environment" invariant omits a fourth caller that breaks it
- **Severity:** Low
- **Where:** `ARCHITECTURE.md` §4.2, second table; `scripts/capture-screenshots.ts:57,64,467`
- **What happens:** the doc states: *"Three callers pass `process.env` in — `validate-config.ts`,
  `migrate.ts`, `scripts/seed-demo.ts` — and none of them reads a variable itself."* There is a
  fourth caller, and it does read variables itself:
  ```
  scripts/capture-screenshots.ts:57:  const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:5173";
  scripts/capture-screenshots.ts:64:  const EXECUTABLE = process.env.CHROMIUM_EXECUTABLE;
  scripts/capture-screenshots.ts:467: const { DATABASE_URL } = loadConfig(process.env);
  ```
- **What should happen:** either name the fourth caller and its two direct reads as a stated
  exception (the pattern §4.2 already uses well for the valuation invariant), or route `BASE_URL`
  and `CHROMIUM_EXECUTABLE` through `config.ts`. As written the sentence is falsifiable by one grep,
  which §4.2's own preamble warns against ("how a reader ends up disproving the table with a single
  grep").
- **Repro:** `grep -rn "process\.env" app server scripts --include=*.ts | grep -v "^server/config.ts"`
- **Notes:** `capture-screenshots.ts` is a developer script, not the served app, so the *hazard* the
  invariant guards is not actually reached. This is a correctness-of-documentation finding only.

#### [LEAD-8] The whole server process exits when Postgres closes a pooled connection — no `pool.on('error')` handler
- **Severity:** High
- **Where:** `server/db.ts:62` (`createPool`) — the single, documented pool construction site
- **What happens:** `createPool` never attaches an `error` listener to the `pg.Pool`. `node-postgres`
  emits an `error` event on **idle** pooled clients when the backend goes away, and its documentation
  is explicit that an unhandled one is an uncaught exception. So any event that closes an idle
  connection — a Postgres restart, a minor-version upgrade, a container OOM-kill, a failover, an
  operator's `pg_terminate_backend`, or a server-side `idle_session_timeout` — **kills the Node
  process with exit code 1**. It is not a failed request; the listener is gone.

  Verified on both the production build (`react-router-serve`) and `react-router dev`.
- **What should happen:** `pool.on("error", …)` that logs and swallows. The pool then discards the
  dead client and the next request opens a fresh one — which is the behaviour `/healthz` is written
  for (`checkHealth` already catches a query failure and reports `database:false`). Today `/healthz`
  can never report that, because the process is not alive to answer.
- **Repro A — a plain Postgres restart, i.e. `docker compose restart db`.** This is the realistic
  trigger and it is the one that matters:
  1. Start a Postgres, `createdb portfolio_restart`, migrate it.
  2. `DATABASE_URL=…/portfolio_restart PORT=5193 node ./node_modules/.bin/react-router-serve ./build/server/index.js &`
  3. `curl http://localhost:5193/healthz` → 200.
  4. `pg_ctl -D <datadir> -m fast restart` — a normal, graceful restart.
  5. Postgres comes back healthy (`select 1` → 1). **The app process is gone** (exit 1),
     `curl http://localhost:5193/healthz` → connection refused (000).

- **Repro B — an operator terminating an idle backend.** (deterministic; ran it four times, four crashes)
  1. `createdb portfolio_crash` and migrate it.
  2. `DATABASE_URL=…/portfolio_crash PORT=5191 node ./node_modules/.bin/react-router-serve ./build/server/index.js &`
  3. `curl http://localhost:5191/healthz` → 200. One backend now exists and goes idle:
     `select count(*) from pg_stat_activity where datname='portfolio_crash'` → 1
  4. `select pg_terminate_backend(pid) from pg_stat_activity where datname='portfolio_crash' and pid <> pg_backend_pid();`
  5. Within ~1 s the process is **gone**. `curl http://localhost:5191/healthz` → connection refused (000).
- **Evidence:** stdout at the moment of death:
  ```
  /home/user/portfolio/node_modules/pg-protocol/src/parser.ts:395
        : new DatabaseError(messageValue, LATEINIT_LENGTH, name)
          ^
  error: terminating connection due to administrator command
      at parseErrorMessage (…/pg-protocol/src/parser.ts:395:9)
      at Parser.handlePacket (…/pg-protocol/src/parser.ts:212:19)
      at Socket.emit (node:events:519:28)
      …
  ```
  `grep -rn "pool.on\|\.on(\"error\"" app server scripts` → **no matches anywhere in the tree**.
  Note "terminating connection due to administrator command" is also exactly the message Postgres
  sends on a normal `pg_ctl stop -m fast`, i.e. on `docker compose restart db`.
- **Notes:**
  - `compose.yaml` sets `restart: unless-stopped`, so the container comes back and this presents as a
    flap rather than an outage. That masks it — it does not fix it. Every in-flight request is lost,
    and while `db` is restarting the app enters a crash/restart loop (`depends_on: service_healthy`
    only gates the *first* start).
  - No data-corruption risk found: an interrupted transaction is rolled back by Postgres, so this is
    availability only. That is why it is filed High rather than Critical.
  - Adjacent, same file, worth deciding at the same time: `createPool` sets `connectionTimeoutMillis`
    but no `max`, no `idleTimeoutMillis` and no `statement_timeout`. The pool therefore runs on pg's
    default of 10 connections with no query deadline.

#### [LEAD-9] `app/components/stub-page.tsx` is dead code its own comment says should be gone
- **Severity:** Low
- **Where:** `app/components/stub-page.tsx`
- **What happens:** `StubPage` is imported by nothing — no route, no component, no test.
  Its header comment says *"The dashboards slice replaces these."* That slice shipped; the
  placeholder it was written for did not get removed with it.
- **What should happen:** delete the file. Nothing references it, so the deletion is total.
- **Repro:** `grep -rn "stub-page\|StubPage" app server tests scripts --include=*.ts --include=*.tsx`
  → one hit, the declaration itself.
- **Evidence:** an importer count across every component confirms it is the only orphan:
  ```
  account-fields 2   empty-state 5   first-run-prompt 1   icons 5   money-cell 2
  net-worth-chart 3  open-instance-banner 1   upload-steps 5   stub-page 0
  ```
  The same sweep over `app/lib/*.ts` found **no** unused modules — this is the single orphan
  in the tree.
- **Notes:** trivial, but it is the kind of file a future reader copies as a pattern.

#### Non-issues investigated

- **Migration runner robustness — solid, no finding.** `server/migrations.ts` takes a session-level
  advisory lock, re-reads the ledger after acquiring it, wraps each file in its own transaction, and
  rolls the whole file back on failure without recording it. Forcing a mid-run failure (by deleting a
  ledger row so an already-present object is recreated) produced a clean
  `Migration 0003_holding_valued_at.sql failed and was rolled back.`, **exit code 1**, and no partial
  application — exactly what `docker-entrypoint.sh`'s `set -e` needs. Re-running after a successful
  run prints `nothing pending` and exits 0.
- **Concurrency — no finding.** 30 concurrent `GET /` against the dev server: all 200, worst case
  0.92 s, no pool exhaustion, no errors in the log. `createPool` sets no `max`, so it runs on pg's
  default of 10 connections; that was sufficient here.
- **Working tree cleanliness — no finding.** Running the app, the seeder and the migrator wrote
  nothing into the repository. `git status` stayed clean throughout (build output is gitignored).
- **Production build — no finding.** `npm run build` succeeds and `react-router-serve` boots and
  serves correctly, on **Node 22** despite `engines` requiring `>=24.12.0`. Response times in
  production at inflated scale: `/` 0.26 s, `/holdings` 0.32 s, `/analysis` 0.05 s, `/income` 0.01 s.
- **`range=all` covers the manual prefix — no finding.** Confirmed the "All" range reaches back to
  the seeded `manual_networth` prefix (axis `Dec 2019 → Aug 2026`) rather than stopping at day zero.

- **The three structural invariants hold — no finding.** Verified by grep against the whole tree:
  `new pg.Pool(` appears exactly once (`server/db.ts:62`); `yahoo-finance2` is imported exactly once
  in application code (`app/lib/price-provider.server.ts:302`, a dynamic import) plus once in its own
  test; and the upload size cap is genuinely called before the body is buffered
  (`refuseOversizedBody(request)` at `app/routes/upload.tsx:48`, `await request.formData()` at 50).
- **The demo seeder's two safety guarantees hold — no finding.** Both claims in its header were
  tested directly. (a) *Refuses data it did not create*: against a migrated database carrying one
  hand-inserted `person` row and no `demo_seed` marker, it exited **1**, printed "There is no
  `demo_seed` marker table, so nothing here is safe to overwrite", and left the row untouched.
  (b) *Idempotent*: two consecutive runs on a clean database produced identical row counts
  (person 2 / holding 280 / price_daily 11,048), i.e. the second replaced the first rather than
  doubling it.
- **`pg_dump` backup/restore round-trips exactly — no finding.** DESIGN.md §10 makes `pg_dump` the
  single backup target, so this was checked digit for digit. Dump (294,603 bytes) restored into an
  empty database with **zero errors**, and the money-bearing aggregates matched exactly:
  `sum(holding.quantity)` = `701272.52360700` and `sum(price_daily.close)` = `1578044.6426` in both.

- **The Income screen being empty is intentional — not a bug.** `app/routes/income.tsx` has no
  loader at all and renders a fixed `EmptyState`. Its header comment argues the position: `quote`
  carries a yield and an annual dividend per share, no slice has ever written them, and *"deriving a
  figure from columns nobody has written would put an invented number on a finance page."* Flagging
  it as a broken screen would be wrong; recorded here so the next tester does not.
- **Pool exhaustion degrades gracefully — no finding.** With `portfolio_e` capped at one server-side
  connection (`alter database … connection limit 1`) and 20 concurrent `GET /`, all 20 returned
  **200**, worst case 1.36 s, and the process stayed up. The crash in LEAD-8 is specific to an
  *existing idle connection being closed*, not to connection pressure.
- **CI is thorough — no finding, one observation.** `.github/workflows/ci.yml` runs typecheck, build,
  a real Postgres, the suite, `npm audit signatures`, a production-only high/critical audit, a
  deprecation report, and the container smoke test. Two things verified by hand:
  `npx kysely-codegen --verify` is a real flag (it is, and `npm run db:types -- --verify` exits 0
  against the current schema — the committed types are in step), and `npm audit --omit=dev
  --audit-level=high` reports **0 vulnerabilities** today. The observation, not filed as a bug:
  Playwright is a devDependency used only by `scripts/capture-screenshots.ts`, so **no browser-level
  test runs in CI** — the smoke test's one `curl` of `/` is the entire end-to-end signal. The
  route-level loader/action tests under `tests/routes/` cover a lot of that ground, which is why this
  is an observation rather than a finding.
- **Deployment files reviewed statically — no findings.** Docker is unavailable in this sandbox so
  `Dockerfile`, `compose.yaml`, `Caddyfile` and `scripts/smoke-test.sh` could not be executed. Read
  them: three stages, non-root `USER node`, dev deps and `typescript` pruned, migrations shipped as
  `.sql`, `read_only: true` with a `/tmp` tmpfs, only Caddy publishing a port, and a `.dockerignore`
  whose one negation (`!scripts/prune-unreachable-deps.mjs`) is valid Docker syntax for re-including
  a file under an excluded directory. Nothing stood out — but note that none of it was **run**.

#### Environment caveats for anyone reproducing this
- Node **v22.22.2**; `package.json` `engines` requires **>=24.12.0**. `npm install` warns
  `EBADENGINE` and continues. Everything tested here still ran.
- Postgres **16.13** (local cluster on :55432); the deployment uses **postgres:17-alpine**.
- Docker is not available in this sandbox, so `compose.yaml`, the `Dockerfile`, the Caddy ingress and
  `scripts/smoke-test.sh` were **not** exercised. Everything above ran against a locally started
  Postgres and either `react-router dev` or `react-router-serve` over a real production build.
- Outbound HTTPS goes through a proxy, so Yahoo Finance reachability is not representative.

---

## Ingest — statement upload, end to end


App: http://localhost:5174 · DB: `portfolio_a` · Scratch: `.../«session scratch»/ingest`

Two full happy paths were walked to commit and verified digit-for-digit against Postgres
(`fidelity.csv` → Empower 401(k), `schwab.csv` → Principal 401(k), plus `numbers2.csv`,
`lot-level.csv`, `liability.csv`, `semicolon.csv`, `401k.csv`). Money exactness holds
everywhere I could reach it — see the non-issues section. The findings below are the failures.

---

#### [ING-1] A statement dated before the account's latest set commits into a black hole — the review's diff and its removal confirmation describe changes that never happen, and no receipt is shown

- **Severity:** High
- **Where:** `app/lib/uploads.server.ts:assembleDiff` (diff is built from `accountHoldings(accountId)`,
  i.e. *current*, with no reference to the as-of date the commit will use) and
  `app/lib/uploads.server.ts:uploadReceipt` (returns `null` unless the new set is
  `lastRecorded`). URL: `/upload/:id/review` → `/accounts/:id?uploaded=<setId>`
- **What happens:**
  1. The review screen builds its diff — "Added / Updated / Removed", and the
     removes-everything confirmation — against what the account holds **now**
     (`latest_position_set`, ordered `as_of_date desc`).
  2. The as-of date is chosen *after* that, or taken from the file, and is never compared
     against the account's latest.
  3. If the resulting date is older than the account's latest set, the commit succeeds and a
     `position_set` is written, but it never becomes current. The account page's holdings,
     total and chart are unchanged.
  4. Because `uploadReceipt` returns `null` for a set that is not the account's latest, the
     landing page `/accounts/:id?uploaded=<setId>` renders **no confirmation at all**. The
     reader is dropped on an unchanged account page with no word about what just happened.
  So the reader is shown a diff that says "this removes every position this account holds —
  all 3", is made to tick a danger-zone confirmation to proceed, and then nothing observable
  changes and nothing tells them so.
- **What should happen:** ingest brief §6.5: "**Success lands on the account** —
  `/accounts/:id?uploaded=<setId>` — with a `role="status"` receipt." A commit that lands
  behind the account's current statement should either say so before the write (the diff is
  against the wrong baseline) or say so after it (a receipt explaining that this statement is
  historical and does not change what the account holds). Neither happens.
- **Repro (three independent ones; the third uses a repo fixture and gives the reader no
  control over the date at all):**
  1. `curl -X POST /upload -F accountId=2 -F file=@tests/fixtures/statements/fidelity.csv`
     → draft 1 → map Symbol/Quantity/Description/Average Cost Basis → resolve FXAIX →
     `/upload/1/review` shows `4 ADDED · 0 UPDATED · 3 REMOVED` and
     "This file removes every position this account holds — all 3."
     POST the commit with `asOf=2026-07-31` (the date fidelity.csv's own preamble states).
     → 302 `/accounts/2?uploaded=125`. Account 2 still shows VIIIX / VBTLX / VTSNX and
     `$265,519.57`; **no receipt sentence anywhere on the page**.
  2. A file that dates itself: `Symbol,Qty,Basis,Date` with `2026-08-01`, mapped with the
     Date column as as-of, uploaded to account 3 (latest set 2026-08-24). Review renders
     "The statement dates itself: 2026-08-01." — **no date control at all**, so the reader
     cannot avoid this. Commit → set 128 → `/accounts/3?uploaded=128` shows no receipt and
     the previous holdings.
  3. `tests/fixtures/statements/liability.csv` → account 6 (Chase Auto Loan, latest set
     2026-08-20). The file dates itself 2026-07-31 — a completely ordinary end-of-month loan
     statement. Review: `1 ADDED · 0 UPDATED · 1 REMOVED`, "removes every position this
     account holds — all 1", no date control. Commit → set 132 →
     `/accounts/6?uploaded=132` renders no receipt; holdings unchanged.
- **Evidence:**
  ```
  # after repro 3
  position_set: 132 | 6 | 2026-07-31 | liability.csv | 2026-08-24 07:06:03+00
  latest_position_set(6) order:  124 (2026-08-20) > 132 (2026-07-31)
  /accounts/6?uploaded=132  ->  grep 'Recorded' : no match  (only the auth banner has role="status")
  holding_valued account 6 before and after commit: instrument 1, quantity -14500.00000000
  ```
- **Notes:** The behaviour of `latest_position_set` (max `as_of_date`) is intended
  (`migrations/0002_holding_valued.sql`, and `recordedDate`'s doc in `input.server.ts`).
  The bug is that the review screen and the receipt do not know about it: the diff's baseline
  and the write's date are chosen independently. Related: `recordedDate` bounds the future
  ("no later than tomorrow") but has **no lower bound**, so `0001-01-01` is accepted — a
  typo'd year (`0226-08-24`) lands a statement two thousand years in the past through exactly
  this silent path. The review's date input carries `max=` but no `min=`.

---

#### [ING-2] A NUL byte anywhere in the instrument column crashes the columns step with a raw Postgres error on screen

- **Severity:** High
- **Where:** `app/lib/csv.ts` (decodes NUL through unharmed),
  `app/lib/instrument-resolution.server.ts:59` (`unresolvedStrings`) via
  `app/lib/uploads.server.ts:386` (`rememberMapping`), reached from
  `app/routes/upload/columns.tsx:242`. URL: `POST /upload/:id/columns`
- **What happens:** HTTP 500. The page renders
  `Something went wrong` / `invalid byte sequence for encoding "UTF8": 0x00` — a raw Postgres
  driver message shown to the household. Full stack trace in `dev-a.log`.
- **What should happen:** `app/lib/csv.ts`'s module doc states the load-bearing property:
  "**Never throws on content.** A file this module cannot make sense of still yields rows for
  the caller to judge, so the refusal a reader eventually sees is a sentence about their
  statement — never a stack trace from in here." `parseUploadForm` already has a sentence for
  bytes that are not text ("This does not read as a text file…"); a NUL byte should reach the
  same sentence, or be stripped, or produce a parse problem naming the row.
- **Repro:**
  1. `printf 'Symbol,Quantity,Cost\nAAP\x00L,10,100.00\nMSFT,5,200.00\n' > nul.csv`
     (NUL is valid UTF-8, so `parseUploadForm`'s `TextDecoder({fatal:true})` accepts it.)
  2. `curl -X POST http://localhost:5174/upload -F accountId=3 -F file=@nul.csv` → 302 to
     `/upload/10/columns`. The columns screen renders fine (the cell shows as `AAP L`).
  3. `curl -i -X POST http://localhost:5174/upload/10/columns -d headerRow=0 -d instrument=Symbol
     -d quantity=Quantity -d costBasis=Cost -d name=__none__ -d asOf=__none__
     -d accountNumber=__none__ -d costBasisIs=per_share`
- **Evidence:**
  ```
  HTTP/1.1 500
  page text: "Something went wrong / invalid byte sequence for encoding "UTF8": 0x00"

  dev-a.log:
  error: invalid byte sequence for encoding "UTF8": 0x00
      at unresolvedStrings (/home/user/portfolio/app/lib/instrument-resolution.server.ts:59:16)
      at rememberMapping (/home/user/portfolio/app/lib/uploads.server.ts:386:7)
      at action (/home/user/portfolio/app/routes/upload/columns.tsx:242:21)
    code: '22021', routine: 'report_invalid_encoding_int'
  ```
- **Notes:** Postgres `text` cannot hold `\x00` at all, so every downstream write of the raw
  string (the alias insert, the mapping jsonb) would fail the same way. The cheapest guard is
  in `readCsv`'s decode. Reproduced twice.

---

#### [ING-3] A numeric-but-out-of-bigint-range id in the URL 500s with a raw Postgres error instead of the documented 404

- **Severity:** Medium
- **Where:** `app/lib/uploads.server.ts:findDraft` — the guard is `if (!/^\d+$/.test(draftId))
  return undefined;`, which passes any string of digits, however long. Also
  `app/lib/uploads.server.ts:requireDraft:303`. URLs: `/upload/:draftId`,
  `/upload/:draftId/columns|instruments|review`
- **What happens:** `/upload/9999999999999999999999/columns` → HTTP 500,
  `Something went wrong` / `value "9999999999999999999999" is out of range for type bigint`.
  All four draft URLs behave the same. The same shape from the drop screen:
  `POST /upload` with `accountId=99999999999999999999` → 500 with the same message
  (`accountId` is validated with `regex(/^\d+$/)` in `uploadInput`).
- **What should happen:** `findDraft`'s own comment states the intent exactly: *"Anything a URL
  carries reaches here; `"abc"` would fail as a malformed bigint in the driver, which is a 500
  wearing a bookmark."* — the expired-or-recorded 404 page (`draft.tsx`'s error boundary), the
  same as `/upload/abc/columns`, `/upload/99999/columns` and `/upload/-1/review`, all of which
  correctly 404.
- **Repro:**
  1. `curl -o /dev/null -w '%{http_code}' http://localhost:5174/upload/9999999999999999999999/columns` → `500`
  2. Same for `/instruments`, `/review` and the bare `/upload/9999999999999999999999`.
  3. `curl -X POST http://localhost:5174/upload -F accountId=99999999999999999999 -F file=@simple.csv` → `500`
- **Evidence:**
  ```
  dev-a.log: error: value "9999999999999999999999" is out of range for type bigint
      at requireDraft (/home/user/portfolio/app/lib/uploads.server.ts:303:15)
      at loader (/home/user/portfolio/app/routes/upload/instruments.tsx:50:19)
    code: '22003', routine: 'pg_strtoint64_safe'
  ```
- **Notes:** `uploadReceipt` has the same `/^\d+$/` guard but survives, because a `?uploaded=`
  overflow value fails the `lastRecorded` comparison before it reaches SQL. Outside the ingest area but
  the same class: `/accounts/9999999999999999999999` also 500s.

---

#### [ING-4] Data rows whose mapped instrument cell is blank are discarded silently — the review screen never mentions them

- **Severity:** High
- **Where:** `app/lib/statement.ts:parseStatement` —
  `const instrument = cells[instrumentIndex] ?? ""; if (instrument.trim() === "") continue;`
  (no `skipped` entry, no problem). `app/routes/upload/review.tsx` only prints
  `diff.skipped`, which is populated for *absent-quantity* rows only.
- **What happens:** With `tests/fixtures/statements/401k.csv` mapped instrument → `Ticker`
  (the obvious choice for anyone used to brokerage exports), the two collective-investment-trust
  rows — `$22,325.17` and `$36,367.51`, 96% of the file's value — have a blank `Ticker` cell
  and are dropped without a word. The review screen reads `1 ADDED · 0 UPDATED · 4 REMOVED` and
  says nothing about lines 2 and 3. Committing records a statement missing them.
- **What should happen:** the sibling rule is right there in `statement.ts`'s own doc for
  `SkippedRow`: *"Skipped rather than refused, and reported so the review screen can say so:
  a row that vanishes silently is how 'a missing row means sold' becomes an accident."*
  The same reasoning applies verbatim here — and review.tsx's own header comment cites §5.2:
  *"a file showing 2 of 30 positions is a valid statement that silently sells 28 holdings"*.
  A blank-instrument data row should be named on the review screen the same way a
  blank-quantity row is, or the columns step should warn how many data rows the chosen
  instrument column is empty on. (The blank-instrument skip is documented as the *footer /
  spacer* rule, but the rule cannot tell a footer from a real position.)
- **Repro:**
  1. `curl -X POST /upload -F accountId=4 -F file=@tests/fixtures/statements/401k.csv` → draft 37
  2. Map `instrument=Ticker, quantity=Units, name=Investment, costBasis=Unit Price, asOf=As Of`
     — accepted, no warning (the `rememberMapping` "No row in this file has anything under X"
     guard only fires when *every* row is blank; here one of three has a ticker).
  3. `GET /upload/37/review`
- **Evidence:** review screen text, in full:
  ```
  What this statement changes   1 ADDED · 0 UPDATED · 4 REMOVED
  401k.csv · Principal 401(k)
  Compared against what Principal 401(k) holds now.
  Added:  VBTIX  Vanguard Total Bond  240  $10.4500
  Removed: AAPL, FXAIX, SPAXX, VTI
  ```
  Nothing about `Vanguard Target Retirement 2045 Trust II` (412.5123 units, $22,325.17) or
  `Vanguard Institutional 500 Index Trust` (88.2 units, $36,367.51).
- **Notes:** The columns screen's 3-row preview does show the blank cells, so a careful reader
  *could* catch it — but the review screen is the documented safety valve and it is silent.
  The correct mapping for this file is `Investment`, which nothing on screen suggests.

---

#### [ING-5] "Record this statement" commits the draft's *current* mapping, not the one the review was rendered against — a second tab writes numbers the reader never saw

- **Severity:** High
- **Where:** `app/lib/uploads.server.ts:commitUpload` → `assembleDiff(draft, db)` re-reads
  `draft.mapping` from the database at commit time. `app/routes/upload/review.tsx`'s form
  carries only `accountId`, `confirmRemovals` and `asOf` — no fingerprint or version of the
  mapping the diff was built from.
- **What happens:** The review screen is documented as read-only and as the flow's safety
  valve, but the numbers it displays and the numbers the commit writes are two independent
  reads of a mutable row. Anything that changes `upload_draft.mapping` between the render and
  the submit — a second browser tab on the same draft, or "Back to columns" → remap →
  browser-back to the stale review — makes the commit write different figures with no warning.
  The reader sees "Added: AAPL 50, VTI 120, FXAIX 84.512, SPAXX 2,450.1" and Postgres receives
  229.35 / 282.10 / 189.24 / 1.00.
- **What should happen:** ingest brief §6: review is "The safety valve, and the flow's only
  write… Review is read-only plus the date and the tick." A commit must write what the
  reviewed diff described, or refuse because the draft moved underneath it — the instruments
  step already does exactly this with its `raw-N` hidden fields and
  *"The file's first sightings changed while this page was open."*
- **Repro (verified in a real Chromium with two tabs, and with curl):**
  1. Tab A: upload `fidelity.csv` to Empower 401(k); map
     `instrument=Symbol, quantity=Quantity, name=Description, costBasis=Average Cost Basis`;
     land on `/upload/52/review`, which shows AAPL 50 / VTI 120 / FXAIX 84.512 / SPAXX 2,450.1.
  2. Tab B: open `/upload/52/columns`, change only **Quantity** to `Last Price`, save. Tab B
     lands on review showing 229.35 / 282.10 / 189.24 / 1.
  3. Tab A (still showing the first diff): tick the confirmation, click
     **Record this statement**.
- **Evidence:**
  ```
  Tab A reviewed: AAPL 50.000, VTI 120.000, FXAIX 84.512, SPAXX 2,450.10
  Tab A committed -> /accounts/2?uploaded=137

  select i.symbol,h.quantity from holding h join instrument i on i.id=h.instrument_id
   where h.position_set_id=137;
   AAPL  | 229.35000000
   FXAIX | 189.24000000
   SPAXX |   1.00000000
   VTI   | 282.10000000
  ```
  Reproduced identically with curl on draft 36 → set 133.
- **Notes:** The receipt afterwards is honest (it is recomputed from the database), so the
  reader's only clue is that the counts differ from the ones they just read. The commit-time
  guards (product guard, account-number guard, majority-removal tick) are all evaluated
  against the *new* mapping, so they do not catch it either.

---

#### [ING-6] Double-clicking "Record this statement" records the statement but leaves the reader on the "expired or already recorded" page

- **Severity:** Medium
- **Where:** `app/routes/upload/review.tsx` — the submit button has no disabled/pending state,
  and the flow deliberately carries no client state. Server side
  `app/lib/uploads.server.ts:commitUpload` deletes the draft first inside the transaction,
  so the loser of the race gets `NotFoundError` → `data({accountId}, {status:404})`.
- **What happens:** With two clicks in flight at once, exactly one `position_set` is written
  (good — no double count), but the response the browser renders is the losing one:
  *"This upload has expired or was already recorded."* The reader never sees the receipt and
  has no way to know whether the statement landed except by following the secondary link.
- **What should happen:** ingest brief §6.5 reserves that page for *"A committed draft posted
  again — the back button pressed after success, a resubmitted tab"*, i.e. a deliberate second
  action after a visible success. An impatient double-click on the primary button should land
  on the account with its receipt.
- **Repro:** Playwright (`pw4.mjs`): open `/upload/40/review`, tick `confirmRemovals`, then
  `btn.click()` three times in a row without awaiting navigation.
- **Evidence:**
  ```
  URL after: http://localhost:5174/upload/40/review
  page:  "This upload has expired or was already recorded."
         "Start a new upload · See what the account holds now"

  select count(*) from position_set where source_filename='schwab.csv' and account_id=1;  -> 1
  select id, as_of_date from position_set where account_id=1 order by id desc limit 1;    -> 134 | 2026-08-24
  ```
- **Notes:** The concurrency itself is solid — 6 simultaneous curl POSTs against one draft
  produced exactly one set and five 404s. This is purely which response the reader is shown.

---

#### [ING-7] The documented closed-account commit refusal is unreachable; the reader gets the generic expired page instead

- **Severity:** Medium
- **Where:** `app/lib/uploads.server.ts:commitUpload` (the `draft.accountClosedAt !== null`
  branch, `ValidationError.form(...is closed...)`) is thrown correctly, but
  `app/routes/upload/review.tsx`'s **loader** then re-runs on revalidation, calls
  `diffForDraft` → `requireDraft`, which treats a closed account's draft as expired and throws
  a 404. The loader's 404 replaces the action's field error.
- **What happens:** Close an account while a draft against it is sitting at review, then
  commit: the reader gets *"This upload has expired or was already recorded. A draft is kept
  for a day and deleted once its statement lands…"* — which is not what happened (the draft is
  still in the table) — and, because the loader's 404 body is a plain string rather than
  `data({accountId})`, the "See what the account holds now" link is missing too.
- **What should happen:** ingest brief §6.5: *"**A closed account** — closed while the draft sat
  open — refuses in `setBalance`'s words: a closed account's history does not change"*, and
  §6.5 places all three commit-time refusals as a `.form-error` above the commit row.
  `uploads.server.ts` says the same: `requireDraft` reads a closed account's draft as expired
  *"while `commitUpload` owes it a sentence in `setBalance`'s words"*.
- **Repro:**
  1. `curl -X POST /upload -F accountId=5 -F file=@simple.csv` → draft 32; map it; it reaches review.
  2. `curl -X POST /settings/accounts/5 -d intent=close`
  3. `curl -X POST /upload/32/review -d accountId=5 -d asOf=2026-08-24 -d confirmRemovals=true`
- **Evidence:**
  ```
  HTTP/1.1 404
  "This upload has expired or was already recorded."
  "Start a new upload"        <- no account link

  select id,account_id from upload_draft where id=32;  -> 32 | 5   (the draft still exists)
  select closed_at from account where id=5;            -> 2026-08-24 07:04:38+00
  ```
  For contrast, the genuine already-committed re-POST (draft 33) renders the same page *with*
  the "See what the account holds now" link, exactly as §6.5 describes.
- **Notes:** The `ValidationError` message in `commitUpload` is effectively dead code as long
  as the review loader 404s a closed account's draft.

---

#### [ING-8] The instruments step will create a second instrument with a symbol that already exists, with no warning

- **Severity:** Medium
- **Where:** `app/lib/instrument-resolution.server.ts:resolveAll` — the "create" path validates
  symbol length, name, price source and classification, and refuses a **classification name**
  that collides with an existing one, but never checks `instrument.symbol`. `instrument_symbol_idx`
  is a plain btree, not unique.
- **What happens:** Choosing "This is new" and typing a symbol that is already in the list
  creates a duplicate instrument. Holdings then lists two rows both badged `AAPL`, with
  different names, prices and (for a feed instrument) two quote rows for the same ticker.
  The review screen for the same upload also shows two `AAPL`-badged rows.
- **What should happen:** the same treatment the analogous collision already gets —
  ingest brief §5.2: *"A new name colliding with an existing classification is a field-level
  refusal naming it."* A symbol collision is the more consequential of the two (it splits a
  holding's value and its price feed) and deserves at least a refusal or a warning pointing at
  the "instrument already listed" path.
- **Repro:**
  1. Upload a file whose instrument column contains a string no alias covers (e.g. `aapl`
     lowercase — alias lookup is byte-exact, so it is a first sighting).
  2. On `/upload/:id/instruments`, choose **This is new**, symbol `AAPL`, name `Apple dup`,
     price source Manual, classification Individual stock. Save.
  3. Then upload any file naming both spellings, e.g.
     `Symbol,Qty,Basis` / `aapl,3,10.0000` / `AAPL,4,20.0000`, and commit it.
- **Evidence:**
  ```
  select id,symbol,name from instrument where symbol='AAPL';
    6 | AAPL | Apple Inc.
   28 | AAPL | Apple dup

  /accounts/2 holdings table (set 138):
    AAPL  Apple Inc.                 4   $193.31   $773.23
    AAPL  Apple dup  (never priced)  3      —         —
  ```
- **Notes:** Aliases are global and `instrument_alias.raw_string` is the PK, so the *alias* side
  is safe; it is only the instrument row that duplicates. Related nit on the same screen: the
  "instrument already listed" select is a flat list of every instrument, so on a household with
  many holdings the duplicate is easy to reach by accident.

---

#### [ING-9] After committing a statement that legitimately holds no positions, the account page says "Nothing has been recorded for this account yet" — directly under a receipt saying it was recorded

- **Severity:** Medium
- **Where:** `app/routes/account.tsx:409` — `counted === 0 ? "Nothing has been recorded for
  this account yet, so there is nothing to value."`, keyed off the holdings count rather than
  `lastRecorded` (which the loader already has, as `recorded`). Same wording in the holdings
  panel's empty state.
- **What happens:** A statement that sells everything (every row's quantity is an absence
  marker — `--`, `n/a`) commits correctly with zero holdings. The account page then renders,
  in this order:
  > Recorded **allskip.csv**: 0 added · 0 updated · 4 removed, as of **2026-08-24**.
  > Principal 401(k) now holds **0 positions**.
  > … Total value: *Nothing has been recorded for this account yet, so there is nothing to value.*
  > … *The positions this account holds are listed here … Nothing has been recorded for this
  > account yet — upload a statement for it and they appear.*
  Two contradictory sentences on one screen; the performance chart below still draws the
  account's whole history.
- **What should happen:** the rule is stated in `uploads.server.ts:assembleDiff` for the diff
  and should hold here too: *"'No statement yet' through `lastRecorded`, not through an empty
  holdings read: an account sold down to nothing has a statement and gets an honest
  three-count diff."* An account sold to nothing should read as *worth nothing today*, not as
  *never recorded*.
- **Repro:**
  1. `printf 'Symbol,Qty,Basis\nAAPL,--,10.00\nVTI,n/a,10.00\n' > allskip.csv`
  2. Upload to account 4, map `Symbol`/`Qty`/`Basis`. The review correctly names both skipped
     lines and demands the removes-everything tick.
  3. Commit with `asOf=2026-08-24` → `/accounts/4?uploaded=136`.
- **Evidence:** rendered page text above; `select count(*) from position_set where
  account_id=4;` → non-zero, and `select count(*) from holding where position_set_id=136;` → 0.
- **Notes:** Straddles the account-detail area; recorded here because the ingest flow is the
  only way to reach the state and the contradiction is with the ingest receipt.

---

#### [ING-10] The account total and the holdings table's rounded row values disagree by a cent

- **Severity:** Low
- **Where:** `holding_valued.value` is `numeric(20,4)`; the account total sums the unrounded
  values and rounds once, while each row is rounded to 2 places for display.
- **What happens:** On `/accounts/4` after committing `schwab.csv`: rows read `$9,665.40` and
  `$8,162.94` (they sum to `$17,828.34`), the Total value reads `$17,828.33`.
- **What should happen:** the three views that should agree — screen total, holdings
  table, direct SQL sum — should reconcile, or the total should be the sum of the figures
  actually printed.
- **Repro:** `/accounts/4` (or `/accounts/1`) after the `schwab.csv` commit; compare the
  visible column against the visible total.
- **Evidence:**
  ```
  select instrument_id, value from holding_valued where account_id=4;
     6 | 9665.3950
     7 | 8162.9375
    19 |  (null)
  select sum(value) from holding_valued where account_id=4;   -> 17828.3325
  screen: rows $9,665.40 + $8,162.94 = $17,828.34 ;  Total value $17,828.33
  ```
- **Notes:** Pre-existing and global (the seeded data has the same 4-decimal row values), not
  caused by ingest — flagged because that invariant is the one under test. Also found in the
  holdings tester's scope.

---

#### [ING-11] `/favicon.ico` 404s, so every page load logs a console error

- **Severity:** Low
- **Where:** `public/` contains only `fonts/`; nothing serves a favicon and `root.tsx` links none.
- **What happens:** Every page in the upload flow (and everywhere else) produces
  `Failed to load resource: the server responded with a status of 404 ()` for
  `http://localhost:5174/favicon.ico` in the browser console. `/favicon.svg` and
  `/apple-touch-icon.png` 404 too.
- **What should happen:** no console errors on a clean page load.
- **Repro:** open any page in Chromium with `page.on('console')` attached.
- **Evidence:** `curl -o /dev/null -w '%{http_code}' http://localhost:5174/favicon.ico` → `404`
- **Notes:** Global, not ingest-specific. It is the only client-side console error or
  `pageerror` I saw across the whole flow.

---

#### Non-issues investigated

Things that looked suspicious and turned out to be correct, so the next person does not repeat them.

- **`headerFingerprint` looked like it joined header cells with the empty string**
  (`app/lib/column-mapping.server.ts:49`), which would collide `["ab","c"]` with `["a","bc"]`.
  It does not: the separator is a literal **U+001F unit separator**, exactly as the doc says —
  it is invisible in `Read`/`cat` output. Verified empirically: `Ticker,Units,PricePerUnit` and
  `Ticke,rUnits,PricePerUnit` produce **different** stored fingerprints and the second file
  gets no auto-applied mapping.
- **Double submit / concurrent commit of one draft does not double-count.** Six simultaneous
  `POST /upload/16/review` produced exactly one `position_set` and five 404s. The
  delete-the-draft-first-inside-the-transaction guard works. (Which response the browser shows
  is ING-6.)
- **Two statements on the same as-of date do not double-count.** Committing a second statement
  for account 3 dated 2026-08-24 replaced the first one's holdings entirely
  (`select count(*) from holding_valued where account_id=3` → 2, not 10). The
  `created_at`-then-`id` tie-break resolves it as documented.
- **The 10 MB cap is enforced twice, as documented.** A 20 MB file with `Content-Length` is
  refused by `refuseOversizedBody` ("This upload is larger than 10 MB…"); the same file sent
  chunked is refused by the `File.size` check ("This file is larger than 10 MB…"). No crash,
  no OOM, sub-second.
- **Non-CSV and malformed files are handled without a crash.** 0-byte file → "This file has no
  content."; invalid UTF-8 (`\xff`) and a real PNG → "This does not read as a text file.";
  a PDF, an HTML file named `.csv` and a file with no extension are accepted as text and then
  dead-end harmlessly at the columns step ("one column cannot also be the quantity", or
  "No row in this file has anything under X"). Header-only, no-header, ragged rows, BOM,
  CRLF, bare CR, tab-delimited, semicolon-delimited, quoted commas, embedded newlines,
  unterminated quotes and emoji/RTL cells all parse and render correctly.
- **Money never round-trips through a float.** Every committed figure was compared byte-for-byte
  against the CSV in Postgres: `1,234.56`→`1234.56000000`, `(500)`→`-500.00000000`,
  `$1,234`→`1234.00000000`, `$1,234.5678`→`1234.5678`, `99999999.12345678` intact,
  `0`→`0.00000000` (kept, not dropped), `0.0001` basis intact. `costBasisIs=total` divides
  exactly (`$8,533.00 / 50 = 170.6600`, `($265.00) / -10 = 26.5000`). The three-lot weighted
  average in `lot-level.csv` gives `110.1636`, matching `Decimal` to the last place.
  `12.5%` is stored as `12.5` unscaled — documented behaviour of `normaliseFigure`.
- **Over-precision and overflow are refused rather than rounded**, each naming its line:
  30 decimal places, 18 integer digits, a 12-decimal cost basis, `1.2e3`, `NaN`, `Infinity`,
  `12$34`, `1.234,56`. All correct.
- **Date handling is solid.** `31/02/2026` → "not a date on the calendar"; `2027-01-01`,
  `9999-12-31` and the day after tomorrow → "is in the future"; `2026-8-1` → "must be written
  as YYYY-MM-DD"; two differing dates in one file → refused naming both lines; `2026-08-01`
  and `08/01/2026` in one file correctly reconciled to one date; tomorrow allowed.
  `0001-01-01` and `1900-01-01` are accepted (no lower bound) — see ING-1's note.
- **Column-mapping form refusals all fire**: the same column mapped twice, a required column
  left unmapped, a forged column name, a hidden `headerRow` pointing past the file, a missing
  `costBasisIs`.
- **Instrument-resolution refusals all fire**: symbol > 40 chars, name > 200 chars, feed with
  no symbol, an unknown instrument id, an unknown classification id, a new-classification name
  that already exists. A 300-character raw string resolves fine as an alias.
- **Step skipping is properly blocked.** `GET` and `POST` to `/upload/:id/review` over a draft
  that still owes columns or instruments redirect to the owed step and write nothing;
  `/upload/:id` resumes correctly; `/upload/abc/...`, `/upload/-1/...`, `/upload/0/...` and
  `/upload/99999/...` all 404 to the expired page.
- **Both halves of the account-number guard work**, naming both numbers, and a review POST
  carrying a different `accountId` than the draft's is refused. The number is captured onto
  the account only when the column was empty.
- **`owedAsPositive` works**: `liability.csv`'s `"14,500.00"` becomes `−14,500`.
- **Duplicate-instrument folding works** both in the parser (two `DUP` rows → one position,
  quantity 13, weighted basis `15.3846`) and after alias resolution (`AAPL` and `" AAPL "`
  pointing at one instrument → "2 rows combined").
- **An all-rows-skipped statement is handled well**: every skipped line is named on the review
  screen and the removes-everything tick is demanded. (The account page afterwards is ING-9.)
- **Scale**: a 600-column file and a 60,000-row / 888 KB file both parse and render in under a
  second, with no error in the log.
- **`?uploaded=` cannot be forged into a false receipt**: `?uploaded=abc`,
  `?uploaded=<another account's set id>` and `?uploaded=<overflow>` all render no receipt.
- **Review counts and receipt counts agree** on a commit that becomes the account's latest
  (`3 ADDED · 0 UPDATED · 3 REMOVED` on review, `3 added · 0 updated · 3 removed` on the
  receipt), and the account total matched `sum(value)` from SQL exactly.
- **No unhandled promise rejections** appeared in `dev-a.log` across the whole session; the
  only server errors logged are ING-2 and ING-3.

---

## Settings and the other write paths


Scope: everything that writes outside the upload flow — `/settings`, `/settings/people`,
`/settings/accounts`, `/settings/accounts/:accountId`, `/settings/tax`, the balance form on
`/accounts/:accountId`, and the inline position editor on `/holdings`.

Environment: app `http://localhost:5175`, DB `portfolio_b`.
Baseline net worth on the seeded household: **$687,247.44**.

> **Ids move.** `scripts/seed-demo.ts` was re-run several times during this session, so `account.id`
> and `person.id` differ from run to run. Every repro below writes them as `<fidelityId>` etc.;
> resolve them first with
> `psql -h 127.0.0.1 -p 55432 -U portfolio -d portfolio_b -c 'select id, name, kind, owner_id from account order by id'`.
> The database was restored to the seeded baseline at the end of the session.

---

#### [SET-1] Changing an account's kind to `bank`/`liability` re-opens the Set-balance form on an account full of securities, and one submission wipes it — irrecoverably

**Fixed.** Both writers now answer from what the account's current statement holds rather than from
`kind` alone — `app/lib/current-statement.server.ts` is the one reader they share, `setBalance`
refuses and repeats the refusal inside its own write statement, and `updateAccount` refuses the kind
change itself. The entry below stands as it was written, as the record of what the defect was.

- **Severity:** Critical
- **Where:** `app/lib/accounts.server.ts:224` (`updateAccount` — kind is freely editable),
  `app/lib/balances.server.ts:60-85`/`:183` (the guard that gets bypassed),
  `app/routes/settings/account.tsx`, `app/routes/account.tsx:562`
- **What happens:**
  1. `Fidelity Individual` (brokerage, 7 securities, **$211,007.64**) has **Kind** changed to
     *Loan or other liability* (or *Bank*) on `/settings/accounts/:id`. The save is accepted with no
     warning of any kind.
  2. `/accounts/:id` now renders the **Set balance** panel, because `acceptsSetBalance` is decided
     purely from `kind`. On a liability it is captioned *"What is still owed on Fidelity
     Individual"* — printed directly beneath a holdings table that still lists AAPL, MSFT, VTI,
     VXUS, VGSH, VNQ and SPAXX.
  3. Submitting any figure writes one `manual` position set carrying a **single `USD` row**. Under
     §5.2's "a missing row means sold", all seven securities are thereby recorded as sold.
  4. Household net worth falls from **$687,247.44 to $476,238.81** (liability) /
     **$476,240.81** (bank) in one click. `/holdings` no longer contains the string `AAPL` anywhere.
  5. **It cannot be undone from the application.** Changing the kind back to `brokerage` does not
     restore anything — the manual set still wins `latest_position_set`. The Holdings inline editor
     "changes numbers, never membership" (`positions.server.ts` header), so the seven rows cannot be
     typed back. Nothing in the app deletes a position set. Only a fresh upload of the statement, or
     `psql`, recovers it.
- **What should happen:** `app/lib/balances.server.ts:24-27` states the invariant in as many words:
  > **Only `bank` and `liability`.** A position set is a photograph of everything an account holds,
  > so recording one `USD` row against a brokerage would record every security in it as sold. The
  > refusal below is what stands between a mis-clicked form and a wiped portfolio.
  A kind edit walks straight around that refusal. Either `updateAccount` must refuse (or require an
  explicit confirmation for) a change from a multi-position kind to a single-position kind while the
  account's current position set holds anything but one `USD` row, or `setBalance` must key its
  refusal off what the current set actually contains rather than off `kind` alone.
- **Repro:**
  1. `curl -s -o /dev/null -X POST localhost:5175/settings/accounts/<fidelityId> --data-urlencode 'name=Fidelity Individual' --data-urlencode 'institution=Fidelity' --data-urlencode 'kind=liability' --data-urlencode 'ownerId=<alexId>' --data-urlencode 'taxTreatment=taxable' --data-urlencode 'externalAccountNumber=X47-283910'`
     — identical to picking *Loan or other liability* in the **Kind** dropdown and pressing **Save changes**.
  2. `curl -s -o /dev/null -X POST localhost:5175/accounts/<fidelityId> --data-urlencode 'amount=1' --data-urlencode "asOf=$(date -u +%F)"`
     — identical to typing `1` into **Amount owed** and pressing **Record balance**.
  3. Load `/`.
- **Evidence:**
  ```
  before                                   after
  kpi-figure: $687,247.44                  kpi-figure: $476,238.81
  Fidelity Individual  $211,007.64         Fidelity Individual  −$1.00

  select ps.id, ps.as_of_date, ps.source, count(h.id)
    from position_set ps left join holding h on h.position_set_id = ps.id
   where ps.account_id = <fidelityId> group by 1,2,3 order by 2 desc limit 4;
   263 | 2026-08-24 | manual | 1     <- the wipe
   151 | 2026-08-20 | upload | 7
   150 | 2026-06-30 | upload | 7
   149 | 2026-03-31 | upload | 7

  # after reverting kind to brokerage
  curl -s localhost:5175/ | grep -o 'kpi-figure u-data">[^<]*'   ->  $476,238.81
  curl -s localhost:5175/holdings | grep -c AAPL                 ->  0
  ```
- **Notes:** The Set-balance panel's own helper line — "Recording a balance never overwrites an
  earlier one: each is kept on its own date" — is true of *rows* and badly misleading about
  *effect* in this state. The same door exists for `401k`/`ira` → `bank`.
- **Left open by that fix**, deliberately, and each still reproducible. Nothing else in this report
  was touched either.
  1. `revisePosition`'s cash test (`positions.server.ts:318`) is `priceSource === "fixed"`, so it
     holds `SPAXX` to two decimal places — a money-market share count is legitimately fractional.
  2. Four comments assert that `fixed` belongs to the seeded `USD` row alone
     (`instrument-resolution.server.ts:177,353`, `positions.server.ts:92`, `prices.server.ts:71`).
     `scripts/seed-demo.ts:209` files `SPAXX` as `fixed` and disproves all four. Either the seed or
     the comments are wrong, and the fix had to resolve cash on `symbol` **and** `price_source`
     together to avoid choosing between them.
  3. **The upload door is still open.** `commitUpload` never reads `kind`, so a statement can still
     be uploaded to a `bank` account. It cannot silently empty one — the majority-removal tick
     catches that — but it can commit *partial* removals with no confirmation, because the tick is
     keyed on a strict majority (`uploads.server.ts:855,1029`) and a 4-of-7 statement drops three
     positions silently.
  4. `SET-9` stands. `sameDirection` (`positions.server.ts:263`) returns true whenever either side
     is zero, so the $29,000 sign shape is still reachable through the Holdings editor in two
     deliberate edits.
  5. `bank`/`liability` → a securities kind still strands the account: the Set-balance panel
     disappears and `/accounts/:id` is then left with no write control at all.

---

#### [SET-2] A single-character typo in the balance date (`1026` for `2026`) permanently destroys the "All" net-worth chart, with no way back

- **Severity:** High
- **Where:** `app/lib/input.server.ts:241` (`recordedDate` — no lower bound),
  `app/lib/valuation.server.ts` `firstRecordedDate()`, `app/routes/overview.tsx` /
  `app/routes/account.tsx` `windowDays()`; URL `/accounts/:id`
- **What happens:** `recordedDate` guards the future extremely carefully (its docstring spends a
  paragraph on why `2126` must be refused) and applies **no floor at all** to the past.
  `asOf=1026-08-24` — one digit wrong — is accepted and stored.
  `firstRecordedDate()` is `min(as_of_date)` over `position_set`, and the **All** range is measured
  from it, so:
  - The overview's All chart x-axis becomes **Apr 1068 · Jun 1547 · Aug 2026**, and the household's
    entire three years of history is compressed into the last few pixels.
  - The change chip reads **+$687,247.44** — "you gained your whole net worth" — because the
    baseline sample lands in the 11th century where nothing existed.
  - Every *account's* All chart is affected too: `windowDays()` uses the same global day zero.
  - **It is permanent.** There is no delete anywhere; recording a correct balance appends a new
    position set and leaves the 1026 row as day zero for ever
    (`select min(as_of_date) from position_set` still returns `1026-08-24` afterwards).
- **What should happen:** the mirror image of the rule the same function already states for the
  future. `input.server.ts:225-233` argues that a mistyped year "does not merely record a wrong date
  — it pins the account to that row"; a mistyped year in the other direction pins *day zero*, which
  is worse because nothing can move it back. A floor (day zero of the instance, or simply a sane
  year) belongs beside `latestRecordableDate()`. `docs/guide/overview.md`'s "All" is documented as
  the household's history, not a millennium.
- **Repro:**
  1. Open `/accounts/<allyId>` (a bank account), type `42000` in **Balance** and `1026-08-24` in
     **As of**, press **Record balance**. (curl equivalent:
     `curl -s -o /dev/null -X POST localhost:5175/accounts/<allyId> --data-urlencode 'amount=42000' --data-urlencode 'asOf=1026-08-24'` → 302, accepted)
  2. Load `/?range=all`.
  3. Record a *correct* balance for today and reload `/?range=all` — unchanged.
- **Evidence:** screenshot
  `«session scratch»/settings/all-1026.png`
  — axis `Apr 1068 / Jun 1547 / Aug 2026`, chip `+$687,247.44`.
  `select min(as_of_date) from position_set;` → `1026-08-24`, still `1026-08-24` after a correction.
- **Notes:** `0001-01-01` and `1900-01-01` are accepted too. The date input carries `max` but no
  `min`, so the browser does not stop it either.

---

#### [SET-3] `asOf=0000-01-01` is accepted by the validator and 500s in the driver

- **Severity:** Medium
- **Where:** `app/lib/input.server.ts:241` (`recordedDate`), `app/lib/balances.server.ts:218`
  (`setBalance`), `app/routes/account.tsx:230`
- **What happens:** `recordedDate` accepts `0000-01-01` — the `\d{4}-\d{2}-\d{2}` shape matches and
  the JS `Date` round-trip check passes, because JavaScript has a year zero. Postgres does not, so
  the insert raises and the reader gets a 500 error page.
- **What should happen:** `input.server.ts:30-36` — "A refusal is an ordinary outcome of a form
  submission — **never a 500**." The round-trip check is meant to be the calendar check and does not
  catch this one case.
- **Repro:**
  `curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:5175/accounts/<allyId> --data-urlencode 'amount=1' --data-urlencode 'asOf=0000-01-01'` → `500`
- **Evidence:** `dev-b.log`
  ```
  error: date/time field value out of range: "0000-01-01"
    at setBalance (/home/user/portfolio/app/lib/balances.server.ts:218:3)
    at action (/home/user/portfolio/app/routes/account.tsx:230:21)
    code: '22008', routine: 'DateTimeParseError'
  ```
- **Notes:** `2026-02-30` is correctly refused as "not a date on the calendar"; only year zero slips
  through.

---

#### [SET-4] Closing an account leaves the overview headline and its own chart disagreeing by that account's value for the rest of the day

- **Severity:** Medium
- **Where:** `migrations/0003_holding_valued_at.sql:114-118` (`closed_at > d`) vs
  `migrations/0002_holding_valued.sql:140` (`closed_at is null`);
  `app/lib/valuation.server.ts:648` `netWorthChange`, `app/routes/overview.tsx`;
  triggered from `/settings/accounts/:id` → **Close**
- **What happens:** the headline KPI comes from `holding_valued`, which drops a closed account
  immediately. The chart's points come from `holding_valued_at(d)`, which counts an account closed
  *during* `d` for the whole of `d`. So on the day of a closure the number and the line directly
  under it are computed differently for the same date:
  - Headline: **$645,247.44**
  - Chart's final point, dated today: **$697,247.99**
  - The delta chip reads **−1.4% / −$9,388.35** with a *down* arrow while the line it sits above is
    drawn climbing steeply to the top of the plot.
- **What should happen:** `docs/guide/settings.md` — closing "records **today** as the closing date.
  The account **stops counting toward current net worth** from then on." Both readings of "now"
  should agree. DESIGN.md §8.2's whole argument is that one figure must come from one query; here
  two queries answer "net worth today" with a $52,000 gap.
- **Repro:**
  1. Note the overview figure. Record any balance on `/accounts/<allyId>` so the account has a
     current value.
  2. `/settings/accounts/<allyId>` → **Close Ally Online Savings**.
  3. Load `/?range=1m`. The headline and the plotted endpoint differ by the closed account's value.
  4. SQL cross-check:
     `select sum(value) from holding_valued;` vs `select sum(value) from holding_valued_at(current_date);`
- **Evidence:** screenshot
  `«session scratch»/settings/close-day-chart.png`.
  SQL: `holding_valued` → `645247.4448`; `holding_valued_at(current_date)` → `697247.9948`.
  Both figures are present in the same SSR payload (`697247.9948` and `645247.4448`).
- **Notes:** The `closed_at > d` choice is deliberate and argued in the migration ("it was held for
  part of that day"). The bug is that the *headline* does not use the same rule, so the screen
  contradicts itself. Self-corrects the next day.

---

#### [SET-5] `setBalance`'s form-level refusal is thrown, caught, and rendered nowhere — the submission is a silent no-op

**Fixed.** `errors.form` is rendered from the page rather than from inside `SetBalance`, so a
form-level refusal reaches the reader whether or not the panel is mounted. It was moved, not copied.

- **Severity:** Medium
- **Where:** `app/routes/account.tsx:562` (`{takesBalance ? <SetBalance …/> : null}`) vs
  `app/routes/account.tsx:662` (`errors?.form` is only rendered *inside* `SetBalance`)
- **What happens:** `balances.server.ts:183` refuses a securities account with a carefully written
  form-level message ("… holds securities, so its balance comes from a statement rather than from a
  typed figure. Recording one cash figure here would record everything else it holds as sold.").
  `account.tsx`'s action catches it and returns `{errors}` — but the only element that renders
  `errors.form` lives inside `SetBalance`, which is not rendered when `takesBalance` is false. The
  reader gets HTTP 200, the ordinary account page, and **no message anywhere**. Nothing is written,
  so the submission silently does nothing.
- **What should happen:** every refusal reaches the reader
  (`docs/guide/when-something-is-refused.md`; `input.server.ts:30-36`).
- **Repro (a real two-tab sequence, no curl needed):**
  1. Open `/accounts/<allyId>` (a bank) in tab A; leave the **Set balance** form on screen.
  2. In tab B change that account's **Kind** to *Brokerage* and save.
  3. Submit tab A's form → 200, page re-renders with neither a confirmation nor a refusal;
     `select count(*) from position_set where account_id=<allyId> and source='manual'` is unchanged.
  One-liner: `curl -s -X POST localhost:5175/accounts/<brokerageId> --data-urlencode 'amount=500' --data-urlencode "asOf=$(date -u +%F)"` → 200.
- **Evidence:** the 200 response body contains zero rendered `field-error`/`form-error` elements and
  does not contain the string `holds securities`; `select count(*) … source='manual'` = 0.
- **Notes:** The closed-account branch of the same refusal is unreachable for a different reason —
  `/accounts/:id`'s loader 404s a closed account because `accountTotal` returns null for one.

---

#### [SET-6] A NUL byte in any text field is a 500 with a driver stack trace instead of a refusal

- **Severity:** Medium
- **Where:** `app/lib/input.server.ts:69` (`requiredText`) and `:83` (`optionalText`); reached from
  `/settings/people`, `/settings/accounts`, `/settings/accounts/:id`
- **What happens:** Zod only trims and length-checks, so `U+0000` passes. Postgres then rejects the
  bind parameter and the action throws; the browser gets the generic 500 page and the log a full
  Kysely/pg stack.
- **What should happen:** `input.server.ts:30-36` — "A refusal is an ordinary outcome of a form
  submission — never a 500." A control character no `text` column can hold is bad input and belongs
  on the form as a message.
- **Repro:** (`$'…\x00…'` is bash's escape for a literal NUL)
  ```
  curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:5175/settings/people \
    --data-urlencode 'intent=create' --data-urlencode $'name=a\x00b'                     # 500
  curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:5175/settings/accounts \
    --data-urlencode $'name=a\x00b' --data-urlencode 'kind=bank' \
    --data-urlencode 'taxTreatment=taxable' --data-urlencode 'ownerId=<alexId>'          # 500
  ```
  Also reproduces via `institution` and `externalAccountNumber`.
- **Evidence:** `dev-b.log`
  ```
  error: invalid byte sequence for encoding "UTF8": 0x00
    at createPerson (/home/user/portfolio/app/lib/people.server.ts:92:15)
    at action (/home/user/portfolio/app/routes/settings/people.tsx:31:9)
    code: '22021', routine: 'report_invalid_encoding_int'
  ```
- **Notes:** Reachable from a browser — a NUL survives a paste into a text input in Chromium.

---

#### [SET-7] `personId` is never checked for id shape — any non-numeric or oversized value 500s

- **Severity:** Medium
- **Where:** `app/lib/people.server.ts:107` (`renamePerson`) and `:142` (`removePerson`);
  `POST /settings/people`
- **What happens:** both take `id: string` straight into `.where("id", "=", id)`. Postgres raises
  `invalid input syntax for type bigint` (or `value out of range`) and the request 500s with a
  stack trace. Confirmed 500 for `personId` = `abc`, `1e10`, `1;drop`, `%`, `null`, `'1'`, `1.5`,
  `9223372036854775808`. Well-formed but absent ids (`999999`, `-1`, `0`) correctly 404, so it is
  only the shape check that is missing.
- **What should happen:** the sibling module already does exactly this and explains why —
  `app/lib/accounts.server.ts:172`: `if (!/^\d+$/.test(id)) throw new NotFoundError(…)`, with the
  argument written out at `accounts.server.ts:87-92`: *"anything that is not digits would reach
  Postgres as a malformed bigint and fail as a 500 rather than as a message on the form."*
  `people.server.ts` has no such guard.
- **Repro:**
  ```
  curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:5175/settings/people \
    --data-urlencode 'intent=remove' --data-urlencode 'personId=abc'                     # 500
  curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:5175/settings/people \
    --data-urlencode 'intent=rename' --data-urlencode 'name=x' --data-urlencode 'personId=1e10'  # 500
  ```
- **Evidence:** `dev-b.log` — `invalid input syntax for type bigint: "abc"`,
  `routine: 'pg_strtoint64_safe'`.
- **Notes:** SQL injection is **not** possible — the value is parameterised and dies at the bigint
  cast, and `'; drop table account; --` typed as a *name* round-trips into the column byte-for-byte.
  `personId` values `' 1 '`, `'+1'` and `'01'` all resolve to person 1; harmless, but it confirms
  nothing normalises the id.

---

#### [SET-8] An id that is all digits but larger than `bigint` 500s on account create, edit and view

- **Severity:** Low
- **Where:** `app/lib/accounts.server.ts:87-92` (`accountInput.ownerId` regex), `:172`
  (`getAccount`'s guard), `:282` (`requireOwner`)
- **What happens:** `/^\d+$/` admits `9223372036854775808` (bigint max + 1), so the guard passes and
  Postgres raises `value "9223372036854775808" is out of range for type bigint`. 500s on:
  - `POST /settings/accounts` with `ownerId=9223372036854775808`
  - `GET`/`POST /settings/accounts/9223372036854775808`
  - `GET /accounts/9223372036854775808`
- **What should happen:** the same "never a 500" rule. The digits check needs a length or range
  bound — `app/lib/holdings-view.ts:740` already gets this right and says why: *"Eighteen digits,
  not 'any run of digits'. … a nineteen-digit number can be larger than one holds — which Postgres
  answers with `value out of range`, reaching the reader as a 500 rather than as a closed editor."*
  The same reasoning simply was not applied in `accounts.server.ts`.
- **Repro:**
  ```
  curl -s -o /dev/null -w '%{http_code}\n' localhost:5175/settings/accounts/9223372036854775808   # 500
  curl -s -o /dev/null -w '%{http_code}\n' localhost:5175/accounts/9223372036854775808            # 500
  curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:5175/settings/accounts \
    --data-urlencode 'name=x' --data-urlencode 'kind=bank' --data-urlencode 'taxTreatment=taxable' \
    --data-urlencode 'ownerId=9223372036854775808'                                                # 500
  ```
  (`ownerId` = `0`, `999999`, `abc`, `-1`, `1e10` all correctly produce a form message; the Holdings
  editor's `?edit=9223372036854775808.1` correctly redirects to a closed editor.)
- **Notes:** Only reachable by editing the `<select>` option value, or by URL.

---

#### [SET-9] The Holdings editor will store a negative balance on a bank account, which the Set-balance form refuses outright

- **Severity:** Low
- **Where:** `app/lib/positions.server.ts:306-339` (`revisePosition`'s narrowing + `sameDirection`)
  vs `app/lib/input.server.ts:181` (`moneyMagnitude`) and `app/lib/balances.server.ts:214-216`
- **What happens:** the two doors onto a cash account's `USD` quantity disagree about the sign.
  `setBalance` refuses a minus outright ("… whether it counts for or against you follows from the
  kind of account it is") and derives the sign from `isOwed(kind)`. The Holdings editor accepts a
  minus, and the documented "record zero first" step is enough to flip a bank row negative:
  edit → `0` → save, edit → `-9000` → save. The account then reads **−$9,000.00**, is still
  `kind = 'bank'`, is still counted as an asset by the "Value by account type" ring, and its own
  page still captions the box **Balance** rather than **Amount owed**.
- **What should happen:** `positions.server.ts:306-322` states the rule it is breaking — "this
  editor is a second door onto the figure `setBalance` writes. **The two doors have to refuse the
  same things**" — and then narrows only the decimal-places rule, not the sign rule.
- **Repro:**
  ```
  curl -s -o /dev/null -X POST 'localhost:5175/holdings?edit=<allyId>.1' --data-urlencode 'quantity=0'     --data-urlencode 'costBasisPerShare='
  curl -s -o /dev/null -X POST 'localhost:5175/holdings?edit=<allyId>.1' --data-urlencode 'quantity=-9000' --data-urlencode 'costBasisPerShare='
  ```
  (instrument id 1 is the seeded `USD` row). Both succeed; `/accounts/<allyId>` then reads
  −$9,000.00 under **Kind: Bank**. The mirror case (a liability driven positive) works the same way.
- **Evidence:** `select h.quantity from position_set ps join holding h on h.position_set_id=ps.id where ps.id=latest_position_set(<allyId>)` → `-9000.00000000`;
  overview row `Ally Online Savings −$9,000.00`.
- **Notes:** `docs/guide/holdings.md` documents the zero-then-flip escape hatch for securities, so
  the mechanism is intended; what is unintended is that it also defeats `moneyMagnitude`'s no-sign
  rule on a cash row.

---

#### [SET-10] The Settings → Accounts table prints raw enum slugs where every other screen prints labels

- **Severity:** Low
- **Where:** `app/routes/settings/accounts.tsx:87` (`<td>{account.kind}</td>`) and `:89`
  (`{account.taxTreatment.replace("_", "-")}`); `app/lib/account-options.ts:226` (`labelOf`, unused
  here)
- **What happens:** the table's **Kind** column reads `bank`, `liability`, `401k`, `brokerage`,
  `ira`, and **Tax treatment** reads `taxable`, `tax-deferred`, `tax-free` — the machine values from
  the check constraint. The dropdown eight inches below on the same page offers *Bank*,
  *Loan or other liability*, *Workplace plan (401k, 403b)*, *Brokerage*, *IRA*, and the account
  detail page renders the label via `labelOf`. A reader who chose "Loan or other liability" sees
  "liability" in the list.
- **What should happen:** `account-options.ts:219-231` provides `labelOf` precisely for this — "The
  label a stored value wears on screen" — and `docs/guide/people-and-accounts.md` names the five
  kinds by their labels.
- **Repro:** open `/settings/accounts`.
- **Evidence:** screenshot
  `«session scratch»/settings/settings-accounts.png`
- **Notes:** Cosmetic, but it is the one table in the app that leaks storage values.

---

#### [SET-11] The account-number field's own help text says the opposite of the guide and of the code

- **Severity:** Low
- **Where:** `app/components/account-fields.tsx:158-161`; also the type comment at
  `app/lib/accounts.server.ts:56`
- **What happens:** the note under **Account number** reads *"Optional, and only ever used to
  **pre-select this account** when a statement carrying the same number is uploaded."* It never
  pre-selects anything. `app/lib/uploads.server.ts:1079-1086` uses it as a commit-time guard plus a
  one-time capture into an empty column.
- **What should happen:** `docs/guide/settings.md` states it correctly and in bold: *"It is optional,
  and it is a **check, not a chooser**: it never picks an account for you, but if you upload a
  statement that names a different account number than the one recorded here, the upload is refused
  rather than landing in the wrong place."* `docs/guide/people-and-accounts.md` agrees. The form's
  own note is the only place that claims otherwise, and it is the note a person actually reads while
  filling the box in.
- **Repro:** open `/settings/accounts` and read the note under **Account number**.
- **Notes:** `accounts.server.ts:56` carries the same wrong claim in a doc comment.

---

#### [SET-12] Two tabs editing one account: the second save silently reverts the first, including a tax treatment

- **Severity:** Low
- **Where:** `app/lib/accounts.server.ts:224` (`updateAccount` writes all six columns from the form)
- **What happens:** whole-form last-write-wins with no version check and no notice. Tab A (opened
  when `tax_treatment = taxable`) renames the account; tab B, opened at the same moment, changes only
  the tax treatment and saves second. The rename is gone and both tabs were told "Saved."
- **What should happen:** at minimum the app should notice — `docs/guide/settings.md` warns that
  "Correcting a tax treatment here changes every figure computed from this account, everywhere", so
  a *silent* revert of one is worth more than nothing. (Contrast `revisePosition`, which explicitly
  detects the same race and refuses: `positions.server.ts:409-418`.)
- **Repro:**
  ```
  # tab A: rename only
  curl -s -o /dev/null -X POST localhost:5175/settings/accounts/<id> --data-urlencode 'name=Fidelity Individual RENAMED' \
    --data-urlencode 'institution=Fidelity' --data-urlencode 'kind=brokerage' --data-urlencode 'ownerId=<alexId>' \
    --data-urlencode 'taxTreatment=taxable' --data-urlencode 'externalAccountNumber=X47-283910'
  # tab B: tax treatment only, carrying the stale name
  curl -s -o /dev/null -X POST localhost:5175/settings/accounts/<id> --data-urlencode 'name=Fidelity Individual' \
    --data-urlencode 'institution=Fidelity' --data-urlencode 'kind=brokerage' --data-urlencode 'ownerId=<alexId>' \
    --data-urlencode 'taxTreatment=tax_free' --data-urlencode 'externalAccountNumber=X47-283910'
  ```
- **Evidence:** `select name, tax_treatment from account where id=<id>` → `Fidelity Individual | tax_free`
  — tab A's rename lost, no warning on either submission.

---

#### [SET-13] A name consisting only of zero-width characters is accepted, producing an invisible person

- **Severity:** Low
- **Where:** `app/lib/input.server.ts:69` (`requiredText` — `.trim()` does not remove `U+200B`)
- **What happens:** `name=<U+200B>` (zero-width space) passes "A name is required." and is stored.
  `/settings/people` then shows a row with an empty-looking name box, an empty **Remove** aria-label,
  and the person is selectable as an account owner under a blank label. `U+00A0` alone *is* caught
  (JS `trim` strips it); `U+200B` and `U+200D` are not.
- **What should happen:** "A name and nothing else … This is a label for whose money it is"
  (`people.server.ts:38-45`) — a label nobody can read is not one.
- **Repro:** `curl -s -o /dev/null -X POST localhost:5175/settings/people --data-urlencode 'intent=create' --data-urlencode $'name=​'`
  then open `/settings/people`.
- **Evidence:** `select id, name from person order by id desc limit 1` → `4 | ​`.
- **Notes:** Emoji, RTL/bidi overrides, combining marks, ZWJ sequences, tabs and newlines are all
  accepted and round-trip intact; those are reasonable for a free-text name. Only the
  entirely-invisible case is a problem.

---

#### [SET-14] A rejected 1MB field is echoed back to the browser twice, in a 2.2MB response

- **Severity:** Low
- **Where:** `app/routes/settings/people.tsx:58-64` and `app/routes/settings/accounts.tsx:34`
  (`values` returned verbatim on refusal), `app/components/account-fields.tsx` (`defaultValue`)
- **What happens:** the refusal contract deliberately returns what was typed so the boxes keep it.
  There is no cap, so a 1MB paste into **Name** — refused with "A name must be 120 characters or
  fewer." — comes back as a 2,233,899-byte HTML document: once in the `value=""` attribute and once
  in the React Router hydration payload.
- **What should happen:** the bound that already exists on the field (120/200/64 characters) could
  bound the echo too; nothing is gained by re-serving a megabyte the validator has just rejected.
- **Repro:**
  ```
  python3 -c "open('/tmp/big.txt','w').write('A'*1048576)"
  curl -s -o /dev/null -w '%{http_code} size=%{size_download}\n' -X POST localhost:5175/settings/people \
    --data-urlencode 'intent=create' --data-urlencode name@/tmp/big.txt
  ```
- **Evidence:** `200 size=2234153`, response time 0.08s, error text
  `A name must be 120 characters or fewer.`
- **Notes:** Not a crash and not slow at 1MB; recorded because there is no upper bound at all on the
  request body for these actions.

---

#### [SET-15] `23,8` in the tax-rate box is refused as "cannot be more than 100%", and `1,5` is silently stored as 15%

- **Severity:** Low
- **Where:** `app/lib/input.server.ts:143` (`bareDecimal` strips `,` unconditionally), used by
  `percentRate` at `:396`
- **What happens:** `bareDecimal` exists to accept `$14,500.00` the way a statement prints it, and
  it is reused verbatim for the tax rate. A comma written as a *decimal* separator therefore becomes
  a thousands separator: `23,8` → `238` → refused with the confusing message "A capital gains rate
  cannot be more than 100%", and `1,5` → `15` → **accepted and stored as 15%** with no indication
  that it was reinterpreted.
- **What should happen:** a rate is a small number with no thousands to separate, so the comma
  generosity buys nothing there and costs a silently wrong figure. Every other rate input is exact
  by construction (`percentRate`'s docstring: "No `Number`. The output is the digits").
- **Repro:**
  ```
  curl -s -o /dev/null -X POST localhost:5175/settings/tax --data-urlencode 'capitalGainsRate=1,5'
  psql … -c 'select capital_gains_rate from app_setting'   -> 15.000000
  ```
- **Evidence:** probe matrix (`taxprobe.sh`) — `[23,8] err=A capital gains rate cannot be more than 100%.`;
  `[1,5] stored=15.000000 err=`.

---

#### Non-issues investigated

These looked wrong and are not; recorded so the next person does not re-walk them.

- **XSS / HTML injection — fully escaped.** `<script>alert(1)</script>`,
  `"><img src=x onerror=alert(1)>` and `javascript:alert(1)` were stored as person names, account
  names and institutions and then loaded in Chromium on `/settings/people`, `/settings/accounts`,
  `/`, `/holdings` and `/analysis` with `page.on('dialog')` and `page.on('pageerror')` attached.
  **Zero dialogs, zero page errors, zero live DOM.** Payloads appear as `&lt;script&gt;…` in
  attributes and as `<script>` inside the hydration payload. There are no URL-ish fields
  in this area, so `javascript:` has no sink.
- **SQL injection — parameterisation holds and strings round-trip intact.** `'; drop table account; --`,
  `%'` and `\` stored in a name come back byte-for-byte; injected into an *id* field they die at the
  bigint cast (see SET-7). No table was harmed.
- **Tax rate validation is solid.** `-5`, `101`, `1e2`, `abc`, blank, whitespace, `NaN`, `Infinity`,
  `0.1+0.2`, `0x10`, `1e-2`, `+`/full-width/Arabic-Indic digits are all refused with a sensible
  message; `0`, `100`, `0.5`, `50%`, `23.8 `, `0000000023.8` and 6-decimal rates are accepted; a 7th
  decimal is refused. Analysis renders correctly at both extremes (`0%` → every Potential tax
  `$0.00`; `100%` → tax equals the taxable-account gain exactly). **No stored rate breaks Analysis.**
- **No delete affordance anywhere, as designed.** There is no route, action or button that deletes
  an account or a position set; `position_set.account_id` is `on delete restrict`. Removing a person
  who owns accounts is refused with a sentence naming each account and marking closed ones —
  matching `docs/guide/people-and-accounts.md` exactly. Closing twice keeps the original date. A
  closed account's settings page stays reachable and editable (which is how you reassign its owner to
  make a person removable).
- **Balance corrections append, never overwrite.** Three balances recorded for the same date produce
  three `position_set` rows; `latest_position_set` picks the last by `created_at`/`id`, exactly as
  `balances.server.ts:160-171` and the on-screen note describe. **There is no UI that shows that
  history** — but `/settings` names *History* as one of the three tabs "later slices build", so that
  is a documented gap rather than a bug.
- **Closed account 404s at `/accounts/:id`.** Deliberate — `account.tsx:137-144` argues that
  rendering it would produce "a header whose every figure is empty and no explanation of why". The
  settings page for it still resolves, as `docs/guide/settings.md` promises.
- **No reopen control.** `docs/guide/settings.md` admits it: "Closing is one-way in this version.
  Some refusal messages suggest reopening an account from Settings; there is no control that does
  it."
- **Escape does not close the Holdings editor.** There is a **Cancel** link and
  `docs/guide/holdings.md` documents Cancel, not Escape. Navigating away and coming back shows the
  stored figure, not the abandoned draft — no stale state.
- **CSRF.** No tokens anywhere, but `app/lib/auth.server.ts:57` sets `sameSite: "lax"` on the
  session cookie, which blocks cross-site form POSTs. (This instance also runs with no password at
  all, which the app itself banners on every page.)
- **Owner and tax-treatment edits propagate correctly.** Moving Fidelity Individual from Alex to
  Jordan moved exactly $211,007.64 between the "Net worth by person" rows and left the total at
  $687,247.44; switching it to `tax_free` turned every Potential tax cell to "—" while Unrealized
  stayed at +$111,291.70. Both match `docs/guide/settings.md`.
- **Holdings inline-edit validation is thorough.** Quantity `0` is stored as zero (row kept, still
  editable); a cost basis far above the price is accepted (it is a loss, not an error); clearing a
  cost basis stores `NULL` rather than `0`; 9 decimal places, `1e3`, `.` and 13 integer digits are
  refused; a bank/loan `USD` row is held to 2 decimal places with `moneyMagnitude`'s wording; a
  direct sign flip is refused with the documented "record it as zero first" message.
- **`?edit=` row keys are bounded.** `holdings-view.ts:745` caps each half at 18 digits, so an
  oversized id closes the editor rather than 500ing — the guard `accounts.server.ts` is missing
  (SET-8).

---

## Dashboards — the read screens and the numbers on them


Instance: http://localhost:5176 · DB `portfolio_c` · scratch
`«session scratch»/dash`

Scope covered: `/`, `/holdings`, `/analysis`, `/income`, `/accounts/:accountId`; every figure on
them cross-checked against `psql` on `portfolio_c`; URL-parameter abuse; 1440x1000 and 390x900
rendering; console/`pageerror` capture; JS-disabled run; accessibility basics.

---

#### [DASH-1] `/accounts/<19+ digit id>` returns 500 with the raw Postgres error on the page

- **Severity:** High
- **Where:** `app/lib/valuation.server.ts:359-363` (`isAccount`), reached from
  `app/routes/account.tsx:143`. URL: `http://localhost:5176/accounts/9223372036854775808`
- **What happens:** `isAccount()` gates the id with `/^\d+$/` only. Any all-digit string passes and
  is bound to a `bigint` column, so a value above 2^63−1 makes Postgres raise `22003 value out of
  range for type bigint`. The loader does not catch it, the request 500s, and the root
  `ErrorBoundary` (`app/root.tsx:223-227`) prints `error.message` — i.e. the database's own error
  text — as the page subtitle. The server log gets a full `pg`/kysely stack trace per hit.
- **What should happen:** a clean 404, the same answer `/accounts/99999999` already gives.
  `app/lib/holdings-view.ts:726-745` (`parseRowKey`) documents this exact trap and guards against
  it — *"Eighteen digits, not 'any run of digits'. Both halves reach a `bigint` column, and a
  nineteen-digit number can be larger than one holds — which Postgres answers with `value out of
  range`, reaching the reader as a 500 rather than as a closed editor."* `isAccount` is the same
  situation with the guard missing. `account.tsx:139-141` also states the intent: *"`accountTotal`
  answers null for an id that names no account, for one that is not an id at all … and all three
  are a 404 rather than a page of blanks."*
- **Repro:**
  1. `curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:5176/accounts/9223372036854775808"` → `500`
  2. Same for a 85-digit id, and for `/accounts/0000000000000000000000000000000000000009223372036854775808` (leading zeros do not help).
  3. Contrast: `/accounts/99999999` → `404`, `/accounts/abc` → `404`, `/accounts/-1` → `404`.
- **Evidence:**
  - Page body text: `Something went wrong` / `value "9223372036854775808" is out of range for type bigint`
  - `«session scratch»/logs/dev-c.log`:
    ```
    error: value "9223372036854775808" is out of range for type bigint
        at PostgresConnection.executeQuery (…/kysely/dist/dialect/postgres/postgres-driver.js:126:41)
        at accountTotal (/home/user/portfolio/app/lib/valuation.server.ts:453:15)
        at loader (/home/user/portfolio/app/routes/account.tsx:143:17)
      code: '22003', routine: 'pg_strtoint64_safe'
    ```
- **Notes:** the leaked message text is dev-mode behaviour; the 500 itself is not mode-dependent.
  Reachable by anyone who can reach the instance (which, per the app's own banner, is anyone on the
  network when `AUTH_PASSWORD` is unset). Same class of input reaches `settings/accounts/:id`, which
  is outside the dashboards area — see `SEC-2` and `SET-8`, which are the same missing bound.

---

#### [DASH-2] The printed money columns do not add up to the printed total (one cent out, on every read screen)

- **Severity:** High
- **Where:** `app/lib/format.ts:88` (`formatMoney` rounds at render time) as consumed by
  `app/routes/holdings.tsx` (`Figures`), `app/routes/analysis.tsx` (`Breakdown`, `Donut`),
  `app/routes/overview.tsx` (`AccountsPanel` vs the KPI), `app/routes/account.tsx` (holdings table
  vs `Total value`). URLs: `/holdings`, `/analysis`, `/`, `/accounts/1`, `/accounts/4`
- **What happens:** every figure is stored at `numeric(20,4)` and rounded to 2dp only when it is
  printed. Each cell is individually correct, but adding the cells a reader can see gives a
  different answer from the total printed beneath them. Measured, on the seeded demo household:

  | Screen | Sum of the printed parts | Printed whole | Δ |
  |---|---|---|---|
  | `/holdings` Value column (17 cells) vs Total row | `687,247.43` | `$687,247.44` | −0.01 |
  | `/holdings` Cost basis column (11 cells) vs Total row | `266,936.16` | `$266,936.17` | −0.01 |
  | `/holdings?group=account` six subtotals vs Total row | `687,247.45` | `$687,247.44` | +0.01 |
  | `/analysis` "Net worth by person" rows vs ring centre | `687,247.45` | `$687,247.44` | +0.01 |
  | `/analysis` "Value by account type" rows vs ring centre | `687,247.45` | `$687,247.44` | +0.01 |
  | `/analysis` "Value by asset class" rows vs ring centre | `687,247.45` | `$687,247.44` | +0.01 |
  | `/` accounts list (6 rows) vs net-worth headline | `687,247.45` | `$687,247.44` | +0.01 |
  | `/accounts/1` 7 Value cells vs "Total value" | `211,007.63` | `$211,007.64` | −0.01 |
  | `/accounts/4` 2 Value cells vs "Total value" | `87,438.92` | `$87,438.93` | −0.01 |

  (`/holdings` Unrealized reconciles here only by luck.)
- **What should happen:** the codebase states the rule itself, in `app/lib/allocation.ts:435-449`
  (`taxOn`): *"**Rounded to the cent here, not at the point it is printed.** … Carrying them would
  make the column fail to add up in the ordinary case rather than the rare one: two rows at
  `5391.2284` and `11459.9761` print as $5,391.23 and $11,459.98 over a total of $16,851.20, and a
  reader adding the two figures in front of them gets a different answer than the one underneath.
  Rounding where the figure is made keeps the printed column exact."* The gains column follows that
  rule; the value / cost-basis / subtotal columns do not. `docs/guide/README.md` also sells the app
  on being reconcilable against a statement, and `README.md`/`format.ts` on "this app does not round
  the numbers a person is trying to reconcile".
- **Repro:**
  1. `curl -s http://localhost:5176/holdings`, add the 17 `$…` cells in the Value column: `687,247.43`.
  2. Read the Total row on the same page: `$687,247.44`.
  3. Script used: `«session scratch»/dash/` — reproduced programmatically, output below.
- **Evidence:**
  ```
  rows counted: 17 11 11
  SUM of printed Value cells   : 687247.43   Printed Total Value      : $687,247.44 17 of 18
  SUM of printed Cost basis    : 266936.16   Printed Total Cost basis : $266,936.17 11 of 18
  SUM of printed Unrealized    : 111291.70   Printed Total Unrealized : +$111,291.70 11 of 18
  ```
  SQL confirming the cause (exact values are correct; only the display rounds late):
  ```
  portfolio_c=> select sum(round(value,2)) sum_of_rounded, round(sum(value),2) rounded_sum, sum(value) exact from holding_valued;
   sum_of_rounded | rounded_sum |    exact
  ----------------+-------------+-------------
        687247.43 |   687247.44 | 687247.4448
  ```
  Per-slice on `/analysis`: equity `509998.9884`, bond `119886.1767`, cash `43500.0000`,
  other `13862.2797` → printed `509,998.99 + 119,886.18 + 43,500.00 + 13,862.28 = 687,247.45`
  against a ring centre of `$687,247.44`.
- **Notes:** no arithmetic is wrong — `sumMoney`/`render` and the SQL `sum()` are exact. This is
  purely "round at render" versus "round where the figure is made". Screenshots
  `shots/desktop-holdings.png`, `shots/desktop-analysis.png`, `shots/desktop-overview.png`.

---

#### [DASH-3] Overview lists an account with nothing recorded as `$0.00`; its own page refuses to

- **Severity:** Medium
- **Where:** `app/routes/overview.tsx:309` (`{formatMoney(account.amount)}` with no coverage check)
  vs `app/routes/account.tsx:300-305, :404-411` (`const valued = known > 0`). URL: `/` and `/accounts/:id`
- **What happens:** `accountTotals()` coalesces an account with no rows in `holding_valued` to
  `0.0000` over a coverage of zero holdings. The Overview's accounts list prints that as
  **`$0.00`**. Opening the same account shows no figure at all and the sentence *"Nothing has been
  recorded for this account yet, so there is nothing to value."* Two screens, one account, one is
  making a claim the other explicitly withholds.
- **What should happen:** the figure should be withheld on the Overview row too, or the row marked
  as uncovered. `account.tsx:305-309` states the rule: *"§8.4's rule, applied to one account: a zero
  and an absence must not look alike … A `$0.00` on a finance page is a claim, and this is not the
  page to make it on."* `docs/specs/foundation/07-empty-states-and-first-run.md`: *"an empty chart
  must never read as a zero balance in a finance app"* / *"rather than a zero figure"*.
  `docs/guide/README.md`: *"A number is withheld rather than guessed … A dash never means zero."*
  `app/components/empty-state.tsx`: *"an empty dashboard in a finance app must never render a
  figure."*
- **Repro:**
  1. Settings → Accounts → add an account (any kind) to a household that already has data.
  2. Open `/` — the new account is listed with `$0.00` and counted in "N active".
  3. Click through to `/accounts/<new id>` — no figure; "Nothing has been recorded for this account
     yet, so there is nothing to value."
- **Evidence:** performed on `portfolio_c` (accounts 7 and 8, since closed again so the seeded
  figures still reproduce):
  ```
  /          …  QA Chart Probe · QA Bank · Bank        $0.00   Alex Rivera
  /accounts/7 … Total value
                Nothing has been recorded for this account yet, so there is nothing to value.
  ```
- **Notes:** the same `$0.00` appears for an account whose every holding is unpriced —
  `accountTotal` returns `0.0000` there too, and `account.tsx` withholds it while the Overview row
  does not. The Overview's whole-instance empty state (`holdingCount === 0`) is correct and
  unaffected; this is the per-row case only.

---

#### [DASH-4] Account-detail holdings table scrolls sideways on a phone: Value is off-screen, Price is clipped mid-figure

- **Severity:** Medium
- **Where:** `app/routes/account.tsx:512-556` (plain `.data-table`, no `data-label` cells) plus
  `app/app.css:2147-2290` (the card reflow is scoped to `.data-table--holdings` only).
  URL: `/accounts/1` at 390x900
- **What happens:** at a 390px viewport the table's content is 503px inside a 356px scroll box.
  Only Asset, Quantity and a truncated Price are visible; the **Value** column — the reason the
  table exists — is entirely off-screen, and Price renders as `$193.`, `$1.`, `$326.`, `$102.`,
  which reads as a wrong number rather than as a clipped one. The Holdings screen's table gets the
  card reflow at the same breakpoint; this one does not.
- **What should happen:** DESIGN.md §8.1: *"thirteen columns on a phone is a horizontal scroll
  nobody uses. Mobile gets a card list…"*, and `app/app.css:2143-2146` restates it. `docs/guide/overview.md`
  ("On a phone"): *"Nothing is withheld on a small screen."* `docs/guide/account-detail.md` documents
  the four columns with no mention of scrolling to reach them.
- **Repro:**
  1. Chromium at 390x900, open `http://localhost:5176/accounts/1`.
  2. Scroll to the Holdings panel. Value is not on screen; Price is cut mid-figure.
  3. Measured: `.data-table-scroll` `clientWidth 356`, `scrollWidth 503`; column offsets
     `Asset 0–184, Quantity 184–301, Price 301–391, Value 391–503`.
- **Evidence:** `shots/mobile-account-table.png` (390px). Also 360px → 177px overflow, 320px → 217px.
  Same page at 1440x1000 is fine (`shots/desktop-*`).
- **Notes:** smaller instance of the same thing — `/analysis`'s "Value by account type" table
  overflows its scroll box by 12px at 390px (and by 42px at 360px), so the "% of total" column is
  partly hidden. `/holdings` reflows to cards correctly at both widths and does not overflow.

---

#### [DASH-5] A stray hairline runs under the first cell only of every total and subtotal row

- **Severity:** Low
- **Where:** `app/app.css:1022-1025` (`.data-table th` carries `border-bottom`) vs `app/app.css:1916-1922`;
  `.data-table .row-total th/td` / `.row-subtotal th/td` only override `border-top`.
  URLs: `/analysis` (Unrealized gains `tfoot`), `/holdings`, `/holdings?group=account`
- **What happens:** the label cell of a total/subtotal row is a `<th scope="row">`, so it keeps the
  column-heading bottom border while the `<td>`s beside it have none. The result is a 1px rule that
  starts at the left edge of the table and stops about 45% across, underneath the grand total.
- **What should happen:** either the full width or nothing; a rule that ends mid-row reads as a
  rendering fault.
- **Repro:**
  1. Open `/analysis` at 1440x1000, look at the bottom edge of the "Unrealized gains" table.
  2. Computed styles on the `tfoot` row: `TH border-bottom: 1px solid rgb(195,197,217)`,
     both `TD`s `0px none`.
- **Evidence:** `shots/gains-table.png` (cropped). Same on `/holdings` `tfoot` and on every
  `.row-subtotal` under `?group=…`.
- **Notes:** cosmetic only; no figure is affected.

---

#### [DASH-6] "Value is all 1 holdings" — the coverage sentence is not pluralised

- **Severity:** Low
- **Where:** `app/routes/holdings.tsx:1042` (`Value is all ${value.total} holdings.`), and the
  "the rest have/has" branch beside it. URL: `/holdings?account=6`, `/holdings?tax=tax_free&assetClass=bond`
- **What happens:** filtering to a single holding produces `Value is all 1 holdings.` and
  `Unrealized is 0 of 1 — the rest have no cost basis recorded`. The panel header on the same
  screen gets this right (`1 holding · 1 account`), and the partial branch two lines up already
  computes `missing === 1 ? "has" : "have"`, so the omission is inconsistent within one function.
- **What should happen:** "Value is the 1 holding." / singular agreement, matching the care taken
  in `panel-count` and in `plural()` on `/analysis` (*"without an '(s)' anywhere on a finance page"*).
- **Repro:** `curl -s "http://localhost:5176/holdings?account=6"` → coverage note reads
  `Value is all 1 holdings. Unrealized is 0 of 1 — the rest have no cost basis recorded…`
- **Evidence:** as above.

---

#### [DASH-7] `/favicon.ico` 404s: a console error on every page load and a server stack trace per request

- **Severity:** Low
- **Where:** no favicon route and nothing under `public/` but `fonts/`; `app/root.tsx` links none.
- **What happens:** every browser page load requests `/favicon.ico`, React Router has no match, the
  browser logs `Failed to load resource: the server responded with a status of 404`, and the dev
  server writes a full `Error: No route matches URL "/favicon.ico"` stack trace to the log.
- **What should happen:** either ship an icon or answer the request without a stack trace. Real
  client-side errors are hard to spot in a console that always has one.
- **Repro:**
  1. `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5176/favicon.ico` → `404`
  2. Load any page in Chromium with `page.on('console')` attached — one `error` message every time.
  3. `grep -c 'No route matches URL "/favicon.ico"' «session scratch»/logs/dev-c.log` → one per page load.
- **Evidence:** `«session scratch»/dash/shots-report.json` (`desktop/overview … CONSOLE:1`), log lines 210+.
- **Notes:** this was the **only** console message and the only `pageerror` across all 22
  page/viewport combinations tested — no hydration mismatch, no React key warning, no uncaught error.

---

#### [DASH-8] Leading-zero account ids resolve, giving unlimited duplicate URLs for one account

- **Severity:** Low
- **Where:** `app/lib/valuation.server.ts:359-363` (`isAccount` accepts `\d+`); no canonicalisation
  in `app/routes/account.tsx`. URL: `/accounts/01`, `/accounts/000000000000000000000000001`
- **What happens:** both serve account 1 with a `200` and `<title>Fidelity Individual · Portfolio</title>`.
- **What should happen:** `app/lib/holdings-view.ts:736-739` decided the opposite for the sibling case
  and says why: *"And no leading zeros, so that the one spelling of a row is the spelling `rowKey`
  produces. `0001.0002` names the same pair as `1.2` …"*. A 404 or a redirect to `/accounts/1` would
  match that.
- **Repro:** `curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5176/accounts/01` → `200`.
- **Notes:** harmless on its own; it is the same missing-`isAccount`-guard as DASH-1.

---

#### [DASH-9] Selecting the default range navigates to `/?index` rather than `/`

- **Severity:** Low
- **Where:** `app/routes/overview.tsx:425` — `to={key === DEFAULT_RANGE ? "." : \`?range=${key}\`}`
- **What happens:** from `/?range=3m`, clicking **1Y** lands on `http://localhost:5176/?index`.
  `?index` is React Router's internal marker for an index route's loader/action; putting it in the
  address bar is a URL a person may then bookmark or send.
- **What should happen:** `/` — `docs/guide/overview.md`: *"The choice lives in the address bar as
  `?range=3m`. So it survives a reload, you can bookmark it, and you can send the address to the
  other person in the household."* The default should spell as the bare path. (`to="/"` or
  `to={{ pathname: "/", search: "" }}`.)
- **Repro:**
  1. Open `/`, click **3M**, then click **1Y**.
  2. Address bar reads `/?index`. The page is correct (1Y active, `+41.8% / +$202,643.95`).
- **Evidence:** Playwright run in `«session scratch»/dash/nav.mjs`:
  `after All … /?range=all` → `after 1Y … http://localhost:5176/?index`
- **Notes:** functionally harmless — `/?index`, `/?index&range=3m` and `/?index=1` all render
  correctly. The account page's copy of the same control is unaffected (it is not an index route).

---

#### [DASH-10] `/analysis` heads its share column "% of total" beside a "Total" it is not a share of

- **Severity:** Low
- **Where:** `app/routes/analysis.tsx:250-256` (column heading) and `:176-181` (`Donut` centre).
  URL: `/analysis`
- **What happens:** in "Value by account type" the ring's centre reads `Total $687,247.44` and the
  column beside it is headed **% of total**, but the percentages are of *gross assets*
  (`$701,747.44` — the positive rows only). `50.3%` of the total in the centre is `$345,685`, not
  the `$352,958.50` printed on the row. Every account-type share is therefore inconsistent with the
  header by about 2%.
- **What should happen:** the header should name its own denominator (e.g. "% of assets") on a
  breakdown that contains a liability. The panel's own note already concedes the problem —
  *"its percentage is of gross assets rather than of the total in the centre"* — but a note under
  the table does not undo a column heading. `app/lib/allocation.ts:36-61` sets out why the
  denominator is right; only the label is wrong.
- **Repro:** `/analysis`, "Value by account type": `$352,958.50 / 50.3%` against a centre of
  `$687,247.44`.
- **Evidence:** `shots/desktop-analysis.png`. Denominator confirmed in SQL:
  `sum of positive account-kind slices = 701747.4448`; `352958.4978 / 701747.4448 = 0.502971`.
- **Notes:** the "Net worth by person" and "Value by asset class" panels have no negative slice, so
  their header is accurate; only the panel containing the loan is mislabelled.

---

#### [DASH-11] Grouped by asset class, the subtotal shares shown sum to 99.9% under a note promising 100%

- **Severity:** Low
- **Where:** `app/routes/holdings.tsx:1054-1057` (the note) vs `app/lib/allocation.ts:126-186`
  (`allocateShares`, exact at 6dp) and `formatShare` rounding to 1dp. URL: `/holdings?group=assetClass`
- **What happens:** the shares are exact to six places and do sum to `1.000000`, but they are
  displayed at one decimal place, and the printed column reads `74.2% + 17.4% + 6.3% + 2.0% = 99.9%`
  directly under the sentence *"the shares above sum to 100%"*.
- **What should happen:** either the claim is softened, or the displayed percentages are apportioned
  at the precision they are shown at — the same largest-remainder correction `allocateShares` already
  performs, applied at the rendered scale.
- **Repro:** `curl -s "http://localhost:5176/holdings?group=assetClass"` — subtotal shares
  `74.2 / 17.4 / 6.3 / 2.0`, note: *"…so the shares above sum to 100% and a liability's is negative."*
  Same on `/analysis` "Value by asset class" (`74.2 + 17.4 + 6.3 + 2.0`).
  (Other groupings do reach 100.0 at 1dp: owner 100.0, tax 100.0, account/institution/kind 100.0
  over the positive rows, classification 100.0.)
- **Notes:** related to DASH-2 — both are "exact underneath, rounded at the point of display".

---

#### [DASH-12] The "shares sum to 100%" note is printed on a grouped table whose every share is a dash

- **Severity:** Low
- **Where:** `app/routes/holdings.tsx:1054-1057` — the note is added whenever `grouped`, with no
  check that any share exists. URL: `/holdings?account=6&group=account`,
  `/holdings?classification=Target+date+fund&group=account`
- **What happens:** filter to the loan alone (or to the unpriced trust alone) and group. Every
  subtotal's share renders `—`, because `groupHoldings` correctly returns `share: null` when nothing
  is positive. The note underneath still reads *"Each group's share is of gross assets — the positive
  groups added together — so the shares above sum to 100% and a liability's is negative."*
- **What should happen:** the surrounding code is careful about exactly this — `overview.tsx`
  (`AllocationPanel`) filters its notes to the ones that apply: *"Said only where it is true …
  Naming a cause the instance does not have is how a note stops being read."* The same test belongs
  here.
- **Repro:** `curl -s "http://localhost:5176/holdings?account=6&group=account"` — subtotal row shows
  `Chase Auto Loan subtotal —  −$14,500.00`, note as quoted.
- **Notes:** cosmetic; the dash itself is the correct rendering.

---

#### [DASH-13] The Income empty state gives a reason that is no longer true

- **Severity:** Low
- **Where:** `app/routes/income.tsx:3-13` and `:28-31`. URL: `/income`
- **What happens:** the page says *"Nothing records income yet — the pricing slice is what starts
  collecting it"*, and the module header says *"`quote` carries a yield and an annual dividend per
  share, but no slice has filled them"*. On this instance they **are** filled: 15 of 16 `quote` rows
  carry both `yield_pct` and `annual_dividend_per_share`.
- **What should happen:** `README.md:251` states the current position: *"Prices refresh on their own
  (below), so Income has the yield figures it needs; what it still lacks is the screen."* The screen
  is telling the reader to wait for something that has already happened.
- **Repro:**
  1. `/income` → "Nothing records income yet — the pricing slice is what starts collecting it."
  2. ```
     portfolio_c=> select count(*) total, count(yield_pct) with_yield, count(annual_dividend_per_share) with_div from quote;
      total | with_yield | with_div
     -------+------------+----------
         16 |         15 |       15
     ```
- **Notes:** Income being a placeholder is documented and expected (`docs/guide/first-run.md`,
  `docs/guide/README.md`, DESIGN.md §8.1). Only the stated *reason* is stale.

---

#### Non-issues investigated

Recorded so the next person does not re-walk them.

- **`?range=All` shows `+$687,247.44` with no percentage, while the chart clearly starts at ~$177K.**
  Intended. `netWorthChange` measures against `holding_valued_at(since)`, which is `0.0000` before
  day zero, and the hand-typed `manual_networth` prefix deliberately plays no part in the delta.
  `docs/guide/overview.md` documents it with its own worked example (*"the All range in the next
  picture reads `+$690,850.55` with no percentage"*).
- **`?range=1M` / `99Y` / `-1M` / `__proto__` / `toString` / 5,000-char values / `?range=` / repeated
  `?range=1m&range=all`.** All render 200 with the default 1Y (or the first value, for repeats) and
  the correct chip highlighted. `Object.hasOwn` is used deliberately instead of `in`
  (`overview.tsx:154-159`). No 500 anywhere. Range keys are lowercase by design; uppercase falling
  back to the default is honest because the active chip moves with it.
- **Range survives reload and browser back/forward.** Verified with Playwright:
  `3M → reload → 3M`, `1M → back → 3M → forward → 1M`, all with the matching delta figure.
- **Money sorts numerically, not lexically.** `?sort=price&dir=asc` gives `$1.00, $1.00, $1.00,
  $9.66, $10.52, $48.72 …` — `compareDecimal` on `BigInt` units. Nulls stay at the bottom in both
  directions (`sortHoldings` settles absence before direction). Ties break on instrument → account →
  instrument id, so the order is stable between renders.
- **Filter/sort/group URL abuse on `/holdings`.** `sort=bogus`, `dir=ASC`, `group=bogus`,
  `owner=999999`, `account=abc`, `assetClass=<script>…`, `kind=__proto__`, repeated params, 8,000-char
  values, `edit=0001.0002`, `edit=99999999999999999999.1` — every one either renders or 302s to the
  canonical URL. HTML is escaped (`&lt;script&gt;…`). A filter key nothing carries renders
  "Not in this portfolio" plus a sentence naming it, as `docs/guide/holdings.md` describes.
- **"No single filter can leave you with an empty table."** Checked all 39 options across all seven
  dropdowns: every one returns ≥1 holding. The two-filter empty case produces the documented
  sentence.
- **Route params.** `/accounts/0`, `-1`, `abc`, `99999999`, `1e5`, `1%20`, `1.5`, `+1`, `null`,
  `NaN`, `0x1`, `%2e%2e%2f%2e%2e`, `1'--` → clean 404 with no SQL text. (The 19-digit case is DASH-1.)
- **`?uploaded=` / `?recorded=` / `?saved=` fuzzing.** `abc`, `999999`, 20-digit, `1'--`, empty — no
  500, no receipt sentence produced from a bad value. `?saved=1.2` does render "Recorded. …" for a
  write that never happened, but the sentence is read back out of the database and is therefore true
  of what the account holds; `holdings.tsx:125-133` argues for exactly this.
- **JavaScript disabled.** Every read screen renders server-side; the range control, the filter GET
  form, the group-by chips and the column-sort links all navigate correctly with scripting off.
- **Client-side health.** `console` and `pageerror` captured on 11 URLs × {1440x1000, 390x900}. The
  only message anywhere was the favicon 404 (DASH-7). No hydration mismatch, no React key warning.
- **Contrast.** Every text node on `/`, `/holdings`, `/analysis`, `/accounts/4` measured against its
  resolved background in both `prefers-color-scheme: light` and `dark`: no node below WCAG AA for
  its size. Chart colours resolve from custom properties, so the dark theme is coherent
  (`shots/dark-overview.png`).
- **Accessibility basics.** Both `nav`s are `aria-label="Primary"` and only one is ever displayed;
  the range and group-by strips are labelled navs with `aria-current`; every table has `th` with
  `scope`; sortable headers carry `aria-sort`; the donut SVG is `aria-hidden` with the table as its
  accessible equivalent; no duplicate ids; no unlabelled input; no link without an accessible name;
  heading order is h1 → h2 throughout; tab order follows visual order. Gain/loss is carried by sign
  + arrow + hue, never hue alone (§12). The row-edit pencil is `opacity: 0` but revealed on `:focus`
  (not `:focus-visible`), so it is reachable and visible by keyboard.
- **Fixed bottom nav on mobile.** `.app-canvas { padding-bottom: 88px }` clears it. Scrolled every
  page to the bottom at 390x900 and measured: no element overlaps the bar. (Full-page screenshots
  *look* like it overlaps — that is a screenshot artefact of `position: fixed`, not a bug.)
- **Chart edge cases.** 25-point (all ranges), 1-point and 0-point charts all behave: 0 points →
  "There is no data yet" empty state and no axis; 1 point → "A line needs two dated points and this
  range holds 1"; a perfectly flat two-point line centres at y=150 with all three axis ticks equal
  and produces no `NaN`/`Infinity` in the SVG (verified on a throwaway account, since closed). Axis
  labels verified against the drawn domain: for 1Y, min `484,603.4951` / max `687,247.4448` with 8%
  padding gives floor `468,391.98` → `468.4K`, mid `585,925.47` → `585.9K`, top `703,458.96` →
  `703.5K`, exactly as rendered.
- **Cross-screen agreement of every figure.** Net worth `$687,247.44` and coverage `17 of 18` are
  identical on `/`, `/holdings`, `/analysis`; each account's total is identical on `/` and on
  `/accounts/:id`; the liability's sign is negative on all four screens and its share negative on
  both that show one. All verified against `psql`:
  `687247.4448 (17/18)`, cost basis `266936.1717 (11)`, unrealized `111291.7008 (11)`;
  by person `557808.5193 / 129438.9255`; by asset class `509998.9884 / 119886.1767 / 43500.0000 /
  13862.2797`; gains by asset type `stocks 22424.2560`, `funds 88867.4448` (taxable `48615.5415`),
  tax at 23.8% → `5336.97` / `11570.50` / total `16907.47`. Every printed figure matches digit for
  digit (the only discrepancy is the column-vs-total rounding of DASH-2).
- **No float contamination.** Scanned the rendered text of all read screens for `.30000000000004`-style
  artefacts and long zero/nine runs: none. The only floats are bar widths, donut arc lengths and SVG
  coordinates, each licensed by `toPlotValue`.
- **HTTP methods.** `POST /`, `/analysis`, `/income` → 405; `POST /holdings` without `?edit=` → 400
  with the documented message; `HEAD` on every read route → 200. `.data` single-fetch URLs behave
  (`/accounts/99999999.data` → 404).
- **`docs/guide/*` claims spot-checked and correct:** the accounts list is largest-first with the
  liability last; a closed account disappears from today's figures; the coverage sentence appears
  only when something is missing; "filtered from 18" appears only when filtered; grouping by
  Owner/Account drops that column; the three coverage counts are genuinely three.

---

## Security, the login gate, and first run


Instance: `http://localhost:5177` (react-router **dev**), DB `portfolio_d`,
`AUTH_PASSWORD='correct horse battery staple'`, `SESSION_SECRET='test-signing-key-abc123'`.
A production build (`npm run build` + `react-router-serve`) was also run on **5188** for the
error-disclosure and dev-only checks; it has been stopped again. 5177 is back on its assigned
configuration and the DB is left at the "almost empty" boundary that was under test
(1 person `Ada`, 1 account `Joint Brokerage`).

Scratch dir: `.../«session scratch»/sec` (scripts, screenshots under `sec/shots/`, `sec/prod-5188.log`).

---

#### [SEC-1] Open redirect: a tab in `next=` escapes `safeRedirectTarget` and sends a freshly-logged-in browser off-origin

- **Severity:** High
- **Where:** `app/lib/auth.server.ts:153-158` (`safeRedirectTarget`), used by
  `app/routes/login.tsx:23` (loader) and `app/routes/login.tsx:40-44` → `auth.server.ts:261`
  (action). URL: `http://localhost:5177/login?next=/%09/evil.example.com`
- **What happens:** `safeRedirectTarget` rejects `//x`, `/\x`, `https://x` and anything not
  starting with `/`, but does nothing about the characters browsers strip from a URL before
  parsing it (TAB `%09`, LF, CR). `/%09/evil.example.com` starts with a single `/`, so it is
  returned unchanged, `redirect()` emits `Location: /<TAB>/evil.example.com`, and Chromium
  strips the tab, leaving `//evil.example.com` — a protocol-relative URL — and navigates to
  `http://evil.example.com/`.

  It works on both halves of the login flow:
  - the loader, for an already-authenticated visitor (`GET /login?next=…`), and
  - the action, because the loader writes the tainted value into
    `<input type="hidden" name="next">` (`login.tsx:64`), so a visitor who lands on the
    crafted login URL, types the correct password and submits is redirected off-origin
    *after* a successful login. That is the shape that makes an open redirect worth
    phishing with.
- **What should happen:** `auth.server.ts:145-152` states the intent explicitly — "anything
  that could leave the origin (`//evil.example`, `https://…`, a backslash Windows treats as a
  slash) becomes the home page instead." A tab-smuggled protocol-relative URL leaves the
  origin, so it should have become `/`.
- **Repro:**
  1. `curl -s -o /dev/null -D - -X POST http://localhost:5177/login \
       --data-urlencode 'password=correct horse battery staple' \
       --data-binary $'&next=%2F%09%2Fevil.example.com' \
       -H 'Content-Type: application/x-www-form-urlencoded' | grep -i ^location | cat -A`
  2. Or the full browser flow: `node sec/phish.mjs` — a fresh context with **no** cookie opens
     `/login?next=/%09/evil.example.com`, fills in the correct password, submits.
- **Evidence:**
  ```
  # curl, POST /login
  location: /^I/evil.example.com^M$          # ^I is a literal TAB

  # Chromium (sec/phish.mjs), starting unauthenticated:
  on login page, hidden next = "/\t/evil.example.com"
  final url: chrome-error://chromewebdata/
  navigations:
     GET http://localhost:5177/login?next=/%09/evil.example.com
     GET http://evil.example.com/            <-- left the origin after a successful login
     GET http://evil.example.com/
  ```
  (`ERR_NAME_NOT_RESOLVED` on `evil.example.com` is the proof that the browser treated it as a
  *host*, not a path.) The blocked variants all behave correctly for comparison:
  ```
  next=https://evil.example.com   -> location: /
  next=//evil.example.com         -> location: /
  next=/\evil.example.com         -> location: /
  next=javascript:alert(1)        -> location: /
  next=%2f%2fevil.example.com     -> location: /
  next=/%5c%5cevil.example.com    -> location: /
  ```
- **Notes:** No cookie or token is in the URL, so the impact is phishing assistance — a link
  that is genuinely on the household's own instance, shows the real login page, accepts the
  real password, and then lands on an attacker page. Rated High rather than Critical because
  nothing is read or written; rated above Medium because a documented, deliberately written
  security control is bypassed. `LF`/`CR` variants are covered separately in SEC-3.

---

#### [SEC-2] Any account id past `bigint` range 500s instead of 404ing

- **Severity:** Medium
- **Where:** `app/lib/accounts.server.ts:172` (`if (!/^\d+$/.test(id)) throw new NotFoundError(...)`),
  reached from `app/routes/account.tsx:143,172-177` and `app/routes/settings/account.tsx:24`.
  URLs: `/accounts/9223372036854775808`, `/settings/accounts/99999999999999999999`
- **What happens:** the id guard is a digits-only regex with no range check, so a longer digit
  string passes it, reaches Postgres as a `bigint` comparison and raises
  `value "…" is out of range for type bigint`. The result is an unhandled 500 error page.
  `9223372036854775807` (int8 max) correctly 404s; `9223372036854775808` 500s.
- **What should happen:** the same 404 that every other unparsable id gets. `/accounts/abc`,
  `/accounts/-1`, `/accounts/1.5`, `/accounts/0` all 404 correctly. ARCHITECTURE.md §7.6 cites
  this guard as the thing that makes the raw `accountId` interpolation safe
  ("the `accountId` there is bound behind a `/^\d+$/` guard") — it is safe from injection, but
  it is not a validity check.
- **Repro:**
  1. `curl -s -o /dev/null -w '%{http_code}\n' -b sec/cj.txt http://localhost:5177/accounts/9223372036854775808` → `500`
  2. `curl -s -o /dev/null -w '%{http_code}\n' -b sec/cj.txt http://localhost:5177/settings/accounts/99999999999999999999` → `500`
  3. `curl -s -o /dev/null -w '%{http_code}\n' -b sec/cj.txt http://localhost:5177/accounts/9223372036854775807` → `404`
- **Evidence:** dev error page subtitle:
  `value &quot;999999999999999999999999999&quot; is out of range for type bigint`.
  Reproduced identically against the **production** build on 5188 (500, message masked to
  "Unexpected Server Error").
- **Notes:** Under the default deployment (`AUTH_PASSWORD` unset) this URL is reachable
  unauthenticated, and ARCHITECTURE.md §7.6's error-disclosure row applies to whatever the
  boundary prints; in a production build React Router masks the message, so the leak is
  dev-only but the 500 is not.

---

#### [SEC-3] A `next=` containing `%0A` or `%0D` throws an unhandled 500 out of `redirect()`

- **Severity:** Medium
- **Where:** `app/lib/auth.server.ts:153-158` (`safeRedirectTarget`) → `app/routes/login.tsx:24`
  and `auth.server.ts:261`. URL: `/login?next=/%0a//evil.example.com`
- **What happens:** `safeRedirectTarget` passes any value starting with a single `/` through
  untouched, including one containing a bare LF or CR. `redirect()` then calls
  `Headers.set("Location", …)`, undici rejects the control character, and the thrown
  `TypeError` escapes to the root error boundary as a 500.
- **What should happen:** the same treatment as every other unusable `next` — fall back to `/`.
  `auth.server.ts:145-152` describes `next` as "attacker-supplied by construction"; a value it
  will not use should be discarded, not handed to the header writer.
- **Repro:**
  1. Hold a valid session cookie (or be logged in in the browser).
  2. `curl -s -o /dev/null -w '%{http_code}\n' -b sec/cj.txt 'http://localhost:5177/login?next=/%0a//evil.example.com'` → `500`
  3. `… 'http://localhost:5177/login?next=/%0d%0aX-Injected:%201'` → `500`
  4. Same two URLs against the production build on 5188 → `500`.
- **Evidence:** `«session scratch»/logs/dev-d.log`:
  ```
  TypeError: Headers.set: "/
  //evil.example.com" is an invalid header value.
      at _Headers.set (node:internal/deps/undici/undici:9145:31)
      at redirect (…/react-router/dist/development/chunk-62JRHF6Z.mjs:996:11)
      at loader (/home/user/portfolio/app/routes/login.tsx:24:50)
  ```
- **Notes:** Header **injection** is prevented — undici refuses the write, so no split response
  is emitted. What is left is a self-inflicted 500 reachable by anyone who can get a
  logged-in household member to click a link. Same root cause as SEC-1 (`safeRedirectTarget`
  only inspects the first two characters); fixing both means rejecting control characters and
  re-serialising, not just adding a third prefix test.

---

#### [SEC-4] Root middleware and root loader never run for unmatched paths — 404s are ungated and carry no open-instance banner

- **Severity:** Low
- **Where:** `app/root.tsx:43-48` (gate middleware), `app/root.tsx:139-152,190` (banner in
  `Layout`), `app/lib/auth.server.ts:8-14`. URL: any non-existent path, e.g. `/nonexistent`
- **What happens:** React Router resolves the route match before the root route's middleware
  chain runs, so a URL that matches no route never reaches the gate. Two consequences:
  1. **Gated instance:** `GET /nonexistent` returns a `404` page containing the whole
     application shell (nav rail, brand, links to every screen) to a caller with no session,
     instead of the `302 /login` every real route returns. No household data is in it.
  2. **Open instance (`AUTH_PASSWORD` unset):** the same 404 page is the *only* page in the
     application that does **not** carry the "This instance has no password" banner, because
     the root loader did not run and `rootData?.authConfigured` is `undefined` rather than
     `false`.
- **What should happen:** three places state the opposite.
  - `app/lib/auth.server.ts:10-13`: "it sees every request to every route in the tree, and
    refuses anything that is not on the short open list … A route added in a later slice is
    protected the moment it is routable".
  - `ARCHITECTURE.md` §7.6, Enforcement point: "**Deny-by-default for every routed path**:
    everything not on `auth.server.ts:40`'s open list … is refused, **including routes that do
    not exist yet**".
  - `docs/operating.md` §"What an attacker on your LAN can reach": "Everything else is refused,
    including routes that do not exist yet".
  - `app/root.tsx:141-143`: the banner "is placed here rather than on a page so that every
    route — **including ones that do not exist yet** — carries it."
- **Repro:**
  1. Gated: `curl -s -o /dev/null -w '%{http_code} %{size_download}\n' http://localhost:5177/nonexistent`
     → `404 10131` (compare `/holdings` → `302 0`). Same on the production build (`404 10546`).
  2. Ungated: restart 5177 with no `AUTH_PASSWORD`, then
     `curl -s http://localhost:5177/nonexistent | grep -c "This instance has no password"` → `0`,
     while every real page (including the `404` at `/accounts/1`, which *does* match a route)
     → `1`.
- **Evidence:**
  ```
  # gate off, banner presence per URL
  /                   200 BANNER
  /holdings           200 BANNER
  /settings/tax       200 BANNER
  /accounts/1         404 BANNER     <-- route matched, root loader ran
  /nonexistent        404 NO-BANNER  <-- no route matched
  /healthz            200 NO-BANNER  (correct — resource route, no shell)
  ```
- **Notes:** `tests/root-gate.test.ts` cannot catch this: it invokes `middleware` directly with
  a synthetic match, so it proves the rule and not the wiring. The gate itself is otherwise
  airtight — see the Non-issues section for the full route enumeration.

---

#### [SEC-5] Two router endpoints answer unauthenticated beyond the documented open list

- **Severity:** Low
- **Where:** `app/lib/auth.server.ts:40` (`OPEN_PATHS`), `app/lib/auth.server.ts:128-143`
  (`normalizePath`), `app/root.tsx:60-78` (root loader).
  URLs: `/healthz.data`, `/__manifest?paths=…`
- **What happens:**
  1. `normalizePath` strips the `.data` suffix before testing the open list, so `/healthz.data`
     is exempt. React Router then runs the **root** loader alongside the healthz loader, and
     the single-fetch payload returns `authConfigured` and `firstRun` to a caller with no
     session. `/healthz` itself returns neither.
  2. `/__manifest` (React Router's lazy route-discovery endpoint) answers 200 with the full
     route table — ids, parents, which routes have loaders/actions/error boundaries.
- **What should happen:** `docs/operating.md`: "**With it set**, exactly two paths answer
  without a session: the login page and `/healthz`", qualified only for "Static assets — the
  JavaScript bundles, the CSS, the font". `/__manifest` is a live router endpoint, not a static
  asset, and `/healthz.data` returns strictly more than `/healthz` does.
- **Repro:**
  1. With the DB empty and no cookie: `curl -s http://localhost:5177/healthz.data`
  2. `curl -s 'http://localhost:5188/__manifest?paths=%2F%2C%2Fsettings%2Fpeople&version=392b450f'`
     (production build, no cookie) → `200`
- **Evidence:**
  ```
  # /healthz.data, empty DB, no session
  [{"_1":2,"_3":4},"root",{"_5":15},"routes/healthz",{"_5":6},"data",
   {"_7":8,…},"status","ok","database",true,"migrations","current","pendingMigrations",[],
   {"_16":10,"_17":18},"authConfigured","firstRun","people"]
                                                    ^^^^^^^^ setup state
  ```
- **Notes:** No household data in either. What `authConfigured` gives an unauthenticated
  scanner is the answer to "is this instance open?", which is the one reconnaissance question
  worth asking of this app; `firstRun` says whether it has been set up. Cheapest fix is to make
  the open list a function of the *matched route* rather than the normalised pathname, or to
  keep the root loader off the open paths. Low because the same two facts are inferable from
  the login page existing at all.

---

#### [SEC-6] No `<title>` on any error page

- **Severity:** Low
- **Where:** `app/root.tsx:217-239` (`ErrorBoundary`) — `root.tsx` exports no `meta`, so
  `<Meta />` renders nothing when the boundary replaces the route's own component.
  URLs: `/nonexistent`, `/accounts/1` (no such account), `/settings/accounts/1`, any 500
- **What happens:** the served HTML contains no `<title>` element at all. The browser tab shows
  the raw URL. Every non-error page has one (`Overview · Portfolio`, `People · Settings ·
  Portfolio`, …).
- **What should happen:** a title on every page; the boundary already computes exactly the
  right string for one (`root.tsx:220-222` builds `"404 Not Found"` / `"Something went wrong"`).
- **Repro:**
  `for u in /nonexistent /accounts/1 /settings/accounts/1; do curl -s -b sec/cj.txt "http://localhost:5177$u" | grep -c '<title>'; done` → `0 0 0`
- **Evidence:** Playwright `page.title()` returns `""` for `/accounts/1` and
  `/settings/accounts/1` while every other screen returns its full title
  (see `sec/shots/empty_accounts_1.png`).
- **Notes:** Cosmetic; noted because the same boundary is the one an operator will be looking at
  when something is wrong, and a tab full of URLs is the worst time for it.

---

#### [SEC-7] Non-upload actions read an unbounded request body

- **Severity:** Low
- **Where:** `MAX_UPLOAD_MB` is consulted only in `app/lib/uploads.server.ts:122,164`
  (`Content-Length` before the body, `File.size` after). Every other action goes straight to
  `await request.formData()` — e.g. `app/routes/settings/tax.tsx:29`,
  `app/routes/settings/people.tsx:25`, `app/routes/settings/accounts.tsx:28`.
- **What happens:** a 100 MB `application/x-www-form-urlencoded` body POSTed to
  `/settings/tax` is fully buffered and answered `200` after 42 s. A 50 MB body to
  `/settings/people` likewise. Nothing is written (validation rejects the value), but the
  memory was spent.
- **What should happen:** `.env.example` describes `MAX_UPLOAD_MB` as bounding "what an accident
  can put in memory", and ARCHITECTURE.md §7.6's "Upload bounds — guarded twice" is the only
  body-size control in the table. There is no equivalent for the form actions, and the
  container is the same process that serves every page.
- **Repro:**
  1. `python3 -c "import sys; sys.stdout.write('capitalGainsRate='+'1'*100000000)" > big.txt`
  2. `time curl -s -o /dev/null -w '%{http_code}\n' -b sec/cj.txt -X POST \
       http://localhost:5188/settings/tax --data-binary @big.txt \
       -H 'Content-Type: application/x-www-form-urlencoded'`
- **Evidence:** `200` after `real 0m41.8s`; `sec/prod-5188.log`:
  `POST /settings/tax 200 - - 41645.995 ms`.
- **Notes:** Requires a session on a gated instance — but the **default** deployment has
  `AUTH_PASSWORD` unset, and then any device on the LAN can do this to any action. It is
  denial-of-service only, and `docs/operating.md` is already blunt that an open instance is
  fully exposed; recorded because the app does bound one route and could bound the rest with
  the same number.

---

#### [SEC-8] `SESSION_SECRET` is accepted at any length ≥ 1

- **Severity:** Low
- **Where:** `server/config.ts:56` — `SESSION_SECRET: z.string().min(1).optional()`
- **What happens:** `SESSION_SECRET=x` validates clean ("Configuration OK.") and the instance
  signs its session cookies with a one-character key.
- **What should happen:** every other bounded setting in the same schema is range-checked and
  says so by name (`PORT` 1–65535, `PRICE_POLL_INTERVAL_MINUTES` 1–1440, `MAX_UPLOAD_MB` ≥ 1),
  and `.env.example` tells the operator to use `openssl rand -hex 32`. A minimum length —
  32 characters would match the documented recommendation — is the same kind of check and the
  only one whose absence is a security question rather than an operational one.
- **Repro:**
  `env -i PATH=$PATH DATABASE_URL='postgres://a:b@c:5432/d' AUTH_PASSWORD=p SESSION_SECRET=x node ./server/validate-config.ts`
  → `Configuration OK.` (exit 0)
- **Evidence:** as above. Contrast:
  `MAX_UPLOAD_MB=0` → `MAX_UPLOAD_MB must be at least 1 megabyte` (exit 1).
- **Notes:** With a guessable secret the cookie is forgeable outright, which is the one failure
  in this design that hands over the whole instance. Everything else about the cookie is sound
  (see Non-issues).

---

#### [SEC-9] Settings → Accounts prints raw enum values where every other screen prints labels

- **Severity:** Low
- **Where:** `app/routes/settings/accounts.tsx:86` (`{account.kind}`) and `:88`
  (`{account.taxTreatment.replace("_", "-")}`). URL: `/settings/accounts`
- **What happens:** the accounts table shows `brokerage` and `taxable` — and would show
  `tax-deferred` / `tax-free`, which is neither the stored value (`tax_deferred`) nor a label.
  The `<select>` **on the same page** offers "Brokerage" and "Taxable — tax due on gains", and
  `/accounts/1` shows "Brokerage" / "Taxable".
- **What should happen:** `labelOf(ACCOUNT_KINDS, …)` / `labelOf(TAX_TREATMENTS, …)` from
  `app/lib/account-options.ts`, which is what `app/routes/overview.tsx:299`,
  `app/routes/account.tsx:375,379`, `app/lib/holdings-view.ts:182,193` and
  `app/lib/allocation.ts:251` all use.
- **Repro:**
  1. Log in, go to `/settings/accounts` with at least one account recorded.
  2. Compare the Kind / Tax treatment cells with the same account on `/accounts/1`.
- **Evidence:**
  ```
  /settings/accounts  row: Joint Brokerage | Vanguard | brokerage | Ada | taxable | Open
  /accounts/1         dl : Kind: Brokerage   Tax treatment: Taxable
  ```
  Screenshots `sec/shots/p1a1_settings_accounts.png`, `sec/shots/p1a1_accounts_1.png`.
- **Notes:** Cross-cutting with whoever owns the Settings screens. Found while walking the
  one-person / one-account boundary; it is invisible on an empty database.

---

#### [SEC-10] There is no way to sign out

- **Severity:** Low
- **Where:** `app/routes.ts` (no logout route), `app/root.tsx` (no affordance),
  `app/lib/auth.server.ts:78-104` (`AuthGate` has `logIn`, no `logOut`)
- **What happens:** nothing in the application ends a session. `grep -rni "logout|sign out"` over
  `app/` returns only an unrelated comment in `input.server.ts`. The cookie is `Max-Age=2592000`
  (30 days) with no server-side expiry, so a session on a borrowed or shared device stays valid
  for a month and the only way to end it is for the operator to change `AUTH_PASSWORD` or
  `SESSION_SECRET`, which signs out the entire household.
- **What should happen:** DESIGN.md §10 "Authentication is not multi-user" rules out user
  tables and per-person permissions but does not mention sign-out either way.
  `docs/operating.md` §"Revocation, and the two silent settings" acknowledges the *consequence*
  ("no way to sign out one lost phone without signing out the household") without saying that
  there is no sign-out button at all. A single `POST /logout` that clears the cookie needs no
  session store and would not change the revocation story.
- **Repro:** log in, then look for any control that ends the session — there is none on any of
  the 11 screens walked; and no route in `app/routes.ts` accepts one.
- **Evidence:** route table enumerated in full below; `grep -rn "logout" app/` → one unrelated
  hit at `app/lib/input.server.ts:287`.
- **Notes:** Recorded as a gap for a maintainer to accept or close deliberately rather than as a
  defect — the docs get within one sentence of saying it, which is why this is Low.

---

#### [SEC-11] Every unmatched URL writes a stack trace to the production log

- **Severity:** Low
- **Where:** React Router's `No route matches URL` error, surfaced by
  `@react-router/express`. Observed under `react-router-serve` (production build) on 5188.
- **What happens:** each 404 emits six lines of framework stack trace before the access-log
  line. Because the application ships **no `/favicon.ico`** (`public/` contains only
  `fonts/inter-latin-var.woff2`) and sets no icon link in `app/root.tsx`, every real browser
  requesting the site produces one of these on its own.
- **What should happen:** `docs/operating.md` §Logs is what an operator reads a container's
  output against; a routine 404 should be an access-log line, not a stack trace. Adding a
  favicon would also remove the self-inflicted case.
- **Repro:**
  1. `npm run build && PORT=5188 DATABASE_URL=… npx react-router-serve ./build/server/index.js`
  2. `curl -s -o /dev/null http://localhost:5188/favicon.ico`
  3. read the server log.
- **Evidence:** `sec/prod-5188.log`:
  ```
  Error: No route matches URL "/favicon.ico"
      at getInternalRouterError (…/chunk-62JRHF6Z.mjs:5503:5)
      at Object.query (…/chunk-62JRHF6Z.mjs:3505:19)
      at handleDocumentRequest (…/chunk-ZA36QIGN.mjs:1428:38)
      at requestHandler (…/chunk-ZA36QIGN.mjs:1288:24)
      at requestHandler (…/chunk-ZA36QIGN.mjs:1342:12)
      at …/@react-router/express/dist/index.mjs:28:28
  GET /favicon.ico 404 - - 4.211 ms
  ```
- **Notes:** Also fills the log for any internet-facing scanner, which `docs/operating.md`
  §"Can I put this on the internet?" contemplates. The trace names framework paths only — no
  application source, no configuration.

---

#### Non-issues investigated

Recorded so the next person does not repeat them.

#### The gate itself is correct on every routed path
Enumerated every route in `app/routes.ts` and probed each unauthenticated, as a page **and**
as a single-fetch `.data` request, plus the legacy `?_data=` form and action POSTs:

```
/  /holdings  /analysis  /income  /upload
/upload/:draftId  /upload/:draftId/{columns,instruments,review}
/accounts/:accountId
/settings  /settings/{people,accounts,tax}  /settings/accounts/:accountId
                                          -> 302 /login?next=…
/login  /healthz                          -> 200 (the documented open list)
```
- `.data` variants of every protected route return `202` carrying a `SingleFetchRedirect` to
  `/login` — no loader data.
- `POST /settings/people.data` (with and without `?_routes=…`) unauthenticated → `202`
  redirect, nothing written; confirmed `select count(*) from person` unchanged.
- `HEAD`, `PUT`, `DELETE`, `PATCH`, `POST` on a protected route unauthenticated → `302 /login`.
- `/settings/../settings/people`, `/healthz/../settings/people`, `//settings/people`,
  `/HOLDINGS`, `/holdings/`, `/healthz/`, `/healthz%2f`, `/%00`, `/holdings%00`,
  `/%2e%2e/%2e%2e/etc/passwd`, a 5000-char path and unicode paths are all either gated or
  404 — none of them reaches a protected loader. `/healthz/` and `/HOLDINGS` fall to the
  *gated* side, which is the safe direction.
The one gap is unmatched paths — SEC-4.

#### The session cookie resists every tamper tried
`__portfolio_session=<base64 JSON>.<HMAC>`; `HttpOnly`, `SameSite=Lax`, `Path=/`,
`Max-Age=2592000`, `Secure` only when `X-Forwarded-Proto: https` (verified — the header flips
the attribute, matching `auth.server.ts:252-254`). All of the following → `302 /login`:
signature last character flipped, signature truncated by 5, payload with the signature removed,
payload re-encoded with a garbage signature, empty value, all-dots garbage.
Rotation works both ways, confirmed by restarting 5177:
- different `SESSION_SECRET`, same password → old cookie rejected, password still accepted.
- different `AUTH_PASSWORD`, same secret → old cookie rejected, old password rejected, new
  password accepted. That is the pinning at `auth.server.ts:215`.

#### Password comparison is timing-safe
`auth.server.ts:116-118`: `timingSafeEqual(sha256(submitted), sha256(configured))` — both sides
hashed first so the compared buffers are always 32 bytes, which is the right way to avoid
`timingSafeEqual`'s length-mismatch throw leaking the configured length. Nothing to report.

#### No login rate limiting — documented, and true
60 wrong-password POSTs completed in **0.84 s** (~71/s), all `200`, and the correct password was
accepted immediately afterwards. Each failure logs `Failed login attempt.` (no address, because
there is no `X-Forwarded-For` on a direct connection — `auth.server.ts:244`,
`forwarded.server.ts:69-71`). This is exactly what `docs/operating.md` §"Five things the code
does not do" states: "There is no login rate limiting or lockout of any kind … The length and
randomness of the password is the entire defence."

#### CSRF is *better* defended than the docs claim
`docs/operating.md` says "There is no CSRF token anywhere. `SameSite=Lax` on the session cookie
is the whole of it." In fact React Router 7 also enforces an origin check server-side:
```
POST /settings/people, valid cookie, Origin: https://evil.example.com  -> 400 Bad Request
POST /settings/people, valid cookie, no Origin                          -> 200 (write happened)
POST /settings/people, valid cookie, Origin: http://localhost:5177      -> 200 (write happened)
```
with `throwIfPotentialCSRFAttack` in the server log. A browser always sends `Origin` on a
cross-site form POST, so the cross-origin case is refused twice over. The doc paragraph is
pessimistic rather than wrong; worth correcting but not a defect.

#### No security headers — documented
No CSP, HSTS, `X-Frame-Options`, `X-Content-Type-Options` or `Referrer-Policy` on any response,
dev or production, on a page or on `/healthz`. `docs/operating.md`: "**No security headers are
set at all** … the app sets none and the Caddyfile sets none. If you want them, a `header` block
in the Caddyfile is where they go." Verified the `Caddyfile` is a bare `reverse_proxy`.
Also noted, and *not* filed: no `Cache-Control` on authenticated HTML. In the documented
topology (Caddy → app, no cache anywhere) nothing can store it, so it is the same class of
deliberate omission.

#### Production masks error messages; dev leaks them
Same 500 (`/accounts/999999999999999999999999999`), two builds:
```
dev  (5177): subtitle "value &quot;999…&quot; is out of range for type bigint";
             page also contains /home/user/portfolio paths and node_modules frames
prod (5188): subtitle "Unexpected Server Error"; no path, no SQL, no DATABASE_URL
```
`TRACE /holdings` likewise: dev returns the Vite overlay with a full stack and absolute paths;
production returns a 148-byte `Internal Server Error` with `Content-Security-Policy: default-src
'none'` and `X-Content-Type-Options: nosniff` (Express's own final handler). Source disclosure
is dev-only too: `/app/root.tsx`, `/server/config.ts` and `/node_modules/**/package.json` all
serve `200` under `react-router dev` and `404` under `react-router-serve`; `/.env` is `403` even
in dev. This is precisely what `docs/operating.md` predicts: "in a production build React Router
replaces a thrown error's message with a generic one … It is not true under `react-router dev`,
which should never face anything."

#### Configuration validation is thorough and names the variable every time
`node ./server/validate-config.ts` — all exit `1` with the variable named:
```
(no DATABASE_URL)                 DATABASE_URL is required but not set
DATABASE_URL='not a url'          DATABASE_URL must be a Postgres connection URL, for example …
DATABASE_URL='mysql://a:b@c/d'    (same)
AUTH_PASSWORD set, no secret      SESSION_SECRET is required but not set (it becomes required
                                  as soon as AUTH_PASSWORD is set)
PORT=0 / PORT=99999               PORT must be a TCP port between 1 and 65535
PORT=abc                          PORT must be a whole number (a TCP port)
PRICE_POLL_INTERVAL_MINUTES=0     PRICE_POLL_INTERVAL_MINUTES must be between 1 and 1440 minutes
MAX_UPLOAD_MB=0 / -1              MAX_UPLOAD_MB must be at least 1 megabyte
MARKET_TIMEZONE=Not/AZone         MARKET_TIMEZONE must be an IANA time zone name, for example …
TZ=Not/AZone                      TZ must be an IANA time zone name, for example …
```
Several bad variables at once are reported together in one message. `SESSION_SECRET` without
`AUTH_PASSWORD` is accepted (the secret is simply unused) — correct.
Note the entrypoint (`docker-entrypoint.sh`) is what runs this; `npm run dev` / `npm start`
outside the container do not, so a bad value surfaces on first use there. That is the documented
container contract, not a bug.

#### `AUTH_PASSWORD=` (empty) silently disables the gate — documented
`server/config.ts:128-131` treats empty as unset; validation says `Configuration OK.` and the
instance serves wide open. `docs/operating.md` calls this out by name: "`AUTH_PASSWORD=` with
nothing after it reads as unset … Check the banner in the UI, never the file." Verified the
banner does appear on every page in that state (except the unmatched-route 404 — SEC-4).

#### `/healthz` is correct
`200` gated and ungated, `GET` and `HEAD`, `Cache-Control: no-store`, body
`{"status":"ok","database":true,"migrations":"current","pendingMigrations":[]}`. The only thing
it can disclose is migration *filenames* when the image is ahead of the database, which
`docs/operating.md` names as a deliberate version fingerprint. `POST`/`DELETE /healthz` →
`405`. Trailing-slash `/healthz/` is gated rather than open, which is the safe direction; the
Compose `HEALTHCHECK` uses the exact path.

#### No reflected XSS via `next` or via error text
`?next=/"><script>alert(1)</script>` and `?next=/<img src=x onerror=alert(1)>` come back
HTML-escaped inside `value="…"`; `/settings/accounts/<script>alert(1)</script>` 404s with the
tag escaped in the boundary's message. React's escaping holds throughout.

#### Forged `X-Forwarded-Proto` — documented, and harmless
`POST /login` with `X-Forwarded-Proto: https` over plain HTTP issues the cookie with `Secure`,
so the browser drops it and the sender cannot stay logged in. That is exactly the trade-off in
`app/lib/forwarded.server.ts:16-21` and ARCHITECTURE.md §7.6: "a forged `X-Forwarded-Proto`
changes only the `Secure` attribute on the sender's own session cookie … It grants no access."

#### `next=/login` does not loop
`GET /login?next=/login` with a session → `/login` → (no `next`) → `/`. Two redirects, then the
overview. No loop.

#### Oversized headers and query strings are refused cleanly
A 20 000-character header, cookie or query string → `431 Request Header Fields Too Large`, no
stack trace, no crash. `FROBNICATE /holdings` → `400`. `OPTIONS` → `204` in dev / `405` in
production, with no body either way.

#### Empty database: every screen is clean
Walked `/`, `/holdings`, `/analysis`, `/income`, `/upload`, `/settings`, `/settings/people`,
`/settings/accounts`, `/settings/tax`, `/accounts/1`, `/settings/accounts/1` with the DB empty
(screenshots `sec/shots/empty_*.png`). No `NaN`, `$NaN`, `Infinity`, `-0`, `undefined`,
`[object Object]`, no broken SVG attributes (checked every `d`/`x`/`y`/`cx`/`cy`/`points` for
`NaN|Infinity|undefined`), no `pageerror`, no unhandled rejection in the log. Every dashboard
shows its own empty-state copy; `/settings/accounts` correctly refuses to offer the form and
says "Add someone under People first". `/accounts/1` and `/settings/accounts/1` 404 properly.

#### The first-run prompt is accurate and its links work
Empty DB → "Start here … Settings → People" linking to `/settings/people`. After adding one
person the prompt becomes "One more step … Settings → Accounts" linking to `/settings/accounts`.
After adding one account it disappears. It is suppressed inside `/settings` (intended,
`root.tsx:148-151`). Both links navigate correctly — an earlier apparent "URL changes but the
page does not" was a race in my own script (`networkidle` resolves before the lazily-discovered
route chunk arrives in dev); with a 4 s settle both land on the right screen.

#### One person / one account: still clean
Re-walked all 11 screens at the one-row boundary (screenshots `sec/shots/p1a1_*.png`), plus the
intermediate 1-person / 0-account state (`sec/shots/p1a0_*.png`). No `NaN`/`Infinity`/
`undefined` anywhere. `/accounts/1` handles the no-holdings case explicitly — "Nothing has been
recorded for this account yet, so there is nothing to value" and "A line needs two dated points
and this range holds 0" rather than a zeroed chart. `/settings/people` shows "1 account"; the
Remove button is not disabled but the attempt is refused with the right sentence — "Ada still
owns Joint Brokerage. Change the owner on those accounts first — accounts are never deleted,
only closed." — and the row survives (`select count(*) from person` still 1). The only thing
wrong at this boundary is SEC-9.

---

## Pricing, the poller, and the automated suite


Agent: PRICE. App: http://localhost:5173. DB: `portfolio_dev`. Test DB: `portfolio_test`.
Scratch: `«session scratch»/price`.

**Sandbox context, stated once so it is not mistaken for a defect:** the outbound proxy blocks
Yahoo's cookie/crumb handshake, so the real provider is unreachable here. Every live call fails
with `Error: No set-cookie header present in Yahoo's response.` That is an artefact of this
sandbox, **not** a bug in the app — and it made the "provider is down" path easy to exercise for
real. Findings below say explicitly where the sandbox is the cause. Node is v22.22.2 against a
`package.json` requiring `>=24.12.0`, and Postgres is 16 against a deployment on 17; **no failure
I saw is attributable to either** — the suite, the typecheck and every runtime probe passed on
this pairing.

---

#### [PRC-1] No screen ever says how old a price is; `is_stale` is the only signal and a dead poller never sets it

- **Severity:** High
- **Where:** `app/lib/prices.server.ts:357` (`priceFreshness`, zero production callers);
  `app/routes/overview.tsx`, `app/routes/analysis.tsx`, `app/routes/account.tsx`,
  `app/routes/holdings.tsx`. URLs: `/`, `/analysis`, `/holdings`, `/accounts/4`.
- **What happens:** Nothing in the UI renders a price timestamp or any statement of price age.
  The only freshness signal anywhere is the per-row caption `price is stale`
  (`app/lib/holdings-view.ts:687`), which is driven solely by `quote.is_stale`. `is_stale` is
  written in exactly one place — `prices.server.ts:216-226`, when a refresh **ran and a symbol
  did not come back**. A refresh that never runs (poller never started, market-hours logic wrong,
  container asleep, `startPricePoller` swallowed its own failure at
  `app/lib/price-poller.server.ts:171-179`) leaves every quote at `is_stale = false` forever, and
  the headline net worth is presented as live.
  I set `quote.as_of` for VXUS to 2019-01-02 with `is_stale = false`; the Holdings row rendered
  `$62.65` with the caption `International developed · Equity` and no age marker, and `/` showed
  the total with no qualification. A seven-year-old price is indistinguishable from a live one.
  `priceFreshness()` — which returns exactly the `{oldest, stale, priced}` triple this needs, and
  has six tests in `tests/refresh-quotes.test.ts:390-540` — is never called by any route.
- **What should happen:** DESIGN.md §11: *"The 'as of' timestamp is non-negotiable. Silently
  showing yesterday's net worth as though it were live is the one genuinely dangerous failure mode
  in a finance app."* `docs/design/pricing-ui-brief.md` §0 designs the as-of line and the stale
  banner. DESIGN.md §14 does **not** list its absence as an accepted limitation.
- **Repro:**
  1. `psql -h 127.0.0.1 -p 55432 -U portfolio -d portfolio_dev -c "update quote set as_of = '2019-01-02 21:00:00+00', is_stale = false where instrument_id = 3;"`
  2. Load `http://localhost:5173/holdings` and `http://localhost:5173/`.
  3. VXUS renders `$62.65` / `$27,795.82` with no note; the net-worth headline is unqualified.
  4. Restore: `update quote set as_of = '2026-08-24 06:37:22.947+00' where instrument_id = 3;`
- **Evidence:** `«session scratch»/price/badprices/holdings.txt`, `«session scratch»/price/badprices/overview.txt`.
  `grep -rn "priceFreshness" app/` returns only its own definition.
- **Notes:** `docs/design/pricing-ui-brief.md` §0 says the existing screen set "has no settings
  screen, no stale indicator, no loading state, no error state and no refresh control", so the
  *pricing UI slice* is acknowledged as unbuilt. What makes this a finding rather than a known gap
  is (a) DESIGN.md §11 calls the timestamp non-negotiable and §14 does not carry it as a
  limitation, and (b) the server-side answer already exists, tested, and is simply not wired up.

#### [PRC-2] One malformed quote in a batch rolls back the whole refresh and leaves every price flagged fresh

- **Severity:** High
- **Where:** `app/lib/prices.server.ts:189-234` (the `inTransaction` body; the try/catch at
  `181-187` guards only `provider.getQuotes`). Columns: `quote.price`,
  `quote.annual_dividend_per_share`, both `numeric(20,4)` (`migrations/0001_initial_schema.sql:217,221`).
- **What happens:** `refreshQuotes` guards the provider *call* against throwing, but not the
  *write loop*. Any per-symbol value Postgres refuses aborts the transaction, so **no** instrument
  gets its new price and **no** instrument is marked stale — every `is_stale` stays exactly as it
  was, which the module's own comment (`prices.server.ts:174-180`) says is the §11 failure it
  exists to prevent. The error escapes `refreshQuotes` to `tick`, which logs
  `Price refresh failed; last known prices are kept:` and returns. From the UI, prices simply stop
  moving while continuing to present themselves as current.
  Proven against a real Postgres in production shape (`refreshQuotes` owning its own transaction):
  two feed instruments priced at 100.0000; a refresh in which `PRCGOOD` returns `222.2200` and
  `PRCBAD` returns a price of `1e20` left **`PRCGOOD` at 100.0000, `is_stale = false`**. Same for
  an out-of-range `annualDividendPerShare`, an out-of-range `yieldPct` handed in directly, a
  non-numeric price string, and an `Invalid Date` `asOf`.
- **What should happen:** The isolation the code already applies elsewhere. `price-provider.server.ts:120-135`
  guards `yield_pct` against exactly this — its comment: *"That statement is inside the refresh
  transaction, so one bad symbol would roll back every other instrument's price and the
  stale-marking beside it: the whole household loses its refresh over one listing."* `price` and
  `annual_dividend_per_share` have no equivalent guard, and the write loop has no per-symbol
  `try`. DESIGN.md §6.1's currency guard makes the same promise ("refused per symbol, not per batch").
- **Repro:** `npx vite-node /tmp/.../«session scratch»/price/batch2.mts` (uses `portfolio_test`, cleans
  up after itself). Key output:
  ```
  ### after healthy refresh
    [quote] [{"symbol":"PRCBAD","price":"100.0000","is_stale":false,...},
             {"symbol":"PRCGOOD","price":"100.0000","is_stale":false,...}]
  ### now one symbol returns a price that overflows numeric(20,4)
    THREW OUT OF refreshQuotes: DatabaseError
    message: numeric field overflow
    code: 22003 severity: ERROR
    [quote after] [{"symbol":"PRCBAD","price":"100.0000","is_stale":false,...},
                   {"symbol":"PRCGOOD","price":"100.0000","is_stale":false,...}]
  ```
  `PRCGOOD`'s 222.2200 was never written and nothing was marked stale.
- **Evidence:** `«session scratch»/price/batch.mts`, `«session scratch»/price/batch2.mts` and their output above.
- **Notes:** Reachability depends on the provider returning garbage — which DESIGN.md §6.1 and
  §14.5 say to expect from an unofficial client ("it can break"). `regularMarketPrice` above ~1e16
  is implausible for a real listing; a garbage `dividendRate` is much easier to imagine, and the
  `asOf`/`Invalid Date` variant needs only a malformed `regularMarketTime` that `instantOf`
  (`price-provider.server.ts:204-216`) lets through as an out-of-range epoch. The cheap fix shape
  is the one already used for yield: range-check at the boundary, or wrap each symbol's three
  writes in a savepoint. Deliberately not fixed.

#### [PRC-3] A zero or negative price is counted as a known value and summed into every total

- **Severity:** Medium
- **Where:** `migrations/0002_holding_valued.sql:113-115` (`is_priced` is `q.price is not null`);
  no `check` constraint on `quote.price` (`migrations/0001_initial_schema.sql:217`) or
  `price_daily.close` (`:208`). URLs `/`, `/holdings`, `/analysis`, `/accounts/1`.
- **What happens:** With `quote.price = 0` for VTI, the Holdings row renders `$0.00` / `$0.00`
  with **no** note, the holding is still counted as *priced* (the coverage sentence stayed
  "Value is 17 of 18 holdings"), and net worth fell from `$687,247.44` to `$565,522.31`. With
  `quote.price = -100.0000` for AAPL, the row renders `−$100.00` / `−$12,175.55` and that negative
  is summed into net worth, into "Net worth by person", into "Value by account type" and into
  "Value by asset class" — a negative *equity* value, with no note anywhere.
- **What should happen:** DESIGN.md §6.2: *"Never zero, never null into a sum."*
  `docs/guide/prices.md`: *"The holding is excluded from every total, never counted as zero."*
  DESIGN.md §2 and `price-provider.server.ts:232-240`: *"the sign of a position lives in its
  quantity, never in its price"*. The invariant is asserted in four documents and enforced in
  exactly one place — `price-provider.server.ts:237-240` — with nothing behind it.
- **Repro:**
  1. `update quote set price = 0 where instrument_id = 2; update quote set price = -100.0000 where instrument_id = 6;`
  2. Load `/`, `/holdings`, `/analysis`.
  3. Restore: `update quote set price = 304.0988 where instrument_id = 2; update quote set price = 193.3079 where instrument_id = 6;`
- **Evidence:** `«session scratch»/price/badprices/{overview,holdings,analysis}.txt` (+ `.png`). SQL:
  ```
   is_priced | is_stale | symbol |   quantity   |   price   |    value
   t         | f        | AAPL   | 121.75547000 | -100.0000 | -12175.5470
   t         | f        | VTI    | 282.84654100 |    0.0000 |      0.0000
  ```
  Verified restored afterwards — `diff quote-before.txt quote-restored.txt` is empty.
- **Notes:** **Not reachable through today's UI**: the only writer is `prices.server.ts` and its
  input passes `toProviderQuote`'s `> 0` test, and there is no manual-price form yet
  (`docs/guide/prices.md`: "Setting such a price by hand is not possible yet"). This is a
  defence-in-depth gap that becomes a live bug the day DESIGN.md §6.2's promised manual price form
  ("Manual-priced instruments are edited in a form which writes a `price_daily` row") is built, or
  the day anyone restores a backup / runs a fixup by hand. A `check (price > 0)` on both columns
  would make the invariant true rather than intended.

#### [PRC-4] The Overview's per-account figures omit unpriced holdings without saying so

- **Severity:** Medium
- **Where:** `app/routes/overview.tsx:309` (accounts panel) and `app/routes/overview.tsx:353`
  (allocation bars). URL `/`.
- **What happens:** "Principal 401(k) — $87,438.93" is presented as that account's balance. It is
  the sum of 2 of its 3 holdings; the Principal LifeTime 2045 CIT is silently absent. The same
  partial figure drives that account's allocation bar and therefore every other account's
  percentage share. `accountTotals` already returns `coverage: {known, total}` per account
  (`app/lib/valuation.server.ts:396-402`), and the route has it in hand — it is used only to
  compute a page-level sum at `overview.tsx:208-209` for the net-worth note.
  The account **detail** page gets this right: `/accounts/4` renders
  "Based on 2 of 3 holdings. The rest have never been priced and contribute nothing to this
  figure, or to the line below it."
- **What should happen:** `docs/guide/prices.md`: *"**Every total says how much of the portfolio
  it covers**"*. DESIGN.md §8.2 / the coverage design generally. The same sentence the detail page
  already renders belongs on the row, or at least a marker.
- **Repro:**
  1. Load `http://localhost:5173/` — read the "Principal 401(k) $87,438.93" row and the
     "Allocation by account" bar of the same name. No coverage note on either.
  2. Load `http://localhost:5173/accounts/4` — "Based on 2 of 3 holdings."
  3. SQL cross-check:
     ```
     select a.name, sum(hv.value), count(*) filter (where hv.is_priced) known, count(hv.instrument_id) total
     from account a left join holding_valued hv on hv.account_id=a.id
     where a.closed_at is null group by 1;
      Principal 401(k) | 87438.9255 | 2 | 3
     ```
- **Evidence:** `«session scratch»/price/all-stale/overview.txt`, `«session scratch»/price/acct/_accounts_4.txt`.
- **Notes:** The page-level note ("The figure and the line are 17 of 18 holdings") covers the
  headline and the chart, and the Analysis page's page-level note covers every panel on it. The
  gap is specifically the per-account row and its bar, which are totals of their own.

#### [PRC-5] `yahooPriceProvider()` cannot be tested — the live batch loop is the one uncovered money path

- **Severity:** Medium
- **Where:** `app/lib/price-provider.server.ts:404-434`. Coverage: lines **407-432 uncovered**,
  file at 73.52% statements — the lowest in `app/lib` bar `db.server.ts`.
- **What happens:** `probeSymbol` takes an injectable client
  (`price-provider.server.ts:359-362`: `client: typeof yahooClient = yahooClient`) and has six
  tests including "answers unavailable for a payload that is not even a list". `yahooPriceProvider()`
  takes no parameter and calls `yahooClient()` directly at line 409, so nothing can drive it
  without the network — and CI never reaches the network by design. The result: the **only**
  production code path that turns a real provider payload into stored money has zero test
  coverage, including the per-symbol `CurrencyRefused` isolation at lines 423-428, which is the
  rule DESIGN.md §6.1 states most emphatically ("refused per symbol, not per batch: one foreign
  listing in a household of a hundred holdings must not cost the other ninety-nine their prices").
  That exact rule is tested three times over on the *probe* path and zero times on the batch path.
  Line 416's `(await client.quote(symbols)) as unknown[]` is also unguarded where the probe path
  guards with `Array.isArray(raw) ? raw : []` (line 371) — a non-array response is a `TypeError`
  rather than an empty batch. (It lands in `refreshQuotes`'s catch, so the outcome is safe; the
  asymmetry is the point.)
- **What should happen:** The interface exists to be the test seam (`price-provider.server.ts:11-13`:
  "The interface is also the test seam"). One optional parameter, matching `probeSymbol`, would
  make the batch loop testable.
- **Repro:** `npm run test:coverage`; read the `price-provider.server.ts` row. Then
  `grep -n "export function yahooPriceProvider" app/lib/price-provider.server.ts` — no injection point.
- **Evidence:** `«session scratch»/price/coverage.log`:
  `...der.server.ts | 73.52 | 85.45 | 88.88 | 74.13 | 379,407-432`
- **Notes:** This is a *risk*, not a percentage complaint — it is the uncovered path PRC-2 travels.

#### [PRC-6] Chart axis labels are money figures computed from floats, which `format.ts` and ARCHITECTURE §5.6 both forbid

- **Severity:** Low
- **Where:** `app/components/net-worth-chart.tsx:121` —
  `label: formatCompact((floor + span * fraction).toFixed(0))`, where `floor` and `span` come from
  `toPlotValue` at `net-worth-chart.tsx:81,90-92`.
- **What happens:** The `703.5K / 585.9K / 468.4K` labels on the Overview's net-worth chart are
  derived by float arithmetic on money values and then displayed.
- **What should happen:** `app/lib/format.ts:178-189` documents `toPlotValue` as the one licensed
  float and says of its result: *"Never use it for a figure that will be shown, compared, or
  summed."* ARCHITECTURE.md §5.6 restates it and enumerates *"exactly two deliberate exceptions"*
  — `format.ts:187` and `price-provider.server.ts:135`.
- **Repro:** Load `http://localhost:5173/`; the y-axis labels are those figures. Read
  `net-worth-chart.tsx:110-124`.
- **Evidence:** `«session scratch»/price/all-stale/overview.txt` (`703.5K / 585.9K / 468.4K`).
- **Notes:** Harmless in practice — the labels are rounded to whole dollars and then compacted to
  one decimal place, so a double-precision error cannot survive to be seen. Recorded because the
  rule is stated absolutely in two places and this is a real instance of breaking it. A third and
  fourth site outside §5.6's "exactly two" also exist and are self-documented as licensed:
  `app/routes/analysis.tsx:102` (`fraction`) and `app/routes/overview.tsx:255-266`
  (`allocationBars`, via `toPlotValue`) — §5.6's count is simply out of date.

#### [PRC-7] The poller logs nothing at all outside market hours, so a dead loop and a quiet one look identical

- **Severity:** Low
- **Where:** `app/lib/price-poller.server.ts:84` (`if (!isMarketOpen(...)) return;`) versus the
  comment at `:115-118`.
- **What happens:** `tick` returns before any logging when the market is shut, so for roughly 80%
  of the week `docker compose logs` contains no evidence the poller exists. `/home/user/portfolio`
  has been running since 06:49 UTC (02:49 New York, Monday) and `«session scratch»/dev.log` contains not
  one `Price refresh:` line — which is correct behaviour and also indistinguishable from the
  poller having failed to start (that failure is itself only a `console.error` at `:178`).
- **What should happen:** The code's own stated intent, `price-poller.server.ts:115-118`: *"One
  line per attempt, always — 'prices stopped updating' has to be answerable from `docker compose
  logs` alone, and a log that only speaks up on failure cannot distinguish a healthy quiet loop
  from a dead one."* The market-hours early return is exactly such a silent path.
- **Repro:** `grep -c "Price refresh" «session scratch»/dev.log` → `0`, with the app up and healthy.
- **Evidence:** `«session scratch»/dev.log`; `curl -s localhost:5173/healthz` → `{"status":"ok",...}`.
- **Notes:** Polish. A one-line `console.info("Price refresh skipped: market closed.")`, or a
  startup line, closes it. `healthz` deliberately reports no poller state
  (`price-poller.server.ts:31-34`), which is a defensible choice and not part of this.

#### [PRC-8] `isMarketOpen` has no holiday data before 2026 or after 2030, and none for half-days

- **Severity:** Low
- **Where:** `app/lib/market-hours.ts:63-77` (`NYSE_HOLIDAYS`).
- **What happens:** I tested `isMarketOpen` directly across the whole matrix. Everything the
  module claims to get right, it gets right. What it gets wrong:
  | case | result | verdict |
  |---|---|---|
  | Sat/Sun | closed | correct |
  | Tue 09:29:59 / 09:30:00 / 15:59:59 / 16:00:00 / 16:00:01 / 00:00 | F/T/T/F/F/F | correct |
  | 2026 Good Friday, Jul-4-observed, Thanksgiving, Christmas; 2027 New Year | closed | correct |
  | **2025 Jul 4, Thanksgiving, Christmas, Good Friday** | **open** | wrong — table starts at 2026 |
  | **2031-07-04** | **open** | wrong — table ends at 2030 (documented) |
  | day after Thanksgiving 13:30, Christmas Eve 13:30 (1pm closes) | open | wrong (documented) |
  | Mar 2026 and Nov 2026 DST transitions, incl. raw-UTC probes | correct | correct |
  | non-NY `MARKET_TIMEZONE` (London/Tokyo/UTC/LA) | 09:30–16:00 *local*, NYSE holidays applied to *local* dates | see notes |
  I verified every 2026–2030 entry against the real NYSE calendar (including the observed shifts
  — 2026-07-03, 2027-12-24, 2027-07-05, 2027-06-18 — and all five Good Fridays). The table is
  correct as far as it goes.
- **What should happen:** `market-hours.ts:53-62` explicitly accepts running past the last listed
  year: *"Running past the last year listed is not a failure… the poller spends ten wasted
  requests a year, which is the cheaper side of §10's trade-off"*, and half-days are refused
  deliberately at `:56-62`. DESIGN.md §10: *"a wrongly skipped poll costs nothing; a wrongly
  attempted one costs one request."*
- **Repro:** `npx vite-node «session scratch»/price/mh.mjs` — full matrix printed.
- **Evidence:** `«session scratch»/price/mh.mjs` and its output (also reproduced above).
- **Notes:** This is a Low because the module's whole design is that the calendar decides only
  whether to spend a request and can never corrupt `price_daily` — and I confirmed that:
  `marketDateOf` reads only the quote's own instant and got every DST and cross-midnight case
  right. The 2031 cliff is documented; the **pre-2026 gap is not**, though it can only matter to a
  backfill, since the poller only ever asks about now. The non-NY behaviour is arguably a
  configuration foot-gun rather than a bug: `MARKET_TIMEZONE=Europe/London` gives a 09:30–16:00
  London session with NYSE holiday dates, which is nobody's real market — but `.env.example` and
  `server/config.ts:90-94` describe the variable narrowly enough that this reads as intended.

---

#### The automated suite, the typecheck, and what is dark

- **`npm test` — 51 files, 746 tests, all passing, twice.** Run 1: 25.70s. Run 2: 23.31s. No
  failures, **no skipped tests, no `.only`, nothing flaky between the two runs**. Logs:
  `«session scratch»/price/test-run-1.log`, `test-run-2.log`.
  The suite picks the URL up from `TEST_DATABASE_URL` in `tests/support/database.ts:29-31`,
  falling back to `postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_test` — so the
  documented invocation is right.
- **`npm run typecheck` — clean, exit 0.** No errors of any kind.
- **Node 22 vs. the required `>=24.12.0`, and Postgres 16 vs. 17:** nothing failed that could be
  blamed on either. `engines` is not enforced (no `engine-strict`), the suite uses no Node-24-only
  API that I could observe, and every Postgres feature the schema uses (`generated always as
  identity`, `count(*) filter`, `cross join lateral`, `is distinct from`, advisory locks,
  `numeric(20,4)`) is Postgres-13-era or earlier. **No finding is attributable to the version
  skew.** Flagging it only so the next person does not re-derive it.
- **Coverage (`npm run test:coverage`) — dark files that matter.** Reported as risk, not as a
  percentage:
  | file | stmts | why it matters |
  |---|---|---|
  | `app/lib/price-provider.server.ts` **407-432** | 73.52% | the live money-ingest path — see PRC-5 |
  | `server/validate-config.ts` **11-21** | 0% | the container's start-up gate; nothing proves it exits non-zero on bad config |
  | `server/migrate.ts` **24-51** | 0% | the migration entrypoint run at container start (the migration *logic* in `migrations.ts` is 91%, so this is the CLI wrapper only) |
  | `app/routes/settings/people.tsx` **17-111** | 0% | `action` — creating and renaming people |
  | `app/routes/settings/accounts.tsx` **19-79** | 0% | `action` — creating accounts |
  | `app/routes/settings/account.tsx` **20-68** | 0% | `action` — editing an account, incl. closing it and its tax treatment |
  | `app/routes/settings/tax.tsx` **21-54** | 0% | `action` — the capital-gains rate that drives Analysis's "Potential tax" column |
  | `app/components/money-cell.tsx` **22-54** | 0% | a money renderer, untested |
  | `app/lib/db.server.ts` 133,147,154-155 | 73.07% | pool/handle lifecycle |
  The four settings `action`s are the notable cluster: the *rules* under them are well covered
  (`people.server.ts` 100%, `accounts.server.ts` 100%, `settings.server.ts` in `app/lib` at ~96%),
  so what is dark is route-level validation, redirect and error mapping on four write paths.
  `auth.server.ts` is 94.91% and `uploads.server.ts` 96.38% — the ingest and auth *libraries* are
  well covered; it is their route glue that is thin (`upload/review.tsx` 47%, `upload/instruments.tsx` 50%).

---

#### Non-issues investigated

These looked wrong and are not. Recorded so nobody spends the time again.

- **There is no "Refresh now" button.** Deliberate and documented. `docs/guide/prices.md`:
  *"Nobody has to press anything, and there is no button to press — a refresh control is one of the
  things not built yet."* `docs/design/pricing-ui-brief.md` §0 designs it as future work. DESIGN.md
  §6.2 mentions it as intended, so it is a gap, not a defect. A manual refresh was therefore tested
  by calling `refreshQuotes` directly instead.
- **A failed refresh does not corrupt or blank any price.** I ran a real refresh against
  `portfolio_dev` with the (unreachable) live provider. Report:
  `{"requested":14,"priced":0,"stale":14,"closes":0}`; one clear log line
  `Price provider failed; marking every selected instrument stale: Error: No set-cookie header…`;
  no throw, no unhandled rejection. Diffing `quote` before and after: **only `is_stale` changed**
  — every `price`, `yield_pct`, `annual_dividend_per_share` and `as_of` byte-identical, and
  `price_daily` completely untouched (11,048 rows, `diff` empty). This is the documented §6.2
  behaviour and it holds exactly. Evidence: `«session scratch»/price/quote-before.txt`,
  `quote-after.txt`, `pd-before.txt`, `pd-after.txt`.
- **One *unknown* symbol does not poison the batch.** Yahoo drops symbols it does not know, and
  `prices.server.ts:215-226` marks precisely those stale while the rest are priced. Verified with
  a fake provider returning quotes for only some of the requested symbols; also verified
  `probeSymbol("NOTAREALSYMBOLXYZ")` → `{"status":"unavailable"}` without throwing. (PRC-2 is a
  *different* failure — a symbol that comes back with a value the database refuses.)
- **The unpriced CIT is handled correctly on Holdings, Analysis and account detail.**
  `Principal LifeTime 2045 Collective Investment Trust` has no `quote` row and no `price_daily`
  row. Holdings: `Target date fund · Other · never priced`, price `—`, value `—`, total footer
  `$687,247.44 / 17 of 18` plus the sentence "1 has never been priced and is left out rather than
  counted as zero". Analysis: "Based on 17 of 18 holdings…". `/accounts/4`: "Based on 2 of 3
  holdings." It is never zeroed, never dropped without a word — **except** on the Overview's
  per-account row, which is PRC-4.
- **`marketDateOf` is correct.** Not fooled by DST in either direction, and correctly files a
  19:30 New York instant under that day rather than the next UTC day. Nothing else in the app
  decides a `price_daily` date.
- **The poller lifecycle is sound on every point tested.** Driven end to end
  against `portfolio_test` with `PRICE_POLL_INTERVAL_MINUTES=1` and a `MARKET_TIMEZONE` whose
  local wall clock was inside the session, with a provider that throws `429 Too Many Requests`
  every time (`«session scratch»/price/poller.mts`, log at `«session scratch»/price/poller.log`):
  - **Starts once.** `startPricePoller()` called three times → one state object, pinned to
    `Symbol.for("portfolio.pricePoller")` (`price-poller.server.ts:60,156`). No duplicate tick
    lines are possible from the HMR path either: `import.meta.hot.dispose` clears the slot
    (`:200-202`), and `«session scratch»/dev.log` contains no repeated tick lines.
  - **Does run, on schedule.** Two provider calls in 135s at a 1-minute interval.
  - **Survives a provider exception.** Both ticks logged
    `Price provider failed; marking every selected instrument stale: Error: 429 Too Many Requests`
    then `Price refresh: 0 of 1 priced, 1 stale, 0 closes written.` The *second* tick happening at
    all is the proof that `state.running` was cleared by the `finally` at `:133-136` after the
    first failed — a wedge there would stop prices refreshing for the life of the process with
    nothing in the log.
  - **No unhandled rejection or uncaught exception.** I installed
    `process.on("unhandledRejection")` and `process.on("uncaughtException")`; neither fired.
  - **Does not hold the process open.** `timer.hasRef()` is `false` (`unref()` at `:168`), and
    the script exited 0 immediately after starting a poller it deliberately never stopped.
  - **In dev specifically:** the poller *is* started, from `app/root.tsx:67` on the first page
    render. It has produced no log line in this instance only because New York is outside session
    hours right now — see PRC-7.
- **An invalid `MARKET_TIMEZONE` cannot reach `isMarketOpen`.** `Intl.DateTimeFormat` throws
  `RangeError: Invalid time zone specified` on a bad zone, and `isMarketOpen` is called at
  `price-poller.server.ts:84` *outside* the `try`, so it would surface as an unhandled rejection
  from `void tick(...)` at `:163` — but `server/config.ts:18-29,94` validates the zone with
  `Intl` at load, and `startPricePoller` reads `getConfig()` inside its own `try` at `:158-159`,
  so a bad zone stops the poller from starting rather than crashing it later. Dead end.
- **The `yahoo-finance2` v4 static-export trap is real and correctly avoided.** Confirmed live:
  `typeof YahooFinance.quote === "function"` but calling it throws
  ``Call `const yahooFinance = new YahooFinance()` first``. `yahooClient()`
  (`price-provider.server.ts:301-304`) instantiates properly, and
  `tests/price-provider.test.ts:301-330` asserts both halves.
- **Money is not round-tripped through a JS float on the way *out* of the database.**
  `server/db.ts` registers the string parsers for `NUMERIC`/`INT8`/`DATE`; `valuation.server.ts`,
  `allocation.ts`, `money.ts` and `holdings-view.ts` never call `Number()` on a value — the only
  `Number()` calls there are on `count(*)` cardinalities (`valuation.server.ts:224,345,558`,
  `prices.server.ts:387-388`). The floats that do exist are the plotting ones — see PRC-6.
- **Money *is* a float on the way *in* from the provider, and this is unavoidable and documented.**
  Trace: Yahoo's JSON → `JSON.parse` inside `yahoo-finance2` → validated as a JS number at
  `app/lib/price-provider.server.ts:153` (`regularMarketPrice: z.number()`) → carried as a float
  through `:237-240` → converted once at `:107` (`value.toFixed(scale)` in `decimal()`) and never
  a number again. The derived-yield path also divides two floats at `:268` before `toFixed(6)`.
  `price-provider.server.ts:96-104` states exactly this and why ("the input is already a float that
  has been through JSON, so there is no precision left to preserve"). ARCHITECTURE §5.6's claim is
  about values crossing *from Postgres*, and that claim holds.
