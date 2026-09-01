# Income

What the portfolio pays you over the coming year, split by how it is taxed and by where it lands.

![The Income screen](images/income.png)

One figure at the top, then that same figure cut two ways. Every number here is summed from the
positions the [Holdings](holdings.md) table shows, so the two screens cannot tell you different
things.

## The headline

**Total annual dividend** is what every position is projected to pay over the next year, added
together. A position contributes the number of units you hold times the per-share rate last
recorded for it, so the figure moves when a position changes or a price refresh brings a new rate
in.

Beside it, the **weighted yield**: that total as a percentage of what the portfolio is worth. The
denominator is everything with a positive value added together rather than net worth, so a
household carrying debt is not shown a negative yield on a portfolio that pays it money.

It is one figure for the whole portfolio, which is why neither table below has a yield column of its
own. The per-holding version — one row's dividend over that row's own value — is the small
percentage under each amount on [Holdings](holdings.md#the-columns).

Two things this page cannot tell you, so you do not go hunting:

- **What was actually paid.** Every figure here is forward-looking. There is no history of dividends
  to ask for, and asking Overview for a past date gets you a net worth, not what was paid that
  year.
- **When it lands.** Nothing records a payment date, so there is no calendar of what arrives in
  March.

### The total is a lower bound

The note under the headline says so on the page, and it is the thing to read before any figure
here. **A holding with no dividend rate on file counts as paying nothing rather than as unknown.**
So the total leaves out:

- every holding nobody can quote — a workplace-plan trust priced by hand, for instance;
- all interest on cash, including a savings balance that really does pay you;
- any interest on a loan, which would count against the total rather than toward it.

What you are being shown is *at least* this much. This is the one figure in the app that reads a
missing number as a zero — everywhere else a number that is not known is withheld and the screen
says so — because nothing recorded can tell "this pays nothing" apart from "nobody was ever asked".
The [Holdings page](holdings.md#the-columns) states the same rule for the column this total is
summed from, on purpose: the rule belongs to the figure rather than to either screen, and you should
meet it on whichever of the two you reach first. The reasoning is in
[the project tour](../../README.md#income--what-the-portfolio-pays-over-the-coming-year).

## Annual dividend by tax treatment

A ring and a table: one row for each tax treatment the household actually has money in, largest
first, with what it pays and its share of the total.

**Tax treatment is not the kind of account.** It is what the money inside the account is taxed as —
taxable, tax-deferred or tax-free — and a workplace plan can be either of the last two. Holdings
filters and groups on both, separately.

**Split three ways and not two, deliberately.** The obvious version of this panel is taxed against
not-taxed, and it would merge the two things on the page that differ most: money in a tax-deferred
account is untaxed now and taxed as ordinary income on the way out, while money in a tax-free one is
never taxed at all. Both are "not taxed this year"; only one of them is a bill you have not had yet.

### The sheltered line

The taxed-against-not-taxed question is still answered, as a sentence under the table:

> Sheltered — tax-deferred and tax-free together — comes to $9,017.77 a year. Taxable accounts come
> to $4,322.05, which is the part taxed this year.

**Two amounts, and neither is a fraction of the other.** That is not fussiness: a taxable group can
come out negative, because a loan sits in a tax treatment like everything else and its interest can
outweigh what the holdings beside it pay. When it does, the sentence says the taxable figure is
going out rather than coming in, instead of dividing one number by a larger one with the wrong sign.

**Sheltered is only ever this sentence.** It is never a row, never a wedge, and there is nothing
anywhere in the app you can group or filter by it — doing that would throw away the distinction the
rows above exist to keep.

## Annual dividend by account

The same total again, one row per account, largest first. This is the panel that answers which
statement the money turns up in.

**An account that pays nothing is still a row**, reading $0.00 — a savings account, or a loan. That
is the lower bound above showing its working: the app is not claiming those accounts pay nothing,
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

Every number here is summed from the Holdings table, and you can watch it happen:

1. Open [Holdings](holdings.md) and clear any filters.
2. Group by **Tax treatment**. Each group's subtotal in the **Annual dividend** column is a row of
   the first panel here, and the Total row is the headline.
3. Group by **Account** instead for the second panel.

They agree because both screens read one set of positions rather than each asking the database its
own question.

That survives the owner filter, which narrows this screen as it narrows Holdings: click through
from one to the other and the selection comes with you, so the subtotals still line up. See
[reading a screen as one owner](owner-filter.md).

## Before anything is uploaded

The page shows one sentence and nothing else — no ring, no zeros, no empty frame. A portfolio that
genuinely pays nothing and an instance nothing has been recorded in yet are different things, and
they do not get the same screen. Start at [upload.md](upload.md).

---

**Next:** [Overview](overview.md) — the whole household at a glance, and the chart's two lines.
