-- The staging row behind an in-progress statement upload.
--
-- DESIGN.md §5.1 makes the upload flow four screens, and the spec review made
-- each one a real URL (docs/specs/0004-ingest.md). A URL cannot carry a CSV and
-- the screens have no client state, so everything a step needs lives in this
-- row: the bytes, the filename and, as the steps pass, the mapping and the
-- as-of date. Each step reads the draft, writes its own part back and
-- redirects — which is what makes a reload, the back button and a bookmarked
-- half-finished upload all behave.
--
--   * `as_of_date` and `mapping` are null until their step is passed, which is
--     what makes "how far did this draft get" a property of the row rather
--     than a status column to keep in sync.
--   * `raw_file` is `not null` here and nullable on `position_set`, for the
--     reason 0001 gives: a manual balance edit has no file, but a draft is a
--     file by definition.
--   * CASCADE, where `position_set` says RESTRICT. A position set is history
--     and must survive its account; a draft is scaffolding, and a half-finished
--     upload into an account that is gone stages nothing.
--   * Drafts are swept, not scheduled: anything older than 24 hours is deleted
--     at the start of the next upload. A cron for a table holding at most a
--     handful of rows in a single-household application is machinery without a
--     payer. The `created_at` index is what the sweep reads.

create table upload_draft (
  id         bigint generated always as identity primary key,
  account_id bigint not null references account (id) on delete cascade,
  filename   text   not null,
  raw_file   bytea  not null,
  as_of_date date,
  mapping    jsonb,
  created_at timestamptz not null default now()
);

create index upload_draft_created_at_idx on upload_draft (created_at);
