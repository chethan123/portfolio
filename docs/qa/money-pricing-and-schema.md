# QA findings — money/numeric core, pricing subsystem, schema & tooling

Instance: **port 5184 / database `qa4`** (Postgres 16.13 on 127.0.0.1:55432).
Repo `/home/user/portfolio` @ `b7f94f3`, branch `claude/amazing-hypatia-k9dcfy`.
Working tree left **clean**; `qa4` left at its seeded baseline (net worth `690469.2082`, verified after
every experiment). A throwaway database `qa4_mig` was created for migration/seed/provider experiments
and has been dropped. No files under `app/`, `server/`, `migrations/`, `scripts/` or `tests/` were edited.

**Headline claim under attack:** *"`numeric` is never round-tripped through a JavaScript number."*
For values that are **already stored**, the claim holds — I could not break it (see
*Tried and did NOT break*). It fails in exactly one direction: the **write** boundary in
`price-provider.server.ts`, where a provider float becomes a money column via `toFixed`. That is
finding **#1**, and it loses a real position's entire value.

---

## 1. A sub-cent quote price is stored as `0.0000` and marked fresh — the holding is silently valued at $0.00 and a real historical close is overwritten with zero

**Severity: Critical** (money wrong, silently; permanent corruption of the `price_daily` spine)

`toProviderQuote` rejects a non-positive price *before* converting it, then converts with
`value.toFixed(4)`. Any price in `(0, 0.00005)` therefore passes the "a non-positive price is not a
price" guard and lands in `quote.price` / `price_daily.close` as **exactly `0.0000`**, with
`is_stale = false`. `holding_valued` then reports `value = 0.0000` **and `is_priced = true`**, so the
coverage line ("17 of 18 holdings") still claims the total is as complete as it was. This is precisely
the failure `prices.server.ts` and DESIGN.md §6.2 say they refuse: *"never zero, never null into a sum."*

**Repro (unit level — shows the boundary conversion):**

```sh
source /opt/nvm/nvm.sh && nvm use 24.19.0
node --input-type=module -e '
import { toProviderQuote } from "./app/lib/price-provider.server.ts";
console.log(toProviderQuote(
  { symbol:"AAPL", currency:"USD", quoteType:"EQUITY",
    regularMarketPrice: 0.000012345, regularMarketTime: new Date() },
  new Date()));'
```

Observed: `{ symbol: 'AAPL', price: '0.0000', quoteType: 'EQUITY', ... }`
Expected: either the real digits, or — since `numeric(20,4)` cannot hold them — **no usable price**
(`null`), which the caller already knows how to handle (keep the last price, mark stale).

**Repro (end to end through the real `refreshQuotes` write path):**

```sh
createdb-style scratch:  psql -h 127.0.0.1 -p 55432 -U portfolio -d postgres \
  -c "create database qa4_mig"
cd /home/user/portfolio
DATABASE_URL=postgres://portfolio:portfolio@127.0.0.1:55432/qa4_mig node ./server/migrate.ts
DATABASE_URL=... node ./scripts/seed-demo.ts
# then call refreshQuotes() with a provider whose quotes come from the real
# toProviderQuote() over { symbol:"AAPL", regularMarketPrice: 0.000012345, ... }
# (script kept at scratchpad/work/probe-refresh.ts, mode "subcent")
```

Observed (`AAPL`, quantity `130.67219400`, previously `183.4711`):

```
report: { requested: 14, priced: 1, stale: 13, closes: 1 }

  account_name     | instrument_name |   quantity   | price  | value  | is_priced | is_stale
 Fidelity Individual | Apple Inc.    | 130.67219400 | 0.0000 | 0.0000 | t         | f

  networth   | priced | total          (before: 690469.2082 | 17 | 18)
 666494.6370 |     17 |    18

 -- price_daily, the "immutable spine":
     date    |  close
  2026-08-25 | 183.4711
  2026-08-24 |   0.0000   <-- a real close for a PAST day, overwritten with zero
  2026-08-21 | 183.6657
```

**Repro (UI, on port 5184 — the same stored state):**

```sh
psql -h 127.0.0.1 -p 55432 -U portfolio -d qa4 \
  -c "update quote set price='0.0000', is_stale=false where instrument_id=(select id from instrument where symbol='AAPL');"
curl -s --noproxy '*' http://localhost:5184/ ; curl -s --noproxy '*' http://localhost:5184/holdings
# restore:
psql ... -c "update quote set price='183.4711' where instrument_id=(select id from instrument where symbol='AAPL');"
```

Observed on Overview: `Total net worth $666,494.64` (−$23,974.57) with the line underneath still
reading *"The figure and the line are 17 of 18 holdings. The rest have never been priced."*
Observed on Holdings: `Apple Inc. … 130.672194  $0.00  $0.00  $14,040.98  −$14,040.98` — no stale
marker, no unpriced marker, nothing that says the price is unusable.

