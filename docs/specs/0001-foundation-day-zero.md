# Foundation — a deployable instance with the domain schema and the shared valuation view

> Triage label to apply when this is filed: `ready-for-agent`
>
> Covers DESIGN.md §4 (domain model), §8.2 (query layer), §8.4 (navigation, People and Accounts),
> §9 (stack), §10 (deployment and operations). This is the day-zero slice — every other slice in
> the design depends on it.

## Problem Statement

There is nothing to run. The repository holds a design document and no application, so a family
that wants to track its net worth has no instance to stand up, no place to record who owns what,
and no schema for a statement to land in.

Every other capability in the design is blocked behind the same three missing pieces:

- **No database.** There is no schema, so positions, instruments, prices and accounts have nowhere
  to live, and no migration path to create them.
- **No shared definition of "what do I hold right now".** The design deliberately gives each
  dashboard its own SQL over one shared view (§8.2), and names divergence between those queries as
  the weakest point in the whole design. Until that view exists, every consumer that gets built
  will invent its own answer, and the failure mode is silent — two pages showing different net
  worth totals with no error anywhere.
- **No way to deploy.** A self-hoster has no image, no Compose file, and no documented
  configuration surface.

There is also a correctness trap waiting at the very bottom of the stack: the Postgres driver
coerces `numeric` to a JavaScript number by default, which silently rounds. On a six-figure
balance that surfaces later as two dashboards disagreeing by cents, and it is far cheaper to get
right before any code reads a money column than to retrofit once several do.

## Solution

A self-hoster runs `docker compose up` on a fresh machine with an empty data directory and gets a
working instance with no manual steps. The container brings up Postgres, applies the full schema,
and only then starts serving.

Opening the app shows the navigation from §8.4 and three empty dashboards, with a single first-run
prompt pointing at Settings → People and then Settings → Accounts. The family adds the people in
the household and the accounts they own — name, institution, kind, owner, tax treatment — which is
everything the ingest slice needs as a landing target.

Underneath, the schema from §4.1 exists in full, and one shared SQL view, `holding_valued`, answers
"what is held right now and what is it worth", with a companion set-returning function
`holding_valued_at(date)` answering the same question for any past date. Both are reached through a
single typed query module, which is the seam the dashboards will later be built on and the seam
these tests drive.

Net worth is a single `SUM` over that view with no branches: cash, securities and debt are all
positions, and the sign lives in quantity.

## User Stories

**Standing up an instance**

1. As a self-hoster, I want a single `docker compose up` on a fresh machine to produce a working
   instance, so that I do not have to follow a manual setup runbook.
2. As a self-hoster, I want the database schema to be created automatically on first start, so that
   I never run migrations by hand.
3. As a self-hoster, I want migrations to be idempotent, so that restarting the container is always
   safe.
4. As a self-hoster, I want migrations to run to completion before the server accepts requests, so
   that I can never hit a page backed by a half-migrated schema.
5. As a self-hoster, I want the app to wait for Postgres to report healthy before it starts, so that
   a cold boot does not fail on a startup race.
6. As a self-hoster, I want the app to exit with a clear message if a required setting is missing,
   so that I find out at startup rather than through a failure hours later.
7. As a self-hoster, I want every setting to be an environment variable listed in one example file,
   so that I can see the whole configuration surface without reading source.
8. As a self-hoster, I want optional settings to have sensible defaults, so that a minimal
   configuration is short.
9. As a self-hoster, I want a health endpoint, so that Compose, my reverse proxy and my monitoring
   can tell whether the instance is genuinely serving.
10. As a self-hoster, I want the health endpoint to report unhealthy when the database is
    unreachable, so that a broken instance does not look fine from the outside.
11. As a self-hoster, I want the Postgres port not published to the host by default, so that my
    database is not exposed on my LAN.
12. As a self-hoster, I want all persistent state in a single named Postgres volume, so that I have
    exactly one backup target.
13. As a self-hoster, I want the application container to write nothing to its own filesystem, so
    that I can destroy and recreate it freely.
14. As a self-hoster, I want the runtime image to run as a non-root user, so that a compromise is
    less damaging.
15. As a self-hoster, I want the runtime image to contain no compiler, no dev dependencies and no
    source tree, so that the image stays small and its attack surface stays small.
16. As a self-hoster, I want dependency installation cached in a separate image layer from the
    source build, so that rebuilding after a code change is fast.
17. As a self-hoster, I want the app to restart automatically unless I stopped it, so that a host
    reboot brings the instance back.
