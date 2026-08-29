# 06 — The "Refresh now" control and the as-of line

_Part of [0002-pricing.md](../0002-pricing.md)._

**What to build:** A control that pulls current prices on demand, and the timestamp that proves it
did. `refreshQuotes` already fetches and writes everything; its only caller is the poller, and the
poller will not run outside market hours. So a position added on a Saturday sits unpriced until
Monday morning, and there is nothing a person can press. This ticket adds the press — a resource
route action, and one component carried by every screen that shows a figure.

The as-of line ships in the same change rather than later, because it is the confirmation. A press
usually rewrites the same close it already held, so every figure on the page is identical
afterwards; without a timestamp there is nothing that separates "it worked and nothing moved" from
"it failed silently", which DESIGN.md §11 names the one genuinely dangerous failure mode in a
finance app.

Split out of 05, which bundles this with the stale banner, the per-row flags and a whole Settings →
Instruments route — more than one thing that can be built, tested and reviewed on its own. 05 keeps
the rest. Read [pricing-ui-brief.md](../../design/pricing-ui-brief.md) §3 and §5 for the visual
design, and **Where this departs from the brief** below for the six places this ticket knowingly
does not follow it.

**Blocked by:** Nothing. 03 and 04 have landed; this ticket widens 03's report and adds no column
and no table.

**Status:** ready-for-agent

**What the refresh reports** (`app/lib/prices.server.ts`)

- [ ] `RefreshReport` carries the id of the `price_poll` row the run wrote, so a caller can name the
      attempt it just performed
- [ ] It carries a count of observations actually written — distinct provider instants new to the
      log — which is the only field that distinguishes a press that learned something from a press
      that re-fetched a price it already held
- [ ] It states whether the provider call itself failed, separately from every symbol coming back
      empty, because forty holdings quoted in GBP and a provider outage are the same aggregate and
      different problems
- [ ] A provider failure still returns a report rather than throwing, as it does today; nothing
      about the existing swallow changes except that the caller can now see it
- [ ] The poller logs the widened report unchanged in shape, so its one line per attempt gains the
      new fields and loses nothing

**The action** (a resource route, no component, following `app/routes/masking.ts`)

- [ ] It takes the poller's advisory lock before fetching, and on failing to take it performs no
      fetch and reports that a refresh is already running — which is an outcome, not an error
- [ ] The lock is released on every path, and its connection is destroyed rather than returned when
      a query fails, because a session-scoped lock survives a failed query and would wedge every
      later tick
- [ ] It redirects on success, on refusal and on provider failure alike, carrying the poll id; the
      figures a person reads are therefore always a fresh loader read rather than a submission's
      echo
- [ ] The redirect returns to the screen the press came from with its query string intact, so a
      filtered and sorted Holdings view survives a refresh
- [ ] The return path is guarded against an off-site redirect the way the masking action already
      guards it
- [ ] A database failure is the only thing that throws, and it surfaces as the failure message below

**The outcome, re-derived** (a reader beside `priceFreshness`)

- [ ] Given a poll id, it returns what that attempt did: how many instruments were requested, priced
      and marked stale, and how many observations it wrote
- [ ] The observation count is derived from the log by the attempt's own start time, which is exact
      because the advisory lock means nothing else was writing observations in that window
- [ ] A poll id naming no row yields no outcome, and the page renders as though no refresh had
      happened — a hand-typed id fabricates nothing
- [ ] _Deliberate duplication:_ this count and `RefreshReport`'s are the same number computed twice.
      They cannot be one value: the request that displays an outcome is not the request that
      performed it, and Pattern B exists precisely so the confirmation describes the database rather
      than the submission.

**The as-of line**

- [ ] Every screen showing a price-dependent figure carries it: Overview, Holdings, Analysis and
      Account detail
- [ ] It reads the oldest as-of across held feed-priced instruments, not the newest, so one
      instrument failing for a week cannot let the portfolio report itself current
- [ ] It renders in the market timezone with the zone abbreviation, correct across the DST boundary,
      from the same configured zone that decides which calendar day a close is filed under
- [ ] It is an absolute date and time a person would say out loud, never an ISO string, with a
      relative gloss permitted in parentheses once the figure is over an hour old
- [ ] With nothing priced yet it says so, rather than rendering an empty or epoch timestamp
- [ ] Formatting lives in `app/lib/format.ts`, which renders and never computes

**The control**

- [ ] A circular-arrow icon beside a text label, quiet rather than filled, in the page header's
      right-hand slot next to the as-of line it acts on
