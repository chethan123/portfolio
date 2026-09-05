# Portfolio Tracker

A self-hosted family portfolio and net worth tracker.

- **[DESIGN.md](DESIGN.md)** — the design and the reasoning behind it: domain model, ingest,
  pricing, screens, stack, and the accepted limitations.
- **[ARCHITECTURE.md](ARCHITECTURE.md)** — how the running system is put together: processes and
  deployment topology, the layers and the invariants that hold them apart, the database schema and
  its derived views, and the dataflow behind ingest, pricing and every dashboard read.

## Built by agents

**Almost all of this — the code, the SQL, the tests and the documents you are reading — was written
by an AI agent rather than typed by me.** I set the direction, wrote the specs, reviewed the diffs
and sent a good number of them back. Two thirds of the commits on `main` name Claude as their
author, and most of the rest are merges of that work.

That is the experiment rather than a shortcut on the way to one. I wanted to find out what it takes
to build *and then keep maintaining* a real application this way — not a weekend demo, but something
with a schema that migrates, statements that must not be double-counted, and money that must not be
rounded, still standing up to changes months later.

I am saying so at the top because some people would rather know before they read a line, and a
project that is coy about it wastes their time. What it means in practice:

- **A specification first, then the code.** Each slice starts as a document in
  [`docs/specs/`](docs/specs), with a UI brief in [`docs/design/`](docs/design) where a screen is
  involved, and is built against it. Both are in the repository, so what was asked for can be read
  beside what was delivered.
- **Nothing lands unreviewed.** Every plan gets an adversarial second pass against the codebase
  before any of it is written, and every diff is read by me before it merges. The working rules the
  agents are held to are in [AGENTS.md](AGENTS.md); the design they are held to is
  [DESIGN.md](DESIGN.md).
- **Judge it by the code.** The claims the rest of this page makes are the ones worth checking —
  a partial total labelled as partial, every removed position listed in full, `numeric` never
  round-tripped through a JavaScript number. If the provenance shows anywhere, it shows there.

## What it looks like

Every screen below is the real application, running against the generated demo household in
[`scripts/seed-demo.ts`](scripts/seed-demo.ts) — two people, six accounts at six institutions,
three years of statements, one holding nobody can price and one loan. **The figures are invented,
the behaviour is not.** The demo deliberately includes the awkward cases, because a screenshot of a
portfolio where everything is priced and everything has a cost basis is a screenshot of the easy
case.

Screenshots follow your GitHub theme; the app follows your system's.

### Overview — what the household is worth

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/overview-dark.png">
  <img alt="The overview: total net worth, the trend line with a readout above it naming the date and value of the point it ends at, the account list and allocation by account" src="docs/screenshots/overview-light.png">
</picture>

The one figure the household actually asks for, and the line behind it. The range control is a URL,
so a chosen range survives a reload and can be bookmarked.

- **Every total says what it was computed from.** "The figure and the line are 17 of 18 holdings.
  The rest have never been priced." A holding nobody can quote is never silently dropped and never
  counted as zero — it is excluded and the exclusion is written down.
- **Every point on the line can say what it is worth.** A readout under the headline names what the
  line ends at, dated and in full — so a range ending last month reads that month's value rather
  than today's — and pointing anywhere moves the readout to the nearest point, with a guide line to
  say which. The axis rounds its figures to a compact form and leaves the eye to interpolate
  between rules; the readout does neither. A point typed in by hand for the years before the app
  says so in words, because a dashed stroke is a claim about where a figure came from that
  identical text would quietly undo.
- **1D draws the trading session, not a day of it.** The one range measured in moments: it plots
  the most recent session — open to now while it is running, Friday's on a weekend — with one point
  per observed instant and no sampling. A refresh quotes every instrument at once and each comes
  back stamped with its own instant, so one refresh can add many points: the line is exactly as
  detailed as the prices the household was told about, and the cadence it chose is what decides how
  often it is told. The axis and the readout name the time of day on the market's clock, and the
  change beside the headline is measured from yesterday's close.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/overview-1d-dark.png">
  <img alt="The overview at the 1D range: the same net worth headline over a line of the current session, its axis labelled 09:30, 12:45 and 16:00, and a readout naming the last observed moment and its value" src="docs/screenshots/overview-1d-light.png">
</picture>

- **Liabilities are accounts.** The auto loan sits in the list at −$14,500 and subtracts from net
  worth, because a loan is a negative `USD` position rather than a special case in the arithmetic.
- **A zero and an absence never look alike.** An account holding nothing, an account nothing can
  price, and an empty instance each get their own words instead of a `$0.00`.

