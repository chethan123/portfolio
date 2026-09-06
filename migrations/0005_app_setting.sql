-- Household setting, not an env var: the capital gains rate the Analysis screen applies to unrealized gains in a taxable account (DESIGN.md §8.1, §4.5) -- changes with the user's bracket, not a redeploy.
create table app_setting (
  id                 boolean primary key default true
    constraint app_setting_single_row
    check (id),

  -- numeric(9,6), stored as a percentage (23.8, not 0.238) -- matches money.ts's share scale.
  -- Default 23.8% = 20% LTCG + 3.8% NIIT; a default, not a mandate.
  capital_gains_rate numeric(9, 6) not null default 23.8
    constraint app_setting_rate_range
    check (capital_gains_rate >= 0 and capital_gains_rate <= 100)
);

-- Guarded despite the runner's applied-filename ledger: the singleton rule belongs in SQL, not elsewhere.
insert into app_setting default values on conflict (id) do nothing;
