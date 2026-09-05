# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read first

This repository documents itself deliberately; each document is authoritative for one thing. Start
here rather than re-deriving:

- @AGENTS.md — how work here is done and judged: reply style, delegation, plans, types, tests,
  PR sizing. The `@` imports it, so its rules load with this file; everything below is a pointer
  to consult, not an import.
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — structure. §4 is the layering and the single-site
  invariants a change must keep; §5.6 is the numeric boundary; §6 walks ingest and pricing end to
  end; Appendix A maps every module.
- **[DESIGN.md](DESIGN.md)** — why it is like this. When a design looks wrong, the argument is
  usually already there.
- **[docs/developing.md](docs/developing.md)** — checkout setup, the change loop, recipes, traps.
- **[docs/README.md](docs/README.md)** — the layout authority for where any new document goes.
- **[CONTEXT.md](CONTEXT.md)** — the glossary: the word for each domain concept and the words to avoid.

Module headers carry the reasoning for non-obvious code. When a doc and a header disagree, the
header is nearer the code and probably right.

## Commands

Node 24.12+ required. Most tests and all database work need the throwaway Postgres:

```sh
docker compose -f compose.test.yaml up -d --wait     # Postgres on :55432, tmpfs — dies with the container

npm test                                              # whole suite (serial: fileParallelism is off)
npx vitest run tests/config.test.ts                   # one file
npx vitest run tests/config.test.ts -t "names the missing variable"   # one test

npm run typecheck    # react-router typegen + tsc; the runtime strips types WITHOUT checking them
npm run build        # the only thing that exercises the router plugin, bundling, and .server boundaries
npm run migrate      # DATABASE_URL=… PUBLIC_ORIGIN=… npm run migrate; or node --env-file=.env ./server/migrate.ts
npm run db:types     # regenerate app/lib/database.generated.ts from the LIVE database
npm run dev          # needs an already-migrated database; it does NOT run migrations
```

Traps:

- **A `-t` filter that matches nothing reports everything *skipped* and exits 0.** Confirm at least
  one test passed before claiming green. The filter matches `it(...)` text, not `describe` names.
- `npm run dev` starts fine with no database and fails on the first request — config is read lazily.
- `npm run dev`/`build` read `.env` (via Vite); anything run directly under Node
  (`server/*.ts`, `scripts/*.ts`) needs `--env-file=.env` or the variable in the environment.
- **Two variables have no default and nothing starts without them**: `DATABASE_URL` and
  `PUBLIC_ORIGIN` — the latter is the origin the lock derives its relying-party id from, and
  `http://localhost:5173` is what the dev loop wants.
- There is **no lint script, no formatter, no pre-commit hook** — on purpose. Style means matching
  the file you are editing. `typecheck`, `test`, and `build` are the gates.

### Adding a migration

1. `migrations/NNNN_name.sql`, zero-padded — filename order (plain string compare) is apply order.
2. Apply it: `DATABASE_URL=postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_test PUBLIC_ORIGIN=http://localhost:5173 npm run migrate`
3. **`npm run db:types` and commit the regenerated file.** Skipping it fails nothing locally —
   queries stay typed against the old schema — but CI's `db:types -- --verify` rejects it.
   Never hand-edit `app/lib/database.generated.ts`.
4. `npm run typecheck` — where a migration that broke a query surfaces.

Migrations are forward-only (no `down` files) and idempotent via the `schema_migrations` ledger.

## Architecture essentials

One Node process, server-rendered React Router 7, PostgreSQL. No API tier: loaders call domain
modules in-process. Four layers, and **arithmetic goes down, never up** — money is multiplied and
summed in SQL at `numeric` precision; JavaScript-side combination goes through `app/lib/money.ts`
(`BigInt` counts of the last decimal place).

- **Routes** (`app/routes/**`) are thin translators: read a form, hand raw fields to a domain
  function, render what comes back. A route never imports Zod and never states a domain rule.
- **Domain** (`app/lib/*.server.ts`) owns every rule and every refusal. Refusals are data:
  `ValidationError` with a message per field, never a 500; `NotFoundError` becomes a 404.
- **Pure domain** (`app/lib/*.ts`) — statement parsing, money, allocation, formatting — no database,
  no request; every awkward CSV is a fixture.
- **SQL** (`migrations/*.sql`) holds the valuation rules: `holding_valued`, `holding_valued_at(d)`,
  `latest_position_set`.

Single-site invariants (ARCHITECTURE.md §4.2 has the full three-tier table — read it before
concluding a grep found a violation):

