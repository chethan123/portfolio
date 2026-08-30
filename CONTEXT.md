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
The schema calls this column `kind` (the `holding_valued` view exposes it as `account_kind`); the
screens call it Account type.
_Avoid_: using it to mean tax treatment.

**Sheltered**:
Shorthand for tax-deferred and tax-free taken together. A subtotal a screen may state in words. It
is never a stored value, never a grouping key, and never a slice of a chart — grouping by it would
discard the distinction tax treatment exists to keep.
_Avoid_: tax-advantaged, non-taxable, unsheltered.

### How an account ends

**Closed**:
The retired state of an account, recorded as the date it stopped being used. A closed account
contributes nothing to current figures and still counts on every date before its closing date.
Closing is the only way an account ends — nothing is deleted — it must be acknowledged before it
happens, and it is one-way in this version: there is no reopen.
_Avoid_: deleted, removed, archived, deactivated, inactive.

### How a chart's time span is chosen

**Chart range**:
The named span of time a chart plots: one of the fixed presets (1D, 1W, 1M, 3M, YTD, 1Y, 5Y, All)
or a custom start/end pair. Which dates a range can reach differs by screen — the Overview's range
may include hand-typed pre-app data; an account's never does.
_Avoid_: time range, period, date range, window, lookback.

**1D**:
The chart range that plots the most recent trading session's observations, open to close — or to
now while the session is running. Always the latest session (a weekend shows Friday's), never an
older one, and never a trailing twenty-four hours.
_Avoid_: today, intraday range, last 24 hours, daily chart.

**Range end value**:
The value a plotted line actually ends at — the last point inside the chosen chart range. It equals
current net worth only when the range ends today; a range ending in the past ends at a past value,
and stating today's figure for it is simply wrong. A fact about one line over one range, not about
the household now.
_Avoid_: current value, latest value, ending balance, final value.

### How prices stay fresh

**Refresh cadence**:
How often the app asks the price feed for fresh quotes while the market is open — the household's
dial, in whole minutes. Outside market hours no cadence spends anything, so the term speaks of
refreshes rather than of the timer that drives them.
_Avoid_: poll interval, polling frequency, update speed, refresh rate.

**Observation**:
A price the feed reported for one instrument, filed under the instant the provider says it was
struck. Kept forever and never edited, one row per distinct instant; distinct from the quote (the
current answer) and the daily close (a finished day).
_Avoid_: tick, snapshot, price point, intraday price.

**Poll**:
One attempt to refresh quotes for every feed-priced instrument, recorded whether or not any new
observation resulted — the cadence's own attempts and a person's press of Refresh now alike, since
both are the same attempt at the same instruments. What tells a quiet market apart from a server
that was not running: a gap during market hours is the deployment's silence, and a row outside them
is somebody asking.
_Avoid_: refresh run, fetch, sync.

### Who gets in

**Gate**:
The Google sign-in step enforced at the instance's front door, before any request reaches the app.
The app authenticates no one: a request that arrives at all is a family member's.
_Avoid_: login, log-in screen, SSO, auth wall, password gate.

**Allowlist**:
The list of family email addresses the gate admits. It is the whole of who may enter; there is no
registration and no account to create.
_Avoid_: user list, members, whitelist, accounts.

**Authenticated email**:
The verified address the gate attaches to each admitted request, naming which family member is
acting. Attribution, never permission: it may say who did a thing, and it never decides what anyone
may do — every family member sees and can do everything.
_Avoid_: user, account, login, principal, role.

### Whose money a screen is showing

**Person**:
A family member the household has recorded, as a name and nothing else. The thing you add, rename
and remove on the People screen; it is not a login, and admission to the instance is the gate's
business rather than a person's.
_Avoid_: user, member, profile, household member.

**Owner**:
The single person an account's money belongs to. Every account has exactly one, and every holding
inside it is that owner's — the same person seen through the account they hold, which is why a
screen says "owned by" rather than naming the record.
_Avoid_: holder, beneficiary, account user.

**Owner filter**:
The choice to read every screen as one or more owners rather than as everyone. A way of narrowing
what is shown and never of deciding what may be seen — every family member may set it, clear it, and
set it to anybody. It belongs to the reading in progress rather than to the household: it is in the
address of the page being read and nowhere else, so it lasts exactly as long as that address does.
Off means the whole household, which is where every reading starts — and which selecting everybody
is only another way of saying.
_Avoid_: user filter, person filter, lens, view-as, my view, standing choice.

### What a screen shows in public

**Masked**:
The display state in which every amount on a screen is replaced by a fixed run of dots. An amount is
any absolute figure — a value, a balance, a cost basis, a gain, a share quantity; a ratio is never
masked, and neither is a name, a symbol or a date. It is a state of the display and nothing more:
the gate is the only thing that keeps anyone out.
_Avoid_: private, privacy mode, hidden, secure, locked, redacted.

**Masking policy**:
The household's standing choice of what a browser that has not been toggled yet opens in — masked,
unmasked, or as that browser last left it. Distinct from being masked, which is a fact about one
browser at one moment rather than about the household.
_Avoid_: privacy setting, hide on start, default state.
