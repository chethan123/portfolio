# Portfolio Tracker

A self-hosted family portfolio and net worth tracker. Import CSV statements, track account
balances, and see holdings, allocation, estimated gains, and projected income.

- [User guide](docs/guide/README.md): using the app.
- [Operating guide](docs/operating.md): installation, backups, and upgrades.
- [Architecture](ARCHITECTURE.md): code and data flows.
- [Design](DESIGN.md): domain rules, decisions, and limitations.

## Built by agents

Most of the code and documentation was written by AI agents, with human direction and review.
The [specs](docs/specs/README.md) and [working rules](AGENTS.md) record that process.

## What it looks like

These are real app captures using the invented household in [seed-demo.ts](scripts/seed-demo.ts).
The demo includes an unpriced holding, missing cost bases, and a loan. Images follow your GitHub
colour scheme; the app follows your system setting.

### Overview — what the household is worth

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/overview-dark.png">
  <img alt="The overview: total net worth, the trend line with a readout above it naming the date and value of the point it ends at, the account list and allocation by account" src="docs/screenshots/overview-light.png">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/overview-1d-dark.png">
  <img alt="The overview at the 1D range: the same net worth headline over a line of the current session, its axis labelled 09:30, 12:45 and 16:00, and a readout naming the last observed moment and its value" src="docs/screenshots/overview-1d-light.png">
</picture>

The household total, its history, account balances, and allocation. Loans subtract from net worth.
Unpriced holdings are excluded and counted in the coverage note. The 1D range plots observed
prices from the latest recorded session. [Overview guide](docs/guide/overview.md).

### Holdings — every position, sliced any way you ask

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/holdings-dark.png">
  <img alt="Holdings: a filter bar, a group-by strip and the full table of every position with its quantity, price, value, cost basis, unrealized gain and projected annual dividend" src="docs/screenshots/holdings-light.png">
</picture>

Filter, group, and sort holdings through the URL. Value, cost basis, and unrealized gain each
have their own coverage count. Missing figures are not treated as zero.
[Holdings guide](docs/guide/holdings.md).

### Correcting a position — the write that lives on the table

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/holdings-edit-dark.png">
  <img alt="One row of the Holdings table opened for correction: the quantity and cost basis have become boxes in their own columns, and the line beneath says what saving will record" src="docs/screenshots/holdings-edit-light.png">
</picture>