18. As a self-hoster, I want the container clock and the database to use UTC, so that stored
    timestamps are unambiguous.
19. As a self-hoster, I want a documented `pg_dump` backup procedure, so that I can back up properly
    without the app pretending to do it for me.

**Access control**

20. As a self-hoster, I want to optionally set a password that gates the whole app, so that an
    instance reachable beyond my LAN is not wide open.
21. As a self-hoster, I want a login page and a signed cookie when that password is set, so that I
    authenticate once rather than on every page.
22. As a self-hoster, I want a persistent warning banner while no password is set, so that I cannot
    forget I left the instance open.
23. As a self-hoster, I want the health endpoint to stay reachable without authenticating, so that
    my monitoring does not need credentials.
24. As a self-hoster, I want the app to trust `X-Forwarded-*` headers, so that it behaves correctly
    behind my TLS-terminating reverse proxy.
25. As a self-hoster, I want the HTTPS requirement for PWA installation documented, so that I
    understand why my phone will not install the app when I serve it over plain HTTP.

**First run and setting up the household**

26. As a family member, I want to be told what to do first when I open a fresh install, so that I am
    not staring at three empty dashboards wondering whether it is broken.
27. As a family member, I want the first-run prompt to send me to People before Accounts, so that I
    do not try to create an account before an owner exists.
28. As a family member, I want the navigation ordered by how often I use each page, so that the
    pages I open daily come first.
29. As a family member, I want to add a person by name, so that accounts can be attributed to them.
30. As a family member, I want to rename a person, so that a typo is not permanent.
31. As a family member, I want to be stopped from removing a person who still owns accounts, so that
    I cannot orphan them.
32. As a family member, I want to create an account with a name, institution, kind, owner and tax
    treatment, so that my statements have somewhere to land.
33. As a family member, I want to record an account's external account number, so that a later
    upload can pre-select the right account for me.
34. As a family member, I want to edit an account after creating it, so that a wrong tax treatment
    can be corrected.
35. As a family member, I want to model a workplace plan holding both Traditional and Roth money as
    two accounts, so that tax treatment stays accurate for each part.
36. As a family member, I want to close an account instead of deleting it, so that its history is
    preserved.
37. As a family member, I want a closed account to stop counting toward my current net worth, so
    that my totals reflect what I actually hold today.
38. As a family member, I want a closed account to still count on dates before it closed, so that my
    past net worth does not retroactively drop when I tidy up.
39. As a family member, I want the empty dashboards to be honest that there is no data yet, so that
    I do not read an empty chart as a zero balance.

**Valuation**

40. As a maintainer, I want one shared view that resolves "current holdings", so that the three
    dashboards cannot drift on the definition.
41. As a maintainer, I want net worth to be a single sum with no liability branch, so that a
    liability cannot be double-counted or sign-flipped by one consumer and not another.
42. As a maintainer, I want a liability encoded as negative quantity against a positive price, so
    that per-share display, sorting and the price refresh job all stay meaningful.
43. As a maintainer, I want cash modelled as a `USD` position priced at 1.00, so that a bank balance
    and a share position travel the same code path.
44. As a maintainer, I want the view to expose owner, account, institution, kind, tax treatment,
    classification and asset class on every row, so that every dashboard grouping in the design is
    available without adding a join.
45. As a maintainer, I want "current" to mean the newest position set per account, so that an older
    upload arriving late cannot displace a newer one.
46. As a maintainer, I want a deterministic tie-break when two position sets share an as-of date, so
    that a re-upload for the same date produces a stable answer rather than a coin flip.
47. As a maintainer, I want a set-returning function giving positions as of an arbitrary date, so
    that time-series queries share one definition too rather than reimplementing the join.
48. As a maintainer, I want the as-of function to carry forward the last close, so that a weekend or
    a market holiday returns Friday's value instead of a gap.
49. As a maintainer, I want an account to contribute nothing for dates before its first position
    set, so that history starts honestly at day zero rather than backfilling an assumption.
50. As a maintainer, I want an empty position set to be legal and to contribute nothing, so that
    "sold everything" is representable.

**Partial data, told honestly**

51. As a maintainer, I want a null cost basis preserved rather than coerced to zero, so that
    unrealized gain is never overstated by the entire size of an untracked position.
52. As a maintainer, I want reads to report how many holdings a partial figure was computed from, so
    that the UI can label coverage instead of implying completeness.
53. As a maintainer, I want a holding whose instrument has never been priced to be visibly unpriced
    rather than contributing silently nothing, so that a total is never quietly understated.
