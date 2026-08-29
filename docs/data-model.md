# Data Model

The data model of Portfolio Tracker is designed around the core principle that "value = quantity × price". Everything is a position, and the system relies on an append-only transaction model for tracking account histories over time.

## Core Entities

### `person`
Represents individuals in the household.
- **`id`**: `bigint` PK
- **`name`**: `text`

### `account`
Accounts owned by people. Joint accounts are currently modeled as separate accounts.
- **`id`**: `bigint` PK
- **`name`**: `text`
- **`institution`**: `text`
- **`kind`**: `brokerage | 401k | ira | bank | liability`
- **`owner_id`**: `bigint` FK to `person`
- **`tax_treatment`**: `taxable | tax_deferred | tax_free`
- **`external_account_number`**: `text` (optional, for validation during ingest)
- **`closed_at`**: `timestamptz` (soft delete for retirement, preserves history)

### `classification`
User-editable labels grouping instruments, ultimately mapped to an asset class.
- **`id`**: `bigint` PK
- **`name`**: `text` (unique)
- **`asset_class`**: `equity | bond | cash | other`

### `instrument`
Securities, funds, and cash held in accounts. Identifiers use a surrogate key rather than tickers to survive ticker changes.
- **`id`**: `bigint` PK
- **`symbol`**: `text` (nullable, mutable)
- **`name`**: `text`
- **`quote_type`**: `text` (from the provider, e.g., EQUITY, ETF, MUTUALFUND)
- **`price_source`**: `feed | fixed | manual`
- **`classification_id`**: `bigint` FK to `classification`

### `instrument_alias`
Maps raw string variations from brokerages directly to an instrument.
- **`raw_string`**: `text` PK (byte-exact matching via `collate "C"`)
- **`instrument_id`**: `bigint` FK to `instrument`

### `position_set`
An immutable, append-only photograph of what an account held as of a specific date.
- **`id`**: `bigint` PK
- **`account_id`**: `bigint` FK to `account`
- **`as_of_date`**: `date`
- **`source`**: `upload | manual`
- **`source_filename`**: `text`
- **`raw_file`**: `bytea` (original CSV, retained for re-parsing)
- **`created_at`**: `timestamptz` (used for tie-breaking)

### `holding`
Individual positions within a `position_set`.
- **`id`**: `bigint` PK
- **`position_set_id`**: `bigint` FK to `position_set`
- **`instrument_id`**: `bigint` FK to `instrument`
- **`quantity`**: `numeric(20, 8)` (signed, liabilities have negative quantity)
- **`cost_basis_per_share`**: `numeric(20, 4)` (nullable)

### `price_daily`
The immutable historical pricing spine. Intraday pricing is distinct from daily closing prices.
- **`instrument_id`**: `bigint` FK to `instrument`
- **`date`**: `date`
- **`close`**: `numeric(20, 4)`
- PK is `(instrument_id, date)`

### `quote`
Intraday pricing, constantly overwritten by the refresh loop.
- **`instrument_id`**: `bigint` PK FK to `instrument`
- **`price`**: `numeric(20, 4)`
- **`yield_pct`**: `numeric(10, 6)`
- **`annual_dividend_per_share`**: `numeric(20, 4)`
- **`as_of`**: `timestamptz`
- **`is_stale`**: `boolean`

### `manual_networth`
Hand-typed points covering dates prior to the system tracking the portfolio.
- **`date`**: `date` PK
- **`amount`**: `numeric(20, 4)`

### `column_mapping`
Saved mappings for processing brokerage CSV imports.
- **`id`**: `bigint` PK
- **`institution`**: `text`
- **`header_fingerprint`**: `text` (SHA-256 of the header row)
- **`mapping`**: `jsonb`

### `upload_draft`
Staging table for the multi-step upload workflow.
- **`id`**: `bigint` PK
- **`account_id`**: `bigint` FK to `account`
- **`filename`**: `text`
- **`raw_file`**: `bytea`
- **`as_of_date`**: `date`
- **`mapping`**: `jsonb`
- **`had_first_sightings`**: `boolean`
- **`created_at`**: `timestamptz`

### `app_setting`
Global singleton configuration row (e.g., tax rate, UI preferences).
- **`id`**: `boolean` PK (constrained to true)
- **`capital_gains_rate`**: `numeric(9, 6)`
- **`masking_policy`**: `text`
- **`refresh_cadence_minutes`**: `integer`

## Key Views & Functions

### `holding_valued`
A non-materialized view acting as the core valuation query. Joins accounts, instruments, and quotes to compute `quantity * price` and determine `unrealized` gains.

### `holding_valued_at(d date)`
A function yielding the portfolio state as of a given date, tracking back into historical prices (`price_daily`) and the correct active `position_set` for each account on that day.

## Critical Invariants
1. **Numeric Boundary:** Postgres driver parses `numeric(20,4)` and `numeric(20,8)` as strings. JavaScript never does money math using native floating point numbers.
2. **Append-Only History:** When a correction is made or a new file is uploaded, a *new* `position_set` is created. Rows in previous position sets are never updated directly to change the past.
3. **Values are purely quantities × price:** The minus sign for a liability is stored in `quantity`, avoiding branches/special cases for debt and cash (cash has `price_source` = 'fixed' at `1.00`).
