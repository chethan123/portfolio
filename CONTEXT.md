# Portfolio Tracker

A self-hosted family portfolio and net worth tracker. This file is the glossary: the words this
project uses for its own concepts, and the ones it deliberately avoids. It holds no implementation
detail — [`DESIGN.md`](DESIGN.md) is the design record, [`ARCHITECTURE.md`](ARCHITECTURE.md) is how
the code is arranged, and [`docs/adr/`](docs/adr/) holds individual decisions.

Terms are added when one is actually resolved, not preemptively.

## Language

### Money the portfolio pays

**Annual dividend**:
What a holding is projected to pay over the coming year, from the quantity held and the instrument's
current per-share rate. Forward-looking and current-only: there is no such figure for a past date.
_Avoid_: dividend income, payout, projected income, distribution.

**Weighted yield**:
A group's annual dividend as a fraction of that group's value. Stated for the whole portfolio and
per breakdown row; never stored.
_Avoid_: average yield, blended yield, portfolio yield.

### How money is taxed, and where it sits

**Tax treatment**:
Which of three tax regimes an account's money is in — `taxable`, `tax_deferred`, `tax_free`. Three
values, never a boolean: a Traditional balance and a Roth balance are both untaxed today and differ
entirely in what is owed later.
_Avoid_: account type, tax status, taxable/non-taxable.

**Account type**:
Which of five kinds an account is — brokerage, workplace plan, IRA, bank, liability. Distinct from
tax treatment, and the two are not interchangeable: a workplace plan may be tax-deferred or tax-free.
The schema calls this column `account_kind`; the screens call it Account type.
_Avoid_: using it to mean tax treatment.

**Sheltered**:
Shorthand for tax-deferred and tax-free taken together. A subtotal a screen may state in words. It
is never a stored value, never a grouping key, and never a slice of a chart — grouping by it would
discard the distinction tax treatment exists to keep.
_Avoid_: tax-advantaged, non-taxable, unsheltered.

### What a screen shows in public

**Masked**:
The display state in which every amount on a screen is replaced by a fixed run of dots. An amount is
any absolute figure — a value, a balance, a cost basis, a gain, a share quantity; a ratio is never
masked, and neither is a name, a symbol or a date. It is a state of the display and nothing more:
the login gate is the only thing that keeps anyone out.
_Avoid_: private, privacy mode, hidden, secure, locked, redacted.

**Masking policy**:
The household's standing choice of what a browser that has not been toggled yet opens in — masked,
unmasked, or as that browser last left it. Distinct from being masked, which is a fact about one
browser at one moment rather than about the household.
_Avoid_: privacy setting, hide on start, default state.
