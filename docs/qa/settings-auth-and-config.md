# QA findings — forms that write, auth gate, startup configuration

**Instance:** port 5183, database `qa3`. **Branch:** `claude/amazing-hypatia-k9dcfy` (working tree clean, no source edited).
**Date:** 2026-08-25. Server restored to plain qa3 config (gate off) and `qa3` re-migrated + demo-seeded on completion.

Scope tested: `/settings`, `/settings/people`, `/settings/accounts`, `/settings/accounts/:accountId`,
`/settings/tax`, `/login`, `/healthz`, the manual balance flow on `/accounts/:accountId`, `server/config.ts`,
`server/validate-config.ts`, `docker-entrypoint.sh`.

Method: raw `curl` (form tampering, header spoofing, cookie forgery), `psql` against `qa3` to confirm what
was actually written, headless Chromium via Playwright for the real interactive forms and for browser-level
URL resolution, and `scratchpad/qa3.log` after each attempt.

Everything below was reproduced **at least twice**, the second time against a freshly
`drop database` / `migrate` / `seed-demo` copy of `qa3`, unless a finding says otherwise.

Setup used for every repro command:

```sh
B=http://localhost:5183           # curl always with --noproxy '*'
PSQL="psql -h 127.0.0.1 -p 55432 -U portfolio -d qa3"
```

---

## 1. Post-login open redirect: a tab character smuggles `next` off-origin

**Severity: High**

`safeRedirectTarget()` is the app's stated defence against exactly this
(`auth.server.ts:139-152`: *"anything that could leave the origin (`//evil.example`, `https://…`, a
backslash Windows treats as a slash) becomes the home page instead"*). It rejects `//`, `/\` and
anything not starting with `/` — but a URL whose path begins with `/` + **U+0009 TAB** passes the
check, survives into the `Location` header verbatim, and is then parsed by the browser with the tab
**stripped**, per the WHATWG URL spec (tab/CR/LF are removed before parsing). `/<TAB>/evil.example`
becomes `//evil.example`, i.e. a protocol-relative URL, and the browser leaves the instance.

Only reachable while `AUTH_PASSWORD` is set (with the gate off, `/login` redirects to `/` before
`next` is read) — but that is precisely the deployment the operator hardened.

### Repro

Start the instance with the gate on:

```sh
AUTH_PASSWORD="hunter2-correct-horse" SESSION_SECRET="qa3-session-secret-value" \
DATABASE_URL="postgres://portfolio:portfolio@127.0.0.1:55432/qa3" npx react-router dev --port 5183
```

**(a) Header level — already authenticated:**

```sh
CK=$(curl -s --noproxy '*' -D - -o /dev/null -X POST "$B/login" \
      -d "password=hunter2-correct-horse" | grep -i "^set-cookie" | sed 's/set-cookie: //I;s/;.*//')

curl -s --noproxy '*' -D - -o /dev/null -H "Cookie: $CK" \
     "$B/login?next=/%09/evil.example" | grep -i "^HTTP/\|^location:" | cat -A
```

**(b) Full victim flow — unauthenticated, real browser** (`scratchpad/redir2.mjs`): open
`http://localhost:5183/login?next=/%09/evil.example`, type the correct password, submit.

### Observed

(a)

```
HTTP/1.1 302 ^M$
location: /^I/evil.example^M$          <-- ^I is a literal TAB
```

(b) Chromium navigation trace (off-origin requests aborted by the harness so nothing left the box):

```
hidden next value = "/\t/evil.example"
navigations: [
 "GET  http://localhost:5183/login?next=/%09/evil.example",
 "POST http://localhost:5183/login?next=%2F%09%2Fevil.example",
 "GET  http://evil.example/",           <-- left the origin
 "GET  http://evil.example/",
 "GET  http://evil.example/"
]
landed: chrome-error://chromewebdata/   (only because the fetch was blocked)
```

Confirmed identically on the **production build** (`react-router build` + `react-router-serve`), so
it is not a dev-server artefact:

```
location: /^I/evil.example^M$
```

Control cases behave correctly — `//evil.example`, `/\evil.example`, `///evil.example`,
`https://evil.example`, `javascript:alert(1)` all yield `location: /`.

### Expected

`safeRedirectTarget` returns `/` for any target that a browser will resolve off-origin. Stripping
(or rejecting) C0 controls — at minimum `\t`, `\n`, `\r` — before the `//` test, e.g. rejecting any
target matching `/[\x00-\x1f]/`, or resolving the target against the instance origin and refusing it
if the origin changes.

### Cause

`app/lib/auth.server.ts:153-158` — `safeRedirectTarget` inspects only the first two characters and
never normalises whitespace/control characters:

```ts
if (!target.startsWith("/")) return "/";
if (target.startsWith("//") || target.startsWith("/\\")) return "/";
return target;
```

Consumed at `app/routes/login.tsx:26` (loader) and `app/lib/auth.server.ts:258` (`logIn`'s redirect).

---

## 2. An account's `kind` is freely editable, which defeats the set-balance guard and replaces a whole brokerage valuation with one typed number — with no UI undo

**Severity: High** (money wrong; not recoverable through the application)

`balances.server.ts` refuses a typed balance on a securities account and says why in its own header
comment: *"Only `bank` and `liability`. … The refusal below is what stands between a mis-clicked form
and a wiped portfolio."* But the guard reads `account.kind`, and `kind` is an ordinary editable
field on Settings → Accounts → *(account)* with **no warning of any kind** attached to it. Two
ordinary form submissions — both fully available in the UI — turn a $211k brokerage into $1.00.

Reverting the kind afterwards does **not** restore the figure: position sets are append-only, there
is no delete affordance anywhere, and `latest_position_set()` keeps returning the manual USD row.

### Repro

```sh
$PSQL -tAc "select kind from account where id=1; select round(sum(value),2) from holding_valued where account_id=1"

# Step 1 — Settings -> Accounts -> Fidelity Individual -> Kind = "Bank" -> Save changes
curl -s --noproxy '*' -X POST "$B/settings/accounts/1" \
  -d "name=Fidelity Individual&institution=Fidelity&kind=bank&ownerId=1&taxTreatment=taxable&externalAccountNumber=X47-283910"

# Step 2 — the account page now offers "Set balance"; record 1.00 for today
curl -s --noproxy '*' -X POST "$B/accounts/1" -d "amount=1.00&asOf=2026-08-25"

$PSQL -tAc "select round(sum(value),2) from holding_valued where account_id=1"

# Step 3 — try to undo by putting the kind back
curl -s --noproxy '*' -X POST "$B/settings/accounts/1" \
  -d "name=Fidelity Individual&institution=Fidelity&kind=brokerage&ownerId=1&taxTreatment=taxable&externalAccountNumber=X47-283910"

$PSQL -tAc "select kind from account where id=1; select round(sum(value),2) from holding_valued where account_id=1"
```

### Observed

```
BEFORE:        brokerage / 211471.57
step 2:        HTTP 302 -> /accounts/1?recorded=2026-08-25
AFTER:         1.00
AFTER REVERT:  brokerage / 1.00          <-- kind restored, valuation not
```

The seven securities are still in the database (position set 13 is intact) but no longer current:

```
$PSQL -c "select i.symbol, h.quantity from holding h join instrument i on i.id=h.instrument_id
          where h.position_set_id = latest_position_set(1)"
 symbol | quantity
--------+--------------
 USD    | 100.00000000
```

The edit form carries no note beside **Kind** (the only two `field-note`s on the page are on Tax
treatment and Account number), and the page's only warning sentence is about tax treatment:
*"Correcting a tax treatment here changes every figure computed from this account."*

Recovery requires uploading a statement dated on/after the manual entry, or raw SQL.

### Expected

Either (a) `updateAccount` refuses a change between a securities kind and a single-position kind once
the account has any position set — with a message naming what would happen; or (b) the kind control
carries the same weight as the close control (its own confirmation and warning). The design already
treats "one typed cash figure against a securities account" as the failure mode worth a hard refusal;
that refusal should not be removable by an unremarkable dropdown on an adjacent screen.

### Cause

`app/lib/accounts.server.ts:198-240` — `updateAccount` writes `kind` unconditionally and states
*"Editing is deliberately unrestricted"*, an argument made about **tax treatment**, not about kind.
The guard it defeats is `app/lib/balances.server.ts:56-70` (`SINGLE_POSITION`) / `:177-183`.
No warning text in `app/components/account-fields.tsx:84-105` (the Kind field).

Not listed in DESIGN.md §14, ARCHITECTURE.md §7.6, `docs/developing.md` "What does not exist", or
`docs/guide/settings.md`.

---

## 3. The Postgres pool has no `error` listener — a dropped idle connection kills the whole server process

**Severity: High** (crash; takes `/healthz` down with it, so the documented "non-200 when the database is down" behaviour never happens)

`node-postgres` emits `'error'` on the `Pool` when a backend closes an **idle** pooled connection.
`createPool` attaches no listener, so Node raises `Unhandled 'error' event` and the process exits.
Any Postgres restart, minor-version upgrade, OOM kill, admin `pg_terminate_backend`, or a pooler
enforcing an idle timeout takes the application down.

### Repro

```sh
curl -s --noproxy '*' -o /dev/null "$B/settings/people"      # open a pooled connection
psql -h 127.0.0.1 -p 55432 -U portfolio -d postgres -tAc \
  "select pg_terminate_backend(pid) from pg_stat_activity where datname='qa3' and pid <> pg_backend_pid()"
sleep 3
curl -s --noproxy '*' -o /dev/null -w "%{http_code}\n" --max-time 8 "$B/healthz"
pgrep -f "port 518[3]"
```

### Observed

```
up HTTP 200
t t
prod after HTTP 000        <-- connection refused
pids:                      <-- (empty) the process is gone
```

`scratchpad/qa3.log`:

```
node:events:487
      throw er; // Unhandled 'error' event
      ^
error: terminating connection due to administrator command
    at parseErrorMessage (/home/user/portfolio/node_modules/pg-protocol/src/parser.ts:395:9)
    ...
Emitted 'error' event on BoundPool instance at:
    at Client.idleListener (/home/user/portfolio/node_modules/pg-pool/index.js:62:10)
```

Reproduced on **both** `react-router dev` and the production `react-router-serve ./build/server/index.js`.
Also reproduced incidentally by `drop database qa3 with (force)` while the server was running.

### Expected

`/healthz` answers 503 (`{"status":"unhealthy","database":false,…}`, which it does correctly when the
database is merely unreachable at boot) and the process survives to recover when the database comes
back. `pg` documents an idle-client error listener as mandatory:
`pool.on("error", (err) => console.error("Idle client error", err))`.

`compose.yaml`'s `restart: unless-stopped` masks this in the bundled deployment, but the container
still bounces on every `db` restart, the in-process price poller (DESIGN.md §10) loses its tick, and
a bare-metal `npm start` has no recovery at all.

### Cause

`server/db.ts:61-70` — `createPool` returns `new pg.Pool({…})` with no `error` handler and nothing
downstream attaches one (`grep -rn "pool.on" server/ app/` → no matches).

Not documented in `docs/runbook.md`, `docs/operating.md`, or ARCHITECTURE.md §7.6.

---

## 4. A non-numeric or empty `personId` 500s instead of 404ing (People rename/remove)

**Severity: Medium**

`accounts.server.ts` guards ids with `/^\d+$/` precisely so a malformed id "would reach Postgres as a
malformed bigint and fail as a 500 rather than as a message on the form" (its own comment at
`accounts.server.ts:88-91`). `people.server.ts` has no equivalent guard, and `people.tsx` passes
`personId ?? ""` straight through — so a missing `personId` is also a 500.

