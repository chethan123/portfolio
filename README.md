# Portfolio Tracker

A self-hosted family portfolio and net worth tracker. See [DESIGN.md](DESIGN.md) for the full
design — domain model, ingest, pricing, screens, stack, and the accepted limitations.

## What it looks like

Every screen below is the real application, running against the generated demo household in
[`scripts/seed-demo.ts`](scripts/seed-demo.ts) — two people, six accounts at six institutions,
three years of statements, one holding nobody can price and one loan. **The figures are invented,
the behaviour is not.** The demo deliberately includes the awkward cases, because a screenshot of a
portfolio where everything is priced and everything has a cost basis is a screenshot of the easy
case.

Screenshots follow your GitHub theme; the app follows your system's.

### Overview — what the household is worth

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/overview-dark.png">
  <img alt="The overview: total net worth, a three-year chart, the account list and allocation by account" src="docs/screenshots/overview-light.png">
</picture>

The one figure the household actually asks for, and the line behind it. The range control is a URL,
so a chosen range survives a reload and can be bookmarked.

- **Every total says what it was computed from.** "The figure and the line are 17 of 18 holdings.
  The rest have never been priced." A holding nobody can quote is never silently dropped and never
  counted as zero — it is excluded and the exclusion is written down.
- **Liabilities are accounts.** The auto loan sits in the list at −$14,500 and subtracts from net
  worth, because a loan is a negative `USD` position rather than a special case in the arithmetic.
- **A zero and an absence never look alike.** An account holding nothing, an account nothing can
  price, and an empty instance each get their own words instead of a `$0.00`.

### Holdings — every position, sliced any way you ask

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/holdings-dark.png">
  <img alt="Holdings: a filter bar, a group-by strip and the full table of every position with its quantity, price, value, cost basis and unrealized gain" src="docs/screenshots/holdings-light.png">
</picture>

Every position the household holds, whichever account it sits in. Filter by owner, account,
brokerage, account type, tax treatment, classification or asset class; group by any of the same
seven, with subtotals. "Everything Priya holds at Fidelity", "the whole taxable side", "all the
bonds, wherever they are" — each is this table with the arguments changed rather than a screen of
its own.

- **The controls are the URL.** Filters, grouping and sort all live in the query string, so a view
  survives a reload, can be bookmarked, and can be sent to the other person in the household. The
  whole screen works with JavaScript turned off.
- **A filter you cannot use is not drawn.** A dimension only becomes a dropdown once the data holds
  two different values for it, and every option in it is a value something really has — so a
  one-person household gets no Owner filter, and no single filter can land you on an empty table.
  Two of them still can, and the screen says which two rather than leaving you to work it out.
- **Three coverages, not one.** A workplace plan reports a price and no cost basis at all, so the
  value total can be complete while the unrealized total is short. Each figure carries its own
  count rather than borrowing a neighbour's, because a cost basis over 11 holdings printed against
  a value over 17 would otherwise read as a $428,000 gain nothing in the database supports.
- **An empty filter is not an empty portfolio.** A combination nothing matches says so in those
  words and offers to clear itself. It never borrows the first-run screen's "there is no data yet",
  which would be false.

### Correcting a position — the write that lives on the table

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/holdings-edit-dark.png">
  <img alt="One row of the Holdings table opened for correction: the quantity and cost basis have become boxes in their own columns, and the line beneath says what saving will record" src="docs/screenshots/holdings-edit-light.png">
</picture>

A statement arrives quarterly and a position changes weekly. Rather than run the four-screen upload
for "the 401k contribution added eleven units", any row on Holdings opens in place: the quantity and
the cost basis become boxes in their own columns, and Save records it.

- **It appends, it never overwrites.** Saving records a new statement carrying every other position
  in the account forward unchanged, and the statement it corrects is kept on its own date. Nothing
  already recorded moves — your net worth in March does not change because you fixed a figure in
  August. Undo is a second correction. The line under the open row names the date the new statement
  will carry, which is today unless the statement being corrected is dated later still.
- **The line under the row says all of that before you click it**, not after. What "edit" does here
  is not what edit usually does, and finding out afterwards is too late.
