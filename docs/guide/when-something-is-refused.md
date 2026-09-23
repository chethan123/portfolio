# When something is refused

Most refusals explain themselves. When you mistype an amount or leave a required box empty, the app
says so beside the box, keeps what you typed, and records nothing. Read the message and try again.

This page is for the handful where the message is clear but the *cause* is somewhere you cannot see.

## "This upload has expired or was already recorded"

Starting an upload clears unfinished drafts more than 24 hours old. Committing removes its draft
immediately. A draft can also become unavailable if its account closes.

Open the account to check whether the statement landed. If it did not, start another upload;
saved mappings and instrument names remain. A closed account's history does not change, so a draft
that finds its account closed underneath it expires the same way — there is no reopening it. See
[closed-account recovery](people-and-accounts.md#correcting-or-retiring-an-account).

## A securities account will not let you type a balance

[Set balance](account-detail.md) appears on bank and loan accounts only.

A brokerage, IRA or workplace plan holds individual positions, and its value is what those positions
are worth, so there is no single number to type. Its balance comes from
[a statement](upload.md) or [a correction](holdings.md) instead.

## A bank or loan account will not take a balance either

The form is there, and it still says no, naming what the account holds.

A typed balance is the *whole* statement for that account: one figure, replacing everything recorded
before it. That is exactly right for a current account, and it is why the account list, the chart
and net worth all move the moment you record one. But if a statement was uploaded against this
account at some point, it may list more than cash, and typing one figure over it would record
everything else as sold.

So the refusal names the positions in the way. Either [upload a statement](upload.md) for the
account, which is what says what it holds, or [correct the position](holdings.md) on Holdings if it
should not be there.

## An account's kind will not change

Every other field on an account can be corrected freely. **Kind** is the one that cannot always be,
because it is not a caption. Every figure in the application reads it, on every date, including
dates from before you changed it.

Two refusals, both naming what is in the way:

- **It holds positions.** A bank or loan account is one balance; a brokerage, IRA or workplace plan
  is a list. An account holding positions cannot become one that holds a single balance while those
  positions are still recorded against it, because they would have nowhere to go.
- **Its balance points the other way.** Money held and money owed are the same figure with opposite
  signs, so making a savings account a loan would turn what you have into what you owe without
  anything being typed. Record the balance as zero first if it really did turn around, then change
  the kind.

An account with nothing recorded against it yet can always change kind, which is the case this
usually is: a kind picked wrongly when the account was added.

**On a closed account, neither way out is open.** A closed account's history does not change, so
there is no balance to zero and no statement to upload, and the message says so rather than
suggesting something that would be refused in turn. Its other fields still edit normally. This is
only about **Kind**.

## A person cannot be removed

Someone who owns an account cannot be removed, and that includes accounts that have been **closed**.
A closed account still counts on every date before it closed, so its owner is still needed.

The refusal names each account in the way. Change the owner on those accounts, then remove the
person.

Almost nothing in this application deletes anything, so this is the shape of most "no" answers here:
an account is closed rather than deleted, a correction is a new record rather than an overwrite. What
does delete, immediately and with no undo: removing a person once they own nothing at all, and
removing a passkey on Settings → Passkeys. See [Passkeys and the lock](passkeys.md).

## The review screen wants a sentence ticked

A statement is one photograph of the whole account, so anything the file leaves out is treated as
sold. That is correct for a normal export and catastrophic for a filtered one.

When a file would remove more than half of what the account holds, the review screen states the
ratio and will not record until you tick it. Before you do, check that you exported *all* positions
rather than a filtered page. The removals are listed individually, with quantities, so they are
worth reading.

## A statement must be reviewed again before it records

Recording is tied to the exact statement interpretation shown on Review. The app asks for another
review when the file or mapping changed, an instrument name gained a different meaning, the chosen
date changed, or an upload, balance or correction changed the account's history. An older open form
may also need a fresh review after an app update. Price updates can change the values shown, but
do not cause this refusal because Review is authorizing positions rather than prices.

Nothing was added to the account. Read the newly drawn date and diff, then select any filed-behind
or removal confirmations that still apply and record again. If a figure is wrong, return to Columns
to check the mapping; if an instrument name is wrong, check Settings → Instruments. When the draft
needs an earlier step before Review can be drawn again, the app takes you there first.

## The file itself is refused

A statement is rejected outright, rather than partly imported, when it cannot be read honestly:

- **It is not a CSV.** Export the CSV version. Spreadsheets and PDFs are not read.
- **It is too large.** The cap is set by whoever runs the instance.
- **A quantity makes no sense**, or rows disagree about what date the statement is. The message
  names the line, so open the file at that line.
- **An instrument is blank while a mapped quantity or cost basis states a figure or malformed
  text.** The message names the line and populated columns. If the instrument is in another column,
  change the mapping. If the source row is wrong, edit the CSV outside Portfolio and start a new
  upload; an existing draft keeps its original file.
- **Rows disagree about the account number.** A single-account upload describes one account; export
  one account per file, or upload it as **Several accounts (the file has an account-number column)**
  instead, which routes each row by its own number.
- **Quantity multiplied by price, per-share basis, or dividend rate exceeds the money field's limit.**
  Check the named row's quantity and basis mapping; commit refuses amounts it cannot store.
- **The statement dates itself before 1970-01-01.** That is the earliest date this application can
  price anything, so a statement older than it could not be valued.

Nothing is ever partly recorded. A refused file leaves the account exactly as it was, which is why
it is safe to try again.

## Several accounts

Choosing **Several accounts (the file has an account-number column)** on `/upload` adds an Accounts
step, and with it a few refusals of its own:

- **A row that would be a position, and names no account.** The message lists the line numbers and
  instruments. A totals or footer row with nothing in the quantity column is not one of these — it
  is dropped quietly, the same as on a single-account upload — because only a row the app would
  otherwise record needs to say which account it belongs to.
- **A number recorded only on a closed account.** The message names the account and says the number
  can be cleared on it in Settings — a closed account's history never changes, so there is no
  reopening it to accept the file instead.
- **A number already recorded on another open account.** Settings refuses giving a number to a
  second account, and a single-account upload whose account-number column is mapped is refused the
  same way, both naming the account that already holds it. If both accounts genuinely share this
  number, choose **Not in this file** for the account-number column and upload again.
- **An account number stored as blank space.** The app will not write an answered number over it;
  save that account once in Settings, which clears it, and record again.
- **A number two open accounts both hold once spacing is trimmed.** Settings can let two accounts'
  numbers differ only by a leading or trailing space, but routing trims before it compares, so the
  file's rows have nowhere single to go. The message names both accounts; clear the number from all
  but one of them in Settings.
- **An answer gone stale.** If the account you chose for an unknown number has recorded a number of
  its own since you answered, the upload sends you back to the accounts step to choose again.
- **An account number changed while the file was being recorded.** Its rows now go to a different
  account than the review showed. Nothing was recorded — the review re-renders so you can check and
  confirm again.
- **Every number skipped.** Telling every unknown number to skip its rows means the upload would
  record nothing, so it is refused rather than doing that silently.
- **One account given two numbers.** An account offered for an unknown number can be chosen for only
  one of them per upload; choosing it twice is refused.

---

**Next:** back to [the guide index](README.md).
