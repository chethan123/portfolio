# Ingest — the CSV upload, and the four screens that make a statement safe to apply

> Triage label to apply when this is filed: `ready-for-agent`
>
> Covers DESIGN.md §5.1 (the upload flow), §5.2 (uploads append, never mutate), §5.3 (the generic
> column mapper) and §4.3's alias table. Builds on the foundation slice (0001), which created
> `position_set`, `holding`, `instrument_alias` and `column_mapping` and left all four unwritten by
> anything; on the pricing slice (0002), whose USD guard and price sources a newly resolved
> instrument has to satisfy; and on the holdings slice (0003), whose correction path (§5.4) already
> established how a write that appends rather than edits is validated.

## Problem Statement

`/upload` is a 14-line `StubPage`. It is the destination of the rail's one filled primary action —
§13's mock extraction gives the button to **Upload statement** on the grounds that it is "this app's
only write action" — and what it renders is a sentence saying the ingest slice builds it.

The consequence is not a missing screen. It is that **a brokerage account cannot be populated at
all**:

- **The set-balance form refuses securities by design.** `acceptsSetBalance`
  (`app/lib/balances.server.ts:83`) allows `bank` and `liability` only, and `setBalance` leads with a
  form-level refusal for anything else — "recording one cash figure here would record everything
  else it holds as sold". Correctly: it writes a single `USD` row, and §5.2 makes a position set a
  photograph of the whole account.
- **The correction path cannot add anything.** §5.4 is explicit that it "changes numbers, never
  membership", because adding an instrument means resolving a name nobody has seen before against
  the alias table, "which is the upload flow's job". `revisePosition` re-resolves
  `(account, instrument)` through `latest_position_set` and refuses when the current statement does
  not carry the instrument — so it cannot bootstrap the first one.
- **Seeding is the only other writer.** `scripts/seed-demo.ts` inserts position sets directly. Every
  screenshot in the README, and every figure on every screen, currently traces back to a script no
  household runs.

So five schema objects built in 0001 have no writer anywhere in the application: `instrument_alias`,
`column_mapping`, `position_set.raw_file`, `position_set.source = 'upload'`, and
`account.external_account_number`. And the one path that *does* write positions — `setBalance` —
covers the two account kinds that hold a single number, leaving `brokerage`, `401k` and `ira` with
no way in.

## Solution

Build §5.1's flow as four screens over **one staging table**, with every step a real URL.

```
GET  /upload                        pick an open account, drop a CSV
POST /upload                        → creates an upload_draft, redirects to its first step
     /upload/:draftId/columns       map the columns   (prefilled when the fingerprint is known)
     /upload/:draftId/instruments   resolve first sightings  (skipped when there are none)
     /upload/:draftId/review        the diff, then commit
POST /upload/:draftId/review        → inserts the position_set, deletes the draft,
                                      redirects to /accounts/:id?uploaded=<setId>
```

**The draft is a table, not client state.** A URL cannot carry a CSV, and §8.1's screens have no
React state and work with JavaScript off. A new `upload_draft` row holds the bytes, the filename,
the in-progress mapping and the chosen as-of date; each step reads it, writes its own part back, and
redirects to the next. Reload, the back button, a closed laptop and a bookmarked half-finished
upload all behave, and an interrupted upload is resumable rather than lost. The two alternatives
were both rejected in the spec review: a `draft` flag on `position_set` puts a state column on the
immutable table `latest_position_set` and `holding_valued_at` read, where one missed filter counts a
half-finished statement as the household's holdings; and re-posting the bytes in a hidden field
cannot work at all, because a browser will not re-fill a file input programmatically.

**Nothing is applied until the last screen.** The first three steps write only to `upload_draft`.
The commit is one transaction: `position_set` (with `source = 'upload'`, the filename and the bytes
in `raw_file`), its `holding` rows, and the draft deleted. Nothing partially applied can exist,
because nothing is applied until then.

**The diff preview is the safety valve, and removals are its point.** §5.2's "a missing row means
sold" is what makes a filtered export dangerous: a file showing 2 of 30 positions is a valid
statement that silently sells 28 holdings. The review screen therefore lists every removed position
in full — instrument, quantity, last known value — never as a count, and a file that removes more
than half of what the account holds cannot be committed without ticking a sentence that says so in
those words.

