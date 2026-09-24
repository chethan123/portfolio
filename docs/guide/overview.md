# Overview

What the household is worth today, and the line behind it.

![The Overview screen at its default 1Y range](images/overview.png)

## The headline and the chip beside it

**Total net worth** adds the current value of open accounts. Loans subtract. The change chip
compares current value with the value on one earlier date, its **comparison date**: the start of the
range on every range but 1D, and on 1D the day before the session being drawn. This remains true for
Custom ranges ending in the past. The chip is not the change between the chart's endpoints.

**Three things can be that earlier value, in this order.** A statement recorded on or before the
comparison date: your positions, valued there. Failing that — the comparison date falls before your
first statement — the most recent hand-typed point on or before it, held forward the way a price is.
That point need not be one the line draws. It is the value in force on that date, not the first dot
on the chart.

Failing both, the chip measures from the earliest date it can value, and says which under the
figure: "Measured from 12 Oct 2023". That happens whenever nothing you have recorded reaches the
comparison date: when the range starts before anything at all was recorded, as the default year does
while nothing — no statement, no hand-typed point — is older than a year; when you have narrowed to
an owner and the range reaches back past that owner's first statement, since the hand-typed history
is the household's and has no owner; and on 1D on the day of your first upload, where your positions
begin on the session itself and no hand-typed point is in force on the day before.

The note is about your own history, not about the market. A closing price for that day may well be
stored — the app fills in earlier closes for what you hold — and the chip will still measure from
later, because none of your positions reach back that far.

If that earlier value is genuinely zero — nothing was held then — only the amount is shown, with no
percentage.

The **As of** line is the oldest provider timestamp among currently held feed-priced instruments,
across the household. A successful refresh need not advance it. [Prices](prices.md).

## The range control

Nine options, top right: **1D**, **1W**, **1M**, **3M**, **YTD**, **1Y**, **5Y**, **All**,
**Custom**. You get 1Y unless you pick another, or unless a browser you have chosen a range on
before opens here again. See below.

- **1D** is the most recent trading session, and it is the one option that is not a span of days.
  See below.
- **1W / 1M / 3M / 1Y / 5Y** are trailing spans back from today: a week, a calendar month, a
  calendar quarter, a year, five years.
- **YTD** is January 1st of this year through today.
- **All** starts at the earliest date anything is recorded: your first statement, or the oldest
  hand-typed point if that is older still. It is not a fixed number of years.
- **Custom** opens a small form with a start and end date. Both boxes refuse a date before your
  earliest data or after today, so you cannot pick a span that could only fail. Once applied, the
  button shows the two dates you chose instead of the word "Custom".

**A greyed-out option is one your data cannot reach yet.** A household eight months old sees 5Y
disabled rather than a click that silently does the same thing All already does. 1D greys out for a
different reason: an instance with no stored price observations has no session to draw yet.

**Narrowing to an owner can grey more of them out**, because a narrowed chart reaches back only as
far as the selected owners' own first recorded holdings. See the dashed line below. The options
come back the moment you press **Show everyone**.

**1W, 1M and 3M draw the sessions inside them, not just their closes.** Every day gets a point every
15 minutes, an hour or three hours depending on the range, finer for a shorter one, laid across the
whole day's width — a session takes up as much of the chart as any other day, not the sliver of the
24 hours it actually runs. The weekend is a flat stretch between Friday's close and Monday's open. A
gap, a stretch where nothing was observed, is a straight bridge between the point before and the
point after, never a flat run. A point's readout names the moment its price was actually struck. YTD
gets whichever of these applies to how much of the year has passed, and changes partway through it:
15-minute steps for the first week of January, hourly until the start of February, three-hourly
until early April, then the ordinary daily line for the rest of the year.

The choice lives in the address bar as `?range=3m` (or, for Custom,
`?range=custom&start=…&end=…`). So it survives a reload, you can bookmark it, and you can send the
address to the other person in the household and they will see the same window you did. With no
range in the address bar, this browser reopens on whichever range you picked here last time,
remembered in a cookie. That choice is a convenience, not a household setting, so it is
not in Settings and does not follow you to another browser.