### Repro

```sh
curl -s --noproxy '*' -X POST "$B/settings/people" -d "intent=rename&personId=abc&name=Zed"
curl -s --noproxy '*' -X POST "$B/settings/people" -d "intent=remove&personId="
curl -s --noproxy '*' -X POST "$B/settings/people" -d "intent=remove"
```

### Observed

All three: **HTTP 500**, error page reading

```
Something went wrong
invalid input syntax for type bigint: "abc"
```

`scratchpad/qa3.log`:

```
error: invalid input syntax for type bigint: "abc"
    at renamePerson (/home/user/portfolio/app/lib/people.server.ts:114:15)
    at action (/home/user/portfolio/app/routes/settings/people.tsx:34:9)
  code: '22P02', routine: 'pg_strtoint64_safe'
```

Compare: `personId=9999` (well-formed, no such row) correctly returns **404 `No person with id 9999.`**

### Expected

404 `No person with id abc.` — the same answer `getAccount` already gives for `/settings/accounts/abc`
(verified: HTTP 404).

### Cause

`app/lib/people.server.ts:107-120` (`renamePerson`) and `:142-172` (`removePerson`) — neither
validates `id` before `.where("id", "=", id)`. Callers: `app/routes/settings/people.tsx:34,37`.

---

## 5. Ids that overflow `bigint` 500 even where the `/^\d+$/` guard exists

**Severity: Medium**

The `/^\d+$/` guard added to stop exactly this class of 500 admits any digit string, including ones
Postgres cannot fit in a `bigint`.

### Repro

```sh
BIG=99999999999999999999999
curl -s --noproxy '*' -o /dev/null -w "%{http_code}\n" "$B/settings/accounts/$BIG"
curl -s --noproxy '*' -o /dev/null -w "%{http_code}\n" "$B/accounts/$BIG"
curl -s --noproxy '*' -X POST "$B/settings/accounts" \
  -d "name=T&kind=bank&ownerId=$BIG&taxTreatment=taxable"
```

### Observed

All three **HTTP 500**:

```
Something went wrong
value "99999999999999999999999" is out of range for type bigint
```

