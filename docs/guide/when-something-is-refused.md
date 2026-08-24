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

## A bank or loan account will not take a balance either

The form is there, and it still says no — naming what the account holds.

A typed balance is the *whole* statement for that account: one figure, replacing everything recorded
before it. That is exactly right for a current account, and it is why the account list, the chart
and net worth all move the moment you record one. But if a statement was uploaded against this
account at some point, it may list more than cash — and typing one figure over it would record
everything else as sold.

So the refusal names the positions in the way. Either [upload a statement](upload.md) for the
account, which is what says what it holds, or [correct the position](holdings.md) on Holdings if it
should not be there.

## An account's kind will not change

Every other field on an account can be corrected freely. **Kind** is the one that cannot always be,
because it is not a caption — every figure in the application reads it, on every date, including
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
usually is — a kind picked wrongly when the account was added.

**On a closed account, neither way out is open.** A closed account's history does not change, so
there is no balance to zero and no statement to upload, and the message says so rather than
suggesting something that would be refused in turn. Its other fields still edit normally — this is
only about **Kind**.

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
- **The statement dates itself before 1970-01-01.** That is the earliest date this application can
  price anything, so a statement older than it could not be valued.

Nothing is ever partly recorded. A refused file leaves the account exactly as it was, which is why
it is safe to try again.

---

**Next:** back to [the guide index](README.md).
