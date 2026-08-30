# Why a number did not change

Prices mostly look after themselves, so this page is three short answers.

## "My total is the same as yesterday"

Prices refresh on their own, in the background, while the market is open. Every screen with a
figure carries the same **As of** line in its header — the age of the oldest fetched price on
anything the household owns, whichever screen or owner you are looking at — and a **Refresh now**
button beside it. One press spends one request for fresh quotes and says underneath
what it did: how many prices it fetched, or that nothing was new since the stamp. That answer is
how you know it ran — the stamp itself is the *oldest* fetched price, so it can stay put after a
press that worked.

So a total that has not moved usually means the market has not moved it:

- **Outside trading hours, nothing refreshes on its own.** Evenings, weekends and market holidays
  hold the last close. This is working correctly. Refresh now still works then — it usually finds
  nothing new, but it is how a holding recorded on a weekend gets its first price without waiting
  for Monday's open.
- **Quantities only change when you record them.** A price moving is automatic; you holding more of
  something is not. That comes from [an uploaded statement](upload.md) or
  [a correction](holdings.md).
- **How often prices refresh during the day is the refresh cadence**, set at Settings → Prices in
  whole minutes. A change is picked up when the next refresh runs, so it can take up to one old
  cadence to apply. If a total looks genuinely stuck beyond that, press **Refresh now** first; if
  it reports a failure rather than "nothing new", see [operating](../operating.md).

Two things you may see on a row instead of a fresh figure:

- **"price is stale"** — the last refresh could not get a new quote, so the price shown is the last
  one known. It is still a real price, just an older one. It keeps counting.
- **"never priced"** — see below.

## "This holding shows a dash"

A dash is not zero. It means nothing here can put a value on that holding, and the app would rather
show you nothing than show you a wrong number.

That happens when the holding has no price anyone can look up. A collective investment trust inside
a workplace plan is the usual case: it has no public ticker, so there is nothing to quote.

What follows from it:

- **The holding is excluded from every total, never counted as zero.** Your net worth is the value
  of everything that *could* be priced.
- **Every total says how much of the portfolio it covers** — "the figure and the line are 17 of 18
  holdings; the rest have never been priced". That sentence is how you know something is missing
  rather than worth nothing.
- **Each column counts separately.** A workplace plan often reports a price and no cost basis at
  all, so the value total can be complete while the unrealized total is short. The counts differ
  because they are counting different things.

Setting such a price by hand is not possible yet — Settings lists Instruments as a tab that is not
built. Until it exists, that holding stays outside the totals and the coverage sentence keeps saying
so.

## Everything is in dollars

The app is USD only. It does not convert currencies, and it refuses a foreign-currency price rather
than guessing an exchange rate. A holding quoted in another currency cannot be priced here.

---

The reasoning behind all of this — why an unpriceable holding is excluded rather than zeroed, and
why a quote is filed under the day the market gave it — is in
[the README](../../README.md#where-prices-come-from).

**Next:** [Settings](settings.md) — the dials behind these screens, the refresh cadence among them.