- **It changes figures, not membership.** A correction can say "not 100 units but 120", and can say
  "zero", and cannot say "and also some Apple" — adding an instrument means resolving a name against
  the alias table, which is what an upload is for. Nor can it turn something held into something
  owed: the sign lives in the quantity, so flipping it would move net worth by twice the figure while
  looking like an ordinary edit.
- **It is still a URL.** The editor is `?edit=<account>.<instrument>`, so it opens exactly one row,
  survives a reload, and closes the moment you touch a filter. Like the rest of the screen it works
  with JavaScript turned off — with it off, Save is a plain form post and the confirmation comes back
  on the next page.

### Analysis — where the money actually sits

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/analysis-dark.png">
  <img alt="Analysis: three donut-and-table panels breaking net worth down by person, by account type and by asset class, and a fourth table of unrealized gains by asset type with the tax a taxable one would attract" src="docs/screenshots/analysis-light.png">
</picture>

Three breakdowns of the same total — by person, by account type, and by asset class — each a donut
beside the table it is drawn from, and beneath them what has been gained and not yet sold.

- **Debt is drawn as debt.** The ring paints what is owned, so the loan's row is left unfilled and
  the panel says why rather than pretending a negative is a slice.
- **Percentages state their denominator.** A negative row's share is of gross assets, not of the
  total in the centre, and the panel says so instead of leaving you to work out which.
- **The gains panel names a tax and calls it a ceiling.** Only a taxable account can owe capital
  gains tax, so a gain inside an IRA is in the unrealized column and not in the one beside it. The
  rate is the household's own, set at Settings → Tax and starting at 23.8% — 20% long-term plus the
  3.8% net investment income tax. A loss in one asset type is not netted against a gain in another
  the way a real return would net it, so the figure is an upper bound rather than a bill, and the
  panel says which.

### Account detail — one account, end to end

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/account-detail-dark.png">
  <img alt="A brokerage account: its own header, its own valuation chart, and a holdings table" src="docs/screenshots/account-detail-light.png">
</picture>

Each account carries its own header, its own valuation line, and what it holds.

- **Price quality is on the row it applies to.** The real-estate ETF above reads "price is stale",
  meaning its last known price is being used rather than discarded. A holding that has never been
  quoted at all reads "never priced" and shows a dash for its price and value — never a zero, which
  would understate the account by the whole position and look deliberate.
- **The figure here is the figure elsewhere.** This total and the overview's row for the same
  account are one `SUM` over one shared view, not two queries that agree by luck.

### Set balance — the one thing you type

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/account-balance-dark.png">
  <img alt="A loan account showing the set balance form, with the amount entered unsigned and stored negative" src="docs/screenshots/account-balance-light.png">
</picture>

Bank accounts and loans have no statement worth mapping — they are one number. Those two kinds get a
form; nothing else does.

- **You type what you owe, not what it stores.** The minus sign for a liability comes from the kind
  of account, never from your typing, so `14,500` on a loan can only ever move net worth *down*.
  `$14,500.00`, `14,500` and `14500.00` are all accepted.
- **Recording never overwrites.** Each balance is kept on its own date and the most recent one
  speaks, so a correction is an entry rather than an edit and undo costs nothing.
- **A brokerage is refused, on purpose.** A recorded set is a photograph of everything an account
  holds, so one cash figure against a brokerage would record every security in it as sold. Those
  accounts are not offered the form at all.

### Upload — a statement, mapped once and diffed before it lands

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/upload-dark.png">
  <img alt="The upload flow's drop screen: the four-step strip under the page title, a select over the household's open accounts and the statement file input" src="docs/screenshots/upload-light.png">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/upload-mapping-dark.png">
  <img alt="The columns screen: the file's own header row and first three data rows shown verbatim, dollar signs and all, above a select per column saying which is which" src="docs/screenshots/upload-mapping-light.png">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/upload-review-dark.png">
  <img alt="The review screen: what the statement changes, grouped into added, updated and removed, with a removed position listed in full with its quantity and last known value" src="docs/screenshots/upload-review-light.png">
</picture>

