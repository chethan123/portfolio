-- The whole day-zero schema, in one migration.
--
-- DESIGN.md §4.1 is authoritative for the table and column list; this file is
-- that list made real, plus the details §4.1 leaves open (docs/specs/0001).
--
-- Splitting day zero across several migrations would buy nothing when no
-- database has ever been deployed, so everything lands here — including the
-- seed rows that let cash and debt travel the same path as a share position.
--
-- Conventions used throughout:
--
--   * Enumerated columns are CHECK constraints, never `CREATE TYPE` enums.
--     Altering a check constraint is a far smaller operation than altering an
--     enum type, and the value sets here are expected to grow.
--   * Money and prices are numeric(20,4); quantity is numeric(20,8) so a
--     dividend-reinvested fractional share is exact. Never floating point.
--   * Surrogate keys are `bigint generated always as identity`. They are
--     monotonic, which is what makes "tie-break by id descending" mean "the
--     later insert wins" — a random UUID would make that tie-break arbitrary.
--     The driver returns int8 as a string, so they cross the boundary as
--     strings, exactly like the numerics.
--   * Timestamps are `timestamptz`. The database stores UTC regardless of the
--     container clock (DESIGN.md §10).


-- ----------------------------------------------------------------- people ----

create table person (
  id   bigint generated always as identity primary key,
  name text not null
);


-- --------------------------------------------------------------- accounts ----

-- Ownership attaches to the account as a single owner (DESIGN.md §4.2). Joint
-- accounts are deliberately not supported; a plan holding both Traditional and
-- Roth money is modelled as two accounts.
create table account (
  id                      bigint generated always as identity primary key,
  name                    text not null,
  institution             text not null,

  kind                    text not null
    constraint account_kind_valid
    check (kind in ('brokerage', '401k', 'ira', 'bank', 'liability')),

  -- RESTRICT, not CASCADE: deleting a person who still owns accounts is refused
  -- rather than quietly orphaning or destroying their portfolio. The People
  -- screen turns this refusal into a readable message naming the accounts.
  owner_id                bigint not null
    references person (id) on delete restrict,

  -- Three-way, never a boolean. $500k in a Traditional IRA is roughly $350k of
  -- spending power while $500k in a Roth is $500k, and a boolean throws away
  -- exactly that distinction (DESIGN.md §4.5).
  tax_treatment           text not null
    constraint account_tax_treatment_valid
    check (tax_treatment in ('taxable', 'tax_deferred', 'tax_free')),

  -- Optional, captured from a CSV; used to auto-select the account on upload.
  external_account_number text,

  -- Closing preserves history: an account is never deleted, and it still counts
  -- on every date before it closed.
  closed_at               timestamptz
);

create index account_owner_id_idx on account (owner_id);


-- --------------------------------------------------- instruments and labels ---

-- User-editable labels, not a code enum, because the category list will grow
-- (DESIGN.md §4.4). `asset_class` is the fixed rollup that makes the user's
-- mixed-axis labels aggregate into a stock/bond/cash split.
create table classification (
  id          bigint generated always as identity primary key,

  -- Unique: it is the user-facing label, and duplicates would make the Settings
  -- list incoherent.
  name        text not null unique,

  asset_class text not null
    constraint classification_asset_class_valid
    check (asset_class in ('equity', 'bond', 'cash', 'other'))
);

-- Surrogate primary key, because tickers change: Facebook became Meta and `FB`
-- became `META`. With the symbol as the key, that day the app decides you sold
-- your entire position and bought an unrelated one, splitting position and
-- price history permanently. Here it is a one-column update (DESIGN.md §4.3).
create table instrument (
  id                bigint generated always as identity primary key,

  -- Nullable and mutable. A collective investment trust in a workplace plan
  -- ("Vanguard Target Retirement 2045 Trust II") has no public symbol and no
  -- quote on any retail API; it carries symbol NULL and price_source 'manual'.
  symbol            text,

  name              text not null,

  -- Whatever the price provider reports: EQUITY | ETF | MUTUALFUND | … Not
  -- constrained, because it is the provider's vocabulary, not ours.
  quote_type        text,

  price_source      text not null
    constraint instrument_price_source_valid
    check (price_source in ('feed', 'fixed', 'manual')),

  -- Required: every instrument carries a label, so no consumer has to invent a
  -- fallback for an unclassified one. The importer's unresolved-instrument
  -- prompt is where a first sighting gets its classification.
  classification_id bigint not null
    references classification (id) on delete restrict
);

create index instrument_classification_id_idx on instrument (classification_id);
create index instrument_symbol_idx on instrument (symbol);

-- Every string ever seen in a CSV, pointing at the instrument it means.
--
-- Aliases are global rather than scoped per institution: Fidelity's `CASH` and
-- Schwab's `Cash & Cash Investments` are two rows pointing at the same `USD`
-- instrument, and genuine collisions across brokerages essentially do not occur
-- for securities. A scope column can be added if one ever does.
create table instrument_alias (
  -- COLLATE "C" makes the match byte-exact and case-sensitive as stored,
  -- whatever locale the deployment's Postgres was initialised with. The raw
  -- string is looked up exactly as the brokerage wrote it — no normalisation
  -- heuristics, a miss prompts once and is remembered permanently.
  raw_string    text collate "C" primary key,
  instrument_id bigint not null
    references instrument (id) on delete cascade
);

create index instrument_alias_instrument_id_idx on instrument_alias (instrument_id);


-- ------------------------------------------------------------- statements ----