**Expected:** a price the money column cannot represent is *no price*. `decimal()` should return
`null` when `toFixed(scale)` rounds a positive input to zero, so the instrument keeps its last known
price and is flagged stale — the path already written for "the symbol did not come back".

**Cause:** `app/lib/price-provider.server.ts:105-107` (`decimal()` = `value.toFixed(scale)`, no
zero-after-rounding check) combined with the positivity guard at
`app/lib/price-provider.server.ts:237-242`, which tests the **unrounded** float.

**Reachability:** requires a quote below $0.00005. Yahoo genuinely quotes such prices for OTC shells
and for USD-denominated crypto pairs (which pass the USD currency guard), and a mis-scaled provider
payload would do it too. The threshold is exact: `0.00005 → "0.0001"` (fine), `0.00004999 → "0.0000"`.

---

## 2. The Overview home page returns 500 (`numeric field overflow`) whenever net worth has grown more than ~10,000× over the chart range

**Severity: High** (home page dead, all four ranges, not recoverable from the UI)

`netWorthChange` casts the percentage to `numeric(10, 4)` — max `999999.9999`. A household whose
recorded net worth at the start of the window was small relative to today overflows that cast and
Postgres aborts the statement. The React Router error boundary renders "Something went wrong /
numeric field overflow" for the whole page.

**Repro (realistic data, no adversarial values at all):**

```sh
psql -h 127.0.0.1 -p 55432 -U portfolio -d postgres -c "create database qa4_mig"
cd /home/user/portfolio
export DATABASE_URL=postgres://portfolio:portfolio@127.0.0.1:55432/qa4_mig
node ./server/migrate.ts
psql -h 127.0.0.1 -p 55432 -U portfolio -d qa4_mig <<'SQL'
insert into person (name) values ('Sam');
insert into account (name,institution,kind,owner_id,tax_treatment)
  select 'Checking','Ally','bank',id,'taxable' from person where name='Sam';
insert into account (name,institution,kind,owner_id,tax_treatment)
  select 'Workplace 401(k)','Empower','401k',id,'tax_deferred' from person where name='Sam';
-- a $25 checking balance recorded 400 days ago
insert into position_set (account_id,as_of_date,source)
  select id, current_date-400,'manual' from account where name='Checking';
insert into holding (position_set_id,instrument_id,quantity)
  select ps.id,i.id,25.00000000 from position_set ps, instrument i
  where ps.account_id=(select id from account where name='Checking') and i.symbol='USD';
-- a $500,000 401(k) statement today
insert into position_set (account_id,as_of_date,source)
  select id, current_date,'manual' from account where name='Workplace 401(k)';
insert into holding (position_set_id,instrument_id,quantity)
  select ps.id,i.id,500000.00000000 from position_set ps, instrument i
  where ps.account_id=(select id from account where name='Workplace 401(k)') and i.symbol='USD';
SQL
node --input-type=module -e '
import { createDatabase } from "./app/lib/db.server.ts";
import { netWorthChange } from "./app/lib/valuation.server.ts";
const db = createDatabase(process.env.DATABASE_URL);
for (const d of [30,90,365]) {
  const since = new Date(Date.now()-d*86400000).toISOString().slice(0,10);
  try { console.log(d, await netWorthChange(since, db)); }
  catch (e) { console.log(d, "THREW", e.message); }
}
await db.destroy();'
```

Observed:

```
netWorth now: { amount: '500025.0000', coverage: { known: 2, total: 2 } }
netWorthChange(2026-07-26) [30d]  => THREW numeric field overflow
netWorthChange(2026-05-27) [90d]  => THREW numeric field overflow
netWorthChange(2025-08-25) [365d] => THREW numeric field overflow   <-- 1Y is DEFAULT_RANGE
```

**Repro (end to end over HTTP on port 5184):** the same overflow, reached from a large holding —

```sh
psql -h 127.0.0.1 -p 55432 -U portfolio -d qa4 \
  -c "update holding set quantity='100000000000.00000000' where id=13;"
curl -s --noproxy '*' -o /dev/null -w '%{http_code}\n' http://localhost:5184/   #  -> 500
curl -s --noproxy '*' -o /dev/null -w '%{http_code}\n' http://localhost:5184/holdings  # -> 200
psql ... -c "update holding set quantity='286.44219100' where id=13;"           # restore
```

Log (`scratchpad/qa4.log`):

```
    at netWorthChange (/home/user/portfolio/app/lib/valuation.server.ts:652:15)
  severity: 'ERROR', code: '22003',
  detail: 'A field with precision 10, scale 4 must round to an absolute value less than 10^6.'
```

