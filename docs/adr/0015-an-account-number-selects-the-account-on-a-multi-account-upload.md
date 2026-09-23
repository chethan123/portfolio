# An account number selects the account on a multi-account upload

Spec 0004 made the account number "a guard, not an auto-selector", and left "one file covering
several accounts" out of scope because the flow picks the account before the file is parsed. We are
reversing both, for one kind of upload only. A household that keeps its positions in one
spreadsheet, or downloads one brokerage's all-accounts export, has to split it into one CSV per
account today, by hand, which is exactly the editing the tolerant reader exists to spare them. So an
upload may now skip picking an account, and then every row is routed to the open account whose
recorded **account number** matches its own. An upload made into a chosen account is unchanged, and
there the number stays a guard.

## Why this is safe to reverse now

The old line held because nothing could make a number trustworthy as a selector. It was optional,
free text, captured as a side effect of the first upload, and not unique. Three rules make it
trustworthy, and the reversal depends on all three:

- **At most one open account records a given number.** A partial unique index over open accounts.
  Settings refuses a duplicate, and so does the commit that would record one. Closed accounts are
  outside it, because nothing is ever routed to one.
- **An unknown number is asked about, never guessed.** It is asked once in the upload that meets it,
  like a first sighting. It can be given only to an open account that records no number yet, or its
  rows can be skipped. The answer is the draft's until the upload is recorded (the same rule as
  ADR-0013), and then the account keeps the number. A recorded number is never overwritten by an
  upload, and it outranks an answer: an answer whose account has recorded a number since is
  refused at commit as stale, not applied. A renumbered account is corrected in Settings,
  deliberately.
- **Matching is exact, surrounding whitespace aside.** No case folding and no stripping of dashes or
  leading zeros. A spreadsheet that ate a leading zero produces an unknown number, which the reader
  sees in the picker, rather than a guessed match they never see.

## What else follows from routing by number

- **Any mix of institutions.** The number is the key, so constraining a file to one institution buys
  nothing. The file's column mapping is saved by header fingerprint alone, in a scope of its own, so
  it never collides with an institution's.
- **A file is a statement for each account it names, and nothing else.** An open account the file
  does not mention is untouched. An absent account says nothing about it, and treating it as sold
  would be §5.2's filtered-export accident scaled up to a whole account.
- **Every row must name an account.** A blank number refuses the file, listing the lines. A dropped
  row is a position recorded as sold.
- **A number recorded only on a closed account refuses the file.** It names the account and says to
  clear the number in Settings (`updateAccount` still edits a closed account).
- **All or nothing.** One transaction across every account, locking each in ascending id order.
  The review screen and its confirmations are per account, because each confirmation is a sentence
  about one account's baseline.
- **Stored numbers are trimmed on every write,** so the unique index and the router agree on what
  "the same number" is.

## Considered options

- **Keep the line, and split the file client-side into N single-account drafts.** Rejected: N drafts
  means N mapping and instrument passes over one file, and N commits with no atomicity between them.
- **Create an account for each unknown number.** Rejected: an upload would become account creation,
  and a mistyped number would make a phantom account. Accounts are made in Settings.
- **Let the picker overwrite a recorded number.** Rejected: one misclick merges two accounts'
  holdings into one statement and routes every later file wrongly, silently.
- **One institution per file.** Rejected, as above. It would have kept the mapping scope unchanged,
  and that was its only benefit.

## Consequences

- The glossary's **Account number** entry names both roles, guard and selector, and says which
  upload uses which.
- An account can no longer be emptied through a multi-account upload, since absence means
  untouched. That stays a single-account upload or a set balance of zero.
- A migration adds the uniqueness index, and it fails naming any duplicates already recorded rather
  than choosing between them.
- `ARCHITECTURE.md`, `docs/data-model.md` and `migrations/0001_initial_schema.sql`'s column comment
  all say "never a selector". The first two are amended when [spec 0023](../specs/0023-multi-account-upload.md)
  lands. The migration comment stays as the history it is, and the new migration's comment
  supersedes it.
