# The projected dividend stays outside `holding_valued`

A holding's projected annual dividend is joined onto the current holdings read in
`valuedNow()`, rather than added as a column on the `holding_valued` view where every other
per-holding figure lives. It is deliberate, and it will look like an oversight to anyone tidying
`valuation.server.ts` — the view already left-joins `quote`, so joining it a second time outside
reads like a mistake.

## Considered options

**Add the columns to the view.** The obvious shape, and where a reader will expect them. Rejected
for two reasons.

The first is that it makes the history lie or carry dead weight. `holding_valued_at(d)` declares
`returns setof holding_valued`, so the view's row type is a contract binding both. There is no
historical dividend anywhere — `quote` is one row per instrument, overwritten every refresh, and
`price_daily` holds only a close — so the as-of function would have to answer a 2019 query with
either today's figure, which is an anachronism reported as fact, or a permanently null column
describing something with no historical meaning.

The second is how it fails. Tried against a real Postgres 16 with all five migrations applied:

```
create or replace view holding_valued as ...   -- two columns appended
CREATE VIEW
```

It succeeds, with no error and no warning, despite the dependent function. The function is checked
only when called:

```
select * from holding_valued_at(current_date);
ERROR:  return type mismatch in function declared to return holding_valued
DETAIL:  Final statement returns too few columns.
```

So a migration that forgets to replace both objects together deploys green and breaks the net worth
chart at first use. `tests/holdings-at.test.ts` would catch it, but that is a trap to have paid for
a column we did not want in the row type.

**Join `quote` in the current read.** Chosen. `valuedAt` is untouched, so the historical answer
carries no dividend by construction rather than by a null anyone has to maintain.

## Consequences

- **The row type has to be widened by hand, and that is the real price.** `Database` is a straight
  alias of the kysely-codegen output, CI verifies the generated file against the live schema, and
  with no migration there is nothing for it to generate. So `valuation.server.ts` declares a local
  `ValuedRow = HoldingValuedRow & { … }` — a deliberate, narrowly-scoped exception to `AGENTS.md`'s
  rule that types are derived from `database.generated.ts` rather than hand-written. Adding the
  columns to the view would not need this, and that is the strongest argument on the other side.
- `ValuedHolding.annualDividend` is nullable and carries nothing on every as-of path. Because
  `holding_valued_at` does not emit the column at all, the value there is `undefined` rather than
  `null`, so the mapper must use `?? null` — not `required()`, and not a bare read. Vitest's
  `toEqual` treats an `undefined` property as equal to a missing one, so the row-shape tests will
  not catch this on their own; the as-of test asserts `annualDividend: null` explicitly.
- `quote` is joined twice for one row — once inside the view for the price, once outside for the
  rate. At household scale that is free. It is the visible oddity this record exists to explain.
- §8.2's concern is untouched: resolving *which position set is current* stays wholly inside the
  view, and this adds no second definition of it.
- Moving the figure into the view later means replacing the view and the function in one migration.