- `server/db.ts` is the only pool construction — it registers the type parsers that keep
  `numeric`/`int8`/`date` as strings.
- `server/yahoo-client.ts` is the only importer of `yahoo-finance2`, reached from the price worker
  process, not this one; `app/lib/prices.server.ts` is the only price writer.
- `app/lib/valuation.server.ts` is the only valuation reader of `holding_valued` — every screen
  reads holdings through its readers (`currentHoldings(owners)`, `netWorth(owners)`,
  `holdingsAt(owners, d)`, `netWorthAt(owners, d)`, `accountHoldings(id)`, `accountTotals(owners)`).
  A screen writing its own join over `holding` has left the design. The household-scoped readers
  take an `OwnerFilter` first, required and never defaulted, so a new screen cannot read holdings
  without saying whose (ADR-0008); the account-scoped ones are already narrower and take none.

**History is append-only.** Uploads, balance sets, and position corrections each write a new
`position_set`; nothing edits or deletes one, because `holding_valued_at` reads them for every date
the chart plots. The only deletes in the app are narrow, named cases — a person owning no accounts,
an instrument that lost an alias race, a passkey a family member removes (`removePasskey`,
`app/lib/lock.server.ts`) — plus rows that are scaffolding rather than history: `upload_draft` rows
(swept at 24h, consumed at commit) and `unlock_grant` rows (swept once past their idle window, superseded when the browser
holding one verifies another assertion, deleted outright by the explicit "Lock now" control,
`app/routes/lock-now.ts`, and cascaded away with the passkey that minted them). Accounts are *closed* (`closed_at`), never removed.

**`app/routes.ts` is hand-written route configuration, not file-based routing.** Dropping a file
into `app/routes/` does nothing until an entry is added there — the most common wasted hour in this
repo. After adding a route, run `npm run typecheck` to regenerate `./+types/<route>`.

## Rules that get a change rejected

- **Money, quantities, ids, and dates cross the driver boundary as strings.** Never `Number()`,
  `parseFloat`, or a JSON round trip on one. Arithmetic in SQL or through `money.ts`; `format.ts`
  renders and never computes.
- **`.server.ts` is a bundle boundary.** Plain `.ts` in `app/lib` ships to the browser.
  `import type` crosses freely; a value import of a `.server` module from browser-reachable code
  ships server code or breaks the build.
- **No enums, no parameter properties, no namespaces** — `tsconfig` sets `erasableSyntaxOnly`
  because `server/*.ts` runs under Node's type stripping. Use unions of string literals and `const`
  objects.
- **`any` never ships.** `unknown` plus a Zod narrowing where genuinely unknown; derive types from
  the schema and `database.generated.ts` rather than hand-writing a second copy.
- **Zod at the boundaries only, in the domain module** — a route that validates has taken a rule the
  domain owns.

## Tests

Tests run against real Postgres — the risk lives in Postgres-specific SQL and `numeric` handling,
which disappear under a mock. House style (docs/developing.md has the rest):

- Wrap database test bodies in `withDatabase` (transaction, always rolled back; `getDb()` resolves
  to it at any depth). Call `afterAll(closeTestDatabase)` in files that touch the database.
- Seed through the builders in `tests/support/fixtures.ts` (`seedPerson`, `seedAccount`,
  `seedPositionSet`, `seedQuote`, `seedDailyClose`, …). Raw `INSERT`s belong in the builder, nowhere else.
- Call loaders/actions through `tests/support/routes.ts` (`get`, `post`, `args`, `outcomeOf`) —
  routes signal redirects/404s by throwing a `Response`.
- Money assertions are exact decimal strings at the stored scale (`"250.0000"`), never
  `toBeCloseTo`. No DOM/jsdom: component tests assert `toContain` fragments on
  `renderToStaticMarkup` output.
- `it` is a full sentence stating the rule, no "should". Test what would hurt to break; a
  reproducing case for every bug fixed.

## Conventions

- **Commit messages carry the argument.** Imperative, sentence-case subject, no `type:` prefix,
  naming the effect rather than the files; the body is prose with the reasoning. Read `git log`
  first.
- One logical unit per PR: typechecks, builds, carries its own tests standing alone.
- Check a library's **current** docs before using it — this stack moves (React Router 7, React 19,
  Kysely, Zod 4, Vitest 4, Node 24).
- Replies to the user: answer first, then bullets; short lines; point at `file:line` instead of
  pasting code (AGENTS.md).
