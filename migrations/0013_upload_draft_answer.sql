-- A draft's own answers to its first sightings (issue #291, audit QA-04). Vocabulary
-- (instrument_alias) is written only when a statement is recorded: commitUpload promotes the
-- rows whose strings the recorded file names, and the draft delete cascades the rest away. An
-- abandoned or swept draft takes its answers with it, so one wrong match made in a draft nobody
-- finished never resolves another upload silently. The bit had_first_sightings (0004) keeps its
-- job: an answer here says which draft made it, a promoted alias still does not.
-- Keyed like instrument_alias (collate "C": byte-exact), scoped by draft, so two drafts answering
-- one string never collide -- whichever is recorded first wins the vocabulary row.
-- instrument_id CASCADE, as instrument_alias: an answer naming a gone instrument says nothing.
create table upload_draft_answer (
  draft_id      bigint not null references upload_draft (id) on delete cascade,
  raw_string    text collate "C" not null,
  instrument_id bigint not null references instrument (id) on delete cascade,
  primary key (draft_id, raw_string)
);

-- The instrument cascade reads this, as instrument_alias_instrument_id_idx does.
create index upload_draft_answer_instrument_id_idx on upload_draft_answer (instrument_id);