**Expected:** an implausibly large percentage is a display problem, not a 500. Either widen the cast,
or return `null` (which the type already allows — `percent: string | null` — and which the screen
already renders as "no percentage") when the ratio will not fit.

**Cause:** `app/lib/valuation.server.ts:670` — `cast((present.amount - past.amount) / abs(past.amount) * 100 as numeric(10, 4))`.
The `case when past.amount = 0 then null` arm guards division by zero but nothing guards magnitude.

**Threshold, exactly:** overflow when `|current − previous| / |previous| ≥ 10,000`.

---

## 3. `NaN` is legal in every money and quantity column; it 500s Holdings and Analysis, reports net worth as `$0.00`, and blanks the net-worth chart

**Severity: High** (silently wrong money on one screen, hard 500 on two others; no CHECK anywhere)

`numeric(20,8)` and `numeric(20,4)` accept `'NaN'` in Postgres (only `Infinity` is refused by a
constrained typmod). No column in `migrations/0001_initial_schema.sql` has a check against it. `NaN`
poisons `sum()`, so **one bad row makes the whole household's total `NaN`**. The three consumers then
disagree about what that means:

* `format.ts` strips non-digits, so `formatMoney("NaN")` returns **`"$0.00"`** — a wrong figure with
  no error;
* `money.ts` `toUnits("NaN", 4)` builds `BigInt("NaN0000")` and **throws**;
* `toPlotValue("NaN")` returns `NaN` and the SVG renders `points="0,NaN …"` — the line vanishes.

**Repro A — holdings quantity:**

```sh
psql -h 127.0.0.1 -p 55432 -U portfolio -d qa4 -c "update holding set quantity='NaN' where id=244;"
for p in / /holdings /analysis /income; do
  curl -s --noproxy '*' -o /dev/null -w "$p -> %{http_code}\n" http://localhost:5184$p; done
psql ... -c "update holding set quantity='42000.00000000' where id=244;"   # restore
```

Observed:

```
/         -> 200      Overview headline: "Total net worth $0.00   0.0% / $0.00"
                      coverage line still: "17 of 18 holdings"
                      account rows below still add to ~$648,000
/holdings -> 500      "Something went wrong — Cannot convert NaN0000 to a BigInt"
/analysis -> 500      same
/income   -> 200
```

Stack traces from `scratchpad/qa4.log`:

```
SyntaxError: Cannot convert NaN0000 to a BigInt
    at toUnits (/home/user/portfolio/app/lib/money.ts:63:17)
    at compareDecimal (/home/user/portfolio/app/lib/money.ts:268:17)
    at compareBy (/home/user/portfolio/app/lib/holdings-view.ts:274:14)
    at sortHoldings (/home/user/portfolio/app/lib/holdings-view.ts:322:24)
    at loader (/home/user/portfolio/app/routes/holdings.tsx:164:34)

SyntaxError: Cannot convert NaN0000 to a BigInt
    at toUnits (/home/user/portfolio/app/lib/money.ts:63:17)
    at group (/home/user/portfolio/app/lib/allocation.ts:203:50)
    at allocationByPerson (/home/user/portfolio/app/lib/allocation.ts:239:10)
    at loader (/home/user/portfolio/app/routes/analysis.tsx:439:15)
```

**Repro B — a hand-typed net-worth point:**

```sh
psql -h 127.0.0.1 -p 55432 -U portfolio -d qa4 -c "update manual_networth set amount='NaN' where date='2020-12-31';"
curl -s --noproxy '*' "http://localhost:5184/?range=all" | grep -o 'points="[^"]\{0,60\}'
psql ... -c "update manual_networth set amount='237664.5007' where date='2020-12-31';"  # restore
```

Observed: `points="0,NaN 74.9279538904899,NaN 150.67929188966653,NaN …"` — **both** series (manual
*and* computed) disappear, y-axis labels read `0 0 0`, HTTP 200 with no error anywhere.

**Also accepted with no complaint** (verified in a transaction, then rolled back):
`holding.cost_basis_per_share = 'NaN'`, `manual_networth.amount = 'NaN'`.
(`app_setting.capital_gains_rate` is *accidentally* safe — Postgres sorts `NaN` above all numerics, so
`check (… <= 100)` rejects it.)

**Expected:** either a `check (quantity = quantity)` / `check (price = price)` style guard on every
money and quantity column (the schema already uses CHECK constraints liberally), or `toUnits`
refusing a non-decimal string with a named error instead of a raw `BigInt` `SyntaxError` — and
`formatMoney` never rendering an unparseable value as `$0.00`.

**Cause:** `migrations/0001_initial_schema.sql:184,208,217` (and `manual_networth.amount`) declare the
columns with no NaN guard; `app/lib/money.ts:57-65` assumes the string is a decimal;
`app/lib/format.ts:18-25` (`parse`) strips non-digits, turning nonsense into `0`.