- [ ] The icon joins the existing set and is built on its shared wrapper, decorative and
      `aria-hidden`, standing beside the label rather than in place of it
- [ ] It submits through a fetcher so the page updates without a manual reload, and remains a real
      form, so a press works with JavaScript disabled
- [ ] While a press is in flight the label says so and the control stops accepting input, without
      the browser's grey disabled treatment, which reads as forbidden rather than busy
- [ ] The in-flight state is read from the submission's form data rather than a fetcher's state, for
      the reason the masking toggle already records: a mounted fetcher stays listed after it goes
      idle
- [ ] The spinner has a reduced-motion branch that stops the animation, leaving the label sufficient
      on its own
- [ ] Below the mobile breakpoint the header stacks and the control sits under the title block

**What the outcome says**

- [ ] A press that wrote new observations reports how many instruments were updated and how many
      were marked stale
- [ ] A press that wrote none says so and names the timestamp it is still showing, because a
      weekend press that re-fetches Friday's close must not claim to have updated anything
- [ ] A press refused by the lock says a refresh is already running and that the figures will follow
- [ ] A provider failure leaves every figure on screen exactly as it was, and says the provider did
      not respond, naming the timestamp still being shown
- [ ] Every symbol coming back empty without a provider failure is reported as staleness, not as a
      failed refresh
- [ ] Confirmations and refusals are inline text in the page, since the app has no toast system and
      no modal dialogs

**Vocabulary** (`CONTEXT.md`)

- [ ] The entry for **poll** says that an attempt includes a manual one, so the log's meaning stays
      true once presses appear in it outside market hours

**Tests**

- [ ] A press outside market hours refreshes, which is the case the poller cannot serve
- [ ] A press that re-fetches an instant already in the log writes no observation and reports none
- [ ] A press while the lock is held fetches nothing and reports the refusal
- [ ] A provider failure marks stale, writes no price, and is distinguishable from every symbol
      being omitted
- [ ] An instrument that has never been priced is valued after one press, which is the position
      added on a Saturday
- [ ] The as-of line renders the same instant identically on both sides of a DST change
- [ ] A poll id naming no row renders no outcome
- [ ] The rendered control carries its label beside the icon in every state

**Where this departs from the brief**

Six deviations, each deliberate. A reader who finds the code disagreeing with §3 or §5 should find
the reason here.

1. **No "refused" count.** The brief's success line and 05 both call for one. It cannot be produced:
   a currency refusal is caught inside the provider adapter and the symbol simply omitted, and
   `ProviderQuote` has nowhere to carry it on purpose. Producing it means reopening 03's seam, which
   is a wider change than this ticket. Refusals are reported as staleness, indistinguishable from a
   delisting — as they already are everywhere else.
2. **Market time, not browser-local.** The brief recommends browser-local and leaves the decision
   open; 05 agrees with it. Neither noticed that these pages are server-rendered and every screen
   is required to work without JavaScript, so a browser-local timestamp is either unavailable or a
   visible flash on the one caption whose job is being trustworthy. Market time also keeps the
   displayed instant in the same frame as the date its `price_daily` row is filed under, which
   ARCHITECTURE.md §6.2 calls the most important line in the subsystem.
3. **A closed-market outcome exists.** §5's state table has no state for a press that changed
   nothing, and its success copy assumes counts moved. Outside market hours they usually do not.
   This is a gap in a brief written before anyone considered a weekend press, not a decision to
   honour.
4. **The report gains fields.** 03 fixed the summary at four counts. A UI that reports a provider
   outage honestly, and distinguishes a press that learned something, cannot be written against
   them.
5. **The refresh takes the poller's lock.** 0002-pricing.md scopes that lock to two overlapping
   containers and a slow tick meeting the next one; a refresh started from a request is unconsidered
   ground in every document. Without it two tabs fire two calls at an unofficial API, and one run
   can mark an instrument stale that the other priced a moment earlier — the wrong signal from a
   feature whose whole job is saying whether a figure can be trusted.
6. **The oldest quote, not the newest.** 05 says the timestamp comes from the newest quote behind
   what it displays; `priceFreshness` deliberately returns the oldest and argues the point. The code
   is right and 05's line is superseded. The same function is instance-wide, so an account's caption
   describes the portfolio — pessimistic, which is the safe direction for this number.

No ADR. Each of these is reversible in an afternoon — a format function, a report field, one query —
so none clears the three tests in `docs/README.md`.
