# 03 — Mapping the columns once per institution

_Part of [0004-ingest.md](../0004-ingest.md)._

**What to build:** §5.3's generic mapper — the reason a new brokerage costs zero code. The screen
shows the file's own header row and its first data rows, asks which column is which, and saves the
answer against the institution and a fingerprint of that header. Every later export with the same
header opens the screen already filled in.

The screen's real job is to be readable: a household maps by looking at *values*, not at column
names, so the sample rows underneath each dropdown are the feature, not decoration.

**Blocked by:** 01 (the draft), 02 (the reader).

**Status:** ready-for-agent

**The fingerprint**

- [ ] `headerFingerprint(cells)` is SHA-256 hex over each cell trimmed, lowercased, internal
      whitespace collapsed to one space, joined with U+001F, in file order
- [ ] Two files differing only in header case, padding or internal spacing fingerprint the same
- [ ] Two files with the same columns in a different order fingerprint differently, deliberately
- [ ] The fingerprint covers the header row only; data rows never affect it

**Auto-apply**

- [ ] On reaching `/upload/:draftId/columns`, a `column_mapping` for
      `(account.institution, fingerprint)` is looked up and its mapping preselected in every control
- [ ] With a mapping found, the screen still renders — it is not skipped — and says the mapping came
      from a previous upload from this institution, so a changed export is visible rather than
      silently reapplied
- [ ] With no mapping found, every control opens unselected
- [ ] A saved mapping naming a column the file no longer has opens with that control unselected and
      says which column disappeared

**The screen**

- [ ] Each of `instrument`, `name`, `quantity`, `costBasis`, `asOf` and `accountNumber` is a
      `<select>` over the file's header cells, with an explicit "not in this file" option for the
      five optional ones
- [ ] The first three data rows are shown beneath the header, so a column is chosen by its values
- [ ] The header row itself is choosable, defaulted from `candidateHeaderRows`, and changing it
      re-renders the samples — a file with a two-line preamble is fixed here rather than by editing
      the CSV
- [ ] `costBasisIs` is a two-way control (per share / total for the position), shown only when a
      cost basis column is chosen
- [ ] `owedAsPositive` is a checkbox, defaulted from `isOwed(account.kind)`, with wording that names
      the account: "This file lists what is owed on <account> as a positive number"
- [ ] The same column may not be chosen twice; a duplicate selection is a field-level refusal
- [ ] `instrument` and `quantity` unchosen are field-level refusals through `parseInput`, rendered
      like every other form error in the app
- [ ] The screen works with JavaScript off; the samples are server-rendered and the header-row
      change is a form submission

**Saving**

- [ ] Submitting writes the mapping to `upload_draft.mapping` and redirects to the next step
- [ ] It also upserts `column_mapping` on `(institution, header_fingerprint)`, so a corrected mapping
      replaces the one that was wrong rather than accumulating a second row the constraint would
      refuse
- [ ] Returning to this step from a later one shows what was saved and can be resubmitted, because
      the draft holds it
- [ ] The next step is `/upload/:draftId/instruments` when the file contains at least one unresolved
      string, and `/upload/:draftId/review` when it contains none

**Refusals that belong here rather than later**

- [ ] A file whose mapped instrument column is empty on every row is refused here, naming the
      column, rather than producing an empty diff two screens later
- [ ] A parse error from step 02 — an unparseable quantity, disagreeing as-of dates — is shown on
      this screen against the row and column that caused it, since remapping is the fix
