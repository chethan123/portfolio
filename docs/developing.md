# Developing

For someone who has just cloned this and wants to change something. It covers the mechanics: how to
get a checkout that actually runs, which commands exist, what to run before you push, the recipes for
the changes you are most likely to make, and the traps that are specific to this repository.

Three other documents already speak to a developer, and this one deliberately does not repeat them:

- [`../AGENTS.md`](../AGENTS.md) owns the **standards** — `any` never ships, what is worth testing,
  checking a library's current docs rather than recalling. Read it once, in full. It is short.
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) owns the **structure** and why the seams sit where they
  do. When a sentence here explains *why*, it is a link.
- [`../README.md`](../README.md) owns the pitch, the screens, and running an instance.

This file is the fourth: **how the work is done**. If your question is about a *deployed* instance
rather than a checkout, it is not here — see the closing line.

- [What to read first](#what-to-read-first)
- [Getting a working checkout](#getting-a-working-checkout)
- [Seeing it with real-shaped data](#seeing-it-with-real-shaped-data)
- [Running the tests](#running-the-tests)
- [Writing a test that fits](#writing-a-test-that-fits)
- [The change loop](#the-change-loop)
- [Recipes](#recipes)
- [Rules that will get a change rejected](#rules-that-will-get-a-change-rejected)
- [Debugging and resetting](#debugging-and-resetting)
- [What does not exist](#what-does-not-exist)

---

## What to read first

In this order, before you open a file with the intent to change it.

**[`../ARCHITECTURE.md` §4](../ARCHITECTURE.md#4-runtime-architecture)** — one process, four layers,
and the rule that the arithmetic goes down and never up. §4.2 is the list of invariants a change has
to keep. If you read one thing, read this.

**[`../DESIGN.md`](../DESIGN.md)** — why the system is shaped this way, including the alternatives
that were rejected. Reach for it when a design looks wrong; usually the argument is already there.

**[`../AGENTS.md`](../AGENTS.md)** — how work here is judged. Types, tests, replies, plans.

**Module headers.** This codebase argues its decisions in a prose header above the code rather than
in commit messages. When ARCHITECTURE.md and a header disagree, the header is nearer the code and is
probably right ([§1](../ARCHITECTURE.md#1-how-to-read-this-document)).

Then, as you need them: [§5.6](../ARCHITECTURE.md#56-the-numeric-boundary) for how money crosses the
driver boundary, [§6](../ARCHITECTURE.md#6-dataflows) for ingest and pricing end to end, and
[Appendix A](../ARCHITECTURE.md#appendix-a-module-map) as the map of what each module is for.

---

## Getting a working checkout

**The trap first, because you will hit it otherwise.** `npm run dev` starts Vite happily with no
database and no error. Nothing goes wrong until the first page request, which returns 500 and renders
an error page naming `DATABASE_URL` as missing. Configuration is parsed lazily — `getConfig()` in
[`../server/config.ts`](../server/config.ts) reads and caches `process.env` on first use — so a boot
with no configuration is not a boot that fails. The dev server starting means nothing.

The current [README](../README.md#working-on-it) gives the two-line version. This is the sequence
that actually produces a working checkout. It is a deliberate overlap with the README: that reader is
deciding whether to install anything, you are at a terminal with a clone.

Node 24 is required (`engines` in [`../package.json`](../package.json)), plus Docker with the
Compose v2 plugin.

```sh
npm install

# A throwaway Postgres, published on :55432.
docker compose -f compose.test.yaml up -d --wait

# It creates `portfolio_test` and nothing else; make your own.
docker compose -f compose.test.yaml exec db \
  psql -U portfolio -d portfolio_test -c 'create database portfolio_dev'

# `.env.*` is gitignored except `.env.example`.
printf 'DATABASE_URL=postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_dev\n' > .env.dev

node --env-file=.env.dev ./server/migrate.ts
DATABASE_URL=postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_dev npm run dev
```

Four things about that sequence are worth knowing rather than rediscovering.

**`compose.test.yaml` creates exactly one database, `portfolio_test`.** Every other database — a
development one, a demo one, a scratch one — you create by hand, with the `psql` line above or
`createdb` against `127.0.0.1:55432`. Skipping that is the second way to get a 500 on the first
request, this time naming a database that does not exist.

**`npm run dev` does not run migrations.** Only the container entrypoint does
([`../docker-entrypoint.sh`](../docker-entrypoint.sh)), which is why an operator never runs a migrate
step and you always do. Run `./server/migrate.ts` yourself after every `git pull` that touches
`migrations/`. It is idempotent, so re-running it costs nothing.

**`.env` is read by some of these commands and not others, which is the confusing part.** There is
no `dotenv` dependency; what you get is whatever the thing running your code does.

- **`npm run dev` reads `.env`.** It goes through Vite, which loads the file. Put `DATABASE_URL`
  there and the dev server picks it up with nothing on the command line.
- **`npm run migrate` does not**, and neither does anything else that runs a `server/*.ts` or
  `scripts/*.ts` file directly under Node. Those need `--env-file=<file>`, or the variable in the
  command's environment. Run one against a `.env` you think is being read and you get the
  configuration refusal naming `DATABASE_URL`, which is a confusing way to learn this.
- **`docker compose` reads `.env` too**, for a third purpose — see
  [`operating.md`](operating.md#environment-variables). That is the deployment's configuration, not
  your checkout's.

The sequence above passes the variable explicitly at every step for exactly this reason: one form
that works everywhere beats three rules about which command reads what.

**That Postgres is in-memory and dies with the container.** `compose.test.yaml` mounts the data
directory on tmpfs on purpose. `docker compose -f compose.test.yaml down` loses everything in it,
which is fine — nothing in a checkout is worth keeping. Recreate and re-migrate.

You now have an application that serves pages against an empty database. It will show you the
first-run prompt, which is correct and not very interesting.

---

## Seeing it with real-shaped data

[`../scripts/seed-demo.ts`](../scripts/seed-demo.ts) generates one plausible household: several
accounts at several institutions, two people, statements going back years, a price history with a
drawdown, one instrument nobody can quote, and a liability that sums negative. It exists so that every
branch a dashboard has to render is actually rendered — a portfolio where everything is priced and
everything has a cost basis is the easy case, and screenshotting it proves nothing.

```sh
node --env-file=.env.dev ./scripts/seed-demo.ts
```

It prints a summary ending in the net worth it produced and how many holdings that was computed from.

**It refuses more than it accepts, on purpose.** It will not run if migrations are pending; it names
them and tells you to apply them. It will not touch a database that holds data it did not create: the
first successful run stamps a `demo_seed` marker table, and a database without that marker must be
pristine or the script exits non-zero having written nothing. **There is no `--force`, and adding one
would be a mistake** — the one thing this script must never become is a way to lose a real portfolio.

**It is idempotent, and it replaces rather than doubles.** The guard, the wipe of the previous
generation and the insert all happen in one transaction. Run it twice and you have one household, not
two.

**Account ids climb on every run.** `account.id` is an identity column and the wipe is a plain
`delete`, so a second run renumbers everything. Nothing may hardcode one — not a test, not a script,
not a screenshot recipe. [`../scripts/capture-screenshots.ts`](../scripts/capture-screenshots.ts)
looks accounts up by *kind* for exactly this reason.

---

## Running the tests

Most of the suite needs Postgres on `:55432`. `fileParallelism: false` in
[`../vitest.config.ts`](../vitest.config.ts) runs files one at a time against that single database,
so a full run is serial — scope your runs while iterating.

```sh
docker compose -f compose.test.yaml up -d --wait

npm test                                                  # the whole suite
npx vitest run tests/config.test.ts                       # one file
npx vitest run tests/config.test.ts -t "names the missing variable"   # one test
npm run test:watch
npm run test:coverage
```

**The gotcha: a `-t` filter that matches nothing reports everything *skipped*, not failed.**

Vitest reports every file and every test as `skipped`, and exits 0. A typo in the filter therefore
looks exactly like a pass, and "I ran the test and it was green" is a claim you cannot make from that
output. Check that the run reports at least one test *passed*. The filter matches the text of
`it(...)` — not a `describe` name, and not a message inside an assertion.

**If Postgres is not up,** the failure names the fix rather than making you infer it from a
connection error — it tells you the URL it tried and the `compose.test.yaml` command that starts one,
and mentions `TEST_DATABASE_URL` if you would rather point it at your own. A few files build their
own connection, because what they test *is* the pool or the migration runner, and they carry the same
message themselves.

### How the suite is built

The reasoning is [ARCHITECTURE §9](../ARCHITECTURE.md#9-testing-architecture); what follows is only
what changes how you run and write things.

- **A real Postgres, by choice.** No mock, no SQLite. The risk here lives in Postgres-specific SQL and
  in `numeric` handling, and both disappear under a substitute.
- **`withDatabase` is the isolation story.** It opens a transaction, runs your body, and unwinds it
  with a private rollback sentinel. It also enters an `AsyncLocalStorage` store so that `getDb()`
  returns *that transaction* however deep the call goes — which is why a loader called with no
  database argument does not quietly commit and leave rows for later tests to trip over.
- **Fixtures are the only test code that knows the schema.**
  [`../tests/support/fixtures.ts`](../tests/support/fixtures.ts) has the builders. No raw `INSERT` in
  a test body; that is what keeps a schema change from rewriting every test.
- **There is no jsdom and no `globals`.** Every file imports `describe`/`expect`/`it` from `vitest`
  itself, and every file that touches the database calls `afterAll(closeTestDatabase)` itself —
  forget it and the pool stays open and vitest hangs at the end of the run.
- **Component tests assert on a string.** [`../tests/support/render.tsx`](../tests/support/render.tsx)
  uses `renderToStaticMarkup`. There is no DOM, no `@testing-library/react`, no `screen.getByText`.
- **A React warning is a failure.** The renderer swaps `console.error` and throws on anything React
  says, with one known stub artefact allowed by exact prefix.
- **Coverage has no threshold and is not a CI gate**, deliberately. The useful reading is which files
  are dark, not what the total says.

---

## Writing a test that fits

What [`../AGENTS.md`](../AGENTS.md) says about *what* is worth testing is the judgement call, and it
is not repeated here. This is the house style for a test once you have decided to write it.

**Open the file with a comment naming the risk it exists for**, usually citing DESIGN.md. Not what
the file tests — why losing it would hurt.

**`describe` names a thing or a rule. `it` is a full sentence stating the rule**, with no "should":
`it("a closed account is excluded from current holdings", ...)`.

**Money and quantity are exact decimal strings at the stored scale.** `"250.0000"`, not `250`. Never
`toBeCloseTo` — that is what would hide a driver-coercion regression, which is the class of bug the
suite exists for. `toBeCloseTo` appears only for chart pixel coordinates, where it belongs.

**Markup assertions are `toContain` fragments**, not whole strings. A whole-string assertion fails on
every harmless attribute change.

**Seed through the builders**, and if you need a shape they cannot express, add a builder rather than
an `INSERT`.

**Route logic is testable exactly as far as it is exported** —
[§9.3](../ARCHITECTURE.md#93-the-standing-constraint). Tests import a `loader` or an `action` and call
it directly. If what you want to test lives inside a loader body, the fix is to move it out.

---

## The change loop

Before you push, in this order. Each one catches something the next cannot.

```sh
npm run typecheck   # the runtime strips types WITHOUT checking them
npm test            # needs the test database up
npm run build       # the only thing that exercises the plugin, routes and bundling
```

`typecheck` runs `react-router typegen` first, so it also regenerates the route types that make
`loaderData` typed. Run it after adding a route, or your editor will disagree with reality.

`build` matters because vitest deliberately does not load the React Router plugin. A route that fails
to bundle, or a `.server` import pulled into the client, is invisible until this step.

If you touched a migration, `npm run db:types` is a fourth gate — see the recipe below.

### What CI rejects

[`../.github/workflows/ci.yml`](../.github/workflows/ci.yml), three jobs, all of them gating. The
reasoning behind each is [§8.2](../ARCHITECTURE.md#82-ci).

- **`check`** — typecheck, build, then a real Postgres: migrate, `npm test`, and
  `npm run db:types -- --verify`. That last step is what makes regenerating types after a migration
  mandatory rather than remembered.
- **`audit`** — `npm audit signatures` and `npm audit --omit=dev --audit-level=high` both block.
  Dev-dependency advisories and deprecation notices are reported and do not fail the build.
- **`smoke`** — [`../scripts/smoke-test.sh`](../scripts/smoke-test.sh) on a clean runner. The only
  thing that exercises `compose.yaml`, the `Dockerfile`, the entrypoint's migrate-then-serve ordering
  and the `.sql` files being present in the runtime image. **Never run it locally against anything
  you care about: it runs `docker compose down -v` at the start and again from an exit trap.**

---

## Recipes

### Add a migration

1. `migrations/000N_name.sql`, zero-padded. Files are applied in **filename order compared as plain
   strings**, so the padding is load-bearing.
2. Write it so it can run exactly once. The runner's ledger guarantees that, but any seed rows in it
   carry their own `ON CONFLICT` guards anyway — a seed that depends on bookkeeping elsewhere to stay
   singular is only accidentally idempotent.
3. `node --env-file=.env.dev ./server/migrate.ts`
4. **`npm run db:types`, and commit the regenerated `app/lib/database.generated.ts`.**

Step 4 is not optional and is not a courtesy. `db:types` introspects a **live** database and rewrites
that file; every Kysely query in the codebase is typed from it. Skip it and nothing fails locally —
your queries stay typed against the *old* schema, `typecheck` passes, and the new column simply does
not exist as far as TypeScript is concerned. CI's `db:types -- --verify` is what turns that silence
into a red build. Note the `--`: it is a passthrough to `kysely-codegen`, not an npm flag.

`db:types` introspects whatever `DATABASE_URL` names, defaulting to `portfolio_test`. Point it at a
database you have just migrated, or you will faithfully generate types for the wrong schema. Never
hand-edit the generated file.

Details and the transaction semantics of a failed migration:
[§8.3](../ARCHITECTURE.md#83-adding-a-migration).

### Add a configuration variable

Four places, and the last two are documentation that a reader will otherwise find contradicting the
code:

1. `configSchema` in [`../server/config.ts`](../server/config.ts) — with a Zod refinement whose
   message reads as advice to an operator, because that is where it ends up.
2. [`../.env.example`](../.env.example) — commented, with the default and the reason.
3. `DESIGN.md` §10.1, the authoritative table.
4. The environment table in [`operating.md`](operating.md#environment-variables).

Add a case to `tests/config.test.ts` if the variable has a shape that can be got wrong. And check
whether it needs threading through `compose.yaml` — [§11.3](../ARCHITECTURE.md#113-live-architectural-debt)
records one variable that is not, and is therefore unsettable in the documented deployment.

### Add a route

[`../app/routes.ts`](../app/routes.ts) is **hand-written configuration, not file-based routing.**
Dropping a file into `app/routes/` does nothing at all until you add an `index()` or `route()` entry
for it. This is the single most common wasted hour in this repository.

1. The module under `app/routes/`, with its `loader`/`action` exported so they can be tested.
2. The entry in `app/routes.ts`. The ordering there is editorial — it is nav order, not alphabetical.
3. `NAVIGATION` or `FOOTER_NAVIGATION` in [`../app/root.tsx`](../app/root.tsx), if it is a nav
   destination. Many routes are not.
4. `npm run typecheck` to regenerate route types.

Keep the route thin: read the form, hand raw fields to a domain function, render what comes back. A
route never imports Zod and never states a domain rule
([§4.1](../ARCHITECTURE.md#41-one-process-four-layers)).

### Retake screenshots after changing a screen

The committed images are the real application against the demo household, and they are the one thing
here that goes stale in silence — nothing fails when a screen changes and its picture does not.
**A change to a screen is not finished until they are retaken.**

Seed a throwaway database as above, serve it, then run the capture script against the same URL:

```sh
printf 'DATABASE_URL=postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_demo\n' > .env.demo
node --env-file=.env.demo ./server/migrate.ts
node --env-file=.env.demo ./scripts/seed-demo.ts
DATABASE_URL=postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_demo npm run dev &

node --env-file=.env.demo ./scripts/capture-screenshots.ts
```

The empty-instance shots the guide opens with come from a second database — migrated, unseeded, served
the same way — with `--first-run`. The script's header carries the full mechanics; the editorial
decisions (which account each shot is of, why the no-password banner is left in) live in
[`screenshots/README.md`](screenshots/README.md) and
[`guide/images/README.md`](guide/images/README.md).

---

## Rules that will get a change rejected

These overlap ARCHITECTURE.md by design: it holds the mechanism and the argument, this holds the
symptom you will see when you break it.

**Money, quantities and ids are strings.** The pool registers type parsers for `numeric`, `int8` and
`date` so they arrive as the strings Postgres sent ([`../server/db.ts`](../server/db.ts)). Never
`Number()` or `parseFloat` one. Arithmetic goes in SQL, or through
[`../app/lib/money.ts`](../app/lib/money.ts), which works on `BigInt` counts of the last decimal
place. The symptom of getting this wrong is not an exception — it is a total that is a few cents out
on some rows and right on others, and no error anywhere.
Why: [§5.6](../ARCHITECTURE.md#56-the-numeric-boundary).

**`.server.ts` is a bundle boundary, not a naming style.** React Router's Vite plugin excludes those
files from the client bundle; a plain `.ts` in `app/lib` **is** shipped to the browser. `import type`
crosses freely and is erased. Import a `.server` module as a *value* from a browser-reachable file and
you will either ship server code and secrets to the client or break the build.
Known live violation, worth knowing about before you copy it: `app/lib/statement.ts:32` imports
`recordedDate` from `input.server.ts` as a value. It stays out of the client bundle only because
tree-shaking removes it, and nothing enforces that.
Why: [§4.3](../ARCHITECTURE.md#43-the-server-convention).

**No enums, no parameter properties, no namespaces.** `tsconfig.json` sets `erasableSyntaxOnly`, and
it covers the whole project. The reason is `server/*.ts`, which runs under Node's type stripping with
no build step: syntax that has to *emit* something cannot be stripped. The symptom is a typecheck
error pointing at the keyword. Use a union of string literals and a `const` object.

**Zod at the boundaries, and only there.** Every form input is re-validated server-side, and the
Yahoo payload is parsed through Zod at the edge. The validation lives in the domain module, not the
route: a domain function returns a `ValidationError` with a message per field rather than throwing a
500. A route that validates is a route that has taken a rule the domain owns.

**One site per hazard.** The pool is constructed in one place, `yahoo-finance2` is imported in one
place, prices are written in one place, and `valuation.server.ts` is the only reader of
`holding_valued` for valuation. A second site is the rejection, whatever it looks like locally.
The full list, in three tiers of how strongly each is enforced:
[§4.2](../ARCHITECTURE.md#42-single-site-invariants).

**`any` never ships**, and derived types beat a second hand-written copy. That one belongs to
[`../AGENTS.md`](../AGENTS.md), along with the rest of how a change is judged.

---

## Debugging and resetting

**Inspect the database directly.** The test Postgres publishes its port, so any client works:

```sh
psql postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_dev
docker compose -f compose.test.yaml exec db psql -U portfolio -d portfolio_dev
```

`schema_migrations` is the ledger of applied filenames. Only filenames are recorded, so editing an
already-applied migration file changes nothing — the runner will never look at it again.

**Logs are stdout, and that is the entire pipeline.** In development they are in the terminal running
`npm run dev`. There is no metrics endpoint, no tracing, no log shipping. Which kinds of line the
application emits, and a stem worth grepping for each, is the list in
[`operating.md`](operating.md#logs) — it is the same output in a checkout as in a container.

**Reset local state**, from cheapest to most thorough:

```sh
node --env-file=.env.dev ./scripts/seed-demo.ts     # replace the demo household
docker compose -f compose.test.yaml down            # tmpfs, so this loses every database on it
rm -rf .react-router build && npm run typecheck     # regenerate route types and clear the build
```

There is nothing to clean up after a test run: every test body is rolled back, so the suite leaves the
database exactly as it found it, including after a failure.

**What is not available**, so you stop looking:

- **No SQL query logging.** No `DEBUG` variable, and Kysely is constructed without a `log` option. To
  see a query, log it at the call site, or turn on Postgres's own statement logging in the throwaway
  container.
- **No debug or verbose flag** anywhere in the application. Configuration is the table in
  `.env.example` and nothing else.
- **No REPL or console.** Use `psql`, or a scratch script run with `node --env-file=`.
- **No migration rollback.** Migrations are forward-only and there are no `down` files. To undo one in
  development, drop the database and recreate it. On a real instance, that is
  [`runbook.md`](runbook.md)'s problem and the answer involves a backup.

---

## What does not exist

You will go looking for these. They are absent on purpose, and their absence is not a gap to fill
without discussing it.

**No linter.** No ESLint, no Biome. Nothing in `package.json` runs one.

**No formatter.** No Prettier, no `.editorconfig`.

**No pre-commit hooks.** No husky, no lint-staged. `git commit` runs nothing.

**No `lint` script.** The complete script list is in [`../package.json`](../package.json); what is
there is what exists.

What stands in for them: `npm run typecheck` (the only thing that verifies types at all, since the
runtime strips them without checking), `npm test`, `npm run build`, and the audit and smoke jobs in
CI. Correctness is gated hard; formatting is not gated at all.

**So style means matching the file you are editing.** Its import order, its quote style, its comment
voice. This codebase is unusually consistent for a repository with nothing enforcing it, and it stays
that way by imitation rather than by tooling.

---

Questions about a *deployed* instance — configuration, TLS, backups, monitoring, upgrades — are
[`operating.md`](operating.md). When something is already broken and you want a procedure rather than
an explanation, [`runbook.md`](runbook.md) is indexed by symptom.
