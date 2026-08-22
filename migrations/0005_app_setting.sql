-- The one row of settings that is not a domain row and not an environment
-- variable: the capital gains rate the Analysis screen applies to an unrealized
-- gain in a taxable account (DESIGN.md §8.1, §4.5).
--
-- **Why this is not an environment variable.** Every other setting is one, and
-- `.env.example` says so at the top. The rule holds for settings that describe
-- the deployment — where the database is, which timezone a close is stamped in,
-- whether the login gate is on — because those are the operator's business and
-- changing one is a restart either way. A tax rate is not that. It is a
-- household's own number, it changes when their bracket or their state does,
-- and the person who wants it changed is the person reading the screen, not the
-- person with a shell on the container. Putting it behind a redeploy would make
-- the figure beside it stale in exactly the case it was added for.
--
-- **Singleton, enforced by the schema rather than by the code above it.** The
-- primary key is a boolean constrained to true, so a second row is a constraint
-- violation instead of a silent ambiguity about which row is the settings.
-- `insert ... default values` seeds it here so no reader has to cope with the
-- table being empty: a missing settings row and a rate of zero would look
-- identical to `sum`-shaped code, and one of them is a bug.
create table app_setting (
  id                 boolean primary key default true
    constraint app_setting_single_row
    check (id),

  -- A percentage, stored as the percentage — `23.800000`, not `0.238000`. It is
  -- what the form takes, what the panel header prints and what a person says
  -- out loud, so the one conversion the arithmetic needs lives in the one place
  -- that does arithmetic (`allocation.ts`) rather than at every boundary.
  --
  -- numeric, never a float, like every other figure that multiplies money
  -- (DESIGN.md §4.1). Scale 6 matches the share scale `money.ts` already
  -- states, which is finer than any rate anyone will type and coarse enough to
  -- be exact.
  --
  -- 23.8% is 20% long-term capital gains plus the 3.8% net investment income
  -- tax. It is a default, not a claim about anyone's return: a household in a
  -- lower bracket, or in a state with its own rate, sets its own.
  capital_gains_rate numeric(9, 6) not null default 23.8
    constraint app_setting_rate_range
    check (capital_gains_rate >= 0 and capital_gains_rate <= 100)
);

insert into app_setting default values;