54. As a maintainer, I want a stale price to be flagged on the row while still being used, so that
    the last known value is shown rather than a zero or a null.

**Money precision**

55. As a maintainer, I want the driver to return `numeric` as strings rather than JavaScript
    numbers, so that cent-level rounding cannot happen anywhere.
56. As a maintainer, I want money and quantity arithmetic to happen in SQL wherever possible, so
    that floating-point behaviour is out of the path entirely.
57. As a maintainer, I want any arithmetic that must happen outside SQL to use a decimal library, so
    that the same guarantee holds there.
58. As a maintainer, I want quantities to carry enough scale for fractional shares, so that a
    dividend-reinvested holding is exact.

**Data model foundations for later slices**

59. As a maintainer, I want instruments identified by a surrogate key with a mutable, nullable
    symbol, so that a ticker change is a one-column update rather than a permanent history split.
60. As a maintainer, I want an alias table keyed on the raw string seen in a CSV, so that the symbol
    resolver the ingest slice needs already exists.
61. As a maintainer, I want an instrument to be allowed no symbol at all, so that a collective
    investment trust in a workplace plan is representable from day one.
62. As a maintainer, I want classifications to be user-editable rows rolling up to a fixed asset
    class, so that the label list can grow without a migration while aggregation still works.
63. As a maintainer, I want tax treatment to be a three-way enum rather than a boolean, so that the
    largest distinction on the balance sheet is not thrown away.
64. As a maintainer, I want a `USD` instrument, a cash classification and a far-past `USD` price row
    seeded by migration, so that cash and debt resolve through carry-forward with no branch in the
    view.

**Building on it**

65. As a maintainer, I want database types generated from the live database including views, so that
    `holding_valued` is typed like a table by everything that reads it.
66. As a maintainer, I want migrations as plain ordered `.sql` files with an applied-migrations
    record, so that the database stays the source of truth.
67. As a maintainer, I want type checking to run in CI even though the runtime only strips types, so
    that stripped types are still actually verified.
68. As a maintainer, I want integration tests against a real Postgres rather than mocks, so that the
    SQL which carries all the risk is the SQL under test.
69. As a maintainer, I want tests to seed through a fixture builder that speaks the domain, so that
    a schema change does not rewrite every test.
70. As a maintainer, I want one container smoke test in CI, so that entrypoint ordering and image
    contents are verified by something other than a first deploy going wrong.

## Implementation Decisions

### Schema

DESIGN.md §4.1 is authoritative for the table and column list; build it as written. This spec fixes
the details §4.1 leaves open:

- **All tables land in one initial migration.** Splitting the day-zero schema across several
  migrations buys nothing when no database has ever been deployed.
- **Enumerated columns are Postgres check constraints, not `CREATE TYPE` enums.** `account.kind`,
  `instrument.price_source`, `classification.asset_class` and `account.tax_treatment` all take a
  small fixed set of values, and altering a check constraint is a far smaller operation than
  altering an enum type.
- **`classification.name` is unique.** It is the user-facing label and duplicates would make the
  Settings list incoherent.
- **`instrument_alias.raw_string` is the primary key and is matched case-sensitively as stored.**
  Aliases are global, not scoped per institution.
- **`holding` has a unique constraint on `(position_set_id, instrument_id)`.** A statement lists an
  instrument once; two rows for the same instrument in one set is a parse fault, not data.
- **`account.closed_at` is a timestamp, nullable.** Closing never deletes.
- **`position_set.raw_file` is nullable.** Manual balance edits have no file.
- **`holding.cost_basis_per_share` is nullable** and must never be defaulted to zero at any layer.
- **Deleting a person who owns accounts is refused** by a restricting foreign key, surfaced as a
  readable error rather than a constraint violation.
- **Seed rows ship in the same migration**: a `Cash` classification with asset class `cash`; a `USD`
  instrument with `price_source = fixed` classified as `Cash`; a `quote` row for `USD` at 1.00; and
  a `price_daily` row for `USD` at a far-past date (1970-01-01) at 1.00.

  That last row is the reason there is no branch anywhere for cash: because the as-of function
  carries forward the last close, a single 1970 row resolves `USD` to 1.00 for every date the
  system will ever be asked about, including a statement dated before the app was installed.

### Migrations

Plain `.sql` files applied in filename order, each inside a transaction, with applied filenames
recorded in a `schema_migrations` table so re-running skips completed ones. The runner is a
standalone TypeScript file executed directly under Node 24's type stripping — no build step for
operational scripts. It exits non-zero on failure, which is what stops the entrypoint from starting
the server.