-- An immutable, as-of-dated photograph of what an account held. Uploads append
-- and never mutate (DESIGN.md §5.2), so undo is free and quantity history comes
-- for nothing.
create table position_set (
  id              bigint generated always as identity primary key,

  account_id      bigint not null
    references account (id) on delete restrict,

  -- From the statement if the CSV carries one, otherwise chosen at upload.
  -- Never the upload timestamp: a statement uploaded three days late describes
  -- the statement date.
  as_of_date      date not null,

  source          text not null
    constraint position_set_source_valid
    check (source in ('upload', 'manual')),

  -- Nullable: a manual balance edit has no file.
  source_filename text,

  -- NULLABLE. The original CSV, retained so a mis-mapped column is fixed by
  -- correcting the mapping and re-parsing rather than by re-downloading a
  -- statement the brokerage may no longer offer. Re-parsing creates a new
  -- position set from these bytes; it never rewrites one in place.
  raw_file        bytea,

  -- The tie-break for two sets sharing an as-of date — a correction re-uploaded
  -- for the same day must resolve deterministically, not by coin flip.
  created_at      timestamptz not null default now()
);

-- The access path every valuation query takes: latest set per account.
create index position_set_account_as_of_idx
  on position_set (account_id, as_of_date desc, created_at desc, id desc);

create table holding (
  id                   bigint generated always as identity primary key,

  -- CASCADE: deleting a bad upload is the design's undo, and a position set
  -- without its holdings is not a thing.
  position_set_id      bigint not null
    references position_set (id) on delete cascade,

  instrument_id        bigint not null
    references instrument (id) on delete restrict,

  -- The sign lives here, never in price. A liability is a negative quantity
  -- against a positive price, which keeps the price column meaningful for the
  -- refresh job, price history, sorting and per-share display (DESIGN.md §2).
  quantity             numeric(20, 8) not null,

  -- NULLABLE, with NO DEFAULT — deliberately, at every layer. 401k statements
  -- often omit cost basis, and defaulting it to zero would report a fake gain
  -- equal to the entire untracked position.
  cost_basis_per_share numeric(20, 4),

  -- A statement lists an instrument once. Two rows for the same instrument in
  -- one set is a parse fault, not data.
  constraint holding_one_row_per_instrument unique (position_set_id, instrument_id)
);

create index holding_instrument_id_idx on holding (instrument_id);


-- ----------------------------------------------------------------- prices ----

-- The immutable spine. An intraday refresh can never corrupt it, and a missed
-- day is a visible gap rather than a wrong close. Non-trading days get no row;
-- history queries carry forward the last close, so Saturday equals Friday.
create table price_daily (
  instrument_id bigint not null
    references instrument (id) on delete cascade,
  date          date not null,
  close         numeric(20, 4) not null,
  primary key (instrument_id, date)
);

-- The intraday tier, overwritten in place. Kept separate from price_daily on
-- purpose (DESIGN.md §6.2).
create table quote (
  instrument_id             bigint primary key
    references instrument (id) on delete cascade,
  price                     numeric(20, 4) not null,

  -- Nullable: not every provider reports these for every instrument.
  yield_pct                 numeric(10, 6),
  annual_dividend_per_share numeric(20, 4),

  as_of                     timestamptz not null,

  -- A failed fetch keeps the last known price and marks the instrument stale.
  -- Never zero, never null into a sum.
  is_stale                  boolean not null default false
);


-- ------------------------------------------------------------ pre-history ----

-- Hand-typed points covering the period before the app existed (DESIGN.md §7).
-- Rendered as a visually distinct series; computed values always win on
-- overlapping dates.
create table manual_networth (
  date   date primary key,
  amount numeric(20, 4) not null
);


-- ------------------------------------------------------------ CSV mapping ----

-- A generic mapper with saved mappings, not hardcoded per-brokerage parsers.
-- The first upload from an institution maps its columns in a UI; the header row
-- is fingerprinted and the mapping auto-applies thereafter, so a new
-- institution costs zero code (DESIGN.md §5.3).
create table column_mapping (
  id                 bigint generated always as identity primary key,
  institution        text not null,
  header_fingerprint text not null,
  mapping            jsonb not null,
  constraint column_mapping_one_per_fingerprint
    unique (institution, header_fingerprint)
);


-- ------------------------------------------------------------------ seeds ----
--
-- These four rows are what let cash and debt travel the same code path as a
-- share position, with no branch anywhere.

insert into classification (name, asset_class)
values ('Cash', 'cash')
on conflict (name) do nothing;

insert into instrument (symbol, name, quote_type, price_source, classification_id)
select 'USD', 'US Dollar', 'CURRENCY', 'fixed', classification.id
from classification
where classification.name = 'Cash'
  and not exists (select 1 from instrument where instrument.symbol = 'USD');

insert into quote (instrument_id, price, yield_pct, annual_dividend_per_share, as_of, is_stale)
select instrument.id, 1.00, null, null, now(), false
from instrument
where instrument.symbol = 'USD'
on conflict (instrument_id) do nothing;

-- The load-bearing row. Because the as-of function carries forward the last
-- close, this single 1970 row resolves USD to 1.00 for every date the system
-- will ever be asked about — including a statement dated before the app was
-- installed. It is why there is no `if instrument is cash` branch anywhere.
-- Do not remove it, and do not "tidy" it to a recent date.
insert into price_daily (instrument_id, date, close)
select instrument.id, date '1970-01-01', 1.00
from instrument
where instrument.symbol = 'USD'
on conflict (instrument_id, date) do nothing;