**Reachability:** *not* reachable through the app's own forms or CSV ingest — `input.server.ts`
(`/^\d+(\.\d+)?$/`) and `money.ts` `normaliseFigure` both refuse `NaN`. It is reachable by anything
that writes the database directly: a restore from a partly-corrupt dump, a future migration, a manual
`psql` repair (which `docs/runbook.md` prescribes), or any new write path that forgets the guard.
This is reported as a *missing-constraint / missing-defence* defect, not as a user-reachable one.

---

## 4. `sum(value)` is cast to `numeric(20,4)` with no guard, so several individually-legal holdings overflow it and 500 the Overview and Analysis pages

**Severity: Medium** (needs absurd but form-accepted quantities; failure is exactly the one the
existing per-row guard was written to prevent)

`positions.server.ts:246` (`fitsTheMoneyColumn`) exists precisely because *"the write succeeds, and
every reader that goes through `holding_valued` — Holdings and Analysis — then throws on every
request."* It checks **one row's** `quantity × perShare` against `10^16`. Nothing checks the **sum**,
which is cast to `numeric(20,4)` in three places.

**Repro:**

```sh
psql -h 127.0.0.1 -p 55432 -U portfolio -d qa4 <<'SQL'
update holding set quantity='600000000000.00000000' where id=13;
update quote set price='9999.9999' where instrument_id=(select instrument_id from holding where id=13);
update holding set quantity='600000000000.00000000' where id=26;
update quote set price='9999.9999' where instrument_id=(select instrument_id from holding where id=26);
select cast(coalesce(sum(value),0) as numeric(20,4)) from holding_valued;
SQL
for p in / /holdings /analysis /income; do
  curl -s --noproxy '*' -o /dev/null -w "$p -> %{http_code}\n" http://localhost:5184$p; done
```

Observed — each row's own `value` is `5999999940000000.0000`, comfortably inside `numeric(20,4)` and
accepted by `fitsTheMoneyColumn`; the sum is not:

```
ERROR: numeric field overflow
DETAIL: A field with precision 20, scale 4 must round to an absolute value less than 10^16.
/         -> 500
/holdings -> 200
/analysis -> 500
/income   -> 200
```

Restore with the four inverse `update`s (baseline: VTI `286.44219100` @ `297.6195`,
VXUS `445.42012700` @ `62.6236`).

**Expected:** the same treatment the per-row case gets — refuse the write, or make the aggregate not
throw. A total that cannot be represented should not take the two main screens down with no way to
correct the offending row from the UI (Holdings *is* the only screen the position editor is reachable
from, which is the argument `positions.server.ts:220-245` itself makes).

**Cause:** `app/lib/valuation.server.ts:214` (`readTotal`), `:396` (`accountTotals`), `:463`
(`accountTotal`) — `cast(coalesce(sum(value), 0) as numeric(20, 4))`, against
`app/lib/positions.server.ts:246-253` which only ever sees one row.

**Reachability through the UI:** `signedQuantity` allows 12 integer digits, so two edits of ~10^10
shares of any instrument priced above ~$500,000/share (BRK.A) — or of any instrument whose quote is
above ~$5,000 with 10^12 shares — reach it without touching the database directly.

---

## 5. Nothing in the schema forbids a zero or negative price, and a negative price silently subtracts from net worth

**Severity: Medium** (missing constraint; the invariant is asserted in prose and in one code path only)

`price-provider.server.ts:237` says *"Negative is meaningless besides: the sign of a position lives in
its quantity, never in its price (§2)"* and refuses it — but `quote.price numeric(20,4) not null` and
`price_daily.close numeric(20,4) not null` carry no `check (… > 0)`. Any other writer (a manual price
form, a migration, a restore, a `psql` repair) can put a negative there and every screen renders it
without complaint.

**Repro:**

```sh
psql -h 127.0.0.1 -p 55432 -U portfolio -d qa4 \
  -c "update quote set price='-50.0000' where instrument_id=(select instrument_id from holding where id=52);" \
  -c "update quote set price='0.0000'  where instrument_id=(select instrument_id from holding where id=39);" \
  -c "select account_name, instrument_name, quantity, price, value, unrealized from holding_valued where price <= 0;"
for p in / /holdings /analysis; do curl -s --noproxy '*' -o /dev/null -w "$p -> %{http_code}\n" http://localhost:5184$p; done
```

Observed — 200 everywhere, and the numbers are quietly wrong:

```
 Fidelity Individual | Microsoft Corporation |  77.51235400 | -50.0000 | -3875.6177 | -16940.8908
 Fidelity Individual | Apple Inc.            | 130.67219400 |   0.0000 |     0.0000 | -14040.9755
Overview: "Total net worth $636,465.68"   (baseline $690,469.21)
```