### Database access

Kysely as a typed SQL builder, with types generated by `kysely-codegen` from the live database so
that `holding_valued` is typed like a table. Generated types are committed and regenerating them is
a documented step after any migration.

**The driver is configured to return `numeric` as strings.** This is a global type-parser override
applied once, in the single place the connection pool is constructed, and it is the reason every
money and quantity value crosses the application boundary as a decimal string rather than a
`number`. Any arithmetic that cannot be expressed in SQL uses a decimal library. No money value is
ever passed through `parseFloat`, `Number()`, or JSON round-tripped as a number.

### `holding_valued`

A plain (non-materialised) view — explicitly not materialised, per §8.2. It resolves the latest
position set per account, joins through holding → instrument → classification and account → person,
and left-joins `quote`.

Decisions this spec fixes:

- **"Latest" is `max(as_of_date)` per account, tie-broken by `created_at` descending and then by
  `id` descending.** Uploading twice for the same as-of date is a real occurrence (a correction),
  and without the tie-break the answer is nondeterministic.
- **Accounts with a non-null `closed_at` are excluded.** A closed account is not part of what you
  hold today, and filtering in each consumer instead is exactly the drift the view exists to
  prevent.
- **The join to `quote` is a LEFT join.** An instrument that has never been priced yields a null
  price and a null value, and the row still appears carrying `is_priced = false`. Inner-joining
  would make the holding vanish, which is the silent understatement this design refuses everywhere
  else.
- **`value` is computed in SQL** as `quantity * price`, and is null when price is null.
- **`cost_basis` is `quantity * cost_basis_per_share`,** null when the per-share basis is null;
  `unrealized` is `value - cost_basis`, null when either side is null.
- **`is_stale` is carried through from `quote` unchanged.** A stale price is used, not discarded.

Exposed columns: account id / name / institution / kind / tax treatment; owner id and name;
instrument id, symbol, name, quote type, price source; classification name and asset class;
quantity, price, value, cost basis per share, cost basis, unrealized; `is_stale` and `is_priced`.

### `holding_valued_at(d date)`

A set-returning function with the same output shape as the view, differing in three ways:

- Per account it selects the position set with the greatest `as_of_date <= d`, using the same
  tie-break.
- An account is included when `closed_at IS NULL OR closed_at > d`, so history before a closure is
  preserved while current figures are not polluted.
- Price comes from `price_daily` at the greatest date `<= d` — carry-forward — rather than from
  `quote`. `is_stale` is not meaningful here and is reported false.

An account with no position set at or before `d` contributes no rows. Combined with the seeded 1970
`USD` price row, this means the earliest date with any value is the first upload, which is what
"history starts at day zero" means in practice.

### The query module

One module is the only thing that talks to `holding_valued` and `holding_valued_at`, and it is the
seam the tests drive. It is a thin translation layer, not a service: no caching, no business rules
beyond assembling the coverage counts.

The shape below encodes the decisions more precisely than prose — note that every numeric field is
a string:

```ts
type ValuedHolding = {
  accountId: string; accountName: string; institution: string
  accountKind: AccountKind; taxTreatment: TaxTreatment
  ownerId: string; ownerName: string
  instrumentId: string; symbol: string | null; instrumentName: string
  classification: string; assetClass: AssetClass
  quantity: string                    // decimal string, negative for liabilities
  price: string | null                // null only when never priced
  value: string | null
  costBasisPerShare: string | null
  costBasis: string | null
  unrealized: string | null
  isPriced: boolean
  isStale: boolean
}

// "based on 8 of 12 holdings"
type Coverage = { known: number; total: number }

type Total = { amount: string; coverage: Coverage }

currentHoldings(): Promise<ValuedHolding[]>
holdingsAt(date: string): Promise<ValuedHolding[]>
netWorth(): Promise<Total>
netWorthAt(date: string): Promise<Total>
```

`netWorth` sums only priced holdings and reports coverage alongside; it never substitutes zero for
an unpriced or unquoted position. The same coverage convention extends to unrealized gain, which
§8.2 already requires for null cost basis — this spec applies the identical rule to unpriced
holdings, since the failure mode is the same.

### People and Accounts management

The Settings People and Accounts tabs from §8.4, and only those two. Writes go through the same
module as reads so there is one seam, not two: the routes are thin wrappers that validate input and
call it.

