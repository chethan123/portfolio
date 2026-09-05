# Settings

Everything that changes what the app knows, apart from [uploading a statement](upload.md).

**Settings** sits at the foot of the left-hand navigation. Inside it, a strip of tabs: **Overview**,
**People**, **Accounts**, **Tax**, **Prices**, **Display** and **Passkeys**.

## Overview

A one-line description of each tab, and a link into it. It also names the three tabs that are **not
built yet**, so nobody hunts for them:

- **Classifications** — the asset labels an instrument is filed under.
- **Instruments** — managing tickers, and typing a price by hand for something with no public quote.
- **History** — the hand-typed net worth series from before this instance existed.

They are named together, with a sentence and nothing to click. See [Not built
yet](../../README.md#not-built-yet).

## People

![The people list, each row with a name box and its account count](images/settings-people.png)

Who is in the household. Every account belongs to exactly one person, so this is the first thing to
fill in — accounts cannot be created until someone is here to own them.

- **Add** with the form at the foot. A name and nothing else: no email, no sign-in, no role. This is
  a label for whose money it is, and it is unrelated to the Google address anyone signs in with —
  adding a person here lets nobody in, and being let in makes nobody a person here.
- **Rename** by editing the box on the row and saving it. Names are not required to be unique.
- **Remove** with the button on the row.

Beside each name is how many accounts they own.

### Removal is refused while they own anything

**A person who owns any account cannot be removed** — and that includes accounts that have been
**closed**, because a closed account still counts on every date before it closed, so its owner is
still needed.

The refusal **names each account in the way**, listed by name and marked where one is closed. Change
the owner on those accounts first, then remove the person.

## Accounts

![The accounts table, with kind, owner, tax treatment and status](images/settings-accounts.png)

The table lists every account the household holds — the name, the institution, the kind, the owner,
the tax treatment, and whether it is open or closed with its closing date.

A closed account stays in the table, marked as closed. Nothing is removed from this list, ever.

**Add** with the form beneath. If nobody exists yet, the form is replaced by a pointer at People.

The fields, and what a kind and a tax treatment mean for your figures, are covered in [People and
accounts](people-and-accounts.md).

**Account number** is the one worth a word here. It is optional, and it is a **check, not a
chooser**: it never picks an account for you, but if you upload a statement that names a different
account number than the one recorded here, the upload is refused rather than landing in the wrong
place.

### Editing one account

![Editing an account, with the close control at the foot](images/settings-account-edit.png)

Select the account's name in the table. Every field is editable and saving is one button, but not
every change is accepted.

**Kind** is the one field that can be refused, because it is how the app reads everything the
account already holds. Changing an account to *Bank* or *Loan or other liability* is refused while
its latest statement still lists positions that a single typed balance would replace, and refused
while its balance is recorded the other way round from the kind you picked — savings moved to *Loan
or other liability*, or a debt moved to *Bank*. The message appears beside **Kind** and names what is
in the way. An account with no statement yet can be changed to anything, and so can any account
moving between *Brokerage*, *Workplace plan* and *IRA*.

Correcting a tax treatment here changes every figure computed from this account, everywhere.

This is also where **Edit details** on [the account's own page](account-detail.md) brings you.

### Closing an account

At the foot of that page, set apart from the fields, is the control that closes it. It has its own
button, separate from saving, so an ordinary edit can never retire an account by accident — and
closing asks to be acknowledged first: tick the sentence that names the account and what closing
does, then select **Close**. The button alone changes nothing; without the tick the close is
refused and the account stays open.

**Closing is not deleting.**

- It records **today** as the closing date.
- The account **stops counting toward current net worth** from then on.
- It **keeps counting on every date before it closed**, so your history does not change shape
  because you retired something today.
- **Closing twice changes nothing.** The original closing date stands; a second attempt cannot
  quietly move a boundary your historical figures are computed against.

A closed account is no longer offered when uploading a statement, and will not accept a typed
balance. Its settings page says it is closed and no longer offers the close control, and it drops
out of the current view everywhere else.

**Closing is one-way in this version.** Some refusal messages suggest reopening an account from
Settings; there is no control that does it. If you close one by mistake, add it again and record
against the new one.

**Almost nothing in this application deletes anything.** An account is closed rather than removed,
and a balance or a statement is corrected by recording another one rather than overwriting it. What
does delete, immediately and with no undo: removing a person, once they own nothing at all, and
removing a passkey on [Settings → Passkeys](#passkeys) — see [Passkeys and the lock](passkeys.md)
for what that does to whatever it was unlocking.

## Tax

![The capital gains rate, as a percentage](images/settings-tax.png)

One field: the capital gains rate, as a percentage. It starts at **23.8%**.

**Nothing but Analysis uses it**, and no figure anywhere is filed with it. See
[Analysis](analysis.md) for what it estimates and the limits on that estimate.

Type a new rate and save. The box then shows what is stored, which is the confirmation.

## Prices

![The refresh cadence, and the holdings whose price history does not reach back far enough](images/settings-prices.png)

Two things: the **refresh cadence**, and a list of what the price history does not cover yet.

The cadence is how often prices are fetched, in whole minutes from 1 to 1440. It starts at **15**.
Fresh *quotes* are only asked for while the market is open, so a lower number costs more requests
during trading hours and none on evenings, weekends and market holidays.

Type a new cadence and save. The box then shows what is stored, which is the confirmation — and the
change is picked up when the next refresh runs, so it can take up to one old cadence to apply. No
restart is needed. See [Why a number did not change](prices.md) for what a cadence can and cannot
make fresher.

**Missing price history** lists every holding you hold from a date the prices do not reach back to,
which is what makes a total for an old date leave that holding out. A refresh fills a few of them in
at a time, at any hour, so the usual answer is to wait — the list empties itself. A row that says
"Never" is one nothing can fetch: a fund with no public ticker, or an instrument nobody has given a
symbol. If a row shows a reason instead of a date, the reason is the whole story; the
[runbook](../runbook.md) says what each one means. An empty list, which is the ordinary state, says
so in a sentence.

## Display

What a browser that has never pressed the **Show amounts** control opens showing. Three choices:
masked every time, showing every time, or however that browser was last left — and it starts at
masked.

This is the household's standing answer, not the control itself. The control — **Show amounts** /
**Hide amounts**, in the navigation on every screen — flips this one browser right now, and needs
no network to do it. Masking hides every amount behind dots while names, dates, the shape of the
chart and every percentage stay readable. It is not a lock: the amounts are still in the page, and
the sign-in at the front door keeps a person out while the lock keeps a browser out.

## Passkeys

![Each enrolled passkey, with its label, when it was enrolled and last used, and whether it can sync to other devices](images/settings-passkeys.png)

What can unlock a browser, once the household holds one. Enrol another, see which can sync to other
devices, and remove one that is gone for good — the full explanation, in the household's own words
rather than this page's, is [Passkeys and the lock](passkeys.md).

No passkey enrolled is not a broken state — it is what a fresh instance already is: unlocked, exactly
as before this tab existed. Enrolling the first one is what turns the lock on, for every browser but
the one doing it, immediately.

---

**Next:** [When something is refused](when-something-is-refused.md).