**A first sighting is resolved once, then remembered forever.** Every distinct string in the
instrument column is looked up byte-exact against `instrument_alias`. Misses reach the unresolved
screen, which either points the string at an instrument that already exists or creates one — and
either way writes the alias, so the same brokerage's next export is silent.

## User Stories

**A household member records the quarter's brokerage statement.**
They pick the account, drop the CSV, and the mapping screen is already filled in because they mapped
this institution's export last quarter. They read "3 updated · 1 added · 1 removed (AAPL, 50 sh,
$8,500)", recognise the sale, and commit. Holdings, Overview and Analysis all move together, because
they all read the same view over the same set.

**The first export from a new institution.**
The mapping screen opens unfilled with the file's own header row across the top and the first three
data rows beneath it, so the reader maps by looking at values rather than guessing from names. The
mapping is saved against the institution and its header fingerprint, and never asked for again.

**A workplace plan that reports no cost basis.**
The 401k export has quantity and price and no basis column at all. The mapper allows the cost basis
to be left unmapped; the holdings land with `cost_basis_per_share` null, and Holdings' three
separate coverages (0003) already report a complete value total against a short unrealized one.

**A statement listing the same fund on three lot lines.**
The parser combines them — quantities summed, cost basis quantity-weighted — and says so on the
review screen as its own line: "VTSAX · 3 rows combined · 412.5 units". Nothing is silent, and the
household does not have to hand-edit a CSV.

**A collective investment trust with no ticker.**
The unresolved screen creates it with a null symbol and price source `manual`, exactly as the
`instrument` table's comment describes, and the refresh job leaves it alone.

**A misread column, caught on the last screen.**
The reader sees every quantity a thousand times too large on the diff, goes back, remaps, and
commits. Nothing was written, because nothing is written before the commit.

## Implementation Decisions

### The draft table

One migration, `migrations/0004_upload_draft.sql`:

```sql
create table upload_draft (
  id         bigint generated always as identity primary key,
  account_id bigint not null references account (id) on delete cascade,
  filename   text   not null,
  raw_file   bytea  not null,
  as_of_date date,
  mapping    jsonb,
  created_at timestamptz not null default now()
);

create index upload_draft_created_at_idx on upload_draft (created_at);
```

`as_of_date` and `mapping` are null until their step is passed, which is what makes "how far did
this draft get" a property of the row rather than a status column to keep in sync. `raw_file` is
`not null` here and nullable on `position_set` for the reason 0001 gives — a manual balance edit has
no file, but a draft is a file by definition.

**Drafts are swept, not scheduled.** Any draft older than 24 hours is deleted at the start of the
next upload. A cron for a table that holds at most a handful of rows in a single-household
application is machinery without a payer.

### The mapping JSON

```jsonc
{
  "headerRow": 3,                    // zero-based index into the file's rows
  "delimiter": ",",
  "columns": {
    "instrument": "Symbol",          // required
    "name": "Description",           // optional, used only when creating an instrument
    "quantity": "Quantity",          // required
    "costBasis": "Average Cost Basis",   // optional
    "asOf": "As of",                 // optional
    "accountNumber": "Account"       // optional
  },
  "costBasisIs": "per_share",        // per_share | total
  "owedAsPositive": false,
  "combineDuplicateRows": true
}
```

**Columns are named, not indexed.** The fingerprint below already guarantees the header row is the
one the mapping was built against, so a name is the readable half of an equivalent key.

**`costBasisIs` earns its place.** Brokerages report total cost basis about as often as per-share,
and the two differ by the quantity — a mapping that assumed one would be wrong by a factor of the
position size on half the institutions in existence, in a direction nothing on screen would flag.
`total` is divided by the row's quantity at parse time, at `numeric(20, 4)`'s scale, with a zero
quantity yielding a null basis rather than a division fault.

**`owedAsPositive` is where a liability's sign is decided.** §2 puts the sign in the quantity and a
loan statement lists a positive balance, so something has to negate it. `setBalance` derives this
from `account.kind` and refuses to accept a typed sign at all (§14.8); here the file states a number
and the checkbox states its direction, defaulted from `isOwed(account.kind)` and saved with the
mapping. This is also the answer to §14.8's overdrawn bank account: a bank export carrying a
negative balance records it, because the file's own sign is kept when the box is unticked.

### The fingerprint

SHA-256, hex, over the header row's cells: each trimmed, lowercased, internal whitespace collapsed
to one space, joined with a unit separator (`U+001F`), in file order. Scoped by
`account.institution`, which is what `column_mapping_one_per_fingerprint` is a unique constraint on.