### Expected

`/settings/accounts/<huge>` → 404. `ownerId=<huge>` → the existing form message *"Choose an owner
from the people on this instance."* (which is what `ownerId=9999` correctly produces).

### Cause

`app/lib/accounts.server.ts:172` (`getAccount`'s `/^\d+$/` test), `:82-84` (`accountInput.ownerId`'s
`.regex(/^\d+$/)`), and `:282-291` (`requireOwner`'s `.where("id", "=", ownerId)`). A digit-count or
range bound is missing from all three. Same shape in `app/lib/balances.server.ts:139`.

---

## 6. A NUL byte in any free-text field 500s with a raw Postgres encoding error

**Severity: Medium**

`requiredText` / `optionalText` trim and bound length but do not reject C0 control characters, and
Postgres `text` cannot store `0x00`.

### Repro

```sh
curl -s --noproxy '*' -X POST "$B/settings/people" -d "intent=create&name=A%00B"
curl -s --noproxy '*' -X POST "$B/settings/accounts" \
  -d "name=A%00B&kind=bank&ownerId=1&taxTreatment=taxable"
```

### Observed

**HTTP 500**

```
Something went wrong
invalid byte sequence for encoding "UTF8": 0x00
```

Nothing is written (`select count(*) from person where name like 'A%'` → 0), so this is a crash
rather than corruption.

### Expected

A field-level `ValidationError` — the module docstring for `input.server.ts` says a refusal *"is an
ordinary outcome of a form submission — never a 500."*

### Cause

`app/lib/input.server.ts:70-76` (`requiredText`) and `:84-93` (`optionalText`) — no control-character
rejection. Not browser-reachable through a plain `<input>`, but reachable from any script/fetch and
from the ingest path's free text.

---

## 7. Any POST/PUT/PATCH/DELETE with a non-form `Content-Type` 500s on every write route

**Severity: Medium**

Every action calls `request.formData()` unguarded, and React Router routes *all* non-GET methods to
the action, so an unsupported method or content type is a 500 rather than a 400/405.

### Repro

```sh
for R in /settings/people /settings/accounts /settings/tax /settings/accounts/1 /accounts/5; do
  printf "%-22s " $R
  curl -s --noproxy '*' -o /dev/null -w "%{http_code}\n" \
    -X POST -H "Content-Type: application/json" -d '{}' "$B$R"
done
curl -s --noproxy '*' -o /dev/null -w "%{http_code}\n" -X PUT "$B/settings/people"
```

### Observed

```
/settings/people       500
/settings/accounts     500
/settings/tax          500
/settings/accounts/1   500
/accounts/5            500
PUT /settings/people   500
```

Error page: `Content-Type was not one of "multipart/form-data" or "application/x-www-form-urlencoded".`
(In production the text is sanitised to `Unexpected Server Error`, but the status is still 500.)

For contrast, a route with **no** action answers correctly: `POST /` → **405**, and `POST /healthz` → **405**.

### Expected

400 (bad content type) or 405 (method not allowed). With `AUTH_PASSWORD` unset — the default
deployment — this is an unauthenticated one-liner that fills the log with stack traces.

### Cause

`app/routes/settings/people.tsx:22`, `settings/accounts.tsx:28`, `settings/tax.tsx:34`,
`settings/account.tsx:33`, `account.tsx:229` — all begin `formFields(await request.formData())`
with no try/catch and no content-type check.

---

## 8. The tax rate silently accepts `1,00` as **100%**

**Severity: Medium** (wrong money figure, recoverable)

`percentRate` runs the shared `bareDecimal` helper, which strips `,` as a thousands separator. On a
field whose maximum legal value is 100, a comma can never be a thousands separator — so a comma is
always either a typo or European decimal notation, and stripping it multiplies the intended rate by
100. The form reports success and shows the new figure only after the loader re-runs.

### Repro

```sh
curl -s --noproxy '*' -X POST "$B/settings/tax" -d "capitalGainsRate=1,00"
$PSQL -tAc "select capital_gains_rate from app_setting"
```

### Observed

```
HTTP 200, no error message
100.000000
```

Analysis then estimates capital gains tax at 100% of every unrealized gain in a taxable account.

### Expected

Refused — `A capital gains rate must be a percentage, like 23.8.` — or interpreted as `1.00`.

Everything else in this field is correct: `-5` → *cannot be negative*; `101` → *cannot be more than
100%*; `1e309`, `abc`, `.`, `１００` (fullwidth) → *must be a percentage*; `23.123456789` → *at most 6
decimal places*; `50%`, `.5`, `+20`, `0`, `100`, `0100`, `099.9` all accepted and stored correctly.

### Cause

`app/lib/input.server.ts:148` — `bareDecimal`'s `.replace(/[$\s ,]/g, "")`, shared unconditionally by
`percentRate` (`:396-420`). The helper's rationale (`:135-142`) is about money copied off statements;
a bounded percentage does not have that requirement.

---

## 9. `npm run dev` and `npm start` never run the startup validator, so `AUTH_PASSWORD` without `SESSION_SECRET` does not fail at startup

**Severity: Low** (fails closed; adjacent to a documented trap, but the spec wording is not met outside the container)

Spec `docs/specs/foundation/08-optional-password-gate.md`: *"The session secret becomes required when
the auth password is set, and **startup fails** with a readable message when it is missing."*
`docker-entrypoint.sh` satisfies this (`node ./server/validate-config.ts` before the server, `set -eu`),
but `package.json` has no `predev`/`prestart` hook, so outside the container the server starts happily
and every request 500s instead.

### Repro

```sh
AUTH_PASSWORD="x" DATABASE_URL="postgres://portfolio:portfolio@127.0.0.1:55432/qa3" \
  npx react-router dev --port 5183
# server starts, prints "➜  Local: http://localhost:5183/"
curl -s --noproxy '*' -o /dev/null -w "%{http_code}\n" "$B/"
curl -s --noproxy '*' -o /dev/null -w "%{http_code}\n" "$B/healthz"
```

### Observed

Server starts with no error. Then:

```
/         500   "Invalid configuration. … SESSION_SECRET is required but not set
                 (it becomes required as soon as AUTH_PASSWORD is set)"
/healthz  500   "Unexpected Server Error\n\nConfigError: Invalid configuration…"
```

The message does name the variable, and the gate fails **closed** (no page renders, no data served) —
those parts are right. Two problems remain: startup does not fail, and `/healthz`, documented as the
one endpoint that always answers without credentials, 500s here even though the database is fine.

### Expected

A `predev`/`prestart` script running `node ./server/validate-config.ts`, so a checkout and the
container fail the same way. (`docs/developing.md:33-37` documents lazy parsing as a known dev trap,
which softens this but does not cover `npm start`.)

### Cause

`package.json` scripts (`dev`, `start`) vs `docker-entrypoint.sh:15`. Lazy parse at
`server/config.ts:163-166` (`getConfig`), first forced by `app/root.tsx:41` (`authGate()`).

---

## 10. `DATABASE_URL` with no host and no database passes validation

**Severity: Low**

The check is `POSTGRES_SCHEMES.includes(new URL(value).protocol)` and nothing else, so any string with
a `postgres:`/`postgresql:` scheme is accepted. `pg` then silently falls back to its own defaults
(localhost, `$USER`, a database named after the user) — a misconfiguration that could connect to the
*wrong* database rather than failing.

### Repro

```sh
env -i PATH="$PATH" DATABASE_URL=postgres://    node ./server/validate-config.ts
env -i PATH="$PATH" DATABASE_URL=postgres:x     node ./server/validate-config.ts
env -i PATH="$PATH" DATABASE_URL=POSTGRES://a/b node ./server/validate-config.ts
```

### Observed

All three: `Configuration OK.`

### Expected

Spec `foundation/01`: *"the process exits with a readable message naming the offending variable."*
A connection URL with no host and no database name is not a Postgres connection URL.

### Cause

`server/config.ts:41-52` — the refinement checks only `protocol`, never `hostname` or `pathname`.

---

## 11. `MAX_UPLOAD_MB` has no upper bound and is absent from DESIGN.md §10.1's environment table

**Severity: Low**

`MAX_UPLOAD_MB=99999999` → `Configuration OK.`, defeating the cap's stated purpose (*"the cap bounds
what an accident can put in memory"*, `server/config.ts:79-83`). A mistyped value is accepted silently.

Separately, spec `foundation/09` requires *"The full environment table is documented … matching the
example environment file."* `.env.example` and `docs/operating.md:131` both carry `MAX_UPLOAD_MB`;
DESIGN.md §10.1's table (`DATABASE_URL`, `SESSION_SECRET`, `AUTH_PASSWORD`, `PORT`,
`PRICE_POLL_INTERVAL_MINUTES`, `MARKET_TIMEZONE`, `TZ`) does not, while calling itself *"the
deployment's whole configuration API"*. Minor units drift too: `config.ts` says megabytes,
`operating.md:131` says mebibytes.

