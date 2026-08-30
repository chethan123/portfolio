# Adding a column to `holding_valued` means replacing `holding_valued_at` in the same migration

The projected annual dividend is a column on the `holding_valued` view, and
`holding_valued_at` reports it as null. Both objects were replaced in one migration, and they
have to be: appending a column to the view **succeeds silently while leaving the function
broken**, and nothing fails until something calls it. This record exists for whoever adds the
next column, because the tooling will not stop them.

## The trap

`holding_valued_at` declares `returns setof holding_valued`, which is deliberate — it is what stops
the historical answer from becoming a second definition of "holdings, valued". The cost is that the
view's row type is a contract binding both, and PostgreSQL does not check it at replace time.
Reproduced against Postgres 17 — the version `compose.test.yaml` runs — with the real migrations
applied:

```
create or replace view holding_valued as ...   -- one column appended
CREATE VIEW
```

No error, no warning. Then:

```
select * from holding_valued_at(current_date);
ERROR:  return type mismatch in function declared to return holding_valued
DETAIL:  Final statement returns too few columns.
```

A migration that replaces only the view therefore deploys green and throws the first time anyone
opens the net worth chart or an account's performance chart. `tests/holdings-at.test.ts` catches it,
because it calls the function — but only if it is run, and the migration itself will not complain.

Replacing both in one file is atomic: the runner wraps each migration in its own transaction.

## Considered options

**Join `quote` outside the view instead, and skip the migration.** This was the original decision
here, and it was reversed. It avoids the trap entirely and leaves the historical row type free of a
column with no historical meaning. It fails on types: `Database` is a straight alias of the
kysely-codegen output, CI runs `npm run db:types -- --verify`, and with no migration there is
nothing for the generator to produce — so the column has to be hand-declared as a local intersection
type, against `AGENTS.md`'s rule that types are derived rather than written twice. It also makes the
as-of value `undefined` rather than `null`, because the function would not emit a column the type
claimed; and since `toEqual` treats an undefined property as equal to a missing one, the row-shape
tests would not have noticed.

**Put it in the view and null it in the function.** Chosen. `db:types` generates
`annual_dividend: Numeric | null`, CI verifies it against the real schema, and the historical null is
written in SQL where a reader can see it.

## Consequences

- **The null is the point, not an oversight.** There is no historical dividend anywhere — `quote` is
  overwritten on every refresh and `price_daily` holds only a close. The function follows the
  precedent it already sets for `is_stale`, where it returns a constant with a comment saying why.
- `ValuedHolding.annualDividend` is `string | null`: never null on the current path, because the
  view coalesces a missing rate to zero, and always null on an as-of one. It must not be narrowed
  with `required()`.
- Any future column on this view inherits the trap. The rule is: replace the view and the function in
  one migration, and never assume a green migration means a working function.