The owner filter, whose control sits beside this one, works the other way round on purpose. It is
the address and nothing else, with no cookie behind it, so opening the base address shows the whole
household; a bookmark or restored tab keeps the selection in its URL. A remembered range shows you
the same shape of the same money; a remembered owner would quietly show you a smaller total. See
[reading a screen as one owner](owner-filter.md#it-lasts-as-long-as-the-address-does).

## Reading a point off the line

The readout names the last plotted point until you point at the chart. It then follows the nearest
point, with a vertical guide. It describes a historical or observed price; the headline uses current
quotes, so the figures can differ even when the range ends today.

## 1D: the latest trading session

![The Overview at the 1D range, its axis labelled by time of day](images/overview-range-1d.png)

1D shows the latest session with stored price observations, from its first recorded instant to its
last. If fetching stopped, that session may be older than the latest market day. There must be at
least two observations at distinct times to draw a line.

- The axis and readout show time on the market's clock.
- Every distinct observed instant is plotted; one refresh can add several points.
- The change chip's comparison date is the day before the displayed session, so it reads the way a
  brokerage's "today's change" does. If your positions begin on the session itself and no hand-typed
  point is in force on the day before, nothing can be valued there: the chip says so and measures
  from the session instead, while the line still draws in full. An older hand-typed point is enough
  to answer for that day, and then there is no note.
- Current quantities are used across the session — 1D is the only range that does this. An upload
  can change the whole 1D line; every other range values each day at the positions you held on it,
  so an upload there only reshapes the line from the day it lands.

Mutual funds often report one daily price, leaving parts of the line flat. The chart does not
stream. Reload or use **Refresh now** to read newer observations.

## The second, dashed line

![The Overview at the All range, with a dashed line ahead of the solid one](images/overview-range-all.png)

The solid line values account snapshots on each date. The dashed prefix contains hand-entered
household totals from before those snapshots. Computed points take precedence where they overlap.
The readout identifies hand-entered points.

An [owner-filtered](owner-filter.md) chart omits manual history because those totals have no owner.
**Show everyone** brings it back. There is no History editor in the app yet.

## What the figure counts

An unpriced holding contributes no value to net worth. The coverage note counts priced holdings
against recorded holdings. A missing price is not a zero.

The chart currently lacks per-point coverage labels: past points can be partial even when current
coverage is complete. [Prices](prices.md) explains missing and stale values.

## The accounts list

Every open account, largest first, with its institution, its kind and its owner. The count in the
header, "6 active", is how many are listed.

- **Click a row to open that account**: its own chart, and what it holds. See
  [account-detail.md](account-detail.md).
- **A liability is an account like any other.** The auto loan reads −$14,500.00 and subtracts from
  the total above. It is not a special case anywhere in the arithmetic.
- **A closed account is not here.** It stops counting toward today's figure and keeps counting on
  every date before you closed it, so the line behind you does not move. Closing is in
  [settings.md](settings.md).

There is no per-account change figure. The list is what each account holds now.

## Allocation by account

The bars are a share of what is **owned**, not a share of the net total.

That has one consequence worth knowing: an account holding nothing ownable has no bar. A loan has
none, and neither does an account whose every position is unpriced. The note under the bars says
so when it applies. The reasoning is in
[the project tour](../../README.md#overview-what-the-household-is-worth).

Only the five largest accounts get a bar. When there are more, the note says how many hold value
altogether.

The figure beside each bar is that account's value, not its percentage. For exact percentages, go
to [Analysis](analysis.md).

## When there is nothing to draw

A line needs at least two plotted points, which can include the household's manual history. Try
**All** or let more dated samples accumulate; a second statement is not required. For 1D, prices
must have been observed at two distinct times. The empty panel still says a second statement is
needed; that wording is outdated
([fix tracked in #280](https://github.com/chethan123/portfolio/issues/280)). An account with no
records differs from one with records but no prices.

## On a phone

![The Overview on a phone](images/overview-mobile.png)

The same page. The left rail becomes a bar along the bottom, and the panels stack. Nothing is
withheld on a small screen.

The readout above the line is filled in already, so the chart says where the line ends without
being pointed at. Tap a point to read that one instead.

![The Overview at the 1D range, on a phone](images/overview-range-1d-mobile.png)

1D reads the same way narrower: the axis and readout still name the time of day, and the range
row scrolls sideways to reach the options past 1Y rather than wrapping them onto a second line.

![The Overview at the All range, on a phone](images/overview-range-all-mobile.png)

The dashed pre-app line is still there too, and still drawn differently from the solid one for the
same reason as above.

---

**Next:** [The owner filter](owner-filter.md), narrowing every figure on these screens to one
person's.
