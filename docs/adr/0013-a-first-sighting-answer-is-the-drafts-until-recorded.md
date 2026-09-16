# A first-sighting answer is the draft's until its statement is recorded

The resolution step used to write `instrument_alias` directly. The argument, recorded in
ARCHITECTURE.md and in [`docs/specs/ingest/04-unresolved-instruments.md`](../specs/ingest/04-unresolved-instruments.md),
was that an alias is a fact about vocabulary rather than about one statement, so a corrected file
re-uploaded after an abandoned attempt must not ask the same questions twice. We are reversing it.
An answer now lands on the draft (`upload_draft_answer`), is read by that draft alone, and becomes
vocabulary only when `commitUpload` records the statement. A draft that is abandoned or swept takes
its answers with it.

## What changed the mind

The product audit reproduced it ([`docs/research/2026-09-13-product-qa-audit.md`](../research/2026-09-13-product-qa-audit.md),
QA-04; [issue #291](https://github.com/chethan123/portfolio/issues/291)): match an unfamiliar string
to VTI on the instruments step, walk away without recording, and every later upload naming that
string reads it as VTI without asking, with no screen anywhere to see or undo the match. The old
argument weighed a re-upload asking twice against nothing. The real other side of the scale is a
holding valued as the wrong security, permanently, from a step nobody finished.

The two costs are not the same size. Asking twice is one screen of questions the reader already
knows the answers to. A wrong alias is a wrong figure on every screen, for as long as nobody notices,
with the only repair a `psql` session.

## The decision

- **Scoped to the draft.** `upload_draft_answer (draft_id, raw_string) → instrument_id`, cascading
  with the draft and keyed like `instrument_alias`. Every lookup an upload step makes reads both,
  and a vocabulary row outranks the draft's own answer.
- **Promoted at commit, for the strings the file names.** The commit copies the draft's answers into
  `instrument_alias` inside its own transaction, `on conflict do nothing`, and only for strings the
  recorded parse states. A string answered and then mapped out of the instrument column was never a
  fact about a recorded statement.
- **Vocabulary wins.** Where a global row and a draft's answer both name a string, every reader takes
  the global row, and the commit records the holding under it. Recording under the draft's own answer
  would leave the next re-upload of the same file diffing that holding away.
- **Instruments are still created at the step.** The instrument and classification rows an answer
  creates are written there and then, as before. An abandoned draft can leave one behind, unaliased
  and unheld, which is clutter rather than a wrong figure; a draft-scoped instrument would mean
  carrying the whole creation form to the commit.
- **Inspectable and repairable.** Settings → Instruments lists every alias with its instrument and
  how many open accounts hold it, and repoints or forgets one only after a preview naming what stays
  recorded and which recorded statements carry the name. The confirm carries the target the preview
  was drawn against, and the write compares-and-sets on it. Nothing here touches `holding`.

## Considered options

- **Keep writing the alias at the step, add the repair screen alone.** Rejected: the screen finds a
  wrong match only once someone suspects one. The abandoned draft is the case nobody suspects.
- **A pending flag on `instrument_alias`.** Rejected: the primary key is the raw string, so two drafts
  answering one string would collide, and the second would inherit the first's unreviewed choice,
  which is the leak in another shape.
- **Promote every answer the draft holds.** Rejected in favour of the strings the recorded file
  names, for the mapped-away case above.
- **Rewrite history when an alias is repointed.** Rejected, as the issue's own non-goal: a holding
  does not record which alias resolved it, so a rewrite would be a guess. The preview names the
  accounts and statements instead, and a re-upload re-records them.

## Consequences

- **Promised.** An upload abandoned after the instruments step changes nothing another upload reads.
  A wrong alias is visible on a screen, with its impact, and can be repointed or forgotten by a
  family member with no terminal.
- **Costs.** A file corrected and re-uploaded before its first attempt was recorded asks its
  questions again. An instrument created in an abandoned draft persists, listed in the picker,
  holding nothing; `instrument.symbol` is not unique, so create, abandon and create again leaves
  two rows spelt alike in every picker, with no screen yet to remove one.
- **Not promised.** Repointing or forgetting an alias never changes a recorded holding. The preview
  says which accounts hold the old instrument and which recorded files carry the name; re-uploading
  those statements is the repair for figures already recorded.
- The glossary's **Answer** and **Alias** entries name the two states; "pending alias" is avoided
  because the answer is not an alias that has yet to happen, it is the draft's own and may never be.