A negative close in `price_daily` is accepted too:
`insert into price_daily (instrument_id, date, close) values (…, '2026-01-05', -12.34)` → `INSERT 0 1`.

Restore: `update quote set price='337.4086' …id=52`, `price='183.4711' …id=39`.

**Expected:** `check (price > 0)` on `quote.price` and `check (close > 0)` on `price_daily.close` —
the design states the rule as absolute, and the schema is where an absolute rule belongs.

**Cause:** `migrations/0001_initial_schema.sql:208` and `:217`.

---

## 6. `scripts/seed-demo.ts` destroys real data once its marker exists, contradicting its own stated guarantee

**Severity: Medium** (unrecoverable data loss; dev-only script, no `--force`, no prompt)

The script's header says *"It refuses to touch data it did not create"* and *"The one thing this
script must never be is a way to lose a real portfolio."* The guard is `to_regclass('public.demo_seed')
is not null → return true` (`scripts/seed-demo.ts:681-687`), which is a fact about the **first** run,
not about what is in the database **now**. Everything added after that first seed is wiped without a
word.

**Repro (on a throwaway db — do not run this against anything you want to keep):**

```sh
export DATABASE_URL=postgres://portfolio:portfolio@127.0.0.1:55432/qa4_mig
node ./server/migrate.ts && node ./scripts/seed-demo.ts        # first seed: marker created
psql -h 127.0.0.1 -p 55432 -U portfolio -d qa4_mig \
  -c "insert into person (name) values ('REAL USER');" \
  -c "insert into account (name,institution,kind,owner_id,tax_treatment)
      select 'MY REAL SAVINGS','Real Bank','bank',id,'taxable' from person where name='REAL USER';"
node ./scripts/seed-demo.ts                                     # second seed
psql ... -tAc "select count(*) from account where name='MY REAL SAVINGS';"
psql ... -tAc "select count(*) from person  where name='REAL USER';"
```

Observed:

```
Replacing the previous generation (the `demo_seed` marker is present).
0
0
```

Both rows gone. The script printed one line about "the previous generation" and never mentioned that
two rows it had not created were among the casualties.

**Expected:** the `PRISTINE_PROBE` that guards the *first* run should also guard a re-run — i.e. on a
marked database, refuse if anything exists that this run did not write, or at minimum name what is
about to be destroyed and require confirmation.

**Cause:** `scripts/seed-demo.ts:681-687` (marker present ⇒ unconditional `return true`) and the
unconditional `for (const statement of WIPE)` at `:1186`.

**Verified good alongside it:** the seed is genuinely idempotent (two consecutive runs both leave
`2 people / 6 accounts / 124 position sets / 280 holdings / 11062 closes / 8 manual points` — no
doubling), the whole thing is one transaction, and the pristine guard does correctly refuse an
unmarked database that holds data.

---

## 7. One malformed `regularMarketTime` aborts the entire refresh transaction, so every other instrument loses its price too

**Severity: Low** (needs an implausible provider payload; the same class of blast radius the
per-symbol currency guard and the yield ceiling were written to prevent)

`instantOf` accepts any finite number as epoch seconds (`price-provider.server.ts:194`). A large
finite value produces an `Invalid Date`, which reaches `quote.as_of` and Postgres rejects the whole
statement. `refreshQuotes` catches a throwing *provider*, but the write loop is outside that `try`.

**Repro:** drive `refreshQuotes` with two quotes, one carrying `regularMarketTime: 1e300`:

```
refreshQuotes THREW: error invalid input syntax for type timestamp with time zone:
  "0NaN-NaN-NaNTNaN:NaN:NaN.NaN+NaN:NaN"
-- VTI, whose quote was perfectly good, is still is_stale = true with its old price
```

`marketDateOf` on the same value throws `RangeError: Invalid time value` before it gets that far in
other orderings. Related, lower-stakes: `regularMarketTime: 1787000000000` (the endpoint switching to
epoch *milliseconds*, which the module's own comment says has changed before in the other direction)
yields `marketDate = 58597-10-10` and writes a `price_daily` row dated in the year 58597.

**Expected:** `instantOf` should validate the constructed `Date` (`Number.isNaN(d.getTime())`) the way
it already does for the `Date` and `string` branches, and fall back to `fetchedAt`.

**Cause:** `app/lib/price-provider.server.ts:208` — `if (typeof value === "number" && Number.isFinite(value)) return new Date(value * 1000);`
(no check on the result), versus `:205` and `:210-213` which do check the result.

---

## 8. A migration file whose name sorts before already-applied ones is applied silently, out of order

**Severity: Low**

**Repro:**

```sh
mkdir -p /tmp/migtest && cp -r /home/user/portfolio/migrations /tmp/migtest/ && cd /tmp/migtest
DATABASE_URL=…/qa4_mig node /home/user/portfolio/server/migrate.ts     # applies 0001..0005
printf 'create table out_of_order_marker (id int);\n' > migrations/0000_late_arrival.sql
DATABASE_URL=…/qa4_mig node /home/user/portfolio/server/migrate.ts
```

Observed:

```
  applied 0000_late_arrival.sql
  skip    0001_initial_schema.sql (already applied)
  …