How securities accounts get populated at all: pick the account, drop the CSV, say which column is
which, resolve anything the file names that has never been seen before — then read exactly what the
statement changes before it is recorded. Four screens, each a real URL over a server-side draft, so
the back button, a reload and a half-finished upload left overnight all behave, with JavaScript off
included.

- **Mapped once per institution.** The first export from a brokerage is mapped by hand against the
  file's own sample rows, shown verbatim so you map by values rather than guessing from names. The
  mapping is remembered by header fingerprint, and every later export arrives with the screen
  already filled in — still shown, never silently reapplied, so a changed export is visible.
- **A missing row means sold — and the diff says removals in full.** A statement is a photograph of
  the whole account, so a filtered export listing 2 of 30 positions is a *valid* statement that
  sells 28 holdings. Every removed position is therefore listed individually with its quantity and
  last known value, never as a count, and a file removing more than half of what the account holds
  cannot be committed without ticking a sentence that states the ratio in those words.
- **Nothing is recorded until the last screen.** The first three steps write only to the draft; the
  commit is one transaction — the immutable position set with the original bytes retained, its
  holdings, the draft deleted. A misread column caught on the review costs nothing, because nothing
  was written, and the landing page's confirmation is read back from the database rather than from
  the URL.

### Settings — people and accounts

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/settings-dark.png">
  <img alt="Settings: the account list with kind, owner and tax treatment, above the add-account form" src="docs/screenshots/settings-light.png">
</picture>

Who is in the household and what they own. Accounts carry a kind, an owner and a **three-way tax
treatment** — taxable, tax-deferred, tax-free — because $500k in a Traditional IRA is roughly $350k
of spending power while $500k in a Roth is $500k, and a boolean throws away exactly that.

Nothing here deletes anything. An account is *closed*, which stops it counting toward today's net
worth while it keeps counting on every date before it closed; a person who still owns accounts
cannot be removed, and the refusal names them.

### On a phone

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/overview-mobile-dark.png">
  <img alt="The overview on a phone, with the navigation as a bottom bar" width="390" src="docs/screenshots/overview-mobile-light.png">
</picture>

The same pages, with the left rail becoming a bottom bar and the tables reflowing. Nothing is
withheld on a small screen: setting a balance and the whole of Settings are reachable from a phone.

### Not built yet

One screen is reachable and still a placeholder — Income, from the navigation. It is listed here
rather than screenshotted, because a picture of a placeholder says nothing a sentence does not:

| Screen | What it will do |
|---|---|
| **Income** | Projected annual dividend and weighted yield, grouped by account and tax treatment |

Prices refresh on their own (below), so Income has the yield figures it needs; what it still lacks
is the screen. The pricing slice also leaves its own UI unbuilt — the "as of" timestamp, the
stale-price treatment, a "Refresh now" control and the Settings → Instruments tab, where a
collective investment trust gets its price typed in by hand. Those are specified in
[`docs/specs/0002-pricing.md`](docs/specs/0002-pricing.md) and drawn in
[`docs/design/pricing-ui-brief.md`](docs/design/pricing-ui-brief.md). Holdings and Upload above
were built the same way — from [`docs/specs/0003-holdings.md`](docs/specs/0003-holdings.md) with
[`docs/design/holdings-ui-brief.md`](docs/design/holdings-ui-brief.md), and from
[`docs/specs/0004-ingest.md`](docs/specs/0004-ingest.md) with
[`docs/design/ingest-ui-brief.md`](docs/design/ingest-ui-brief.md).

## Running an instance

```sh
docker compose up -d
```

That is the whole procedure on a fresh machine. Postgres comes up, the app waits for it to report
healthy and applies the schema, and a bundled Caddy container fronts it on <http://localhost>. There
is no manual setup step and no migration to run by hand — migrations are idempotent, so restarting
the container is always safe.

Every setting an operator has is an environment variable and every one of them is documented in
[`.env.example`](.env.example) with its default. Copy it to `.env` only if you want to change
something. Configuration is validated once at startup: a missing or malformed value stops the
container immediately with a message naming the variable. The one setting that is not an operator's
is the capital gains rate the Analysis screen estimates with: it is a database row, edited at
Settings → Tax rather than in the environment.

