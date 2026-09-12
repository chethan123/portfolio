# Income

What the portfolio pays you over the coming year, split by how it is taxed and by where it lands.

![The Income screen](images/income.png)

One figure at the top, then that same figure cut two ways. It uses the same current positions as [Holdings](holdings.md). Compare them with the same
owner selection and no additional Holdings filters.

## The headline

**Total annual dividend** adds each current quantity multiplied by its recorded per-share annual
rate. It is a projection, not payments received or a payment calendar.

**Weighted yield** divides that total by positive holding values added together. Debt does not
reduce the denominator. Holdings shows each position’s own rate beneath its annual dividend.

### The total is a lower bound

The screen calls this a lower bound, but that description assumes omitted amounts are income.
Missing rates count as zero, including missing loan interest, so it is **not a guaranteed minimum
for net income**. Read it as a projection using recorded rates, with unknown income and expenses
omitted. [Holdings](holdings.md#the-columns) uses the same figures.

## Annual dividend by tax treatment

The table groups annual dividend as taxable, tax-deferred, or tax-free. These describe the
account’s tax treatment, not its kind: a workplace plan can be tax-deferred or tax-free.

### The sheltered line

The sheltered subtotal combines tax-deferred and tax-free accounts. The taxable subtotal stays
separate. Either can include negative amounts when an instrument held as debt has a recorded rate;
the two subtotals are amounts, not percentages of each other.

## Annual dividend by account

The same total again, one row per account, largest first. This is the panel that answers which
statement the money turns up in.

**An account that pays nothing is still a row**, reading $0.00 — a savings account, or a loan. That
is the missing-rate rule showing its effect: the app is not claiming those accounts pay nothing,
only that it has no rate on file for them.

## The rings, and when a percentage is missing

Both panels are the panel [Analysis](analysis.md) draws, and they behave the same way:

- **Colour means rank**, not a particular account or treatment — the same rank is the same colour in
  every panel on every screen. See [Analysis](analysis.md#the-breakdowns).
- **A long breakdown folds its tail into one grey wedge** — grey on purpose, so the remainder never
  looks like a coloured group — while every row keeps its own figures in the table. See
  [More than five rows](analysis.md#more-than-five-rows).
- **A negative row gets no wedge and a hollow dot**, and its percentage is a share of everything
  positive rather than of the figure in the middle of the ring. The panel says so under the table
  when it happens. The sentence differs from the one on Analysis, because a negative here is
  interest going out rather than a debt being held — the arithmetic is the same and the reading
  is not.
- **If nothing in a breakdown pays anything there is no ring at all**, the percentages read as
  dashes, and the amounts are the answer.

## Checking a figure against Holdings

Open Holdings, clear its account and asset filters, and group by the same dimension. Its Annual
dividend total should match Income for the same owner selection. Missing value or cost basis does not imply missing dividend data.

## Before anything is uploaded

The page shows one sentence and nothing else — no ring, no zeros, no empty frame. A portfolio that
genuinely pays nothing and an instance nothing has been recorded in yet are different things, and
they do not get the same screen. Start at [upload.md](upload.md).

## On a phone

![Annual dividend by tax treatment on a phone, the ring above its table](images/income-mobile.png)

Same figures, same two panels, but each one stacks: the ring first, full width, its table below
rather than beside it — the same reflow [Analysis](analysis.md#on-a-phone) uses for its own rings,
since this screen draws them.

---

**Next:** [Overview](overview.md) — the whole household at a glance, and the chart's two lines.