### Repro

```sh
env -i PATH="$PATH" DATABASE_URL=postgres://portfolio:portfolio@127.0.0.1:55432/qa3 \
  MAX_UPLOAD_MB=99999999 node ./server/validate-config.ts
grep -c MAX_UPLOAD_MB DESIGN.md
```

### Observed / Expected

`Configuration OK.` / `0`. Expected an upper bound (`.max(...)`) with a message naming the variable,
and a row in DESIGN.md §10.1.

### Cause

`server/config.ts:84-88` — `.refine((value) => value >= 1)` with no ceiling. DESIGN.md §10.1 table.

---

## 12. A `next` containing a newline 500s instead of falling back to `/`

**Severity: Low**

Same missing control-character handling as finding 1, on the branch where the `Headers` API refuses
the value rather than passing it through.

### Repro (gate on)

```sh
curl -s --noproxy '*' -o /dev/null -w "%{http_code}\n" -H "Cookie: $CK" "$B/login?next=/%0a/x"
```

### Observed

`HTTP 500`, error page `Headers.set: "/` (truncated at the newline).

### Expected

`safeRedirectTarget` returns `/`; a 302 to `/`.

### Cause

`app/lib/auth.server.ts:153-158`, consumed at `app/routes/login.tsx:26`.

---

## 13. The set-balance refusals for a securities account render nothing at all