- Account kind, tax treatment and owner are required at creation; institution and external account
  number are free text.
- Closing an account sets `closed_at`; there is no delete.
- Removing a person is refused while they own any account, closed or open, with a message naming
  the accounts.

### Application shell

Navigation in the §8.4 order: Overview, Holdings, Income, Upload, then Settings. The three
dashboard routes exist and render an empty state; their real content is the dashboards slice. Upload
is a placeholder route. The first-run prompt appears whenever no person exists and points at
Settings → People, then at Settings → Accounts once a person exists.

### Authentication

One optional gate, exactly as §10 describes: setting `AUTH_PASSWORD` enables a middleware, a signed
cookie and a single login page. No user table, no sessions table, no per-person permissions.
`SESSION_SECRET` becomes required when `AUTH_PASSWORD` is set, and startup fails loudly if it is
missing. `/healthz` is exempt from the gate. With `AUTH_PASSWORD` unset, a persistent banner is
rendered on every page.

### Container

Two services, per §10.1: `db` on `postgres:17-alpine` with a named volume and a `pg_isready`
healthcheck and no published port; `app` built from the repo, depending on `db` being healthy,
publishing one port, restarting unless stopped, with a `/healthz` healthcheck.

Three-stage Dockerfile — `deps` (lockfile-only install), `build` (client and server bundles),
`runtime` (`node:24-slim`, production dependencies, build output and migration `.sql` files, non-root
user). The entrypoint runs migrations to completion and only then starts the server; not
concurrently, and not as a separate one-shot service.

### Health endpoint

`GET /healthz` returns 200 when the database is reachable and every migration on disk is recorded as
applied, and a non-200 otherwise. It does not check the price provider — that subsystem does not
exist yet, and a health check that fails on a third-party outage would make Compose restart a
perfectly healthy app.

### Environment surface

Exactly the table in §10.1 — `DATABASE_URL`, `SESSION_SECRET`, `AUTH_PASSWORD`, `PORT`,
`PRICE_POLL_INTERVAL_MINUTES`, `MARKET_TIMEZONE`, `TZ` — validated once at startup against a schema,
with the process exiting on a validation failure. The two pricing variables are parsed and validated
in this slice even though nothing reads them yet, so that the configuration surface is complete and
stable from the first release. Every variable is documented in an example environment file, which is
the configuration API.

## Testing Decisions

### What makes a good test here

Assert on observable behaviour, never on how it was produced. Concretely, for this slice:

- Drive everything through the query module's public functions. A test that asserts on the text of a
  generated SQL statement, on which CTE the view uses, or on an index existing, is testing an
  implementation detail and will fail on a harmless refactor.
- Seed through a fixture builder that speaks the domain — `seedPerson`, `seedAccount`,
  `seedPositionSet({ account, asOf, holdings })`, `seedDailyClose` — never raw `INSERT` statements
  in the test body. When a column moves, one builder changes rather than every test. The builder is
  test infrastructure and is itself allowed to know the schema; nothing else in a test is.
- Assert on decimal strings, not on parsed numbers. `expect(total.amount).toBe('25000.0000')`
  catches the driver-coercion regression this spec exists partly to prevent; `toBeCloseTo` hides it.
- One behaviour per test, named for the rule it protects rather than the function it calls — "a
  closed account is excluded from current holdings", not "currentHoldings returns rows".

### The seam

**One primary seam:** a real Postgres with migrations applied, seeded through the fixture builder,
read through the query module. Every valuation rule is reachable from it, and it is the same seam
the dashboards slice will test against, so none of this is throwaway. No mocked database, no
in-memory substitute, no SQLite — the design's risk lives in Postgres-specific SQL and `numeric`
handling, and both disappear under a substitute.

Each test runs against a database it does not share, either by container-per-run with per-test
truncation or by transactional rollback, so that ordering never matters.

**A second, deliberately thin seam:** one CI-only container smoke test that runs `docker compose up`
against an empty volume, waits for the `app` healthcheck, requests `/healthz`, restarts the app
container and requests it again. It exists only for what the first seam structurally cannot reach —
that migrations complete before the server serves, that a restart is safe, and that the runtime
image actually contains the migration files. Everything else stays out of it; it is slow and it is
not where behaviour gets tested.

There is deliberately no third seam. Testing the view directly in SQL as well as through the module
would be the same assertions written twice, the second copy coupled to the schema.

### What gets tested

Through the primary seam:

- The valuation rule: a positive share position, a cash position, and a negative-quantity liability
  all sum through one code path into a net worth total.
