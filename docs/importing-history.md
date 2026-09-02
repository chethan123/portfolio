# Importing history from Empower (Personal Capital)

How to move the history a household has been keeping in Empower — the tracker formerly called
Personal Capital — into this application. It is written for whoever self-hosts the instance: most of
it happens in a terminal against the database, which is why it lives here rather than in
[`guide/`](guide/), and it is a job done once, not a screen anyone uses twice.

The work is not one import. Empower holds several kinds of history, this application stores several
kinds, and the mapping between them is the actual content of this document. Read the first two
sections before touching anything — the ordering in them is what keeps the chart honest while the
data lands.

## What you are importing into

The Overview draws two lines, and they mean different things
([`guide/overview.md`](guide/overview.md), [DESIGN.md §7](../DESIGN.md)):

- **The solid computed line** is derived, on every read, from two ingredients: *positions* — dated
  statement photographs in `position_set`, one per account per statement — and *closes* — one price
  per instrument per trading day in `price_daily`, carried forward across non-trading days. A past
  date's value is that date's positions priced at that date's close. Nothing stores the line
  itself.
- **The dashed manual line** is a hand-typed series of `(date, amount)` totals covering the years
  before the instance existed. It has no structure — no accounts, no owners, no holdings — so only
  the Overview's total reaches back through it, it is drawn in its own style, and the computed line
  wins wherever the two overlap.

One rule governs everything below: **never fake a photograph.** A `position_set` claims to be the
complete truth of what an account held on a date — a missing row means sold, and every consumer
prices the rows as what they say they are. Empower's per-account *balance* history cannot honestly
become one for an investment account: a balance says what the account was worth, not what it held,
and recording it as a single cash row would file the equity side of the household under cash in
every as-of valuation behind the charts, while the coverage counts report the figure as fully
known. Where this document says "manual series" for something you might wish were computed, that
rule is why.

This section is the third telling of the two lines — [DESIGN.md §7](../DESIGN.md) holds the rules,
[`guide/overview.md`](guide/overview.md) reads them off the screen — and the duplication is
deliberate, named here and in [`README.md`](README.md): an importer has to hold both in one place
before deciding where anything goes. For every rule's reason, those two are the authorities.

What each thing Empower holds can become here:

| Empower has | It becomes | Why |
|---|---|---|
| Daily aggregate net worth history | The manual series (`manual_networth`) | A total with no structure is exactly what the dashed line is for |
| Per-account balance history, bank and loan accounts | Recorded balances through the app's own form | A bank balance *is* a complete photograph — one cash row is the whole truth |
| Per-account balance history, investment accounts | Nothing, directly | A balance is not a photograph; see the rule above. The manual series already carries its share of the total |
| Current holdings | A checklist | To verify your first uploads against — not an import source; your brokerages' statements are |
| Historic holdings | — | The dashboard has nowhere to capture point-in-time holdings from. The computed line's past comes from brokerage statements, or not at all |

## Before you upload anything backdated: the price spine

**The application fills the price spine in for itself**
([ADR-0011](adr/0011-a-backfill-fills-the-spine-but-never-moves-it.md)). Whenever an instrument's
position history reaches back behind its price history, the refreshes after your statement lands
fetch that instrument's daily closes from the feed and store every trading day the spine does not
already hold — a handful of instruments per refresh, nobody asked, nothing to run.

That leaves one window worth knowing about before a backdated statement lands:

**A statement dated before the spine reaches is valued without its securities until its closes
arrive.** Positions exist for those dates, closes do not yet, so every security on them is
unpriced — excluded from the total and counted in the coverage figures — while cash and loans still
price at 1.00. The chart draws those partial points on the ordinary solid line with nothing beside
them saying so, which is the half of issue #83 the backfill does not answer and
[issue #216](https://github.com/chethan123/portfolio/issues/216) carries. A
household loading a decade over forty instruments is filled over a handful of refreshes; at the
seeded fifteen-minute cadence that is an hour or two, and every distorted point repairs itself as the
rows land.

So the order of work is chosen to keep the era each line claims truthful at every step:

1. Capture everything from Empower.
2. Load the pre-app years into the manual series. Nothing computed exists there, so nothing can
   disagree.
3. Record bank and loan balance history. Cash prices on every date through the seeded `USD` close,
   so these are immune to the spine problem.
4. For investment accounts, upload the **most recent** statement first — that creates the instrument
   rows and classifies them — and then the older ones. The older ones may read short for a refresh
   or two while their closes arrive.
5. Check the spine at Settings → Prices, and act on anything the feed cannot fill.
6. Verify, then delete the captured files.

Most recent first is the right order because it is where the instruments get created and classified,
which is what gives the backfill something to work on.

## Step 1 — capture from Empower

Empower's dashboard does not offer these series as downloads, but the web application fetches
everything it draws as JSON, and your browser will show you the responses.

1. Sign in to the dashboard at `home.personalcapital.com` in a desktop browser.
2. Open the browser's developer tools, Network tab, filtered to Fetch/XHR.
3. Open the **Net Worth** view and set its date range as wide as it goes.
4. In the network log, find the request the chart was drawn from — its name contains
   `getHistories`. Open its response, confirm it is a long array of dated entries with the day's
   aggregate figures, and copy the whole response into a file, say `histories.json`.
5. While you are there, capture two more responses the same way: the accounts inventory (name
   contains `getAccounts`), and — from the holdings view — the current holdings (name contains
   `getHoldings`).

Three cautions:

- **These are unofficial endpoints.** Names, paths and field names have drifted across Empower's
  rebrands and will drift again. Trust what your own network log shows over any write-up of the
  API — including this document's claims about what the dashboard does and does not serve — so
  every recipe below tells you which fields to identify by eye rather than assuming a name.
- **The responses are sensitive.** They carry account numbers, institution names and balances. Save
  them outside any git checkout, and delete them at the end (the last step below).
- **Prefer copying individual responses over "save all as HAR".** A HAR file additionally records
  your request headers, and with them the session cookie — a credential, not just data.

If you would rather script the capture, community clients for this API exist and handle the login
and two-factor dance. The same three cautions apply, doubled: verify what a script fetched against
the browser before importing any of it.

## Step 2 — the pre-app years into the manual series

The dashed line has no screen yet — Settings says so itself, and
[`guide/overview.md`](guide/overview.md) explains what a reader of the chart is told about it — so
the series is loaded in the terminal, into the `manual_networth` table: one row per date, two
columns, `date` and `amount`.

**Pick the points, thinly.** The series is a hand-typed prefix, drawn in a style that says "rough
figure, not a priced valuation", and the readout describes its points in those terms. Month-end or
month-start points carry everything the dashed line means; importing every day Empower recorded
adds rows without adding truth. Whatever grain you pick, the useful span is the dates **before your
earliest statement will be** — on any date the computed line covers, a manual point is never drawn.
Leaving overlapping points in place is harmless; importing them is just pointless.

**Extract `(date, amount)` pairs.** Open `histories.json` and identify, in the dated entries, the
field holding the date and the field holding that day's aggregate net worth — assets minus
liabilities. With those two names in hand:

```sh
jq -r '.spData.networthHistories[] | "\(.date)\t\(.networth)"' histories.json > points.tsv
```

substituting the path and field names your capture actually uses. To thin daily data to one point
per month by keeping the day-one rows — a month missing its first day is simply skipped, which a
rough prefix can afford:

```sh
awk -F'\t' 'substr($1, 9, 2) == "01"' points.tsv > monthly.tsv
```

**Read the file before loading it.** It is short — that was the point of thinning — and this is the
moment to catch a mis-picked field, a figure that is assets rather than net worth, or a date format
that is not `YYYY-MM-DD`.

**Load it.** With the file beside your `compose.yaml`:

```sh
docker compose exec -T db psql -U portfolio -d portfolio \
  -c "\copy manual_networth (date, amount) from stdin" < monthly.tsv
```

A re-run fails loudly rather than doubling anything — `date` is the table's primary key — and the
natural way to redo a hand-typed prefix is wholesale: `delete from manual_networth;` through the
same `psql`, then load again.

Open the Overview at the All range. The dashed line should now run ahead of wherever the solid one
starts, and pointing at any of its points should name it in the readout as the rough figure it is.

## Step 3 — bank and loan balance history

Create the people and accounts first if this is a fresh instance
([`guide/people-and-accounts.md`](guide/people-and-accounts.md)). Then, for each bank and loan
account, the app's own balance form is the supported way in
([`guide/account-detail.md`](guide/account-detail.md)): it takes an amount and **the date it was
true**, accepts any date back to 1970, and writes exactly what a statement upload writes, so
history entered this way is computed history — solid line, per-account chart, everything.

The balances come out of Empower the same way as step 1's capture. Whether `histories.json`
already carries per-account entries depends on what the chart you captured it from requested —
check by eye; if it holds only the aggregate, open the account's own page in Empower and capture
the history response *its* balance chart fetches, one file per account. Monthly points are plenty,
entered in any order, since each carries its own date. A loan is typed as the amount owed — the
form owns the sign.

**Decide whether the per-account depth is worth the typing before you start.** The household total
over those years is already covered by the manual series from step 2, and the computed total wins
on any date it covers — so a checking account loaded back through those years makes the *computed*
line start earlier, carrying only that account until the investment statements reach that far.
 What per-account balance
history actually buys is that account's own page reaching back, and an honest cash line through the
years before the app. For a household that mostly wants the total, step 2 alone is a perfectly good
answer, and this step can cover just the recent past — or nothing.

## Step 4 — investment accounts, from brokerage statements

Empower cannot help here — it has balances, not holdings — but your brokerages can: every
custodian's website offers past statements or position exports, usually years back. This is the
same upload flow as any other statement ([`guide/upload.md`](guide/upload.md),
[`guide/first-statement.md`](guide/first-statement.md)); the only thing loading history changes is
how much of it you do, so the notes here are only what matters at volume:

- **Most recent statement first**, per the ordering above: it creates the instrument rows the
  backfill works from, and the first upload is where each new instrument gets its classification.
- **The as-of date is the statement's date**, not the day you upload it. The upload flow reads it
  from the file where the file carries one, and asks otherwise.
- **Each upload is a complete photograph** of the account on that date. A partial file records
  everything absent from it as sold.
- **Pick a cadence and keep it.** Positions are constant between photographs by construction, so
  the line between two statements moves on prices alone — real, but only part of the truth if
  money moved between them. Monthly statements make that gap a month; quarterly is often all a
  401k offers and is fine.
- **Mistakes are corrected by re-uploading.** There is no screen for deleting an upload; a
  corrected upload for the same date simply wins, and the superseded set lingers unread. If one
  gets in the way — step 5's gap query still counts it — the schema is built for removing it: find
  its id in `position_set` by account and date (of the two rows a corrected date holds, the
  superseded one is the earlier, by `created_at` then by `id`), and
  `delete from position_set where id = …` takes its holdings with it.

When the most recent statements are in, open Holdings beside the captured `getHoldings` response
and check the two agree account by account — that is what the capture is for. Then upload the rest,
oldest or newest first as you like.

## Step 5 — check the price spine

For every date a backdated statement covers, each of its instruments needs some close at or before
that date in `price_daily`; the carry-forward does the rest. **The application fills that in on its
own now** ([ADR-0011](adr/0011-a-backfill-fills-the-spine-but-never-moves-it.md)), so this step is a
check rather than a job: give the refreshes a little time after your uploads, then look at what is
left.

**Settings → Prices is the list.** It shows every holding whose price history does not reach as far
back as it is held, when it was first held, where its prices actually start, and what the last
attempt came to. An empty list means the spine covers everything held and this step is done. A row
that says "Never" is one the feed can never fill, and the only two kinds are below.

The same question in the terminal, for a reader who would rather ask the database — the screen shows
these same rows:

```sh
docker compose exec db psql -U portfolio -d portfolio -c "
  select i.id, i.symbol, i.name,
         min(ps.as_of_date) as first_held,
         (select min(date) from price_daily pd where pd.instrument_id = i.id) as first_close
  from holding h
  join position_set ps on ps.id = h.position_set_id
  join instrument i    on i.id  = h.instrument_id
  where i.price_source <> 'fixed'
  group by i.id, i.symbol, i.name
  having not exists (
    select 1 from price_daily pd
    where pd.instrument_id = i.id and pd.date <= min(ps.as_of_date))
  order by i.symbol nulls last;"
```

And the record of what was tried, which is where an outcome's reason lives:

```sh
docker compose exec db psql -U portfolio -d portfolio -c "
  select instrument_id, started_at, range_from, range_until, written, outcome, error
  from price_backfill order by started_at desc limit 20;"
```

One kind of row the list can show needs no closes at all: it reads every set ever uploaded,
including ones a same-date correction has superseded, so an instrument held only in a superseded set
keeps a row here that no valuation reads. Delete that set (step 4's last note) or ignore its row.

**Two traps to know about, now that the machine takes them rather than you.**

- **Split adjustment.** The feed restates history through later stock splits, while your statements
  record shares as held on the day. The application un-adjusts each close by the ratio of every split
  after it, so a pre-split position is valued at what it was actually worth. If it ever cannot read a
  split, it refuses that instrument's whole history rather than storing some rows right and some
  wrong, and the row says `split_unresolved`.
- **Ticker reuse.** A symbol's history at the feed belongs to whatever holds the ticker *now*, and
  the application has no way to know an instrument changed symbols. It will fill in the current
  ticker's past. **For any instrument whose symbol has changed, spot-check a couple of figures
  against a statement of the era.** This is the one thing on this page that still needs your eyes.

**What the feed cannot fill.** A collective investment trust has no history anywhere, and neither
does a feed instrument nobody has given a ticker. Both appear on the list with the reason. For a
CIT, the statements holding it print its unit price — that column is the source. One close per
statement date is enough; the carry-forward holds it between statements. The screen for setting one
by hand is among the tabs Settings lists as not built yet, so until it lands these are `psql`:

```sql
insert into price_daily (instrument_id, date, close)
values (17, date '2024-03-29', 41.2300)
on conflict (instrument_id, date) do nothing;
```

`do nothing` on conflict, always. That is the rule the application's own backfill obeys and the
reason two writers can share this table: **a backfill must never overwrite what the running system
recorded live.** Trading days only; a row for a weekend or holiday would state a close that never
happened, where the carry-forward already answers those dates honestly.

## Step 6 — verify

**In the terminal.** The same function the dashboards read can be asked directly how well any date
is covered:

```sh
docker compose exec db psql -U portfolio -d portfolio -c "
  select count(*) filter (where not is_priced) as unpriced, count(*) as held
  from holding_valued_at(date '2025-06-30');"
```

Ask it at a few dates spread across the era your backdated statements cover. `unpriced` should be zero everywhere,
except holdings you knowingly left without closes, and anything the backfill has not reached yet.
This terminal check is the only one that counts while a gap is open: no screen yet distinguishes a
past date priced worse than today from one priced fully — the Overview's coverage sentence counts
what is unpriced *now*, not then, and the chart-side warning that would say otherwise is
[issue #216](https://github.com/chethan123/portfolio/issues/216). Settings → Prices answers the other question, which is whether anything is
still missing at all.

**On the screens.** The Overview at the All range should now read as one story: dashed manual
years, then a solid line from your earliest backdated statement onward, with no cliff at the date
the instance was installed. Point along the line and read the values; open an account's page and
check its line starts where its own history starts.

**Against Empower — loosely.** Pick a month-end and compare the computed total with Empower's
figure for the same date. Expect them to be close, not equal: the two systems price at different
moments from different sources, and this one excludes what it cannot price and says so, where
Empower carries its own estimates. Chasing exact agreement is chasing two defensible answers to the
same question; what a mismatch worth investigating looks like is a *large* one, which almost always
means a missing statement, a missing account, or a spine gap the queries above will name.

## Clean up

Delete the captured files — `histories.json`, any per-account history captures from step 3, the
accounts and holdings captures, and any TSVs derived from them. Everything they held that matters is now in the database, which
[`operating.md`](operating.md) already tells you how to back up; what remains in them is account
numbers in plain text with no further use.