Migrations OK — applied 1.
```

`out_of_order_marker` exists. Expected: at least a warning that a migration numbered below the
high-water mark has just been applied — the realistic way in is a merge landing a branch whose
migration was numbered before another branch's. The runner's own doc (`server/migrations.ts:44-50`)
says files are applied "in the order it must be applied", which this quietly is not.

**Cause:** `server/migrations.ts:140-146` — the loop filters on `recorded.has(filename)` only; there
is no comparison against the greatest applied filename.

---

## 9. A `demo_seed` table of the wrong shape makes the seeder fail with a raw driver error instead of a refusal

**Severity: Low**

`create table if not exists demo_seed …` (`scripts/seed-demo.ts:1189`) never repairs an existing table
of a different shape, and the guard above it treats *any* `demo_seed` relation as its own.

**Repro:** on a marked database, `drop table demo_seed; create table demo_seed (only_row boolean primary key default true);`
then re-run the seeder.

Observed:

```
Replacing the previous generation (the `demo_seed` marker is present).
Seeding failed. Nothing was written.
error: column "seeded_at" of relation "demo_seed" does not exist
```

Nothing is corrupted (the transaction rolls back correctly), but the message is a driver error rather
than one of this script's carefully written refusals. Expected: verify the marker's shape, or catch
and report "the `demo_seed` marker is not the one this script writes".

---

## 10. `npm run db:types` against a demo-seeded database silently adds `demo_seed` to the committed type surface

**Severity: Low** (tooling hygiene)

`package.json`'s `db:types` introspects `${DATABASE_URL:-…portfolio_test}`. Regenerating against a
database that has been through `seed-demo.ts` picks up the seeder's private marker table.

**Repro / evidence:**

```sh
npx kysely-codegen --dialect postgres --numeric-parser string --date-parser string \
  --out-file /tmp/database.regen.ts --url postgres://portfolio:portfolio@127.0.0.1:55432/qa4
