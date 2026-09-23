-- A multi-account draft's own answers to the account numbers no account records (spec 0023
-- decision 2, ADR-0015): each given to an open account recording no number, or skipped, a null
-- account_id, whose rows are not recorded. The draft's until commit, as upload_draft_answer's are
-- (ADR-0013): commitUpload writes each answered number onto its account before the draft delete,
-- which cascades the rest away. A recorded number outranks an answer, so nothing here is ever
-- read ahead of account.external_account_number.
-- collate "C": matched byte for byte once trimmed (decision 15), as the parser stores it.
-- account_id CASCADE, as upload_draft's: an answer naming a gone account says nothing.
create table upload_draft_account_answer (
  draft_id       bigint not null references upload_draft (id) on delete cascade,
  account_number text collate "C" not null,
  account_id     bigint references account (id) on delete cascade,
  primary key (draft_id, account_number)
);

-- Decision 12: one account takes at most one number per draft. Skips are nulls, as many as asked.
create unique index upload_draft_account_answer_account_unique
  on upload_draft_account_answer (draft_id, account_id)
  where account_id is not null;
