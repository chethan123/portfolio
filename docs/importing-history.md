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
known. Where
this document says "manual series" for something you might wish were computed, that rule is why.

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

For every instrument the poller quotes, the computed line's second ingredient begins late:
`price_daily` holds no close for them from before the day the instance's poller first ran. Nothing
backfills it today —
[issue #83](https://github.com/chethan123/portfolio/issues/83) tracks both the consequence and the
fix — and the consequence is worth understanding before any backdated statement lands:

**A statement dated before the spine begins is valued without its securities.** Positions exist for
those dates, closes do not, so every security on them is unpriced — excluded from the total and
counted in the coverage figures — while cash and loans still price at 1.00. Until issue #83 lands,
the chart draws those partial points on the ordinary solid line with nothing beside them saying so:
a line that runs at cash-minus-loans level and then cliffs up to the real total on the day the
poller first ran.

So the order of work is chosen to keep the era each line claims truthful at every step:

1. Capture everything from Empower.
2. Load the pre-app years into the manual series. Nothing computed exists there, so nothing can
   disagree.
3. Record bank and loan balance history. Cash prices on every date through the seeded `USD` close,
   so these are immune to the spine problem.
4. For investment accounts, upload the **most recent** statement first. That creates the instrument
   rows and starts the computed line in the present, where the spine is sound.
5. Fill the spine backward for those instruments, over the range your older statements will need.
6. Only then upload the older statements — they value correctly the moment they land.
7. Verify, then delete the captured files.

If you skip step 5, nothing is lost — the underlying data stays correct and every distorted point
repairs itself the moment closes for it exist — but the chart misstates the backfilled era in the
meantime, and nothing on screen warns you.

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
on any date it covers — so a backfilled checking account makes the *computed* line start earlier,
carrying only that account until the investment statements catch up. What per-account balance
history actually buys is that account's own page reaching back, and an honest cash line through the
years before the app. For a household that mostly wants the total, step 2 alone is a perfectly good
answer, and this step can cover just the recent past — or nothing.

## Step 4 — investment accounts, from brokerage statements

Empower cannot help here — it has balances, not holdings — but your brokerages can: every
custodian's website offers past statements or position exports, usually years back. This is the
same upload flow as any other statement ([`guide/upload.md`](guide/upload.md),
[`guide/first-statement.md`](guide/first-statement.md)); the only thing backfill changes is how
much of it you do, so the notes here are only what matters at volume:

- **Most recent statement first**, per the ordering above: it creates the instrument rows the price
  backfill in step 5 needs, and the first upload is where each new instrument gets its
  classification.
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
  its id in `position_set` by account and date, and `delete from position_set where id = …` takes
  its holdings with it.

When the most recent statements are in, open Holdings beside the captured `getHoldings` response
and check the two agree account by account — that is what the capture is for. Then upload the rest,
oldest or newest first as you like, ideally after step 5 has run once.

## Step 5 — fill the price spine

For every date a backdated statement covers, each of its instruments needs some close at or before
that date in `price_daily`; the carry-forward does the rest. There is no built-in way to load
historical closes yet (issue #83 again), so this is a `psql` job. This table is the computed line's
pricing authority — work slowly here.

**Find the gaps first.** This query names every instrument whose spine starts later than its
history needs, and the date range each one is missing:

```sh
docker compose exec db psql -U portfolio -d portfolio -c "
  select i.id, i.symbol, i.name,
         min(ps.as_of_date) as first_held,
         min(pd.date)       as first_close
  from holding h
  join position_set ps on ps.id = h.position_set_id
  join instrument i    on i.id  = h.instrument_id
  left join price_daily pd on pd.instrument_id = i.id
  where i.price_source <> 'fixed'
  group by i.id, i.symbol, i.name
  having min(pd.date) is null or min(pd.date) > min(ps.as_of_date)
  order by i.symbol nulls last;"
```

An empty result means the spine already covers everything held, and this step is done.

One kind of row it can show needs no closes at all: the query reads every set ever uploaded,
including ones a same-date correction has superseded, so an instrument held only in a superseded
set keeps a row here that no valuation reads. Delete that set (step 4's last note) or ignore its
row.

**Sourcing closes for quoted instruments.** Historical daily closes for anything with a public
ticker are available from the usual providers — the same unofficial Yahoo API the app's own poller
quotes from serves history through a different endpoint, and a custodian's own download is even
better where offered. Two traps, both silent:

- **Split adjustment.** Most providers restate history through later stock splits, while your
  statements record shares as held on the day. For any symbol that split after a statement date,
  adjusted closes misvalue those positions by exactly the split factor — use unadjusted closes, or
  un-adjust using the provider's own split records. Mutual funds, which is most of a retirement
  account, essentially never split.
- **Ticker reuse.** A symbol's history on a provider belongs to whatever holds the ticker *now*.
  For an instrument that changed symbols, fetch under the symbol of the era, and spot-check a
  couple of figures against a statement.

Only USD closes, ever — the application stores no currency and refuses foreign-listed instruments
at resolution for exactly this reason.

**Sourcing closes for manually priced instruments.** A collective investment trust has no feed
history anywhere, but the statements holding it print its unit price — that column is the source.
One close per statement date is enough; the carry-forward holds it between statements — hand-set
prices carrying forward is how the design prices these instruments generally, though the screen
for setting one is among the tabs Settings lists as not built yet.

**Loading.** However you assemble the closes, they land as rows of `(instrument_id, date, close)`,
with the instrument id taken from the gap query above. For a handful of statement-dated CIT prices,
plain inserts:

```sql
insert into price_daily (instrument_id, date, close)
values (17, date '2024-03-29', 41.2300)
on conflict (instrument_id, date) do nothing;
```

For a fetched series, shape it into a TSV of `instrument_id`, `date`, `close` and `\copy` it in as
in step 2. Either way, `do nothing` on conflict — or for `\copy`, loading only dates before each
instrument's `first_close` — keeps the poller's own rows authoritative: a backfill must never
overwrite what the running system recorded live. Trading days only; a row for a weekend or holiday
would state a close that never happened, where the carry-forward already answers those dates
honestly.

Re-run the gap query until it comes back empty.

## Step 6 — verify

**In the terminal.** The same function the dashboards read can be asked directly how well any date
is covered:

```sh
docker compose exec db psql -U portfolio -d portfolio -c "
  select count(*) filter (where not is_priced) as unpriced, count(*) as held
  from holding_valued_at(date '2025-06-30');"
```

Ask it at a few dates spread across the backfilled era. `unpriced` should be zero everywhere,
except holdings you knowingly left without closes. This terminal check is the only one that
counts: until issue #83 lands, no screen distinguishes a past date priced worse than today from
one priced fully — the Overview's coverage sentence counts what is unpriced *now*, not then.

**On the screens.** The Overview at the All range should now read as one story: dashed manual
years, then a solid line from your earliest backfilled statement onward, with no cliff at the date
the instance was installed. Point along the line and read the values; open an account's page and
check its line starts where its own history starts.

**Against Empower — loosely.** Pick a month-end and compare the computed total with Empower's
figure for the same date. Expect them to be close, not equal: the two systems price at different
moments from different sources, and this one excludes what it cannot price and says so, where
Empower carries its own estimates. Chasing exact agreement is chasing two defensible answers to the
same question; what a mismatch worth investigating looks like is a *large* one, which almost always
means a missing statement, a missing account, or a spine gap the queries above will name.

## Clean up

Delete the captured files — `histories.json`, the accounts and holdings captures, and any TSVs
derived from them. Everything they held that matters is now in the database, which
[`operating.md`](operating.md) already tells you how to back up; what remains in them is account
numbers in plain text with no further use.