Deliberately order-sensitive: a reordered export is a different fingerprint and costs one re-map,
which is cheaper than a mapping that silently follows a column that moved.

### The parser is ours, and it is a pure function

`app/lib/csv.ts` — bytes in, rows of strings out — plus `app/lib/statement.ts`, which applies a
mapping to those rows. Neither touches the database, so both are testable against fixture files with
no fixture household.

A library was considered and passed over. `csv-parse` and `papaparse` solve RFC 4180 quoting, which
is the easy half; they solve none of the tolerance §5.3 actually asks for — preamble rows, footer
disclaimers, `$` prefixes, parenthesised negatives, `n/a` strings, thousands separators — and every
one of those has to be handled in our own code either way. The quoting half is about sixty lines and
is exhaustively testable. If it proves fragile against real exports, `csv-parse` is the fallback and
this decision is cheap to reverse, because the seam is one module.

What the reader tolerates, all of it specified as tests in step 02: a UTF-8 BOM; CRLF and bare CR;
quoted fields containing the delimiter, quotes and newlines; a delimiter sniffed between comma,
semicolon and tab; ragged rows; blank rows; a preamble above the header; a footer of disclaimers
below the data.

**Numbers stay strings, always.** `$1,234.56`, `(1,234.56)`, `12.5%`, `n/a`, `--`, an em dash and
the empty string are normalised to a decimal string or to null, never through `parseFloat`. This is
the same invariant 0003 made structural by putting every digit-level operation in
`app/lib/money.ts`, and the normaliser belongs in that module next to them.

### Resolution, and the guard that has to run here

Lookup is byte-exact against `instrument_alias.raw_string`, which 0001 declared `collate "C"` for
exactly this: no normalisation heuristics, a miss prompts once and is remembered permanently.

Creating an instrument from the unresolved screen needs a classification, and the only seeded one is
`Cash` — so the screen offers the existing classifications and, inline, a new one with its
`asset_class`. That is the whole of classification management this slice builds; the Settings →
Instruments tab remains 0002's unfinished business.

**A `feed` instrument's symbol is probed once, at creation.** DESIGN.md limitation 6 and 0002's
non-USD guard keep GBP out of a USD sum, but today the guard only fires at refresh — so a mistyped
or foreign-listed symbol is accepted here and turns up as a permanently stale row with no
explanation. One provider call at creation refuses a non-USD quote naming the symbol and the
currency. A provider failure does not block creation: the instrument is created and the next refresh
marks it stale, which is the pre-existing behaviour rather than a new one.

### The commit reuses the write rules 0003 established

- **The product guard.** `fitsTheMoneyColumn` (`app/lib/positions.server.ts:231`) exists because
  `quantity × cost_basis_per_share` can overflow `numeric(20, 4)` while both operands sit inside
  their own columns — and the failure mode is `holding_valued` raising on every subsequent request,
  taking Holdings and Analysis down together. An upload writes many rows at once, so it is the
  likelier way in. Export it and run it per row; a row that fails refuses the whole commit and names
  the instrument.
- **The as-of date.** `recordedDate` from `app/lib/input.server.ts`, unchanged: a real calendar
  date, no later than tomorrow, for the reason it documents — "latest" is `max(as_of_date)`, so a
  year typed as 2126 pins the account until 2126. A mapped as-of column is read from the file and
  validated the same way; rows disagreeing on it refuse the file rather than picking one.
  `effectiveDate` is **not** used: that is §5.4's rule for a correction, which is about now. A
  statement is about its own date.
- **A quantity of zero is stored as zero**, matching §5.4, so the row stays addressable.

### The account number is a guard, not an auto-selector

`account.external_account_number`'s comment says "used to auto-select the account on upload", but
this flow picks the account before the file is parsed, so there is nothing to auto-select. The
column is used the other way instead: when the mapping names an account-number column and the
account already has one recorded, a disagreement refuses the commit — which is the collision §5.1
built first-class accounts to avoid, caught at the moment it would happen. When the account has none
recorded, the file's value is captured on commit.

### Uploads, and file size

`MAX_UPLOAD_MB` joins `server/config.ts`, an integer defaulting to 10, minimum 1. A `Content-Length`
above it is refused before the body is read; a file that slips past it is refused on `File.size`
before its bytes are touched. A brokerage CSV is tens of kilobytes, so the cap exists to bound what
an accident can put in memory, not to constrain real use.

