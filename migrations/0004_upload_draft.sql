-- Staging row for an in-progress upload: bytes, filename, and (as steps pass) mapping and as-of date -- a URL can't carry a CSV (docs/specs/0004-ingest.md).


-- mapping null = draft hasn't reached the columns step -- progress lives on the row, no status column.
-- had_first_sightings is written once at the columns step: unrecoverable after, aliases don't record which draft resolved them.
-- raw_file NOT NULL here (nullable on position_set): a draft is a file by definition.
-- CASCADE, not RESTRICT: a draft is scaffolding, not history -- gone account, nothing to stage.
create table upload_draft (
  id                  bigint generated always as identity primary key,
  account_id          bigint not null references account (id) on delete cascade,
  filename            text   not null,
  raw_file            bytea  not null,
  as_of_date          date,
  mapping             jsonb,
  had_first_sightings boolean,
  created_at          timestamptz not null default now()
);

-- Swept (anything >24h deleted at next upload), not scheduled -- reads this index.
create index upload_draft_created_at_idx on upload_draft (created_at);
