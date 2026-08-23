# When something is refused

Most refusals explain themselves. When you mistype an amount or leave a required box empty, the app
says so beside the box, keeps what you typed, and records nothing — read the message and try again.

This page is for the handful where the message is clear but the *cause* is somewhere you cannot see.

## "This upload has expired or was already recorded"

An upload in progress is a draft, and a draft does not live forever.

- **Drafts are cleared after 24 hours.** A half-finished upload left overnight is gone in the
  morning. Start it again; nothing was recorded, so nothing is lost but the mapping you did — and
  the column mapping itself is remembered per institution, so the second attempt arrives prefilled.
- **You already finished it.** The draft is deleted the moment the statement is recorded, so going
  back to a step you completed lands here. The statement is safe. Open the account to see it.
- **The account was closed while the draft was open.** A closed account's history does not change,
  so the statement can never land — the draft reads as expired rather than as forbidden.

  The refusal suggests reopening the account from Settings. **There is no reopen control in this
  version** — closing is one-way. If the statement is still real, add the account again under
  [Settings](settings.md) and upload against the new one.

## A securities account will not let you type a balance

[Set balance](account-detail.md) appears on bank and loan accounts only.

A brokerage, IRA or workplace plan holds individual positions, and its value is what those positions
are worth — so there is no single number to type. Its balance comes from
[a statement](upload.md) or [a correction](holdings.md) instead.

## A person cannot be removed

Someone who owns an account cannot be removed, and that includes accounts that have been **closed** —
a closed account still counts on every date before it closed, so its owner is still needed.

The refusal names each account in the way. Change the owner on those accounts, then remove the
person.

Nothing in this application deletes anything, so this is the shape of most "no" answers here: an
account is closed rather than deleted, a correction is a new record rather than an overwrite.

## The review screen wants a sentence ticked

A statement is one photograph of the whole account, so anything the file leaves out is treated as
sold. That is correct for a normal export and catastrophic for a filtered one.

When a file would remove more than half of what the account holds, the review screen states the
ratio and will not record until you tick it. Before you do, check that you exported *all* positions
rather than a filtered page — the removals are listed individually, with quantities, so they are
worth reading.

## The file itself is refused

A statement is rejected outright, rather than partly imported, when it cannot be read honestly:

- **It is not a CSV.** Export the CSV version — spreadsheets and PDFs are not read.
- **It is too large.** The cap is set by whoever runs the instance.
- **A quantity makes no sense**, or rows disagree about what date the statement is. The message
  names the line, so open the file at that line.

Nothing is ever partly recorded. A refused file leaves the account exactly as it was, which is why
it is safe to try again.

---

**Next:** back to [the guide index](README.md).