### Holdings — every position, sliced any way you ask

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/holdings-dark.png">
  <img alt="Holdings: a filter bar, a group-by strip and the full table of every position with its quantity, price, value, cost basis, unrealized gain and projected annual dividend" src="docs/screenshots/holdings-light.png">
</picture>

Every position the household holds, whichever account it sits in. Filter by account, brokerage,
account type, tax treatment, classification or asset class; group by any of those or by owner, with
subtotals. "Everything at Fidelity", "the whole taxable side", "all the bonds, wherever they are" —
each is this table with the arguments changed rather than a screen of its own. Narrowing to an
*owner* is not one of those six: that is the owner filter below, and it narrows all four screens at
once.

- **The controls are the URL.** Filters, grouping and sort all live in the query string, so a view
  survives a reload, can be bookmarked, and can be sent to the other person in the household. The
  whole screen works with JavaScript turned off.
- **A filter you cannot use is not drawn.** A dimension only becomes a dropdown once the data holds
  two different values for it, and every option in it is a value something really has — so a
  household that banks in one place gets no Brokerage dropdown, and no single filter can land you on
  an empty table. Two of them still can, and the screen says which two rather than leaving you to
  work it out.
- **Three coverages, not one.** A workplace plan reports a price and no cost basis at all, so the
  value total can be complete while the unrealized total is short. Each figure carries its own
  count rather than borrowing a neighbour's, because a cost basis over 11 holdings printed against
  a value over 17 would otherwise read as a $428,000 gain nothing in the database supports.
- **An empty filter is not an empty portfolio.** A combination nothing matches says so in those
  words and offers to clear itself. It never borrows the first-run screen's "there is no data yet",
  which would be false.

### Correcting a position — the write that lives on the table

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/holdings-edit-dark.png">
  <img alt="One row of the Holdings table opened for correction: the quantity and cost basis have become boxes in their own columns, and the line beneath says what saving will record" src="docs/screenshots/holdings-edit-light.png">
</picture>

A statement arrives quarterly and a position changes weekly. Rather than run the four-screen upload
for "the 401k contribution added eleven units", any row on Holdings opens in place: the quantity and
the cost basis become boxes in their own columns, and Save records it.

- **It appends, it never overwrites.** Saving records a new statement carrying every other position
  in the account forward unchanged, and the statement it corrects is kept on its own date. Nothing
  already recorded moves — your net worth in March does not change because you fixed a figure in
  August. Undo is a second correction. The line under the open row names the date the new statement
  will carry, which is today unless the statement being corrected is dated later still.
- **The line under the row says all of that before you click it**, not after. What "edit" does here
  is not what edit usually does, and finding out afterwards is too late.
- **It changes figures, not membership.** A correction can say "not 100 units but 120", and can say
  "zero", and cannot say "and also some Apple" — adding an instrument means resolving a name against
  the alias table, which is what an upload is for. Nor can it turn something held into something
  owed: the sign lives in the quantity, so flipping it would move net worth by twice the figure while
  looking like an ordinary edit.
- **It is still a URL.** The editor is `?edit=<account>.<instrument>`, so it opens exactly one row,
  survives a reload, and closes the moment you touch a filter. Like the rest of the screen it works
  with JavaScript turned off — with it off, Save is a plain form post and the confirmation comes back
  on the next page.

### The owner filter — every money screen read as one owner

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/overview-owner-dark.png">
  <img alt="The Overview narrowed to one owner: the owner control open in the page header, showing a tick box per owner with Apply and Show everyone beneath them, a smaller headline figure with the sentence &quot;Showing Alex Rivera only.&quot; below it, and a note on the chart saying the hand-typed history before the instance existed is the household's and is not drawn here" src="docs/screenshots/overview-owner-light.png">
</picture>

"What does this look like for just Alex?" is a question about four screens, not one, so the answer
is one selection that follows you across them: a control in the page header names the household's
owners, and Overview, Holdings, Analysis and Income all read as whichever are chosen. The guide has
the [how](docs/guide/owner-filter.md); what follows is why it is shaped this way.

- **The control is a disclosure, and that is a layout decision.** A row of tick boxes grows with the
  household and wraps at a different width on each of the four screens, so the one control meant to
  look identical everywhere was the one whose layout tracked how many people happened to be
  recorded. Closed, it is a fixed shape that says who is being shown — a name or two, a count past
  that. `<details>` is the browser's own disclosure, so this costs no JavaScript — the custom range
  picker beside it reaches the same no-JavaScript result through a native popover.

- **It is noise reduction, never privacy.** Anyone may set it, clear it, and set it to anybody; the
  gate at the front door keeps a *person* out and the lock keeps a *browser* out, and every family
  member sees everything. It is never derived from who signed in — the app deliberately holds no
  mapping from a sign-in to an owner, and inventing one so that a screen could open on "you" is the
  short step to "and this is *your* data" that a household of shared money does not want taken.
