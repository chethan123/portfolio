# Analysis

Where the money sits, as four breakdowns of the same portfolio.

![The Analysis screen](images/analysis.png)

There are **four panels**. The first three are a ring beside a table. The fourth is a table on its
own.

If a line at the top says "Based on 17 of 18 holdings", that is every figure on the page telling
you what it was computed from: a holding nobody can price contributes nothing here rather than
counting as zero. See [prices.md](prices.md).

## The three breakdowns

- **Net worth by owner** — who owns what.
- **Value by account type** — brokerage, workplace plan, IRA, bank, loan.
- **Value by asset class** — Equity, Bonds, Cash, Other.

Each table has three columns: the name, its **Value**, and its **% of total**. The ring beside it
is a picture of the same rows, and the figure in the hole of it is total net worth.

The dot beside a name is the colour of that row's slice. The largest row is the same colour in
every panel, so the colours mean rank rather than a person or an asset class.

### A debt is not a slice

The ring paints what is **owned**. A loan is not a part of that, so it gets no wedge, its dot is
left hollow, and the panel says so under the table:

> The ring draws what is owned. A debt is not a share of it, so a negative row is left unfilled
> and its percentage is of gross assets rather than of the total in the centre.

That second half matters when you check the arithmetic. **A negative row's percentage is a share
of gross assets** — everything positive added together — not of the total in the middle of the
ring. So the positive rows come to 100% and the loan's −2.1% sits outside that. The reasoning is
in [the project tour](../../README.md#analysis--where-the-money-actually-sits).

### More than five rows

Everything past the fourth row shares one colour and one wedge. Each row keeps its own value and
its own percentage in the table; only the picture merges them. The panel says so when it happens.

### When nothing is owned outright

A household with only a loan recorded has no whole for a share to be part of. There is no ring,
the percentages read as dashes, and the amounts are the answer.

## Unrealized gains

The fourth panel: what has been gained and not yet sold, and what a taxable account would owe on
it. No ring — a gain is signed, and a signed figure is not a share of anything.

Three rows, by what the holding is: **Individual stocks**, **Funds and ETFs**, and **Cash, loans
and everything else**. Then a Total.

Three columns:

- **Asset type** — the row's name. Under it, where only part of the gain is taxable, a line like
  "$47,901.67 of it in taxable accounts", so the tax beside it can be checked.
- **Unrealized** — value minus cost basis, for everything in that row, wherever it is held.
- **Potential tax** — what settling the taxable part would cost at your rate.

A dash means there is nothing to report: no gain, or no tax to estimate on one.

### Only a taxable account can owe the tax

A gain inside an IRA or a 401k appears under **Unrealized** and contributes nothing to **Potential
tax**. The panel says so under the table. That is not a rounding decision — a Roth withdrawal is
not taxed at all, and a traditional one is taxed as ordinary income on the way out, so neither
belongs at a capital gains rate.

The rows stay in the table either way, because dropping them would hide the largest distinction
on the balance sheet.

### The rate is yours

The panel header reads "Taxed at 23.8% · change rate". The link goes to Settings → Tax, where the
household's own rate is set; see [settings.md](settings.md).

23.8% is only the starting value — the 20% long-term capital gains rate plus the 3.8% net
investment income tax. A household in a lower bracket, or in a state that taxes gains of its own,
has a different number.

Nothing anywhere else on any screen uses this rate, and no figure is filed with it.

### The figure is a ceiling, not a bill

**A loss in one asset type is not netted against a gain in another here**, the way a real return
would net them. So the Potential tax column is an upper bound on what settling everything would
cost, not an estimate of a bill. The panel adds that sentence whenever there is a loss for it to
apply to.

The row totals are added up as they stand, so the column on screen adds to the Total printed under
it.

Coverage is counted separately here, because a gain needs **both** a price and a cost basis:

> Based on 11 of 18 holdings: the rest have no cost basis or no price recorded, and a gain needs
> both.

## Reading it as one owner

The control at the top narrows all four panels at once, and it is the same selection Overview,
Holdings and Income carry — see [reading a screen as one owner](owner-filter.md). The **Net worth by
owner** panel then shows the selected people alone, which is the one place the narrowing is visible
twice: the ring is of them, and so are its rows.

## Before anything is uploaded

The page shows one sentence and no panels. No rings, no zeros, no empty frames — a net worth of
zero and an instance with nothing in it are different things. Start at [upload.md](upload.md).

---

**Next:** [Income](income.md) — what the same portfolio is projected to pay over the coming year.