This is the first multipart form in the application — every existing action reads
`formFields(await request.formData())`, which assumes string fields. If the framework's own
`request.formData()` proves unsuitable for bounding the body, `@mjackson/form-data-parser` is React
Router's recommended streaming parser and is the intended fallback.

## Testing Decisions

### The seam

The same one every slice here uses: every server module takes `db` as its last parameter and
defaults to `getDb()`, so tests drive real Postgres through `tests/support/database.ts` and real
fixtures through `tests/support/fixtures.ts`. The parser and the mapping application take no `db` at
all and are tested as pure functions over fixture bytes.

The price provider is already behind 0002's interface, so the creation-time USD probe is tested
against a stub rather than the network.

### What gets tested

- `tests/csv-reader.test.ts` — quoting, delimiters, BOM, line endings, ragged and blank rows.
- `tests/statement-parse.test.ts` — mapping application, number normalisation, `costBasisIs`,
  `owedAsPositive`, duplicate combination and its weighted basis, as-of extraction.
- `tests/column-mapping.test.ts` — fingerprint stability, case and whitespace insensitivity, order
  sensitivity, save and auto-apply per institution.
- `tests/instrument-resolution.test.ts` — alias hit and miss, byte-exactness, instrument creation,
  alias written on resolve, non-USD refusal, provider failure not blocking.
- `tests/upload-draft.test.ts` — draft lifecycle, step gating, the 24-hour sweep, a committed
  draft's second POST.
- `tests/commit-upload.test.ts` — the transaction, the diff arithmetic, removals, the product guard,
  the account-number guard, and that `latest_position_set` returns the new set immediately after.

Fixture CSVs live in `tests/fixtures/statements/` and are shaped like the real thing: a
Fidelity-style export with a preamble and a footer, a Schwab-style one with dollar prefixes and
parenthesised negatives, a 401k with no cost basis and a CIT with no ticker, a lot-level file with
three rows for one fund, a liability statement listing a positive balance, and a file whose header
fingerprint matches an existing mapping.

## Out of Scope

- **Deleting a position set, and re-parsing one from `raw_file`.** §5.2 calls deletion "free undo"
  and §5.4 records that it has no interface; both stay true after this slice, and the retained bytes
  this slice starts writing are what a later one will re-parse. Restated in §14 rather than removed.
- **Settings → Instruments.** 0002's unbuilt UI — manual price entry for a CIT, alias editing,
  classification management as a screen. This slice creates instruments and classifications inline,
  where a first sighting forces the question, and nowhere else.
- **One file covering several accounts.** §5.1's flow is per-account by construction. A household
  export split across accounts is uploaded once per account.
- **Transactions, cash flow and realised gains.** §3's standing exclusion, unchanged.
- **PDF and XLSX.** §5.3's answer is a hand-authored CSV in the app's template, which is just
  another saved mapping.
- **Scheduled or API-driven import.** No account aggregation, by §1.

## Further Notes

**There is no mock for this screen.** The Stitch set covers dashboard, views and account detail
only; the screen audit records "any Upload or Settings screen" as absent from it
(`docs/research/2026-08-19-stitch-screen-audit.md:165`). The UI is therefore built from the app's own
established grammar — the form conventions of Settings, the table conventions and the URL-as-state
discipline of `docs/design/holdings-ui-brief.md` — rather than from an extraction. A design brief is
not a prerequisite for filing these tickets.

**Two documents disagree with this spec today and are amended by it.** The comment above
`holding_one_row_per_instrument` in `migrations/0001_initial_schema.sql` says two rows for one
instrument in a set is "a parse fault, not data" — the constraint stays, since a *set* still holds
one row per instrument, but the parser combines the file's rows on the way in and says so. And
DESIGN.md §14.8's "an overdraft is recordable today only as a `liability` account or through an
upload" becomes plainly true rather than aspirational.

**Mobile.** §11 classes upload as a desktop-shaped workflow, and this slice does not change that.
The screens reflow with the CSS the rest of the app already has, the file input works on a phone,
and nothing is withheld — but the mapping table is wide and no mobile-specific layout is designed
for it.

**Screenshots.** `docs/screenshots/README.md` makes retaking the shots part of finishing a screen,
and the README's "Not built yet" table currently lists Upload. Step 05 carries both.
