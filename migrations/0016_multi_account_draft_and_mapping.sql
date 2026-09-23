-- A null upload_draft.account_id is the multi-account draft itself (spec 0023): "how far did this
-- draft get" already lives on the row alone (0004), never a status column, so no account chosen
-- yet is just another row state, not a new column.
alter table upload_draft alter column account_id drop not null;

-- A null column_mapping.institution is the multi-account scope (spec 0023 decision 4): a mapping
-- saved by header fingerprint alone, since no one institution owns a file that names several. The
-- two partial indexes below replace column_mapping_one_per_fingerprint so the two scopes can never
-- find or overwrite each other's mapping for the same header.
alter table column_mapping alter column institution drop not null;

alter table column_mapping drop constraint column_mapping_one_per_fingerprint;

create unique index column_mapping_institution_fingerprint_unique
  on column_mapping (institution, header_fingerprint)
  where institution is not null;

create unique index column_mapping_multi_account_fingerprint_unique
  on column_mapping (header_fingerprint)
  where institution is null;
