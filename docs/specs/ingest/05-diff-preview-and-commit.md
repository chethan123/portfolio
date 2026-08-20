# 05 — The diff, the commit, and the documents it changes

_Part of [0004-ingest.md](../0004-ingest.md)._

**What to build:** The last screen, and the only write. It compares the parsed file against what the
account holds now and states the consequence in the terms §5.1 gives — "3 updated · 1 added ·
1 removed (AAPL, 50 sh, $8,500)" — then commits one immutable `position_set` in one transaction.

The diff is the safety valve, not a courtesy. §5.2's "a missing row means sold" is what makes a
filtered export dangerous: a file listing 2 of 30 positions is a *valid* statement that sells 28
holdings, and nothing downstream would flag it. So removals are never a count.

**Blocked by:** 04 (everything in the file resolves to an instrument).

**Status:** ready-for-agent

**The comparison**

- [ ] The account's current holdings are read through `latest_position_set`, never by a second
      `order by as_of_date desc` written here — §8.2's drift is a tie-break copied into a new caller
- [ ] Each parsed row is classified against them: added, updated, unchanged, and each current
      holding absent from the file is removed
- [ ] Updated rows show before and after for quantity and cost basis, in the same columns and the
      same tabular figures Holdings uses
- [ ] A cost basis appearing where there was none, or disappearing, is an update and says which
- [ ] The summary line reads in §5.1's shape, with the counts each naming what they counted
- [ ] An account with no statement yet reads as "14 added", not as a diff against nothing

**Removals, in full**

- [ ] Every removed position is listed individually — instrument, quantity, and its last known value
      — never collapsed into a count
- [ ] A holding that could not be priced shows its quantity and says it was never priced, borrowing
      `holdingNote` rather than printing `$0.00`
- [ ] When a file removes more than half of what the account holds, the commit requires an explicit
      tick against a sentence stating the ratio: "This file removes 12 of the 15 positions this
      account holds." Unticked, the commit is refused and nothing is written
- [ ] A file that removes everything says so in those words

**Combined and unusual rows**

- [ ] Rows the parser combined are listed on their own line — "VTSAX · 3 rows combined · 412.5
      units" — so combining is visible before it is recorded, never after
- [ ] A row whose quantity is zero is shown, and is stored as zero rather than dropped, matching
      §5.4's reasoning that a dropped row is unreachable from the table that no longer prints it

**The as-of date**

- [ ] Read from the file when the mapping named an as-of column, shown, and not editable here — the
      statement said it
- [ ] Otherwise a date field defaulting to today, validated by `recordedDate` and carrying
      `latestRecordableDate()` as its `max`, so the control and the refusal state one rule
- [ ] The screen says plainly which of the two happened
- [ ] `effectiveDate` is not used anywhere in this flow

**Refusals before the write**

- [ ] Every row is checked with the exported `fitsTheMoneyColumn`: a `quantity ×
      cost_basis_per_share` that will not round to under 10^16 refuses the whole commit and names the
      instrument. Nothing partially applied
- [ ] The same check runs against the instrument's current price where one exists, since
      `holding_valued` casts that product too
- [ ] When the mapping named an account-number column and the account has an
      `external_account_number` recorded, a disagreement refuses the commit, naming both — this is
      the silent-collision failure §5.1 made accounts first-class to avoid
- [ ] A closed account refuses the commit, in `setBalance`'s words

**The commit**

- [ ] One transaction: insert `position_set` with `source = 'upload'`, the as-of date,
      `source_filename` from the draft, and the draft's bytes into `raw_file`; insert one `holding`
      per parsed row; delete the draft
- [ ] `external_account_number` is captured on the account when the file carried one and the account
      had none
- [ ] Success redirects to `/accounts/:id?uploaded=<setId>` with a confirmation naming the counts and
      the date, so the reader lands on the holdings the upload just changed
- [ ] Posting a committed draft again renders the expired-or-already-recorded page from step 01, with
      a link to the account — not a second set, and not a 500
- [ ] `latest_position_set` returns the new set immediately afterwards, and Overview, Holdings,
      Analysis and Account detail all move together with no cache to clear
- [ ] A second upload for a date that already has one is allowed and resolves by `created_at` then
      `id`, which is the tie-break `latest_position_set` already implements

**The documents this closes**

- [ ] README's "Not built yet" table loses the Upload row, and the sentence "Until Upload lands,
      positions arrive through the set-balance form or by seeding" goes with it
- [ ] README gains an Upload section in the shape of the others — what the screen is for, and the
      two or three things about it worth knowing
- [ ] `docs/screenshots/README.md` gains rows for the new screens, and the shots are taken:
      `upload-*.png` for the drop screen, `upload-mapping-*.png`, and `upload-review-*.png` showing
      a diff with a removal in it. Per that file, the screen is not finished until they exist
- [ ] The comment above `holding_one_row_per_instrument` in `migrations/0001_initial_schema.sql` is
      amended: the constraint still holds one row per instrument per set, and the parser is what
      combines a file's duplicate rows on the way in
- [ ] DESIGN.md §14.8's accepted limitation is updated — an overdrawn bank account is now recordable
      through an upload in fact, not only in principle
- [ ] DESIGN.md §5 gains a short note that in-progress uploads live in `upload_draft`, since §4.1's
      table list is otherwise the complete one
