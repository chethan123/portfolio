# 06 — The "Refresh now" control and the as-of line

_Part of [0002-pricing.md](../0002-pricing.md)._

**What to build:** A control that pulls current prices on demand, and the timestamp that proves it
did. `refreshQuotes` already fetches and writes everything; its only caller was the poller, and the
poller will not run outside market hours. So a position added on a Saturday sat unpriced until
Monday, and there was nothing a person could press.

The as-of line ships in the same change rather than later, because it is the confirmation. A press
outside market hours usually rewrites the close it already held, so every figure on the page is
identical afterwards; without a timestamp there is nothing that separates "it worked and nothing
moved" from "it failed silently", which DESIGN.md §11 names the one genuinely dangerous failure mode
in a finance app.

Split out of 05, which bundled this with the stale banner, the per-row flags and a whole Settings →
Instruments route. 05 keeps the rest. Read [pricing-ui-brief.md](../../design/pricing-ui-brief.md)
§3 and §5 for the visual design, and **Where this departs from the record** below for the seven
places this ticket knowingly does not follow it.

**Blocked by:** Nothing. 03 and 04 have landed; this widens 03's report and adds no column and no
table.

**Status:** built

**What the refresh reports** (`app/lib/prices.server.ts`)

- [x] The report carries a count of observations actually written — instants new to the log — which
      is the only field that distinguishes a press that learned something from a press that
      re-fetched a price it already held. Counted from the insert's own `returning`, where it is
      known, rather than derived afterwards from a table with no index for the scan
- [x] It states whether the provider call itself failed, separately from every symbol coming back
      empty, because the feed being down and the symbols being wrong have identical aggregates and
      need different sentences
- [x] A provider failure still returns a report rather than throwing; nothing about the existing
      swallow changes except that the caller can now see it
- [x] The poller's log line gains the new count — it is one line per attempt and it changes

**The lock, lifted** (`withRefreshLock`, beside the refresh rather than in the poller)

- [x] Both the timer and the button take the same lock through one helper, rather than two copies of
      the take/release/destroy-on-failure contract
- [x] A caller that cannot take it gets `null` — a refusal, not an error: someone else is doing the
      work and the prices will be fresh either way
- [x] The connection is destroyed rather than returned when a query fails, because a session-scoped
      lock survives a failed query and a pooled client keeps its session

**The action** (`app/routes/refresh.ts`, a resource route, no component)

- [x] It **returns** its outcome and never throws. A throw from an action reaches the nearest error
      boundary and replaces the whole page — so the one failure this control promises to show while
      leaving the figures intact (story 18) is the one a throw cannot show
- [x] It never redirects on the scripted path. A fetcher whose action returns a redirect follows it
      as a real navigation, with a history entry and a scroll reset, and discards the outcome the
      action just computed
- [x] A document POST — `Sec-Fetch-Mode: navigate`, set by the browser and not by the page — is the
      no-JavaScript path, and only that path redirects, back to the screen the press came from. The
      as-of line is the confirmation there
- [x] The return path is validated by resolving it, not by matching its first characters

**The as-of line**

- [x] Every screen showing a price-dependent figure carries it: Overview, Holdings, Analysis, Income
      and Account detail. Income is priced by the same quotes — its yield and dividend figures come
      off the columns a refresh writes
- [x] It reads the oldest as-of across held feed-priced instruments, not the newest, so one
      instrument failing for a week cannot let the portfolio report itself current
- [x] It renders in the market timezone with the zone abbreviation, correct across the DST boundary,
      from the same configured zone that decides which calendar day a close is filed under
- [x] It is an absolute date and time a person would say out loud, never an ISO string
- [x] With nothing priced yet it says so, rather than rendering an empty or epoch timestamp
- [x] Formatting lives in `app/lib/market-hours.ts`, which is the only module in `app/` that uses
      `Intl` and already owns the rule for which day an instant belongs to. **Not** `format.ts`,
      whose header commits it to string-in, string-out and no `Intl` at all

**The control**

- [x] A circular-arrow icon beside a text label, quiet rather than filled, built on the existing icon
      wrapper — decorative and `aria-hidden`, standing beside the label rather than in place of it
- [x] It submits through a fetcher, so the figures and the timestamp update without a manual reload,
      and remains a real form, so a press works with JavaScript disabled
- [x] While a press is in flight the label says so and the control stops accepting input, keeping
      full text contrast rather than the browser's grey disabled treatment, which reads as forbidden
      rather than busy