`GET /healthz` returns 200 while the instance is genuinely serving and a non-200 when it is not —
which includes the case where the database is reachable but a migration shipped in the image has
never been applied. It never requires authentication, so monitoring needs no credentials.

The app itself is not reachable directly — only the bundled `caddy` service publishes a port, and it
serves plain HTTP for now, with TLS termination left as a follow-up. `caddy` sets `X-Forwarded-*`,
which the app trusts. [`docs/operating.md`](docs/operating.md) has the proxy configuration, the
`pg_dump` backup and restore procedure, the full environment table, and why a phone will not install
the app from a LAN address.

## Working on it

Requires Node 24.

```sh
npm install
npm run dev            # http://localhost:5173

npm run typecheck      # the runtime strips types without checking them
npm run build
```

Tests run against a real Postgres — the risk this codebase carries lives in Postgres-specific SQL
and `numeric` handling, both of which disappear under a mock.

```sh
docker compose -f compose.test.yaml up -d --wait
npm test
docker compose -f compose.test.yaml down -v
```

Integration tests seed through the fixture builder in [`tests/support/fixtures.ts`](tests/support/fixtures.ts) —
`seedPerson`, `seedAccount`, `seedPositionSet`, `seedQuote`, `seedDailyClose` — and run inside a transaction that is
always rolled back, so no test can see another's rows and ordering never matters. Wrap a test body
in `withDatabase` to get both. Raw `INSERT` statements belong in the builder and nowhere else; that
is what keeps a schema change from rewriting every test.

## Reading what is held

[`app/lib/valuation.server.ts`](app/lib/valuation.server.ts) is the only thing that reads the
`holding_valued` view and its as-of companion `holding_valued_at(d date)`, and it is the seam every
screen reads through:

```ts
currentHoldings()          // every holding held right now, valued
netWorth()                 // one SUM, plus how many holdings it was computed from
holdingsAt('2026-02-14')   // the same, for any past date
netWorthAt('2026-02-14')   // dates are 'YYYY-MM-DD' strings, both directions
```

DESIGN.md §8.2 names three dashboards drifting on the definition of "current holdings" as the
weakest point in the design; the view and this one module over it are the mitigation. A screen that
writes its own join over `holding` has left it. Partial data is reported as partial — an unpriced
holding still appears with `isPriced: false`, is left out of the total, and is counted in the
total's `coverage`, so a figure can be labelled "based on 8 of 12 holdings" rather than quietly
understated.

The as-of pair is not a second definition: `holding_valued_at` is declared `returns setof
holding_valued`, so it has the view's row type, and both resolve "which position set" through the
same `latest_position_set` function. It varies only what must vary — the position set is the newest
at or before the date, an account counts until its `closed_at`, and the price is the last
`price_daily` close at or before the date rather than the live quote. That carry-forward is why a
Saturday is worth what Friday closed at, and why cash prices at 1.00 on any date at all. An account
with no upload at or before the date contributes no rows rather than a zero: history starts at the
first upload (DESIGN.md §7).

## Where prices come from

Quotes are fetched by an in-process loop on `PRICE_POLL_INTERVAL_MINUTES`, and only while the market
is open — there is no worker container, which DESIGN.md §10 chose deliberately for the single
deployment target. [`app/lib/price-provider.server.ts`](app/lib/price-provider.server.ts) is the only
module that imports `yahoo-finance2`, behind the one-method interface §6.1 mandates, so swapping
providers touches one file. [`app/lib/prices.server.ts`](app/lib/prices.server.ts) is the only module
that writes a price.

Three decisions in there are worth knowing before reading a number on a screen:

- **A quote is filed under the date the provider struck it**, not under today. A mutual fund strikes
  one NAV after the close, so an afternoon poll returns yesterday's — filed under today it would be
  a fabricated close, and a poll on Thanksgiving would manufacture a row for a day the market did
  not trade. The market calendar in [`app/lib/market-hours.ts`](app/lib/market-hours.ts) therefore
  only decides whether to spend a request; it can waste one or miss one, and it cannot corrupt the
  daily spine.
- **Today's daily close is provisional.** It is rewritten on each poll and settles on the last price
  of the session. A past day's row is rewritten only when the provider is still reporting that day —
  an evening fund NAV, or a Monday holiday still quoting Friday — and then with the same price it
  already holds.