- **The URL is the whole of it.** `?owner=1&owner=3` and nothing else: no cookie, no stored setting.
  Closing the tab forgets it because there is nothing left to remember it, and pasting the address
  to the other person in the household shows them the same reading — which a cookie could never do.
- **A narrowed screen says so in words**, beside the figure it narrowed, because a filter that
  survives navigation is a filter that can be forgotten. Holdings adds the household's own count to
  its panel header — "filtered from N" — for the same reason.
- **The hand-typed history is not drawn while narrowed.** The pre-app series is the household's and
  has no owner, so a filtered chart cannot reach behind those owners' first recorded holdings — the
  Overview says that rather than showing a suspiciously short line.
- **An account's own page ignores it**, being narrower already, and Settings and the upload flow
  neither read it nor carry it: an excursion into either ends the reading.

### Analysis — where the money actually sits

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/analysis-dark.png">
  <img alt="Analysis: four donut-and-table panels breaking net worth down by owner, by account type, by asset class and by classification, and a fifth table of unrealized gains by asset type with the tax a taxable one would attract" src="docs/screenshots/analysis-light.png">
</picture>

Four breakdowns of the same total — by owner, by account type, by asset class, and by
classification — each a donut beside the table it is drawn from, and beneath them what has been
gained and not yet sold.

- **Debt is drawn as debt.** The ring paints what is owned, so the loan's row is left unfilled and
  the panel says why rather than pretending a negative is a slice.
- **Percentages state their denominator.** A negative row's share is of gross assets, not of the
  total in the centre, and the panel says so instead of leaving you to work out which.
- **The gains panel names a tax and calls it a ceiling.** Only a taxable account can owe capital
  gains tax, so a gain inside an IRA is in the unrealized column and not in the one beside it. The
  rate is the household's own, set at Settings → Tax and starting at 23.8% — 20% long-term plus the
  3.8% net investment income tax. A loss in one asset type is not netted against a gain in another
  the way a real return would net it, so the figure is an upper bound rather than a bill, and the
  panel says which.

### Income — what the portfolio pays over the coming year

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/income-dark.png">
  <img alt="Income: the total annual dividend with the weighted yield beside it, then the same figure as two donut-and-table breakdowns — by tax treatment, with the sheltered subtotal written out beneath the table, and by account" src="docs/screenshots/income-light.png">
</picture>

The annual dividend the portfolio is projected to pay, from the quantity held and the per-share rate
the pricing loop already stores for every instrument it can quote. One headline figure with the
weighted yield beside it, then the same figure cut two ways: by tax treatment, which answers how
much of it is taxed this year, and by account, which answers which statement it lands in.