**Severity: Low**

`setBalance` raises a carefully worded form-level refusal for a brokerage/401k/IRA account
(*"…holds securities, so its balance comes from a statement…"*), and `account.tsx`'s action returns
it — but the component that renders form-level errors is inside `{takesBalance ? … : null}`, and
`takesBalance` is false for exactly those kinds. The POST returns 200 with the page unchanged and no
message anywhere.

### Repro

```sh
curl -s --noproxy '*' -X POST "$B/accounts/1" -d "amount=1&asOf=2026-08-25"   # account 1 = brokerage
```

### Observed

`HTTP 200`, no `.form-error`, no `.field-error`, nothing written.

The sibling refusal for a **closed** account (`"…is closed, and a closed account's history does not
change. Reopen it from Settings…"`, `balances.server.ts:192-195`) is unreachable for a second reason:
`/accounts/:id` 404s outright for a closed account (`accountTotals`/`accountTotal` filter
`closed_at is null`), so the POST is answered `404 Not found` before `setBalance` runs.

### Expected

Both refusals are only reachable by tampering, so the impact is small — but a defensive message that
can never be seen is dead code. Either render form-level errors outside the `takesBalance` gate, or
answer 400/404 rather than a silent 200.

### Cause

`app/routes/account.tsx:562-570` (`{takesBalance ? <SetBalance … /> : null}`, errors passed only
there) vs `app/routes/account.tsx:238-240` (the action returning them);
`app/lib/balances.server.ts:177-195`.

---

# Tried and did NOT break

Everything here was attempted and behaved correctly.

**Cross-site scripting / injection**
- `<script>alert(1)</script>`, `"><img src=x onerror=alert(1)>` as a person name and an account name:
  stored verbatim, rendered escaped (`&lt;script&gt;…`) in HTML and `<` in the streamed payload.
  `grep -rn "dangerouslySetInnerHTML" app/ server/` → no matches anywhere.
- SQL injection: `Bobby'; DROP TABLE person;--` stored as a literal name; every table intact. Kysely
  parameterises; the two `sql` template sites bind values only.
- Emoji / Arabic / RTL-override (`🎉مرحبا‏RTL😀`) round-trip correctly.

**Field validation**
- Empty and whitespace-only names → *A name is required.* (create and rename, both).
- 10 000-character and 121-character names → *A name must be 120 characters or fewer.*
- Account form with everything blank → four correct field messages at once, values retained.
- `kind=crypto`, `taxTreatment=evil` → *Choose what kind of account this is.* / *Choose a tax treatment.*
- `ownerId=9999` (well-formed, no such person) → *Choose an owner from the people on this instance.*
- Unknown `intent` → **400** `Unknown intent "bogus".`; missing `intent` → **400**.
- Repeated form keys (`ownerId=1&ownerId=2`, `kind=bank&kind=brokerage`) → last value wins, validated
  normally, no crash, no array reaching the driver.
- Balance: `-500` → the "plain amount, without a minus sign" refusal; `2027-01-01` → future-date
  refusal; `2026-02-30` → *not a date on the calendar*; missing amount → *A balance is required.*
- Liability sign derivation: `8000` on a `liability` stored as `-8000.00000000`; `0` stored as
  `0.00000000` (no `-0`), exactly as documented.

**Referential integrity — no orphans produced by anything I tried**
- Removing a person who owns accounts → refused with all four account names listed, closed ones
  marked `(closed)`; the row survives.