- **A symbol that does not come back keeps its last price and is marked stale**, never zeroed and
  never nulled into a sum. One that has never been priced gets no row at all, and `holding_valued`
  reports it as unpriced rather than as worthless.

A quote that names a currency other than USD is refused, because there is no currency column to
tell two currencies apart once they are both in a `numeric` (DESIGN.md §14). A quote naming no
currency at all is accepted: refusing it would stop pricing an instrument over a field nobody
promised.

## Recording people and accounts

Settings → People and Settings → Accounts write through
[`app/lib/people.server.ts`](app/lib/people.server.ts) and
[`app/lib/accounts.server.ts`](app/lib/accounts.server.ts), which are also what read them. The
routes above are thin: they turn a form into raw fields, call in here, and render what comes back.
Every rule — what a name is, which fields a figure cannot be computed without, why a person cannot
be removed — lives in the module, so a second caller cannot get a different answer than the screen
does.

Refusals are ordinary outcomes rather than 500s. A `ValidationError` carries a message per form
field, so the form re-renders with the message beside the box that caused it and every other box
still holding what was typed. `NotFoundError` is separate because it becomes a different response:
a 404 rather than a re-rendered form.

Two rules are worth knowing before touching either module:

- **Nothing is ever deleted.** `closeAccount` sets `closed_at` and is the only retirement there is;
  there is no delete function and no delete affordance anywhere. A closed account stops counting
  toward current net worth and keeps counting on every date before it closed, which is the view's
  business rather than the module's — see `holding_valued` and `holding_valued_at`.
- **A person who owns accounts cannot be removed.** `account.owner_id` is `on delete restrict`, so
  the database refuses it anyway; `removePerson` reads the accounts first and turns that into a
  sentence naming them, closed ones included. The way out is to change the owner on those accounts.

## Migrations and database types

The database is the source of truth. A migration is a plain `.sql` file in [`migrations/`](migrations),
applied in filename order, each inside a transaction, with the applied filenames recorded in a
`schema_migrations` table. Re-running skips what is already recorded, which is why a restart is
always safe. The runner is a standalone TypeScript file run directly under Node's type stripping —
no build step — and exits non-zero on failure, which is what stops the container from starting the
server against a half-migrated schema.

```sh
docker compose -f compose.test.yaml up -d --wait
DATABASE_URL=postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_test npm run migrate
```

### Adding a migration

1. Add `migrations/NNNN_what_it_does.sql` with the next zero-padded number. Filename order is
   apply order.
2. Apply it to a throwaway database, as above.
3. **Regenerate the database types.** This is a required step, not an optional one — Kysely is typed
   against [`app/lib/database.generated.ts`](app/lib/database.generated.ts), which `kysely-codegen`
   derives from the *live* database, views included, so `holding_valued` is typed like a table.
   The generated file is committed; nothing regenerates it for you.

   ```sh
   npm run db:types      # against the test database above by default
   ```

   Point it elsewhere with `DATABASE_URL=… npm run db:types`. Never hand-edit the generated file.
4. `npm run typecheck` — this is where a migration that broke a query surfaces.

`./scripts/smoke-test.sh` is the container smoke test CI runs: it brings the stack up against an
empty volume, waits for the app healthcheck, requests `/healthz`, restarts the app, and checks the
runtime image contains what it is meant to and nothing it is not. It is slow and is not where
behaviour gets tested.

## A note on money

The Postgres driver is configured to return `numeric` as **strings**, because its default is to
coerce them into JavaScript numbers, which silently rounds. Every money and quantity value therefore
crosses the application boundary as a decimal string. Do the arithmetic in SQL, or in a decimal
library — never `Number()`, `parseFloat`, or a JSON round trip as a number.

`date` is returned as a `YYYY-MM-DD` string for the same reason: the driver's default parses a
calendar date into a `Date` at *local* midnight, so formatting it back west of UTC gives the
previous day — and a statement's as-of date shifting by a day selects the wrong position set.
`timestamptz` is left alone; `created_at`, `closed_at` and `quote.as_of` are genuine instants.