- Latest-position-set resolution, including a later upload superseding an earlier one, a
  same-as-of-date re-upload resolving deterministically, and an out-of-order upload not displacing a
  newer set.
- Closed accounts: excluded from current holdings; included by `holdingsAt` for a date before the
  closure and excluded for a date after it.
- As-of behaviour: a weekend and a market holiday carry forward the previous close; a date before an
  account's first position set yields no rows for it; an empty position set contributes nothing.
- Null cost basis: unrealized is null on that row, excluded from the total, and reported in the
  coverage count rather than treated as zero.
- Unpriced instruments: the row is returned with `isPriced` false, excluded from the total, and
  counted in coverage.
- Stale quotes: the price is still used and the row is flagged.
- Numerics: values returned as strings at full stored scale, including a fractional-share quantity
  and a value large enough that float coercion would round it.
- People and accounts: creation, editing, closing, and the refusal to remove a person who owns
  accounts.

### Prior art

There is none — this is the first test in the repository, so this slice sets the prior art the later
slices follow. DESIGN.md §10 already fixes the shape ("integration tests against a real Postgres,
concentrated on CSV mapping, alias resolution, and the position-set diff"), and the fixture builder
established here is what those later tests will seed through.

## Out of Scope

- **CSV ingest** (§5) in its entirety — file drop, column mapping, header fingerprinting, alias
  resolution prompts, the diff preview, re-parsing from `raw_file`. The tables that support it are
  created here; nothing writes to them through the UI yet.
- **Pricing** (§6) — the provider interface, `yahoo-finance2`, the 15-minute poller, staleness
  marking, the non-USD guard, manual prices for collective investment trusts. The `quote` and
  `price_daily` tables exist and the view reads them, but nothing populates them except the seeded
  `USD` rows and test fixtures. `PRICE_POLL_INTERVAL_MINUTES` and `MARKET_TIMEZONE` are validated but
  unread.
- **Dashboard content** (§8.1) — the net worth headline, trend line, allocation donut, the Holdings
  table with grouping and filtering, and the Income page. The routes exist and render empty states.
- **The remaining Settings tabs** (§8.4) — Classifications, Instruments, History. Only People and
  Accounts ship here.
- **Manual balance editing** (§5.2) and the manual net worth series (§7).
- **Theming** (§12) — the three-state light/dark/system toggle and the cookie-based SSR approach.
  Flagged rather than silently dropped: the cookie decision is what avoids a flash of wrong theme,
  and retrofitting it is cheap while the shell is small and gets more expensive with every chart
  added. It is a small, self-contained follow-up and a reasonable next slice.
- **PWA** (§10, §11) — manifest, service worker, precaching, stale-while-revalidate.
- **Backups as a feature.** Documented `pg_dump` procedure only, per §10.
- **Multi-user authentication.** The optional single password is the whole auth story.

## Further Notes

**Contradicts nothing in `docs/adr/`** — that directory does not exist yet. `CONTEXT.md` does not
exist either, so this spec uses DESIGN.md's vocabulary directly: *position set*, *holding*,
*instrument*, *alias*, *classification*, *asset class*, *tax treatment*, *quote*, *daily close*.
Those terms are consistent across the spec and are the obvious seed for a glossary when one gets
written.

**Two decisions in this spec extend DESIGN.md rather than merely implementing it,** and are worth
noticing on review:

1. **Closed accounts are excluded from `holding_valued` and date-filtered in `holding_valued_at`.**
   §4.2 and §8.4 say closing preserves history but do not say where the filter lives. Putting it in
   the view rather than in each consumer follows the same reasoning that produced the view.
2. **Unpriced holdings get the coverage treatment §8.2 defines for null cost basis.** The design
   states the rule only for cost basis; the failure mode for an unpriced holding is identical, so
   the rule is applied to both. If this is wrong, the alternative is refusing to report a total at
   all while any holding is unpriced, which seems worse.

**People and Accounts management is a judgment call about the slice boundary.** It is in scope
because without it the first-run prompt points at pages that do not exist, and because the ingest
slice needs somewhere for a statement to land. It could be split out, at the cost of a foundation
that cannot be meaningfully used or demonstrated.

**§8.2 names three hand-rolled dashboard queries diverging as the weakest point in the design.**
This slice is where that risk is either contained or not. `holding_valued` and the single query
module over it are the entire mitigation, which is why the seam is placed at the module and why the
dashboards slice should be held to reading through it rather than writing its own joins.