- Removing / renaming a non-existent numeric id → **404**, no write.
- `account.owner_id` is the only FK to `person` and it is `on delete restrict`; `position_set →
  account` is `restrict`; nothing in the app deletes an account or a position set. Row counts before
  and after every attack run were consistent.
- Closing an account twice → the original `closed_at` stands (verified in SQL). Closing a
  non-existent or non-numeric account id → **404**.
- Double-submitting the create form in the browser → **one** row, not two.

**Auth gate (with `AUTH_PASSWORD` + `SESSION_SECRET` set)**
- Every route refused unauthenticated: `/`, `/holdings`, `/analysis`, `/income`, `/upload`,
  `/accounts/1`, `/settings`, `/settings/people`, `/settings/accounts`, `/settings/accounts/1`,
  `/settings/tax` → 302 to `/login?next=…`. Only `/login` and `/healthz` answer 200.
- Single-fetch data routes (`/_root.data`, `/settings/people.data`, `/holdings.data`,
  `/accounts/1.data`, `/settings/tax.data`, and with `?_routes=…`) return a `SingleFetchRedirect`
  to `/login` — **no loader data leaks**.
- Unauthenticated POSTs to all five write routes, and to `/settings/people.data`, are redirected;
  `select count(*) from person where name='HACKED'` → 0.
- Cookie forgery: unsigned payload, tampered signature, forged payload with a borrowed signature,
  empty value, and `garbage.garbage` are all rejected → 302 to `/login`. The cookie is genuinely signed.
- Cookie attributes correct: `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age=2592000` (30 days),
  and `Secure` present iff `X-Forwarded-Proto: https` (case-insensitive; `https,http` → leftmost wins).
- The password never appears in `qa3.log` (`grep -c` → 0) or on any error page. Failed logins log
  `Failed login attempt.` and `Failed login attempt from 203.0.113.9.` with `X-Forwarded-For`, as designed.
- Wrong password, empty password and a password of the wrong length all return the same
  *Incorrect password.* with no `Set-Cookie` — no length or content oracle.
- Path-normalisation bypasses: `/healthz/../settings/people`, `/HEALTHZ`, `/healthz/`, `/.data`,
  `/settings/people/` — all refused or 404. Nothing normalises *into* the open list.
- Open-redirect payloads that are correctly blocked: `//evil.com`, `///evil.com`, `/\evil.com`,
  `/\/evil.com`, `\\evil.com`, `https://evil.com`, `javascript:alert(1)`, `/..//evil.com`,
  `/%2f%2fevil.com`, `/%09/evil.com` **when percent-encoding survives** (only the decoded tab escapes —
  finding 1). `Host: evil.com` → 403.
- Static bundles are ungated (documented) but carry no household data: `grep -c "Rivera\|Fidelity"` → 0.

**Config validation** — every one of these fails with a message naming the variable:
`DATABASE_URL` missing / empty / `notaurl` / `mysql://…`; `PORT` `0` / `-1` / `70000` / `abc` / `3000.5`;
`PRICE_POLL_INTERVAL_MINUTES` `0` / `1441` / `x`; `MAX_UPLOAD_MB` `0` / `-1`;
`MARKET_TIMEZONE=Mars/Phobos`; `TZ=!!!garbage`; `AUTH_PASSWORD` without `SESSION_SECRET`;
`AUTH_PASSWORD` with `SESSION_SECRET=` (empty read as unset). Valid values accepted: `PORT=" 3000 "`,
`TZ=utc`, `TZ=+05:00`, `MARKET_TIMEZONE=UTC`, `postgresql://` scheme.

**`/healthz`**
- Database reachable, migrations current → 200 `{"status":"ok","database":true,"migrations":"current"}`.
- Pointed at a non-existent database → 503 `{"status":"unhealthy","database":false,…}`.
- Pointed at a dead port → 503 (bounded by `connectionTimeoutMillis: 5000`, no hang).
- `POST /healthz` → 405. Reachable without credentials in both gate modes.

**Error disclosure, dev vs prod**
- Dev leaks the raw message (`invalid input syntax for type bigint: "abc"`) — documented at
  ARCHITECTURE.md §7.6 and `docs/operating.md`.
- Production build (`react-router build` + `react-router-serve`) replaces it with
  `Unexpected Server Error`; `grep -c "bigint"` on the body → 0. The documented claim holds.
- The `DATABASE_URL` password never reaches the page or the log: with
  `postgres://portfolio:SUPERSECRETPW@127.0.0.1:55999/qa3` the page shows only
  `connect ECONNREFUSED 127.0.0.1:55999` and `grep -c SUPERSECRETPW` on both page and log → 0.