- [x] In-flight is read from this component's own fetcher, where `state` is the documented idiom.
      (The form-data guard the masking toggle explains is for reading *someone else's* fetcher,
      which stays listed after it goes idle — a hazard this control does not have)
- [x] The spinner has a reduced-motion branch that stops the animation, leaving the label sufficient

**What the outcome says**

- [x] A press that wrote new observations reports how many instruments were updated, and how many
      were marked stale when any were
- [x] A press that wrote none says so and names the timestamp it is still showing
- [x] A press refused by the lock says a refresh is already running and that the figures will follow
- [x] A provider failure leaves every figure on screen as it was and says the provider did not
      respond, naming the timestamp still being shown
- [x] Confirmations and refusals are inline text, since the app has no toast system and no modals

**Vocabulary** (`CONTEXT.md`)

- [x] The entry for **poll** says an attempt includes a manual one, so the log's meaning stays true
      once presses appear in it outside market hours

**Tests**

- [x] A second press against the same provider instant writes no observation and reports none —
      the weekend press, which is what the count exists for
- [x] A provider that throws is distinguishable from one that returned nothing, though their
      aggregates are identical
- [x] The stamp names EDT in August and EST in December, and reads an evening instant as that
      evening rather than the next UTC day
- [x] The return-path guard refuses a backslash the URL parser resolves off-site, a
      protocol-relative URL, and an absolute one

**Where this departs from the record**

Seven deviations, each deliberate. A reader who finds the code disagreeing with the brief, with 05,
or with DESIGN.md should find the reason here.

1. **No "refused" count.** `03-refresh-quotes.md:64` asks the operation to report how many were
   updated, marked stale *and refused*, and the brief's success copy prints all three. It cannot be
   produced: a currency refusal is caught inside the provider adapter and the symbol simply omitted,
   and `ProviderQuote` has nowhere to carry it on purpose. Producing it means reopening 03's seam,
   which is a wider change than this ticket. Refusals are reported as staleness — as they already
   are everywhere else. 03's criterion has never been met and is not met here.
2. **Market time, not browser-local.** This is the big one, and it overrides three documents, not
   one: the brief recommends browser-local while leaving the decision open (§3); `0002-pricing.md`
   story 8 asks for the reader's own timezone in as many words; and `DESIGN.md` §10's decision table
   states "browser-local for display" as the app's rule. None of them noticed that these pages are
   server-rendered and every screen is required to work without JavaScript, so at render time there
   is no browser clock to ask — browser-local is either unavailable or a visible flash on the one
   caption whose whole job is being trustworthy. Market time also keeps the displayed instant in the
   same frame as the date its `price_daily` row is filed under, which ARCHITECTURE.md §6.2 calls the
   most important line in the subsystem. **Story 8 is superseded, not satisfied.** A reader in
   another timezone gets a stamp that says EDT rather than one that says their own hour; the
   abbreviation is what makes that honest instead of ambiguous.
3. **A closed-market outcome exists.** §5's state table has no state for a press that changed
   nothing, and its success copy assumes counts moved. Outside market hours they do not. A gap in a
   brief written before anyone considered a weekend press, not a decision to honour.
4. **The report gains fields.** A UI that reports a provider outage honestly, and distinguishes a
   press that learned something, cannot be written against the four counts the code shipped with.
5. **The refresh takes the poller's lock, and the lock moved.** `0002-pricing.md:324` scopes it to
   two overlapping containers and a slow tick meeting the next one; a refresh started from a request
   is unconsidered ground in every document. Two tabs is the case that actually happens. The key and
   the take/release contract move out of the poller because the poller is no longer the only caller.
6. **The oldest quote, not the newest.** 05 asked for the newest quote behind a figure;
   `priceFreshness` deliberately returns the oldest and argues the point in place. The code is right.
   The same function is instance-wide, so an account's caption describes the portfolio — pessimistic,
   which is the safe direction for this number. It also means a household holding only cash and a
   hand-priced trust reads "no prices yet" while being fully valued, because no fetched price stands
   behind any of it.
7. **The return-path guard was wrong and is now shared.** `masking.ts` tested that a path starts
   with a single slash. `/\evil.test` passes that and the URL standard resolves it to
   `https://evil.test/`, because a backslash is a slash for special schemes — an open redirect. The
   corrected guard resolves the value and demands the origin back, and both routes now use it.

No ADR. Each of these is reversible in an afternoon — a format function, a report field, one query.
Deviation 2 is the one closest to earning one, since it overrides a line in DESIGN.md's decision
table; it stays here because the rule it overrides is about *display convenience* and the reason it
loses is a rendering constraint, not a change of principle.