diff <(grep -v '^// ' /tmp/database.regen.ts) <(grep -v '^// ' app/lib/database.generated.ts)
```

Observed — the *only* difference, which is good news for schema drift and bad news for this:

```
< export interface DemoSeed { only_row: Generated<boolean>; seeded_at: Generated<Timestamp>; seeded_by: string; }
< …
<   demo_seed: DemoSeed;
```

Expected: the codegen invocation excludes `demo_seed`, or the doc that tells you to run it names the
database to run it against. (Confirmed positive: `app/lib/database.generated.ts` is otherwise **exactly**
what the five migrations produce — no drift.)

---

## 11. Conspicuously untested critical paths (coverage observation, not a defect)

`npm run test:coverage` passes (51 files / 746 tests). What it leaves uncovered in this area:

| Path | Cover | Why it matters here |
|---|---|---|
| `app/components/money-cell.tsx` | **0%** | `Delta`'s "classify on the printed figure, not the stored one" rule — the file's own comment calls it *"subtle enough that the second copy would have been the one that got it wrong"* — is executed by no test. |
| `app/routes/settings/tax.tsx` | **0%** | The form that sets `capital_gains_rate`, which multiplies money on Analysis. Whole `app/routes/settings/` directory is 0%. |
| `app/lib/price-provider.server.ts:407-432` | uncovered | `yahooPriceProvider().getQuotes` — the live batch path, including the `for (const entry of raw)` that a non-array response would hit. Only `toProviderQuote` and `probeSymbol` are tested. |
| `server/migrate.ts` | **0%** | The CLI. Exercised only by `scripts/smoke-test.sh`, which cannot run here (see below). |
| `server/validate-config.ts` | **0%** | Startup config validation. |
| `app/routes/analysis.tsx` | 13.7% | The screen that does the most money arithmetic per render. |

---

## Tried and did NOT break

* **The headline claim, for stored values.** Every money/quantity read path returns a decimal string
  and stays one. `server/db.ts` is the *only* pool construction site in the repo (verified by grep
  across `app/ server/ scripts/ tests/`), so the `numeric`/`int8`/`date` string parsers are universal.
  `valuation.server.ts`, `allocation.ts`, `holdings-view.ts`, `money.ts`, `format.ts` and
  `statement.ts` do all arithmetic in SQL `numeric` or in `BigInt`. `Number()` appears only on row
  **counts** (`coverage.known/total`, `priceFreshness`, `people.server.ts`) and on chart geometry.
* **Precision at magnitude.** `toUnits("12345678901234567890.12345678", 8)` →
  `1234567890123456789012345678n` exactly. `formatMoney("9007199254740993.1234")` →
  `"$9,007,199,254,740,993.12"` (past `Number.MAX_SAFE_INTEGER`, exact). `formatMoney("0.30000000000000004", 4)`
  → `"$0.3000"`. A 3×10^13 net worth rendered exactly on Analysis: `$29,761,950,605,218.43`.
* **Rounding.** `toUnits` is half-away-from-zero at the stated scale in both directions
  (`0.00005 → 1n`, `-0.00005 → -1n`, `0.000049 → 0n`), and `format.ts` rounds the same way, so a
  total and its label cannot round in opposite directions.
* **The aggregates-agree invariant, under adversarial data.** With quantities
  `0.33333333 / 7.77777777 / 0.00000001 / -0.00000001` against prices `3.3333 / 77.7777`, SQL ground
  truth `527802.7574`, the Overview headline `$527,802.76`, and all three Analysis totals
  `$527,802.76` agreed exactly. A tiny negative quantity rounds to `0.0000` with no phantom minus sign.
* **Migration idempotency.** Fresh database → run the migrator 1st, 2nd, 3rd time: applied 5, then
  "nothing pending" twice. `/healthz` reports `"migrations":"current"` with `pendingMigrations: []`.
* **Partial migrations.** A file containing `create table … ; insert … ; select 1/0;` rolls back
  **whole** — no table, no row, no ledger entry — and the CLI exits **1**. Confirmed by
  `to_regclass()` returning null and `schema_migrations` unchanged.
* **Provider unreachable / throwing.** `refreshQuotes` with a provider that throws:
  `{ requested: 14, priced: 0, stale: 14, closes: 0 }`; every stored price unchanged, every
  instrument flagged. A clean no-op, no blanking, no zeroing. The **real** Yahoo client through this
  environment's proxy behaves the same: `getQuotes` threw
  `"No set-cookie header present in Yahoo's response"` in 130 ms and `probeSymbol("VTI")` returned
  `{"status":"unavailable"}` in 26 ms without throwing.
* **Provider returning junk.** `regularMarketPrice` of `0`, negative, `null` or `NaN` → no quote
  written, instrument marked stale. A quote for a symbol nobody asked about → skipped. A payload
  missing `symbol` → dropped. A GBP quote → `CurrencyRefused`, logged, other symbols unaffected. A
  12500% derived yield → `yield_pct` null (not clamped, not an overflow).
* **`market-hours.ts`.** 09:29:59 closed / **09:30:00 open** / 15:59:59 open / **16:00:00 closed**;
  weekends closed; every 2026–2030 holiday in the table matches NYSE (including the observed shifts:
  2026‑07‑03, 2027‑06‑18, 2027‑12‑24, and correctly *no* 2027‑12‑31 for a Saturday New Year). DST
  spring-forward (2026‑03‑08) and fall-back (2026‑11‑01) both resolve through `Intl` with no offset
  error either side. `MARKET_TIMEZONE=UTC` degrades exactly as documented.
* **Poller robustness.** `tick()` catches everything that can throw after `state.running = true`, and
  the only two calls before it (`getConfig()`, cached; `isMarketOpen`, on a config-validated IANA
  zone) cannot realistically throw — I could not construct an unhandled rejection that kills the
  process. Overlap is guarded by `state.running`, cross-process by advisory lock `7295380114023642`
  (distinct from the migration runner's), and the timer is `unref`'d.
* **Schema constraints that do hold.** A second `app_setting` row is refused
  (`app_setting_single_row`); `capital_gains_rate = 'NaN'` is refused (`app_setting_rate_range`, since
  Postgres sorts `NaN` above 100); `Infinity`/`-Infinity` are refused by `numeric(20,8)`/`numeric(20,4)`
  typmods; `holding` cannot exist without a position set and therefore without an account; every
  `check (… in (…))` enumeration holds. No empty position set exists in the seeded data.
* **Tooling.** `npm run typecheck` → exit 0, no output. `npm test` → **51 files / 746 tests passing**,
  twice in a row (20.2s then 32.5s), no order dependence, no flakes. `npm run test:coverage` → same,
  exit 0. `npm run build` → exit 0 (only the four React Router v8 future-flag warnings, which are
  informational). Node 24.19.0 throughout.
* **`app/lib/database.generated.ts`** matches the five migrations exactly (see #10 for the one
  spurious extra).

---

## Documented limitations, not bugs

Checked against `DESIGN.md §14`, `docs/developing.md` "What does not exist", `docs/operating.md`,
`docs/runbook.md` and `docs/specs/`. These all *look* like findings and are not:

1. **No migration checksums; editing an applied migration is a silent no-op forever.** Verified
   (appending `drop table account cascade` to an already-applied `0001` changed nothing). Documented
   verbatim in `docs/operating.md:594-604` and `docs/runbook.md:481-483`.
2. **A database ahead of the code reports perfect health.** Verified — with `0004`/`0005` removed from
   disk, `pendingMigrations()` returns `[]` and `/healthz` says `"current"`. Documented verbatim in
   `docs/operating.md:369-376` ("Rolling an image back is completely invisible to health checking").
3. **No "as of" line, no stale banner, no per-row stale marker, no "Refresh now", no manual price
   form, no Settings → Instruments.** `priceFreshness()` is implemented and tested but called by no
   route, and no component reads `isStale`. This is ticket `docs/specs/pricing/05-pricing-ui.md`,
   status `ready-for-agent` — unbuilt work, not a defect. It does mean findings #1 and #5 are
   currently *invisible* to a user, which is worth weighing when that ticket is scheduled.
4. **The Income page is unconditionally empty.** `app/routes/income.tsx` says so in its own header.
   (Minor doc nit: it says *"`quote` carries a yield and an annual dividend per share, but no slice
   has filled them"* — `prices.server.ts` `writeQuote` now does fill them.)
5. **Half-days (day after Thanksgiving, some Christmas Eves) are treated as full sessions**, and years
   past 2030 as holiday-free. Both stated explicitly in `market-hours.ts:56-70`, with the reasoning
   that a wrongly-attempted poll costs one request and cannot corrupt the spine. Verified: 2026‑11‑27
   and 2026‑12‑24 report `open=true`.
6. **A past `price_daily` row can be rewritten by a later poll.** Deliberate, and argued at length in
   `prices.server.ts:36-46`. (Finding #1 abuses this, but the rewrite itself is correct.)
7. **`instrument.symbol` is not unique**; two rows may share a ticker and both get priced. Stated in
   `prices.server.ts:88-96`; `bySymbol` fans out correctly.
8. **`toPlotValue` (`format.ts:187`) is the one sanctioned money→float conversion**, used for chart
   y-coordinates, the Overview allocation bar widths (`overview.tsx:255-266`) and the Analysis donut
   arcs (`analysis.tsx:102`). All three produce pixels or a CSS width and nothing a reader compares or
   sums; the labels beside them come from `formatMoney`/`formatShare` on the digits. Correct as
   designed, not a precision bug.
9. **`scripts/seed-demo.ts` generates money as JavaScript numbers.** Called out in its own header:
   invented figures, and every total it *reports* is computed in SQL through `holding_valued`.
10. **No linter, no formatter, no pre-commit hooks, no `lint` script.** `docs/developing.md`.
11. **Displayed figures rounded to 2dp** (e.g. `690469.2082 → $690,469.21`) — correct behaviour, and
    the stored value is untouched. Not counted as a finding anywhere above.

---

## Environment notes (not repo defects)

* **`bash scripts/smoke-test.sh` cannot run here.** It fails during `docker compose up -d --build`
  because the Docker registry is behind the agent proxy:
  `failed to copy: httpReadSeeker: failed open: unexpected status from GET request to
  https://production.cloudfront.docker.com/… : 403 Forbidden` (pulling `postgres:17-alpine` and
  `caddy:2-alpine`). Exit 1, teardown clean. Nothing about the script itself is wrong. Consequence:
  the container-only assertions — migrations-run-at-startup, restart safety, the runtime image
  contents, and **`scripts/prune-unreachable-deps.mjs` not having over-pruned** — are unverified in
  this environment. (Reading `prune-unreachable-deps.mjs`, one latent gap: `reachable()` follows
  `dependencies` and `optionalDependencies` but not `peerDependencies`, so a peer-only edge into a
  package otherwise reachable solely through the cut edges would be deleted. The smoke test's
  "runtime dependencies intact" loop is what would catch that, and it cannot run here.)
* **Playwright.** `chromium.launch()` with no `executablePath` fails in this sandbox — playwright
  1.62.1 wants build `1234` and only `1194` is installed. **This is not a repo bug**, and I verified
  why: `scripts/capture-screenshots.ts:64,457-458` already reads a `CHROMIUM_EXECUTABLE` environment
  variable and passes it straight to `chromium.launch({ executablePath })`, and
  `docs/developing.md:376` documents it — *"a machine that already has a Chromium can point
  `CHROMIUM_EXECUTABLE` at it instead"*. Confirmed:
  `CHROMIUM_EXECUTABLE=/opt/pw-browsers/chromium-1194/chrome-linux/chrome` → **launched OK**; unset →
  `Executable doesn't exist at /opt/pw-browsers/chromium_headless_shell-1234/…`. A fresh checkout on a
  network-restricted machine can therefore capture screenshots; it just needs that variable set, which
  the developer guide already tells it to do.