Correct quantity or per-share cost basis in place. Saving appends a complete account snapshot
dated today, or the current statement date if later. Older snapshots remain stored.
[Corrections](docs/guide/holdings.md#correcting-a-position-in-place).

### The owner filter — every money screen read as one owner

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/overview-owner-dark.png">
  <img alt="The Overview narrowed to one owner: the owner control open in the page header, showing a tick box per owner with Apply and Show everyone beneath them, a smaller headline figure with the sentence &quot;Showing Alex Rivera only.&quot; below it, and a note on the chart saying the hand-typed history before the instance existed is the household's and is not drawn here" src="docs/screenshots/overview-owner-light.png">
</picture>

Select owners across Overview, Holdings, Analysis, and Income. The selection stays in the URL
and follows navigation between those screens. It is a reading filter, not access control.
Household-only manual history is omitted while filtered. [Owner guide](docs/guide/owner-filter.md).

### Analysis — where the money actually sits

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/analysis-dark.png">
  <img alt="Analysis: four donut-and-table panels breaking net worth down by owner, by account type, by asset class and by classification, and a fifth table of unrealized gains by asset type with the tax a taxable one would attract" src="docs/screenshots/analysis-light.png">
</picture>

Break down value by owner, account type, asset class, or classification. Allocation percentages
use positive group totals, so debt does not turn the denominator negative. Estimated tax applies
the household rate to positive taxable gains within each asset-type row.
[Analysis guide](docs/guide/analysis.md).

### Income — what the portfolio pays over the coming year

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/income-dark.png">
  <img alt="Income: the total annual dividend with the weighted yield beside it, then the same figure as two donut-and-table breakdowns — by tax treatment, with the sheltered subtotal written out beneath the table, and by account" src="docs/screenshots/income-light.png">
</picture>

Projected annual dividends by tax treatment and account. Missing dividend rates count as zero,
so the projection omits unknown income and expenses. Weighted yield uses gross positive holding values.
[Income guide](docs/guide/income.md).

### Account detail — one account, end to end

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/account-detail-dark.png">
  <img alt="A brokerage account: its own header, its own valuation chart with the same readout above the line, and a holdings table" src="docs/screenshots/account-detail-light.png">
</picture>

An account’s identity, current value, dated chart, and holdings.
[Account guide](docs/guide/account-detail.md).

### Set balance — the one thing you type

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/account-balance-dark.png">
  <img alt="A loan account showing the set balance form, with the amount entered unsigned and stored negative" src="docs/screenshots/account-balance-light.png">
</picture>

Record a bank balance or amount owed. Loans store negative USD quantities; the form takes a
positive amount. Each submission appends a dated snapshot. A later submission for the same date
supersedes the earlier one in valuations. [Balance guide](docs/guide/account-detail.md#set-balance).

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

Choose an account and CSV, map columns, resolve new instruments, then review the changes.
A statement replaces the account’s complete set of holdings for its date: missing positions
are treated as sold. Every removal is listed before commit.

Positions are written only at commit. Drafts, column mappings, instruments, and aliases may be
saved earlier. [Upload walkthrough](docs/guide/first-statement.md).

### Settings — people and accounts

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/settings-dark.png">
  <img alt="Settings: the account list with kind, owner and tax treatment, above the add-account form" src="docs/screenshots/settings-light.png">
</picture>

Manage people and accounts, the estimated tax rate, price-refresh cadence, display policy,
and passkeys. [Settings guide](docs/guide/settings.md).

### Settings — passkeys and the lock

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/settings-passkeys-dark.png">
  <img alt="Settings: one enrolled passkey, with its label, enrolment date, last use and whether it can sync to other devices, above the add-a-passkey form" src="docs/screenshots/settings-passkeys-light.png">
</picture>

The first enrolled passkey activates the household lock. Each browser then needs a live unlock
grant to reach account data. [Passkeys guide](docs/guide/passkeys.md).

### Locked — what a browser with no live grant is shown

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/unlock-dark.png">
  <img alt="The Locked screen: a single centred card with a closed padlock mark, the heading Locked, a sentence explaining that unlocking uses a passkey, and one Unlock button" src="docs/screenshots/unlock-light.png">
</picture>

Google sign-in admits a family member; the passkey lock controls whether a browser can read
the app. Everyone admitted has the same account access. Cross-device unlocking depends on the
browser and credential provider. [Lock guide](docs/guide/passkeys.md).

### Masking — reading the portfolio in public

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/overview-masked-dark.png">
  <img alt="The overview with every amount replaced by a run of dots: the net worth headline, the chart's axis figures, the amount in the chart's readout and every account balance are hidden, while the trend line, the readout's date, the allocation bars, the account names and the dates are unchanged" src="docs/screenshots/overview-masked-light.png">
</picture>

Hide amounts when someone can see your screen. Masking is display only: amounts remain in
page data, and anyone using the browser can reveal them. [Display settings](docs/guide/settings.md#display).

### On a phone

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/overview-mobile-dark.png">
  <img alt="The overview on a phone, with the navigation as a bottom bar" width="390" src="docs/screenshots/overview-mobile-light.png">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/holdings-mobile-dark.png">
  <img alt="Holdings on a phone: the table reflowed into cards, grouped by asset class with the group heading and subtotal strip in frame" width="390" src="docs/screenshots/holdings-mobile-light.png">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/analysis-mobile-dark.png">
  <img alt="Analysis on a phone: the stacked header with the owner chip, the as-of line and Refresh now, above the net-worth-by-owner ring" width="390" src="docs/screenshots/analysis-mobile-light.png">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/overview-owner-mobile-dark.png">
  <img alt="The owner filter narrowed to one owner, on a phone: the closed OWNER chip naming who is selected, immediately above the smaller headline and the sentence saying Showing Alex Rivera only" width="390" src="docs/screenshots/overview-owner-mobile-light.png">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/overview-1d-mobile-dark.png">
  <img alt="The overview at the 1D range, on a phone: the same time-of-day axis and readout as the desktop shot, narrower" width="390" src="docs/screenshots/overview-1d-mobile-light.png">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/overview-masked-mobile-dark.png">
  <img alt="The overview with every amount masked, on a phone" width="390" src="docs/screenshots/overview-masked-mobile-light.png">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/holdings-edit-mobile-dark.png">
  <img alt="One card of the Holdings reflow opened for correction, on a phone: the quantity and cost basis are boxes inside the card rather than columns in a row" width="390" src="docs/screenshots/holdings-edit-mobile-light.png">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/income-mobile-dark.png">
  <img alt="Income on a phone: the headline and weighted yield above the first donut, by tax treatment" width="390" src="docs/screenshots/income-mobile-light.png">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/account-detail-mobile-dark.png">
  <img alt="A brokerage account on a phone: its identity block, its total and the start of its own chart" width="390" src="docs/screenshots/account-detail-mobile-light.png">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/account-balance-mobile-dark.png">
  <img alt="A loan account on a phone, above its Set balance button" width="390" src="docs/screenshots/account-balance-mobile-light.png">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/settings-mobile-dark.png">
  <img alt="Settings on a phone: the tab strip wrapped to two rows, above the start of the account list" width="390" src="docs/screenshots/settings-mobile-light.png">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/settings-passkeys-mobile-dark.png">
  <img alt="Settings → Passkeys on a phone: the one enrolled passkey and its own removal checkbox" width="390" src="docs/screenshots/settings-passkeys-mobile-light.png">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/unlock-mobile-dark.png">
  <img alt="The Locked screen's card on a phone: the same heading, sentence and button, at full width" width="390" src="docs/screenshots/unlock-mobile-light.png">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/upload-mobile-dark.png">
  <img alt="The upload flow's drop screen, on a phone" width="390" src="docs/screenshots/upload-mobile-light.png">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/upload-mapping-mobile-dark.png">
  <img alt="The columns screen, on a phone: the header-row picker above the file's own sample rows, shown verbatim" width="390" src="docs/screenshots/upload-mapping-mobile-light.png">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/upload-review-mobile-dark.png">
  <img alt="The review screen, on a phone: the added/updated/removed counts above the start of the diff, the Added group's first row in frame" width="390" src="docs/screenshots/upload-review-mobile-light.png">
</picture>

The app uses a bottom navigation bar, scrollable chart controls, and holding cards on narrow
screens. It can be installed from the browser over HTTPS. It requires a connection; the service
worker caches no pages or financial data.

### Not built yet

Settings has no Classifications, Instruments, or History editor. There is no manual-price UI,
export, transaction ledger, realized-gain calculation, or investment-return calculation.
The page-level stale-price summary is also pending. See [accepted limitations](DESIGN.md#14-accepted-limitations).

## Running an instance

Follow the [installation checklist](docs/operating.md#installing) to configure `.env`, directory
permissions, and Google sign-in, then start with `docker compose up -d`.

Compose pulls the app image and starts PostgreSQL, the app, the price worker and its egress
proxy, the Google sign-in gate, Caddy, and the dump service. App startup applies pending migrations.
Only Caddy publishes a port. Your outer proxy supplies HTTPS for `PUBLIC_ORIGIN`.

To build from this checkout:

```sh
docker compose -f compose.yaml -f compose.dev.yaml up -d --build
```

Back up before upgrading. See [Upgrading](docs/operating.md#upgrading).

### Who gets in, and where that is decided

The OAuth gate admits addresses from `allowed-emails.txt`. All admitted family members can read
and change every account. A person recorded under Settings is an account owner, not a login.

The passkey lock is a separate browser check. `AUTH_GATE` controls the unprotected-instance banner;
it does not authenticate requests. See [security](docs/security.md).

### Settings, health and the front door

Deployment variables are in [.env.example](.env.example). Tax rate, masking policy, and refresh
cadence are household settings stored in PostgreSQL.

`/healthz` bypasses sign-in and the lock. Its HTTP status reports database and migration health;
pricing failures are reported separately in the response body. See the
[runbook](docs/runbook.md) for diagnosis.

## Working on it

Use Node 24.12 or newer. Keep development data separate from the test database.

```sh
npm ci
docker compose -f compose.test.yaml up -d --wait
docker compose -f compose.test.yaml exec db \
  psql -U portfolio -d portfolio_test -c 'create database portfolio_dev'
export DATABASE_URL=postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_dev
export PUBLIC_ORIGIN=http://localhost:5173
npm run migrate
npm run dev
```

Create `portfolio_dev` once. This Docker database uses tmpfs: stopping or recreating its container
loses both development and test databases. Use a separate persistent database for data you need.
`npm run dev` does not apply migrations. A price worker is optional for local UI work with stored prices.
See [Developing](docs/developing.md) for setup and screenshot recipes.

```sh
npm run typecheck
npm test
npm run build
```

Tests use real PostgreSQL and rollback fixtures. The destructive deployment smoke script is
for a disposable environment; read its cleanup steps before running it.

## Reading what is held

[valuation.server.ts](app/lib/valuation.server.ts) is the shared valuation reader:

- Current totals: latest account snapshot and current quote.
- Daily history: latest snapshot and daily close on or before each requested date.
- 1D: current holdings valued at observed instants in the latest recorded session.

Money products round per holding before summing. Totals carry priced/total holding counts.
Value, basis, and unrealized gain can cover different holdings; do not subtract independently
partial totals to calculate unrealized gain. [Data model](docs/data-model.md).

## Where prices come from

The app owns scheduling, validation, and database writes. A separate worker fetches Yahoo quotes
and history through an egress proxy. Stored prices remain available when the provider fails.
Backfill inserts missing daily closes; quote refreshes can update existing daily rows.
[Pricing guide](docs/guide/prices.md).

## Recording people and accounts

Each account has one owner and a tax treatment. Closing an account removes it from current totals;
its earlier snapshots remain available to dated queries. Ownership and classification metadata
are not versioned, so changing them also changes historical groupings.
[People and accounts](docs/guide/people-and-accounts.md).

## Migrations and database types

SQL migrations are ordered files in `migrations/`. The runner records applied filenames and runs
each pending file in a transaction. Existing migrations are not edited after release.

### Adding a migration

Add the next SQL file, migrate a disposable database, regenerate
[database.generated.ts](app/lib/database.generated.ts) with `npm run db:types`, and run the checks.
When changing `holding_valued`, replace `holding_valued_at` in the same migration: it returns the
view’s row type. See [ADR-0001](docs/adr/0001-holding-valued-row-type-contract.md).

## A note on money

PostgreSQL `numeric` values cross the driver as strings. Outside SQL, calculations use scaled
`bigint` in [money.ts](app/lib/money.ts). Money has four decimal places and quantities eight;
formatting for display is a separate rounding step.