- **One read, so no two figures on the page can disagree.** The headline, both breakdowns and the
  sentence under the first all come off the array `currentHoldings()` returns — the same array the
  Holdings table reads — rather than a query apiece. That seam is
  [Reading what is held](#reading-what-is-held) below, and a screen that is nothing but totals of
  the same rows is what it exists for: the way not to add a dashboard query that drifts apart from
  its neighbours is not to add one.
- **The total is a lower bound, and says so where it is read.** A holding with no dividend rate on
  file counts as paying nothing, because nothing stored distinguishes an ETF that genuinely pays
  nothing from a trust no provider was ever asked about. The consequence is that the figure leaves
  out every unquoted holding, all interest on cash and any interest on a loan — the same treatment
  the unrealized panel gives its own figure by calling it a ceiling.
- **Three tax treatments, never a taxable/sheltered boolean.** A dividend in a taxable account is
  taxed this year, one in a Traditional account is untaxed now and taxed as ordinary income on the
  way out, and one in a Roth is never taxed. Sheltered merges a dated liability with the absence of
  one, so it is a subtotal written out in words beneath the table and never a slice of the ring.
- **That subtotal is two amounts and never a fraction.** A taxable group can net negative, because
  a liability account has a tax treatment like any other and its interest can outweigh what the
  holdings beside it pay. Written as a fraction, the sentence would then divide by a total smaller
  than its own parts, so the sheltered figure and the taxable figure are stated separately and
  neither is divided by the other.
- **A ratio names its denominator.** The weighted yield divides by gross positive value rather than
  by net worth, so a household in net debt is not told a portfolio that pays money has a negative
  yield. A group that pays something and has nothing priced gets no percentage at all rather than a
  0.0% that would read as an answer.

### Account detail — one account, end to end

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/account-detail-dark.png">
  <img alt="A brokerage account: its own header, its own valuation chart with the same readout above the line, and a holdings table" src="docs/screenshots/account-detail-light.png">
</picture>

Each account carries its own header, its own valuation line, and what it holds. That line carries
the same readout and never a hand-typed mark: the pre-app series is the *household's* net worth,
and attributing it to one account would invent that account's history.

- **Price quality is on the row it applies to.** The real-estate ETF above reads "price is stale",
  meaning its last known price is being used rather than discarded. A holding that has never been
  quoted at all reads "never priced" and shows a dash for its price and value — never a zero, which
  would understate the account by the whole position and look deliberate.
- **The figure here is the figure elsewhere.** This total and the overview's row for the same
  account are one `SUM` over one shared view, not two queries that agree by luck.

### Set balance — the one thing you type

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/account-balance-dark.png">
  <img alt="A loan account showing the set balance form, with the amount entered unsigned and stored negative" src="docs/screenshots/account-balance-light.png">
</picture>

Bank accounts and loans have no statement worth mapping — they are one number. Those two kinds get a
form; nothing else does.

- **You type what you owe, not what it stores.** The minus sign for a liability comes from the kind
  of account, never from your typing, so `14,500` on a loan can only ever move net worth *down*.
  `$14,500.00`, `14,500` and `14500.00` are all accepted.
- **Recording never overwrites.** Each balance is kept on its own date and the most recent one
  speaks, so a correction is an entry rather than an edit and undo costs nothing.
- **A brokerage is refused, on purpose.** A recorded set is a photograph of everything an account
  holds, so one cash figure against a brokerage would record every security in it as sold. Those
  accounts are not offered the form at all.

### Upload — a statement, mapped once and diffed before it lands

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/upload-dark.png">
  <img alt="The upload flow's drop screen: the four-step strip under the page title, a select over the household's open accounts and the statement file input" src="docs/screenshots/upload-light.png">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/upload-mapping-dark.png">
  <img alt="The columns screen: the file's own header row and first three data rows shown verbatim, dollar signs and all, above a select per column saying which is which" src="docs/screenshots/upload-mapping-light.png">
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/upload-review-dark.png">
  <img alt="The review screen: what the statement changes, grouped into added, updated and removed, with a removed position listed in full with its quantity and last known value" src="docs/screenshots/upload-review-light.png">
</picture>

How securities accounts get populated at all: pick the account, drop the CSV, say which column is
which, resolve anything the file names that has never been seen before — then read exactly what the
statement changes before it is recorded. Four screens, each a real URL over a server-side draft, so
the back button, a reload and a half-finished upload left overnight all behave, with JavaScript off
included.

- **Mapped once per institution.** The first export from a brokerage is mapped by hand against the
  file's own sample rows, shown verbatim so you map by values rather than guessing from names. The
  mapping is remembered by header fingerprint, and every later export arrives with the screen
  already filled in — still shown, never silently reapplied, so a changed export is visible.
- **A missing row means sold — and the diff says removals in full.** A statement is a photograph of
  the whole account, so a filtered export listing 2 of 30 positions is a *valid* statement that
  sells 28 holdings. Every removed position is therefore listed individually with its quantity and
  last known value, never as a count, and a file removing more than half of what the account holds
  cannot be committed without ticking a sentence that states the ratio in those words.
- **Nothing is recorded until the last screen.** The first three steps write only to the draft; the
  commit is one transaction — the immutable position set with the original bytes retained, its
  holdings, the draft deleted. A misread column caught on the review costs nothing, because nothing
  was written, and the landing page's confirmation is read back from the database rather than from
  the URL.

### Settings — people and accounts

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/settings-dark.png">
  <img alt="Settings: the account list with kind, owner and tax treatment, above the add-account form" src="docs/screenshots/settings-light.png">
</picture>

Who is in the household and what they own. Accounts carry a kind, an owner and a **three-way tax
treatment** — taxable, tax-deferred, tax-free — because $500k in a Traditional IRA is roughly $350k
of spending power while $500k in a Roth is $500k, and a boolean throws away exactly that.

Nothing here deletes anything. An account is *closed*, which stops it counting toward today's net
worth while it keeps counting on every date before it closed; a person who still owns accounts
cannot be removed, and the refusal names them.

### Masking — reading the portfolio in public

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/overview-masked-dark.png">
  <img alt="The overview with every amount replaced by a run of dots: the net worth headline, the chart's axis figures, the amount in the chart's readout and every account balance are hidden, while the trend line, the readout's date, the allocation bars, the account names and the dates are unchanged" src="docs/screenshots/overview-masked-light.png">
</picture>

One click in the sidebar replaces every amount on every screen with a run of dots, and another
brings them back. It is for opening the app on a train, in a café, or in front of anyone who does
not need to know what the household is worth.

What goes is every **amount** — values, balances, cost bases, gains, share quantities. What stays is
everything that says what the portfolio *is*: names, symbols, dates, the trend line's shape, the
allocation ring's proportions and every percentage. The chart's readout splits the same way — the
amount becomes dots, the date stays — and pointing at the line still moves the readout, because
masking changes what a screen shows rather than what it does. A masked screen still answers "how am I split"
and "what do I hold"; it just stops answering "how much".

The click is instant and needs no network, because the moment it is needed is the moment there may
not be one. Settings → Display chooses what a browser opens in — masked every time, showing every
time, or however that browser was last left — and a browser nobody has answered for opens masked.

**It is not a lock.** The amounts are still in the page; masking defends against being read over
someone's shoulder, and the sign-in gate in front of the instance keeps a *person* out while the
lock keeps a *browser* out.

### On a phone

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/overview-mobile-dark.png">
  <img alt="The overview on a phone, with the navigation as a bottom bar" width="390" src="docs/screenshots/overview-mobile-light.png">
</picture>

The same pages, with the left rail becoming a bottom bar and the tables reflowing. Nothing is
withheld on a small screen: setting a balance and the whole of Settings are reachable from a phone.
The chart's readout is rendered before the page is sent rather than composed on hover, so a phone
with no pointer still arrives with the readout filled in — and, like the screens above, it works
with JavaScript turned off.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/holdings-mobile-dark.png">
  <img alt="Holdings on a phone: the table reflowed into cards, grouped by asset class with the group heading and subtotal strip in frame" width="390" src="docs/screenshots/holdings-mobile-light.png">
</picture>

Holdings is the one screen that changes shape rather than merely narrowing: the table reflows into
cards, one per position, with the group headings, the subtotal strips and the grand total carried
across. Every other screen keeps its layout and stacks.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/analysis-mobile-dark.png">
  <img alt="Analysis on a phone: the stacked header with the owner chip, the as-of line and Refresh now, above the net-worth-by-owner ring" width="390" src="docs/screenshots/analysis-mobile-light.png">
</picture>

Analysis at the same width: the header stacks — the owner chip, the price age and its refresh
control all stay — and each ring sits above the table it is drawn from.

### Not built yet

Nothing in the navigation is a placeholder any more. What is still missing sits behind a screen
rather than in place of one.

The pricing slice still owes two of its screens: the page-level stale summary, and the
Settings → Instruments tab where a collective investment trust gets its price typed in by hand. The
"as of" line and its "Refresh now" control already sit on every figure screen, and a stale or
never-priced holding is already labelled on its own row. Settings names Classifications,
Instruments and History on its index page as what later slices build — they are not drawn as
tabs — and there is no export or download of any kind.

The pricing UI is specified in [`docs/specs/0002-pricing.md`](docs/specs/0002-pricing.md) and drawn
in [`docs/design/pricing-ui-brief.md`](docs/design/pricing-ui-brief.md). Every screen above was
built the same way, from an approved spec: Holdings from
[`docs/specs/0003-holdings.md`](docs/specs/0003-holdings.md) with
[`docs/design/holdings-ui-brief.md`](docs/design/holdings-ui-brief.md), Upload from
[`docs/specs/0004-ingest.md`](docs/specs/0004-ingest.md) with
[`docs/design/ingest-ui-brief.md`](docs/design/ingest-ui-brief.md), and Income from
[`docs/specs/0006-dividends.md`](docs/specs/0006-dividends.md), which had no separate brief because
it draws the panels Analysis already had.

## Running an instance

```sh
cp .env.example .env                                # fill in the gate settings
cp allowed-emails.example.txt allowed-emails.txt    # one family address per line
mkdir -p ./volumes/db/data                          # the database lives here
docker compose up -d
```

**Setup is fail-closed: nothing starts until it is done.** Create a Google OAuth client, put its
credentials in `.env`, and list the family's addresses in `allowed-emails.txt`. Leave any of that
out — or the empty database directory the third line makes — and `docker compose up` stops before a
container runs, naming what is missing, rather than bringing up an instance anyone who can reach it can read. The
walkthrough, console to first sign-in, is [`docs/google-sign-in.md`](docs/google-sign-in.md); the
variables it fills in are the gate section of [`.env.example`](.env.example).

Everything else still has a working default. The app image is pulled from GitHub Container
Registry — published for `linux/amd64` and `linux/arm64`, so a Raspberry Pi or an ARM NAS needs
nothing special, and there is no build step to find memory for. Postgres comes up, the app waits for
it to report healthy and applies the schema, and a bundled Caddy container fronts it on port 80.
There is no migration to run by hand — migrations are idempotent, so restarting the container is
always safe.

One caveat today: no `v*` release tag has been cut yet, so CI has never published that image. Until
the first release exists, run from a checkout instead —
`docker compose -f compose.yaml -f compose.dev.yaml up -d --build`.

You do not need a checkout to run this: `compose.yaml`, `Caddyfile`, `scripts/dump-loop.sh`,
`.env`, `allowed-emails.txt` and the `volumes/db/data` and `volumes/dumps` directories beside them
are the whole deployment — the database is a
directory in it, not a volume kept somewhere under `/var/lib/docker`. The same command is also the upgrade — the pinned tag is the floating
major, so `docker compose up -d` fetches the newest `v1.x.y` release. Take a backup first
([Upgrading](docs/operating.md#upgrading)).

What that command stands up, in one picture — the contributor's version, with the trust boundaries,
is [`ARCHITECTURE.md` §2](ARCHITECTURE.md#2-system-context), which this is drawn from:

```mermaid
graph LR
    browser["The family's browsers<br/>and installed phone app"]
    house["House-wide proxy<br/>TLS, the public hostname<br/>(the operator's own)"]

    subgraph stack["This stack — docker compose up"]
        caddy["caddy<br/>the only published port"]
        gate["gate<br/>Google sign-in + allowlist"]
        app["app<br/>the tracker"]
        db[("db<br/>PostgreSQL — ./volumes/db/data")]
    end

    google["Google sign-in"]
    yahoo["Yahoo Finance quotes and history"]

    browser --> house --> caddy
    caddy -->|"every request:<br/>vouched for?"| gate
    caddy --> app
    gate -.-> google
    app --> db
    app -.->|quotes in market hours,<br/>history while a gap is open,<br/>or Refresh now| yahoo
```

### Who gets in, and where that is decided

Sign-in sits *in front of* the app rather than inside it. A sidecar container speaks to Google on
the instance's behalf, and the bundled Caddy asks it about every request before one is allowed
through; anything unvouched-for is handed to Google's own account chooser and comes back only if
the address that signed in is on the operator's list. The sidecar's own interstitial page is
skipped, so the only sign-in screen anyone in the household ever sees is Google's.

The app therefore has no password, no login page and no session cookie of its own, and it makes no
authorization decision at all: the list is the whole of it, and everyone admitted sees and can do
everything. The verified address arrives on every request as a header the app deliberately ignores —
attribution for a later feature, never permission.

Enforcement lives in this stack rather than in whatever proxy terminates TLS in front of it, because
a device on the same LAN can dial this box's published port and land on the bundled Caddy directly.
That is the threat this exists for, so the gate travels with the app.

The one thing the app knows about any of this is whether something in front of it authenticates.
When nothing does — a checkout under `npm run dev`, or a deployment assembled by hand — it draws an
undismissable warning on every page saying so, which is why that strip sits across the top of most
of the screenshots above. The setting protects nothing on its own; it exists only so the warning is
never a lie, because a warning a household learns to scroll past is worse than none at all. (Said
here for someone deciding whether to install this; `server/config.ts` says it again, for whoever
is about to change what the value does.)

### Settings, health and the front door

Every setting an operator has is an environment variable and every one of them is documented in
[`.env.example`](.env.example) with its default — with one exception named there: who may enter is a
file of addresses rather than a variable, because it is a list that grows. Configuration is
validated once at startup: a missing or malformed value stops the container immediately with a
message naming the variable. The one setting that is not an operator's is the capital gains rate the
Analysis screen estimates with: it is a database row, edited at Settings → Tax rather than in the
environment.

`GET /healthz` returns 200 while the instance is genuinely serving and a non-200 when it is not —
which includes the case where the database is reachable but a migration shipped in the image has
never been applied. It is the one path the gate lets through unchallenged, so monitoring needs no
Google account and no credentials.

Neither the app nor the sidecar is reachable directly — only the bundled `caddy` service publishes a
port, which is what makes it the single place the gate can be enforced. It speaks plain HTTP: TLS
and the public hostname belong to the reverse proxy the operator runs in front of the stack, and the
`X-Forwarded-*` headers arriving through it are trusted. [`docs/operating.md`](docs/operating.md)
has the proxy topology, the `pg_dump` backup and restore procedure, the full environment table, the
security posture an operator has to decide about, and installing the instance as an app on a
phone; [`docs/google-sign-in.md`](docs/google-sign-in.md) is the one-time Google setup those depend
on. When something is actually broken, [`docs/runbook.md`](docs/runbook.md) is indexed by symptom
instead of by topic.

Once it is running, [`docs/guide/`](docs/guide/) is the household's guide to using it — the same
screens as above, but as instructions rather than as reasons.

## Working on it

[ARCHITECTURE.md](ARCHITECTURE.md) is the orientation document: §4 is the layering and the
single-site invariants a change has to keep, §5 is the schema and the numeric boundary, and §6 walks
the ingest and pricing dataflows end to end.

Requires Node 24. [`docs/developing.md`](docs/developing.md) is the full path — setting up, the
change loop, the recipes and the traps. The short version:

```sh
npm install
docker compose -f compose.test.yaml up -d --wait     # a Postgres to develop against
DATABASE_URL=postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_test \
  PUBLIC_ORIGIN=http://localhost:5173 npm run migrate
DATABASE_URL=postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_test \
  PUBLIC_ORIGIN=http://localhost:5173 npm run dev

npm run typecheck      # the runtime strips types without checking them
npm run build
```

`npm run dev` needs a migrated database and does not apply migrations itself — only the container
entrypoint does that. Without one it starts anyway and fails on the first request instead, because
configuration is read lazily.

Tests run against a real Postgres — the risk this codebase carries lives in Postgres-specific SQL
and `numeric` handling, both of which disappear under a mock.

```sh
docker compose -f compose.test.yaml up -d --wait
npm test
docker compose -f compose.test.yaml down -v
```

Integration tests seed through the fixture builder in [`tests/support/fixtures.ts`](tests/support/fixtures.ts) —
`seedPerson`, `seedAccount`, `seedPositionSet`, `seedQuote`, `seedDailyClose` — and run inside a transaction that is
always rolled back, so no test can see another's rows and ordering never matters. Wrap a test body
in `withDatabase` to get both. Raw `INSERT` statements belong in the builder and nowhere else; that
is what keeps a schema change from rewriting every test.

## Reading what is held

[`app/lib/valuation.server.ts`](app/lib/valuation.server.ts) is the only thing that reads the
`holding_valued` view and its as-of companion `holding_valued_at(d date)`, and it is the seam every
screen reads through:

```ts
currentHoldings(ALL_OWNERS)         // every holding held right now, valued
netWorth(ALL_OWNERS)                // one SUM, plus how many holdings it was computed from
holdingsAt(ALL_OWNERS, '2026-02-14')  // the same, for any past date
netWorthAt(ALL_OWNERS, '2026-02-14')  // dates are 'YYYY-MM-DD' strings, both directions
```

Every household read names whose money it is counting. `ALL_OWNERS` is the whole household, and it
is required rather than defaulted so that a new screen cannot read holdings without deciding
(ADR-0008).

DESIGN.md §8.2 names dashboards drifting on the definition of "current holdings" as the
weakest point in the design; the view and this one module over it are the mitigation. A screen that
writes its own join over `holding` has left it. Partial data is reported as partial — an unpriced
holding still appears with `isPriced: false`, is left out of the total, and is counted in the
total's `coverage`, so a figure can be labelled "based on 8 of 12 holdings" rather than quietly
understated.

The as-of pair is not a second definition: `holding_valued_at` is declared `returns setof
holding_valued`, so it has the view's row type, and both resolve "which position set" through the
same `latest_position_set` function. It varies only what must vary — the position set is the newest
at or before the date, an account counts until its `closed_at`, and the price is the last
`price_daily` close at or before the date rather than the live quote. That carry-forward is why a
Saturday is worth what Friday closed at, and why cash prices at 1.00 on any date at all. An account
with no upload at or before the date contributes no rows rather than a zero: history starts at the
first upload (DESIGN.md §7).

## Where prices come from

Prices are fetched by an in-process loop on the refresh cadence set at Settings → Prices (seeded to
every 15 minutes) — there is no worker container, which DESIGN.md §10 chose deliberately for the
single deployment target. *Quotes* are asked for only while the market is open. Riding the same
refresh at any hour is a bounded **backfill** batch: whenever a holding's history reaches further
back than its prices do, the feed's own daily history fills the missing days in — inserted where
absent, never over a close the instance recorded itself, and un-adjusted for splits because a
statement records the shares as held on the day.
[`app/lib/price-provider.server.ts`](app/lib/price-provider.server.ts) is the only module that
imports `yahoo-finance2`, behind the two-method interface §6.1 mandates, so swapping providers
touches one file. [`app/lib/prices.server.ts`](app/lib/prices.server.ts) is the only module that
writes a price.

Three decisions in there are worth knowing before reading a number on a screen:

- **A quote is filed under the date the provider struck it**, not under today. A mutual fund strikes
  one NAV after the close, so an afternoon poll returns yesterday's — filed under today it would be
  a fabricated close, and a poll on Thanksgiving would manufacture a row for a day the market did
  not trade. The market calendar in [`app/lib/market-hours.ts`](app/lib/market-hours.ts) therefore
  only decides whether to spend a request; it can waste one or miss one, and it cannot corrupt the
  daily spine.
- **Today's daily close is provisional.** It is rewritten on each poll and settles on the last price
  of the session. A past day's row is rewritten only when the provider is still reporting that day —
  an evening fund NAV, or a Monday holiday still quoting Friday — and then with the same price it
  already holds.
- **A symbol that does not come back keeps its last price and is marked stale**, never zeroed and
  never nulled into a sum. One that has never been priced gets no row at all, and `holding_valued`
  reports it as unpriced rather than as worthless.

A quote that names a currency other than USD is refused, because there is no currency column to
tell two currencies apart once they are both in a `numeric` (DESIGN.md §14). A quote naming no
currency at all is accepted: refusing it would stop pricing an instrument over a field nobody
promised.

## Recording people and accounts

Settings → People and Settings → Accounts write through
[`app/lib/people.server.ts`](app/lib/people.server.ts) and
[`app/lib/accounts.server.ts`](app/lib/accounts.server.ts), which are also what read them. The
routes above are thin: they turn a form into raw fields, call in here, and render what comes back.
Every rule — what a name is, which fields a figure cannot be computed without, why a person cannot
be removed — lives in the module, so a second caller cannot get a different answer than the screen
does.

Refusals are ordinary outcomes rather than 500s. A `ValidationError` carries a message per form
field, so the form re-renders with the message beside the box that caused it and every other box
still holding what was typed. `NotFoundError` is separate because it becomes a different response:
a 404 rather than a re-rendered form.

Two rules are worth knowing before touching either module:

- **Nothing is ever deleted.** `closeAccount` sets `closed_at` and is the only retirement there is;
  there is no delete function and no delete affordance anywhere. A closed account stops counting
  toward current net worth and keeps counting on every date before it closed, which is the view's
  business rather than the module's — see `holding_valued` and `holding_valued_at`.
- **A person who owns accounts cannot be removed.** `account.owner_id` is `on delete restrict`, so
  the database refuses it anyway; `removePerson` reads the accounts first and turns that into a
  sentence naming them, closed ones included. The way out is to change the owner on those accounts.

## Migrations and database types

The database is the source of truth. A migration is a plain `.sql` file in [`migrations/`](migrations),
applied in filename order, each inside a transaction, with the applied filenames recorded in a
`schema_migrations` table. Re-running skips what is already recorded, which is why a restart is
always safe. The runner is a standalone TypeScript file run directly under Node's type stripping —
no build step — and exits non-zero on failure, which is what stops the container from starting the
server against a half-migrated schema.

```sh
docker compose -f compose.test.yaml up -d --wait
DATABASE_URL=postgres://portfolio:portfolio@127.0.0.1:55432/portfolio_test \
  PUBLIC_ORIGIN=http://localhost:5173 npm run migrate
```

### Adding a migration

1. Add `migrations/NNNN_what_it_does.sql` with the next zero-padded number. Filename order is
   apply order.
2. Apply it to a throwaway database, as above.
3. **Regenerate the database types.** This is a required step, not an optional one — Kysely is typed
   against [`app/lib/database.generated.ts`](app/lib/database.generated.ts), which `kysely-codegen`
   derives from the *live* database, views included, so `holding_valued` is typed like a table.
   The generated file is committed; nothing regenerates it for you.

   ```sh
   npm run db:types      # against the test database above by default
   ```

   Point it elsewhere with `DATABASE_URL=… npm run db:types`. Never hand-edit the generated file.
4. `npm run typecheck` — this is where a migration that broke a query surfaces.

`./scripts/smoke-test.sh` is the container smoke test CI runs: it brings the stack up against an
empty data directory, waits for the app healthcheck, requests `/healthz`, restarts the app, and checks that
the runtime image contains what it is meant to and nothing it is not, and that every container holds
only the privileges it was proved to need. It is slow and is not where behaviour gets tested.

## A note on money

The Postgres driver is configured to return `numeric` as **strings**, because its default is to
coerce them into JavaScript numbers, which silently rounds. Every money and quantity value therefore
crosses the application boundary as a decimal string. Do the arithmetic in SQL, or in a decimal
library — never `Number()`, `parseFloat`, or a JSON round trip as a number.

`date` is returned as a `YYYY-MM-DD` string for the same reason: the driver's default parses a
calendar date into a `Date` at *local* midnight, so formatting it back west of UTC gives the
previous day — and a statement's as-of date shifting by a day selects the wrong position set.
`timestamptz` is left alone; `created_at`, `closed_at` and `quote.as_of` are genuine instants.
