-- Day-zero schema (DESIGN.md §4.1); docs/specs/0001 covers details left open there.
-- CHECK constraints, not enum types (value sets grow). Money/price numeric(20,4), quantity numeric(20,8). Ids bigint identity, cross the driver as strings. Timestamps timestamptz (UTC).


create table person (
  id   bigint generated always as identity primary key,
  name text not null
);


-- DESIGN.md §4.2
create table account (
  id                      bigint generated always as identity primary key,
  name                    text not null,
  institution             text not null,

  kind                    text not null
    constraint account_kind_valid
    check (kind in ('brokerage', '401k', 'ira', 'bank', 'liability')),

  -- RESTRICT, not CASCADE: refuse deleting a person who still owns accounts.
  owner_id                bigint not null
    references person (id) on delete restrict,

  -- DESIGN.md §4.5
  tax_treatment           text not null
    constraint account_tax_treatment_valid
    check (tax_treatment in ('taxable', 'tax_deferred', 'tax_free')),

  -- Guard against the wrong account, never a selector (app/lib/uploads.server.ts).
  external_account_number text,

  -- Never deleted; still counts on dates before it closed (append-only history).
  closed_at               timestamptz
);

create index account_owner_id_idx on account (owner_id);


-- DESIGN.md §4.4
create table classification (
  id          bigint generated always as identity primary key,
  name        text not null unique,

  asset_class text not null
    constraint classification_asset_class_valid
    check (asset_class in ('equity', 'bond', 'cash', 'other'))
);

-- DESIGN.md §4.3
create table instrument (
  id                bigint generated always as identity primary key,

  -- Nullable/mutable: a CIT etc. has no symbol/quote; carries price_source 'manual'.
  symbol            text,

  name              text not null,

  -- Provider's vocabulary (EQUITY|ETF|MUTUALFUND|...), not ours -- unconstrained.
  quote_type        text,

  price_source      text not null
    constraint instrument_price_source_valid
    check (price_source in ('feed', 'fixed', 'manual')),

  -- Required: no consumer needs an "unclassified" fallback.
  classification_id bigint not null
    references classification (id) on delete restrict
);

create index instrument_classification_id_idx on instrument (classification_id);
create index instrument_symbol_idx on instrument (symbol);

-- Global, not per-institution: cross-brokerage alias collisions don't occur for securities.
create table instrument_alias (
  -- COLLATE "C": exact byte match, case-sensitive regardless of the DB's locale.
  raw_string    text collate "C" primary key,
  instrument_id bigint not null
    references instrument (id) on delete cascade
);

create index instrument_alias_instrument_id_idx on instrument_alias (instrument_id);


-- DESIGN.md §5.2
create table position_set (
  id              bigint generated always as identity primary key,

  account_id      bigint not null
    references account (id) on delete restrict,

  -- Statement date, not upload time.
  as_of_date      date not null,

  source          text not null
    constraint position_set_source_valid
    check (source in ('upload', 'manual')),

  source_filename text,

  -- Original CSV, retained: a bad column mapping is fixed by re-parsing, not re-uploading.
  raw_file        bytea,

  -- Tie-break for two sets sharing an as_of_date: latest insert wins.
  created_at      timestamptz not null default now()
);

-- Serves the latest-set-per-account lookup every valuation query does.
create index position_set_account_as_of_idx
  on position_set (account_id, as_of_date desc, created_at desc, id desc);

create table holding (
  id                   bigint generated always as identity primary key,

  -- CASCADE: deleting a bad upload removes its holdings too (the undo path).
  position_set_id      bigint not null
    references position_set (id) on delete cascade,

  instrument_id        bigint not null
    references instrument (id) on delete restrict,

  -- Sign lives here, not in price (DESIGN.md §2).
  quantity             numeric(20, 8) not null,

  -- Nullable, no default: many 401k statements omit cost basis; defaulting to 0 fakes a gain.
  cost_basis_per_share numeric(20, 4),

  -- One row per instrument; a multi-lot file is combined on import (docs/specs/0004-ingest.md).
  constraint holding_one_row_per_instrument unique (position_set_id, instrument_id)
);

create index holding_instrument_id_idx on holding (instrument_id);


-- Immutable; no row on non-trading days -- history queries carry forward the last close.
create table price_daily (
  instrument_id bigint not null
    references instrument (id) on delete cascade,
  date          date not null,
  close         numeric(20, 4) not null,
  primary key (instrument_id, date)
);

-- DESIGN.md §6.2
create table quote (
  instrument_id             bigint primary key
    references instrument (id) on delete cascade,
  price                     numeric(20, 4) not null,

  yield_pct                 numeric(10, 6),
  annual_dividend_per_share numeric(20, 4),

  as_of                     timestamptz not null,

  -- Failed fetch keeps the last price, flags stale; never zero/null into a sum.
  is_stale                  boolean not null default false
);


-- DESIGN.md §7
create table manual_networth (
  date   date primary key,
  amount numeric(20, 4) not null
);


-- DESIGN.md §5.3
create table column_mapping (
  id                 bigint generated always as identity primary key,
  institution        text not null,
  header_fingerprint text not null,
  mapping            jsonb not null,
  constraint column_mapping_one_per_fingerprint
    unique (institution, header_fingerprint)
);


-- Lets cash/debt travel the same path as a share position -- no branch anywhere.

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

-- Resolves USD to 1.00 for every date via carry-forward. Do not remove or move the date.
insert into price_daily (instrument_id, date, close)
select instrument.id, date '1970-01-01', 1.00
from instrument
where instrument.symbol = 'USD'
on conflict (instrument_id, date) do nothing;
