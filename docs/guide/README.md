# Using Portfolio Tracker

For the person the numbers belong to. It assumes someone has already got an instance running and
given you the address — if that someone is you, start at
[running an instance](../../README.md#running-an-instance) instead.

Everything here is the real application. The screenshots are of a made-up household with invented
figures, captured in light mode; the app follows your system's setting, so a dark system shows the
same screens darker.

## Start here

Three pages, in this order. Together they take an empty instance to one showing a real net worth.

1. **[First run](first-run.md)** — signing in with Google, what a new instance looks like, and
   finding your way around.
2. **[People and accounts](people-and-accounts.md)** — who is in the household and what they own.
   Nothing else works until this is done.
3. **[Your first statement](first-statement.md)** — the four-step upload, once, end to end.

## The screens

Come back to these when you want to know what something on a screen means.

- **[Overview](overview.md)** — the household total, the line behind it, and the account list.
- **[Holdings](holdings.md)** — every position, filtered and grouped however you ask. Also where you
  correct a figure.
- **[Analysis](analysis.md)** — where the money sits, and what has been gained but not yet sold.
- **[Income](income.md)** — what the portfolio is projected to pay over the coming year, and how
  much of that is taxed.
- **[An account](account-detail.md)** — one account end to end, and where you record a bank or loan
  balance.
- **[Uploading statements](upload.md)** — what a file has to look like, and what the app does with
  it.
- **[Settings](settings.md)** — people, accounts, closing an account, the tax rate, and how
  amounts start hidden.
- **[Passkeys and the lock](passkeys.md)** — what it means for a browser to be locked, and how to
  get one back in.
- **[Reading a screen as one owner](owner-filter.md)** — narrowing all four money screens to one
  owner, and what changes when you do.

## Worth knowing

- **[Why a number did not change](prices.md)** — how prices refresh, and why some holdings show a
  dash instead of a value.
- **Every amount shows as dots?** That is masking: press **Show amounts** in the navigation, and
  see [Settings → Display](settings.md#display) for how a fresh browser opens.
- **[When something is refused](when-something-is-refused.md)** — the refusals whose cause is not
  on the screen in front of you.

## Two things to expect

**Almost nothing here deletes anything.** An account is *closed*, not removed. A correction records
a new figure rather than replacing the old one. Your net worth in March does not change because you
fixed something in August. What does delete, immediately and with no undo: removing a person once
they own nothing at all, and removing a passkey — see [Passkeys and the lock](passkeys.md).

**A number is withheld rather than guessed.** Where a holding cannot be priced it is left out of the
total and the screen says how much of the portfolio the total covers. A dash never means zero.

## Not built yet

So you are not left hunting for them: Settings names **Classifications**, **Instruments** and
**History** as what later slices build — they are not drawn as tabs. There is also no export or
download of any kind.

---

Running the instance — backups, upgrades, the Google sign-in in front of it and who is let
through — is [operating](../operating.md). Why the app behaves as it does is
[the README](../../README.md#what-it-looks-like).