**First run and empty states** (verified against a freshly migrated, unseeded `qa3`)
- No people → *"Start here… Settings → People"*. One person, no accounts → *"One more step… Settings
  → Accounts"*. One of each → prompt gone. Suppressed inside `/settings` and shown on `/`, `/holdings`.
- `/settings/accounts` with no people → the pointer at People replaces the add form.
- Tax page seeds and reads `23.8`.

**Misc**
- Unknown route `/nope` → **404** `No route matches URL "/nope"` (in both gate modes).
- The open-instance banner renders on every page while `AUTH_PASSWORD` is unset, and disappears when
  it is set.
- Browser pass over the real forms (Playwright/Chromium): no uncaught page errors, no console errors
  other than a 404 for `/favicon.ico` (no icon file in `public/`, and `root.tsx` declares no
  `<link rel="icon">` — cosmetic only).
- Refusals retain what was typed everywhere I checked: people rename box, tax rate box, account
  create form.

---

# Documented limitations, not bugs

Checked against DESIGN.md §14, ARCHITECTURE.md §7.6, `docs/operating.md`, `docs/developing.md`
"What does not exist", and `docs/guide/`. Each of these looked like a finding and is explicitly
accepted in writing, so it is **not** reported above.

1. **No login rate limiting, delay, attempt counter or lockout.** Verified: 25 rapid wrong passwords
   all return 200 and the correct password still works immediately after.
   → `docs/operating.md:262-265`, and on the internet-exposure checklist at `:328`.
2. **The session cookie carries an unsalted SHA-256 of `AUTH_PASSWORD`, base64-decodable.** Verified:
   the payload decodes to `{"credential":"417b00ea…"}` which equals `sha256("hunter2-correct-horse")`.
   Combined with plain HTTP by default, a captured cookie yields an offline-crackable password hash.
   → `docs/operating.md:279-284`, which prescribes `openssl rand -hex 32` as the mitigation.
3. **The cookie has no server-side expiry**; `Max-Age` is an instruction to the browser only.
   → `docs/operating.md:286-288`.
4. **No CSRF token anywhere**; `SameSite=Lax` is the whole defence, and an *open* instance has none
   at all. → `docs/operating.md:271-277`.
5. **No security headers** (no CSP/HSTS/X-Frame-Options/X-Content-Type-Options). Verified absent.
   → `docs/operating.md:279`.
6. **Uncaught error messages reach the page in dev.** → ARCHITECTURE.md §7.6 "Error disclosure" row,
   plus the dev/prod note at `docs/operating.md:340`.
7. **Static assets and `public/` are served ahead of the router and are not gated.**
   → ARCHITECTURE.md §7.6 "Enforcement point" row, `docs/operating.md:255-258`.
8. **`/healthz` needs no credentials and discloses pending migration filenames** as a version
   fingerprint. → `docs/operating.md:305-308`, spec `foundation/08`.
9. **`AUTH_PASSWORD=` (empty) reads as unset and serves the instance wide open with no startup error.**
   Verified. → `docs/operating.md:298-302`.
10. **`X-Forwarded-*` is trusted unconditionally**, so a client that can reach the app directly can
    flip its own cookie's `Secure` flag. Verified; it grants no access and affects only the sender.
    → `forwarded.server.ts:18-33`, ARCHITECTURE.md §7.6, DESIGN.md §10.1.
11. **Person names are deliberately not unique**, so double-submitting the add form is not a defect.
    → `people.server.ts:43-46`.
12. **No reopen control for a closed account**, even though several refusal messages say "Reopen it
    from Settings". → `docs/guide/settings.md:90-93`, `docs/guide/people-and-accounts.md:97`,
    `docs/guide/when-something-is-refused.md:20`.
13. **The set-balance form cannot record an overdrawn bank account** (sign derived from `kind`).
    → DESIGN.md §14 item 8.
14. **Configuration is parsed lazily, so a dev server starting means nothing.**
    → `docs/developing.md:33-37`. (Finding 9 above is the narrower gap this does not cover:
    `npm start` and the spec's "startup fails" wording.)
15. **No linter, formatter or pre-commit hooks.** → `docs/developing.md:513-529`.

### Doc/UX observations (labelled, not counted as defects)

- `docs/guide/settings.md:88` says a closed account *"will not accept a typed balance"*; in practice
  its whole `/accounts/:id` page 404s first, so the refusal message the guide implies never appears.
  (Related to finding 13; the 404 itself is in the account-drill-down area rather than this one.)
- `/favicon.ico`, `/manifest.webmanifest`, `/sw.js`, `/registerSW.js` all 404 and log
  `Error: No route matches URL …` on every page view. `public/` contains only `fonts/`. Cosmetic,
  and the PWA slice is listed as not built yet.
