# Upload / CSV ingest pipeline — QA findings

Instance: `http://localhost:5181`, database `qa1`.
All repros below were re-run **from a freshly dropped/recreated + migrated + demo-seeded `qa1`**
(`drop database qa1` → `create database qa1` → `node ./server/migrate.ts` → `node ./scripts/seed-demo.ts`
→ dev server restarted) before being written up. Server log: `scratchpad/qa1.log`.
Scratch fixtures and helper scripts live in `scratchpad/qa-upload/`.

Two helper scripts are referenced below; both are plain `curl`:

```sh
D=/tmp/claude-0/-home-user-portfolio/87e54460-436b-57d4-9ad6-3eed3f537ddd/scratchpad/qa-upload
# $D/up.sh  <file> [accountId]        -> POST /upload, prints STATUS + redirect
# $D/map.sh <draftId> <headerRow> <instrument> <quantity> [name] [costBasis] [asOf] [accountNumber] [costBasisIs]
```

Reference docs read first: `docs/specs/0004-ingest.md`, `docs/specs/ingest/01..05`, `DESIGN.md` §5 and §14,
`docs/design/ingest-ui-brief.md`.

---

## 1. A file whose rows disagree about the account number slips past the intra-file guard when the disagreeing rows share an instrument — the two accounts' quantities are silently summed into one

**Severity: High** (wrong money, silently; the guard built for exactly this case never fires)

`commitUpload` refuses a file that names two different account numbers on two rows. But
`parseStatement` combines duplicate instrument rows *before* the guard sees them, and the combined
position keeps only the **first** row's account number (`app/lib/statement.ts:574`). So a file that
mixes two accounts is refused when the mixed rows name different instruments and **accepted** when
they name the same one — and the accepted case is the one that also adds the two accounts'
quantities together.

### Repro

```sh
D=/tmp/.../scratchpad/qa-upload
printf 'Symbol,Quantity,Account\nAAPL,10,111-AAA\nAAPL,20,222-BBB\n'  > $D/acctmix.csv
printf 'Symbol,Quantity,Account\nAAPL,10,111-AAA\nMSFT,20,222-BBB\n'  > $D/acctmix2.csv

# Account 2 = "Empower 401(k)", external_account_number is NULL on a fresh seed.
bash $D/up.sh  $D/acctmix2.csv 2        # -> /upload/N/columns
bash $D/map.sh N 0 Symbol Quantity __none__ __none__ __none__ Account
curl -s --noproxy '*' -X POST http://localhost:5181/upload/N/review \
  --data-urlencode accountId=2 --data-urlencode asOf=2026-07-31 --data-urlencode confirmRemovals=true

bash $D/up.sh  $D/acctmix.csv 2         # the same file, but both rows say AAPL
bash $D/map.sh N2 0 Symbol Quantity __none__ __none__ __none__ Account
curl -s --noproxy '*' -i -X POST http://localhost:5181/upload/N2/review \
  --data-urlencode accountId=2 --data-urlencode asOf=2026-07-31 --data-urlencode confirmRemovals=true
```

### Observed

`acctmix2.csv` (different instruments) — refused, correctly:

```
FORM-ERROR: This file says it describes account "111-AAA" on one row and "222-BBB" on another,
and a statement describes one account. Check which account this export belongs to — nothing was recorded.
```

`acctmix.csv` (same instrument) — **committed**. Review screen says only:

```
Added
AAPL  Apple Inc.  Equity · 2 rows combined
30    —    $5,504.13
```

```
HTTP/1.1 302
location: /accounts/2?uploaded=125
```

```
$ psql -h 127.0.0.1 -p 55432 -U portfolio -d qa1 -c "select a.external_account_number, i.symbol, h.quantity
  from holding h join position_set ps on ps.id=h.position_set_id join account a on a.id=ps.account_id
  join instrument i on i.id=h.instrument_id where ps.account_id=2 order by ps.id desc limit 1;"
 external_account_number | symbol |  quantity
-------------------------+--------+-------------
 111-AAA                 | AAPL   | 30.00000000
```

10 units of account 111-AAA plus 20 units of account 222-BBB became 30 units in *one* account, and
`111-AAA` was captured onto the account as its number. Nothing on any screen mentions the second
account number.

### Expected

The same refusal the different-instrument case gets. The account-number disagreement is a property
of the *file's rows*, so it must be evaluated before (or independently of) duplicate-row combining.

### Cause

- `app/lib/statement.ts:574` — the combined group keeps `first.accountNumber` and discards the rest.
- `app/lib/uploads.server.ts:704` — the spelling fold does the same (`group.find(... !== null)`).
- `app/lib/uploads.server.ts:974-985` — the guard reads `rows`, which by then holds one account
  number per *instrument*, not one per *file row*.

Spec 0004 ("The account number is a guard, not an auto-selector") and DESIGN.md §5.1 make this the
collision first-class accounts exist to avoid.

---

## 2. A NUL byte anywhere in the instrument column crashes the columns step with a 500

**Severity: High** (500 + stack trace from an ordinary file drop; the flow is dead for that file)

`parseUploadForm` validates the bytes with `new TextDecoder("utf-8", { fatal: true })`. `U+0000` is
valid UTF-8, so the file is accepted; `csv.ts` deliberately never throws on content and keeps the NUL
in the cell; the string then goes into a Postgres `text` parameter, which cannot hold `0x00`.

### Repro

```sh
D=/tmp/.../scratchpad/qa-upload
python3 -c "open('$D/nul.csv','wb').write(b'Symbol,Quantity\nAA\x00PL,10\n')"
bash $D/up.sh  $D/nul.csv 1       # -> 302 /upload/1/columns   (accepted)
bash $D/map.sh 1 0 Symbol Quantity
```

### Observed

```
STATUS=302 LOC=/upload/1/columns
STATUS=500 LOC=
```

`scratchpad/qa1.log:210`:

```
error: invalid byte sequence for encoding "UTF8": 0x00
    ...
    at unresolvedStrings (/home/user/portfolio/app/lib/instrument-resolution.server.ts:59:16)
    at rememberMapping (/home/user/portfolio/app/lib/uploads.server.ts:386:7)
    at action (/home/user/portfolio/app/routes/upload/columns.tsx:242:21)
  code: '22021'
```

The GET of `/upload/1/columns` also renders the raw NUL into the HTML document.

### Expected

Either the upload is refused with the same sentence a non-text file gets ("This does not read as a
text file…"), or the cell is refused as a parse problem naming its row. `csv.ts`'s own docstring
promises "the refusal a reader eventually sees is a sentence about their statement — never a stack
trace from in here".

### Cause

`app/lib/uploads.server.ts:178-186` — the fatal-UTF-8 check does not reject C0 control bytes;
`app/lib/instrument-resolution.server.ts:59-63` is where it reaches the driver.

---

## 3. An instrument cell longer than ~2 700 bytes crashes the instruments step with a 500 (btree index limit)

**Severity: High** (500; unrecoverable for that file, and reachable from a merely malformed export)

`instrument_alias.raw_string` is the table's primary key, so the string has to fit a btree index
entry (2 704 bytes). Nothing in the parser or in `resolveAll` bounds the raw string's length.
This is reachable from a real accident: an unterminated quote makes `csv.ts` swallow the rest of the
file into one cell (documented, intentional), so a mangled export produces exactly this shape.

### Repro

```sh
D=/tmp/.../scratchpad/qa-upload
python3 - <<'PY'
import random, string
random.seed(7)
d='/tmp/.../scratchpad/qa-upload'
s=''.join(random.choice(string.ascii_letters+string.digits+' ') for _ in range(3000))
open(d+'/longsym.csv','w').write('Symbol,Quantity\n"%s",10\n' % s)
open(d+'/longsym.txt','w').write(s)
PY
bash $D/up.sh  $D/longsym.csv 1       # -> 302 /upload/2/columns
bash $D/map.sh 2 0 Symbol Quantity    # -> 302 /upload/2/instruments   (fine so far)

python3 -c "
import urllib.parse
raw=open('$D/longsym.txt').read()
open('$D/body.txt','w').write(urllib.parse.urlencode({'raw-0':raw,'kind-0':'existing','instrumentId-0':'6'}))"
curl -s --noproxy '*' -o /dev/null -w '%{http_code}\n' -X POST \
  http://localhost:5181/upload/2/instruments \
  -H 'Content-Type: application/x-www-form-urlencoded' --data-binary @$D/body.txt
```

(The same POST is what the real page's form sends — the 3 000-character string is rendered into the
hidden `raw-0` field and into the visible `<h3 class="resolve-raw">`.)

### Observed

```
500
```

`scratchpad/qa1.log:249`:

```
error: index row size 3016 exceeds btree version 4 maximum 2704 for index "instrument_alias_pkey"
```

A 2 MB single cell fails the same way (`index row requires 22912 bytes, maximum size is 8191`, after
TOAST compression).

### Expected

A bound on the raw instrument string, refused at parse time with a sentence naming the row —
consistent with how the parser refuses an oversized quantity ("Line N's quantity is larger than this
application can store").

### Cause

`app/lib/instrument-resolution.server.ts:643-648` (the alias insert); no length check exists in
`app/lib/statement.ts`'s row loop or in `resolveAll`'s validation block
(`instrument-resolution.server.ts:309-426`, which bounds `symbol` to 40 and `name` to 200 but never
the raw string).

---

## 4. More than 65 535 distinct instrument strings in one file crashes the columns step with a 500

**Severity: Medium** (500 on a file well inside the app's own 10 MB cap; nothing written, but the
reader is stuck with an unexplained error page)

`unresolvedStrings` puts every distinct string into one `where raw_string in (…)`, one bind parameter
each. Postgres's extended protocol carries a 16-bit parameter count.

### Repro

```sh
D=/tmp/.../scratchpad/qa-upload
python3 -c "
with open('$D/many.csv','w') as f:
    f.write('Symbol,Quantity\n')
    for i in range(70000): f.write('SYM%06d,1\n'%i)"
ls -l $D/many.csv          # 840016 bytes — 0.8 MB, cap is 10 MB
bash $D/up.sh  $D/many.csv 1
bash $D/map.sh 3 0 Symbol Quantity
```

### Observed

```
STATUS=302 LOC=/upload/3/columns
STATUS=500 LOC=
```

`scratchpad/qa1.log:289`:

```
error: bind message has 4464 parameter formats but 0 parameters
    at unresolvedStrings (/home/user/portfolio/app/lib/instrument-resolution.server.ts:59:16)
```

(4464 = 70000 mod 65536 — the count wrapped.)

### Expected

Either the lookup is chunked, or the file is refused with a sentence about how many positions a
statement may hold. Note the sibling limit: the commit's single `insert into holding … values (…)`
would hit the same 65 535-parameter ceiling at ~16 383 holdings
(`app/lib/uploads.server.ts:1062-1077`), though that is not reachable without resolving that many
strings first.

### Cause

`app/lib/instrument-resolution.server.ts:59-63`.

---

## 5. Any id-shaped URL segment or form field accepts an arbitrarily long digit string and 500s on bigint overflow

**Severity: Medium** (500 + stack trace; would be High by the crash rule, but it needs a hand-edited
URL or a forged form, and nothing is written)

`findDraft` explicitly guards `/^\d+$/` for this exact reason — its comment reads *"`abc` would fail
as a malformed bigint in the driver, which is a 500 wearing a bookmark"* — but the guard bounds the
*shape*, not the *magnitude*. The same omission repeats in `getAccount`, and in the instruments
step's `instrumentId-N` and `classificationId-N`.

### Repro

```sh
BIG=99999999999999999999   # 20 digits; bigint max is 19
for u in /upload/$BIG /upload/$BIG/columns /upload/$BIG/instruments /upload/$BIG/review; do
  printf '%-46s ' "$u"; curl -s --noproxy '*' -o /dev/null -w '%{http_code}\n' "http://localhost:5181$u"
done
curl -s --noproxy '*' -o /dev/null -w 'POST /upload accountId=%{http_code}\n' \
  -X POST http://localhost:5181/upload -F "accountId=$BIG" -F "file=@$D/simple.csv"

# and, on a draft sitting at the instruments step:
curl -s --noproxy '*' -o /dev/null -w '%{http_code}\n' -X POST http://localhost:5181/upload/16/instruments \
  --data-urlencode 'raw-0=NEWTHING1' --data-urlencode 'kind-0=existing' --data-urlencode "instrumentId-0=$BIG"
curl -s --noproxy '*' -o /dev/null -w '%{http_code}\n' -X POST http://localhost:5181/upload/16/instruments \
  --data-urlencode 'raw-0=NEWTHING1' --data-urlencode 'kind-0=create' --data-urlencode 'name-0=T' \
  --data-urlencode 'priceSource-0=manual' --data-urlencode "classificationId-0=$BIG"
```

### Observed

```
/upload/99999999999999999999                   500
/upload/99999999999999999999/columns           500
/upload/99999999999999999999/instruments       500
/upload/99999999999999999999/review            500
POST /upload accountId=500
```

`scratchpad/qa1.log:15, 54, 93, 132, 171`:

```
error: value "99999999999999999999" is out of range for type bigint
    at findDraft (/home/user/portfolio/app/lib/uploads.server.ts:257:15)
    at requireDraft (/home/user/portfolio/app/lib/uploads.server.ts:303:15)
...
    at getAccount (/home/user/portfolio/app/lib/accounts.server.ts:174:15)
    at createDraft (/home/user/portfolio/app/lib/uploads.server.ts:209:19)
```

Every other malformed draft id behaves correctly (`abc`, `0`, `-1`, `../../etc/passwd`,
`1%20or%201%3D1`, `1;drop`, a 300-digit id → all 404; `01` → 200, correctly resolving to draft 1).

### Expected

404 (the expired-or-recorded page) for an id outside bigint, exactly as for `abc`.

### Cause

- `app/lib/uploads.server.ts:255` — `/^\d+$/` with no length/magnitude bound.
- `app/lib/accounts.server.ts:168` (`getAccount`), reached from `uploads.server.ts:209`.
- `app/lib/instrument-resolution.server.ts:323` and `:402` — the same `/^\d+$/` shape check.
- `app/lib/uploads.server.ts:1143` (`uploadReceipt`) has the same pattern, but survives because
  `lastRecorded` is queried first with a bounded id.

---

## 6. Rows the parser drops for a blank instrument cell are never reported, even when the row states a real quantity

**Severity: Medium** (silent data loss on the one screen whose entire job is to make loss visible)

`parseStatement` reports a row it skipped for an absent *quantity* ("Line 7's 'Cash & Cash
Investments' states no quantity, so it is not part of this statement"). A row skipped for an absent
*instrument* is `continue`d with no record at all — even when its quantity column holds a number.
Combined with §5.2's "a missing row means sold", a ragged or partly-blank export can silently sell a
position while the review screen shows a clean diff.

### Repro

```sh
D=/tmp/.../scratchpad/qa-upload
printf 'Symbol,Description,Quantity\n,Vanguard Mystery Fund,100\nVTI,Vanguard Total Stock,10\n" ",Padded Blank,55\n' \
  > $D/blankinst.csv
bash $D/up.sh  $D/blankinst.csv 4
bash $D/map.sh N 0 Symbol Quantity Description
curl -s --noproxy '*' http://localhost:5181/upload/N/review | python3 $D/txt.py
```

### Observed

The file states three data rows totalling 165 units. The review screen prints:

```
What this statement changes
1 ADDED · 0 UPDATED · 3 REMOVED   blankinst.csv · Principal 401(k)
Added
  VTI  Vanguard Total Stock Market ETF  Equity     10   —   $2,976.20
Removed
  PTTRX …          3,336.670003
  Principal LifeTime 2045 Collective Investment Trust  1,450
  PRGFX …            674.109964
```

Rows 2 and 4 (100 units of "Vanguard Mystery Fund" and 55 units of "Padded Blank") are gone with no
mention anywhere on the screen.

### Expected

Either the same `SkippedRow` treatment the absent-quantity case gets ("Line 2 states no instrument,
so it is not part of this statement"), or a refusal. The asymmetry is the problem: one kind of
dropped row is named and the other is not.

### Cause

`app/lib/statement.ts:394` — `if (instrument.trim() === "") continue;` with no `skipped.push`.
(The intent — "a row whose instrument cell is blank is a footer or spacer" — is right; the gap is
that a blank instrument *with a quantity* is not a footer and is not reported.)

---

## 7. A mis-sniffed delimiter is a dead end — the columns screen offers no delimiter control

**Severity: Medium** (feature broken for the affected file; no recovery from anywhere in the app)

`readCsv` sniffs between `,`, `;` and tab, and the mapping records the verdict — but nothing in the
UI can override it. The columns screen has a "Re-read with this header row" control and no
equivalent for the delimiter, so a file the sniff reads wrong can never be uploaded. The sniff
prefers "a delimiter that splits something" over one that does not, so a file whose *preamble* is
more consistently split by `;` than its data rows are by `,` loses.

### Repro

```sh
D=/tmp/.../scratchpad/qa-upload
printf 'Report; Positions\nAccount; Individual\nBroker; Example Brokerage\nAs of; 2026-07-31\nSymbol,Quantity,Price\nAAPL,50,229.35\nVTI,120,282.10\n' \
  > $D/sniff.csv
bash $D/up.sh $D/sniff.csv 4
curl -s --noproxy '*' "http://localhost:5181/upload/N/columns?header=4" \
  | grep -o '<option value="[^"]*"[^>]*>[^<]*</option>'
curl -s --noproxy '*' http://localhost:5181/upload/N/columns | grep -ci delimiter
```

### Observed

The file was read with `;`. The real header row is offered as a single column:

```
<option value="4">Row 5 — Symbol,Quantity,Price</option>
...
<option value="Symbol,Quantity,Price">Symbol,Quantity,Price</option>
```

Mapping instrument and quantity to the only column available is refused (correctly):

```
FIELD-ERROR: "Symbol,Quantity,Price" is already mapped to Instrument, and one column cannot
also be the quantity.
```

`grep -ci delimiter` on the columns page → `0`. There is no way forward.

### Expected

A delimiter select beside the header-row select (the mapping JSON already carries a `delimiter`
field and `readCsv` already accepts a forced one, so the plumbing exists), or at minimum a message
saying which delimiter was chosen.

### Cause

`app/lib/csv.ts:135` (the sniff), `app/routes/upload/columns.tsx:370-386` (only a header-row form),
`app/lib/column-mapping.server.ts:202-206` (`parseMappingForm` takes the delimiter from the sniff
rather than from the form).

---

## 8. `DD/MM/YYYY` as-of dates are silently read as `MM/DD/YYYY`, and the screen offers no way to correct the date

**Severity: Medium** (wrong `as_of_date`, silently, with no override)

`isoAsOf` rewrites the US shape only. A European export's `06/07/2026` (7 June) becomes 2026-06-07;
the same file's `31/07/2026` becomes `2026-31-07` and is refused. So roughly half of a European
file's dates fail loudly and the other half are quietly wrong. When the file dates itself, the
review screen deliberately renders no date control ("offering an editor here would invite overriding
a fact with an opinion"), so the reader cannot fix it.

### Repro

```sh
D=/tmp/.../scratchpad/qa-upload
printf 'Symbol,Quantity,AsOf\nAAPL,10,06/07/2026\n' > $D/dates_eu.csv
printf 'Symbol,Quantity,AsOf\nAAPL,10,31/07/2026\n' > $D/dates_eu2.csv
bash $D/up.sh $D/dates_eu.csv 1;  bash $D/map.sh N  0 Symbol Quantity __none__ __none__ AsOf
curl -s --noproxy '*' http://localhost:5181/upload/N/review | python3 $D/txt.py | grep -i "dates itself"
bash $D/up.sh $D/dates_eu2.csv 1; bash $D/map.sh N2 0 Symbol Quantity __none__ __none__ AsOf
```

### Observed

```
The statement dates itself: 2026-06-07 .
```

and for the day-31 file:

```
FIELD-ERROR: The as-of date is not a date on the calendar.
```

### Expected

Ambiguous `d/m/yyyy` should not be resolved silently. Options: refuse when the file's dates are
ambiguous and ask; infer from a day > 12 elsewhere in the file; or let the review screen override a
file-supplied date. Since the app ships a European fixture (`tests/fixtures/statements/semicolon.csv`
is a Dutch export) the case is in scope.

Related: 2-digit years are handled correctly — `07/31/26` is refused with
"The as-of date must be written as YYYY-MM-DD."

### Cause

`app/lib/statement.ts:272-276` (`isoAsOf`), `app/routes/upload/review.tsx:350-355` (no control when
the file dates itself).

---

## 9. Duplicate instrument symbols can be created from the resolution screen with no warning, and there is no UI to undo it

**Severity: Medium** (permanent bad vocabulary; recoverable only with `psql`)

`instrument.symbol` has a non-unique index. `resolveAll` validates the symbol's *length* but never
checks whether the ticker already exists, and the screen shows no warning. Two strings in one submit
can even create two more rows for the same ticker at once. Spec 0004 puts Settings → Instruments
explicitly out of scope, so nothing in the application can delete or merge the duplicates afterwards.

### Repro

```sh
D=/tmp/.../scratchpad/qa-upload
printf 'Symbol,Quantity,Basis\nZZZZFAKE,10,1.00\nAAPL_DUP,5,2.00\n' > $D/newinst.csv
bash $D/up.sh  $D/newinst.csv 4
bash $D/map.sh N 0 Symbol Quantity __none__ Basis
curl -s --noproxy '*' -o /dev/null -w '%{http_code}\n' -X POST http://localhost:5181/upload/N/instruments \
 --data-urlencode 'raw-0=ZZZZFAKE'  --data-urlencode 'kind-0=create' --data-urlencode 'symbol-0=AAPL' \
 --data-urlencode 'name-0=Apple Inc. (duplicate)' --data-urlencode 'priceSource-0=manual' --data-urlencode 'classificationId-0=7' \
 --data-urlencode 'raw-1=AAPL_DUP'  --data-urlencode 'kind-1=create' --data-urlencode 'symbol-1=AAPL' \
 --data-urlencode 'name-1=Apple Inc. (another)' --data-urlencode 'priceSource-1=feed' --data-urlencode 'classificationId-1=7'
```

(Every value above is one the real form posts — the symbol and name are free-text boxes.)

### Observed

```
302
 id | symbol |          name          | price_source
----+--------+------------------------+--------------
  6 | AAPL   | Apple Inc.             | feed
 18 | AAPL   | Apple Inc. (duplicate) | manual
 19 | AAPL   | Apple Inc. (another)   | feed
```

Three instruments now carry the ticker AAPL; two of them are quoted by the feed. Holdings and
Analysis will list AAPL twice, and nothing in the app can remove either row.

### Expected

At least a field-level warning ("AAPL is already listed as Apple Inc. — did you mean to point at
it?"), given that the screen's other branch exists precisely to point at an existing instrument.

**Secondary observation (not asserted as a defect):** `manual` accepts a symbol, while spec
`docs/specs/ingest/04-unresolved-instruments.md:13` describes the two shapes as "a symbol and a
feed, or no symbol and a manual". The wording on line 39 ("`manual` allows none") is ambiguous
enough that this may be intended.

### Cause

`app/lib/instrument-resolution.server.ts:332-371` (create-plan validation) and `:616-637` (the
insert) — no symbol-collision check.

---

## 10. The commit captures a file's account number without the 64-character bound the Settings form enforces, leaving the account's edit form permanently refusing to save

**Severity: Medium** (a write path bypasses its own validator and bricks an unrelated form)

`commitUpload` copies `fileAccountNumber` straight into `account.external_account_number` when the
column is empty. `accounts.server.ts` bounds the same field to 64 characters
(`optionalText("An account number", 64)`) for the Settings form. After an upload writes a longer
value, Settings → Accounts → Edit details refuses every save until the reader manually shortens a
field they never typed.

### Repro

```sh
D=/tmp/.../scratchpad/qa-upload
python3 -c "open('$D/longacct.csv','w').write('Symbol,Quantity,Account\nVTI,10,%s\n' % ('ACCT-'+'X'*200))"
# account 4 = Principal 401(k), external_account_number NULL on a fresh seed
bash $D/up.sh  $D/longacct.csv 4
bash $D/map.sh N 0 Symbol Quantity __none__ __none__ __none__ Account
curl -s --noproxy '*' -X POST http://localhost:5181/upload/N/review \
  --data-urlencode accountId=4 --data-urlencode asOf=2026-07-31 --data-urlencode confirmRemovals=true
psql -h 127.0.0.1 -p 55432 -U portfolio -d qa1 -tc \
  "select length(external_account_number) from account where id=4;"

NUM=$(psql -h 127.0.0.1 -p 55432 -U portfolio -d qa1 -tAc \
  "select external_account_number from account where id=4;")
curl -s --noproxy '*' -X POST http://localhost:5181/settings/accounts/4 \
  --data-urlencode intent=save --data-urlencode 'name=Principal 401(k)' --data-urlencode institution=Principal \
  --data-urlencode kind=401k --data-urlencode ownerId=2 --data-urlencode taxTreatment=tax_deferred \
  --data-urlencode "externalAccountNumber=$NUM"
```

### Observed

```
 205
FIELD-ERROR: An account number must be 64 characters or fewer.
```

The Settings form arrives prefilled with the 205-character value and refuses to save anything —
including a name change — until the reader deletes it. Nothing says where the value came from.

### Expected

The capture should run through the same bound (and truncate/refuse/report), or the commit should
refuse a file whose account-number column exceeds it.

### Cause

`app/lib/uploads.server.ts:1081-1088` (the capture) vs `app/lib/accounts.server.ts:96` (the bound).

---

## 11. `upload_draft.as_of_date` is never written — the statement date is not part of the draft, contrary to the spec, and is lost on reload

**Severity: Low** (dead column + minor UX; nothing incorrect is recorded)

Spec 0004 ("The draft table"): *"`as_of_date` and `mapping` are null until their step is passed,
which is what makes 'how far did this draft get' a property of the row rather than a status column"*,
and DESIGN.md §5.1 says the draft holds "the file's bytes, the chosen account and the half-finished
mapping" so "every step is a URL that survives a reload, the back button and a closed laptop".
The column exists in `migrations/0004_upload_draft.sql`, but nothing ever writes it — the
implementation uses `mapping` + `had_first_sightings` instead.

### Repro

```sh
# run any number of drafts through columns / instruments, then:
psql -h 127.0.0.1 -p 55432 -U portfolio -d qa1 -c \
  "select id, as_of_date, (mapping is not null) as has_mapping, had_first_sightings from upload_draft order by id;"
grep -n "as_of_date" /home/user/portfolio/app/lib/uploads.server.ts
```

### Observed

```
 id | as_of_date | has_mapping | had_first_sightings
----+------------+-------------+---------------------
  1 |            | f           |
  2 |            | t           | t
  5 |            | t           | f
  7 |            | t           | f
  9 |            | t           | t
```

`as_of_date` is null on every draft at every step. The only `as_of_date` writes in
`uploads.server.ts` are to `position_set` (line 1054). Consequently the review screen's date box is
re-defaulted to today on every GET:

```
id="review-as-of" type="date" max="2026-08-26" name="asOf" value="2026-08-25"
```

so a typed statement date does not survive a reload of `/upload/:id/review`.

### Expected

Either the column is written when the review date is chosen, or the spec and the migration comment
are amended to say the draft does not carry a date.

---

## 12. A draft whose account closes underneath it shows the generic "expired or was already recorded" page, never the closed-account sentence the code and spec promise

**Severity: Low** (wrong message; the refusal itself is correct and nothing is written)

`commitUpload` opens with a deliberate, documented refusal for a closed account, "in `setBalance`'s
words". It is unreachable from the UI: the review action returns the `ValidationError` as data, but
React Router then re-runs the route's loader, whose `diffForDraft` → `requireDraft` treats a closed
account's draft as expired and throws a 404 — so the 404 page wins.

### Repro

```sh
D=/tmp/.../scratchpad/qa-upload
bash $D/up.sh  $D/simple.csv 4
bash $D/map.sh N 0 Symbol Quantity __none__ Basis          # -> /upload/N/review
psql -h 127.0.0.1 -p 55432 -U portfolio -d qa1 -tc "update account set closed_at=now() where id=4;"
curl -s --noproxy '*' -o /dev/null -w 'GET  review=%{http_code}\n'  http://localhost:5181/upload/N/review
curl -s --noproxy '*' -w '\nPOST commit=%{http_code}\n' -X POST http://localhost:5181/upload/N/review \
  --data-urlencode accountId=4 --data-urlencode asOf=2026-07-31 --data-urlencode confirmRemovals=true
psql -h 127.0.0.1 -p 55432 -U portfolio -d qa1 -tc "update account set closed_at=null where id=4;"
```

### Observed

```
GET  review=404
POST commit=404
```

and the rendered page reads "This upload has expired or was already recorded." — never
"Principal 401(k) is closed, and a closed account's history does not change. Reopen it from
Settings if this statement is still real."

Nothing was written (`select count(*) from position_set where account_id=4 and source_filename='simple.csv'`
→ 0), so this is a wording defect only.

### Cause

`app/lib/uploads.server.ts:951-956` (the intended sentence) vs `:307` (`requireDraft` treats a
closed account as expired) reached from `diffForDraft` in the loader,
`app/routes/upload/review.tsx:35-37`.

---

## 13. The size cap is measured on the whole request body, so a file at the advertised limit is refused with a form-level error

**Severity: Low** (message/limit mismatch)

`refuseOversizedBody` compares `Content-Length` — which includes the multipart envelope — against
`MAX_UPLOAD_MB * 1 048 576`, so the effective file limit is a few hundred bytes below what the
screen advertises ("Statements up to 10 MB"), and files at the boundary get the form-level message
rather than the field-level "This file is larger than 10 MB" that `File.size` would produce.

### Repro

```sh
D=/tmp/.../scratchpad/qa-upload
python3 -c "
hdr=b'Symbol,Quantity\n'; row=b'AAPL,10\n'
n=(10*1024*1024-len(hdr)-100)//len(row)
open('$D/under.csv','wb').write(hdr+row*n)"           # 10,485,656 bytes < 10,485,760
bash $D/up.sh $D/under.csv 1
```

### Observed

```
-rw-r--r-- 1 root root 10485656 .../under.csv
STATUS=100 LOC=
FORM-ERROR: This upload is larger than 10 MB, which is the most a statement file can be.
```

A file 900 bytes smaller (10 484 760) is accepted.

### Expected

Either the note under the file input reflects the real ceiling, or the header check allows a small
envelope allowance so the `File.size` check is the one that decides.

### Cause

`app/lib/uploads.server.ts:121-130` and `app/routes/upload.tsx:168-170`.

---

## 14. A malformed multipart body 500s with a raw `TypeError` instead of a refusal

**Severity: Low** (needs a hand-crafted request; no data impact)

`/upload` is the app's only multipart route. `request.formData()` throws a `TypeError` on a body it
cannot parse, and the action only catches `ValidationError` and `NotFoundError`.

### Repro

```sh
curl -s --noproxy '*' -o /dev/null -w '%{http_code}\n' -X POST http://localhost:5181/upload \
  -H 'Content-Type: multipart/form-data; boundary=XYZ' --data-binary 'this is not multipart at all'

curl -s --noproxy '*' -o /dev/null -w '%{http_code}\n' -X POST http://localhost:5181/upload \
  -H 'Content-Type: multipart/form-data; boundary=XYZ' --data-binary '--XYZ
Content-Disposition: form-data; name="file"; filename="a.csv"

Symbol,Quantity'

curl -s --noproxy '*' -o /dev/null -w '%{http_code}\n' -X POST http://localhost:5181/upload \
  -H 'Content-Type:' --data-binary 'x=1'
```

### Observed

`500` for all three. `scratchpad/qa1.log:329`:

```
TypeError: Failed to parse body as FormData.
  [cause]: TypeError: no boundary found in multipart body
...
  [cause]: TypeError: expected CRLF
...
TypeError: Content-Type was not one of "multipart/form-data" or "application/x-www-form-urlencoded".
```

### Expected

A 400, or the same form-level refusal a missing file gets.

### Cause

`app/routes/upload.tsx:50` — `await request.formData()` inside the try, but the catch at `:59-71`
re-throws anything that is not a `ValidationError` / `NotFoundError`.

---

# Tried and did NOT break

Everything below was attacked and behaved correctly. Listed so the next person does not re-spend the
time.

**Double-counting (the project's headline claim).** Could not achieve it.
- Four *simultaneous* commit POSTs on one draft → exactly one 302 and three 404s, one `position_set`
  row, draft deleted. The transaction leads with `delete from upload_draft … where id = ?` and aborts
  on `numDeletedRows === 0` (`uploads.server.ts:1044-1048`).
- The same statement uploaded and committed three times (same account, same `as_of_date`) → three
  `position_set` rows, and `holding_valued` still returns exactly two holdings with the file's
  quantities. `latest_position_set` resolves one set; no summation anywhere.
- Browser: committing in tab 1 then in a second tab left open on the same review → tab 2 gets the
  expired-or-recorded page with the "See what the account holds now" link. Back button after a
  successful commit → same page, no re-POST.
- Re-POSTing a committed draft by curl → 404.

**Step gating.** On a draft with no mapping, `GET /upload/:id`, `/instruments`, `/review` and
`POST /review` all 302 to `/upload/:id/columns`. Nothing is committable out of order.

**Column-mapping form tampering.** Same column mapped to two targets → refused naming both;
a column name not in the header → refused; missing required columns → one message each;
`costBasisIs=lol` → refused; unknown extra fields (`evil=1`, `combineDuplicateRows=false`) ignored;
`headerRow=99999999999999999999` → the form-level "header row … is not in the file".

**Instrument-resolution form tampering.** A stale `raw-N` hidden field → "The file's first sightings
changed while this page was open"; one of two strings left unresolved → field-level refusal and
**nothing** written (`select count(*) from instrument_alias where raw_string like 'NEWTHING%'` → 0);
a nonexistent `instrumentId` / `classificationId` → sentence, not a foreign-key fault.

**Commit-time guards.** Product guard (`quantity=999999999999`, `basis=9999999999999999`) → refused
naming the instrument, nothing written. Account-number disagreement across *different* instruments →
refused. Account number recorded on the account vs a different one in the file → refused. Posted
`accountId` disagreeing with the draft's → refused. Majority-removal tick → refused unticked, in the
ratio's words. Closed account → nothing written.

**CSV reader tolerance.** BOM, CRLF, bare CR, quoted fields containing delimiters/newlines/doubled
quotes, ragged rows, blank rows, preamble, footer disclaimers, a semicolon export, a duplicated
header name (resolves to the first occurrence, as documented), blank and whitespace-only header
cells (excluded from the selects, mappable columns unaffected), 5 000 columns, a header-only file
(refused with "No row in this file has anything under …"), an empty file, a UTF-16 file, invalid
UTF-8, a PNG and a ZIP renamed `.csv` (all "This does not read as a text file"), no file, an empty
filename, no `accountId`, a non-numeric `accountId`.

**Number normalisation** (`normaliseFigure`, checked directly and through the flow). Refused:
`1e400`, `1e5`, `Infinity`, `NaN`, `1.234,56`, `1,23,456`, `12$34`, `(-1)`, `.`, `5−`, `1_000`,
`٣`, `１２３`. Accepted correctly: `(1,234.56)` → `-1234.56`, `$1,234.56`, `−5` (U+2212), `+5`,
`- 5`, `$ 5`, `1 234.56` (NBSP/thin space), `.5`, `5.`, `-0` → `0`, `12.5%` → `12.5` (documented).
Over-precision refused rather than rounded: 9 decimal places on a quantity, >4 on money, >12
integer digits on a quantity.

**Money exactness.** No JS float reaches a stored figure in the ingest path (`grep` for
`Number(` / `parseFloat` / `toFixed` across `app/lib` finds only `format.ts`'s per-digit carry and
the documented `toPlotValue`). Verified end to end:
- lot-level combining: 100@95.10 + 200@110.25 + 112.5@123.40 → `412.5` units at `$110.1636`
  (exact: 45 442.5 / 412.5 = 110.16363636…, half-away-from-zero to 4 dp), reported as "3 rows combined".
- `costBasisIs=total` with a short position: Schwab fixture SCHD `-10` units, cost basis `($265.00)`
  → `-10` at `$26.5000`.
- `owedAsPositive` on the liability fixture → `quantity = -14500.00000000`, `as_of_date = 2026-07-31`,
  account number `4400-7788-1234` captured.
- The diff's JS `valueAt` mirrors Postgres's cast rounding: `cast(0.0000005*100.0000 as numeric(20,4))`
  → `0.0001`, `cast(-0.00015 as numeric(20,4))` → `-0.0002`, both half away from zero.

**Header fingerprint.** Initially suspected `join("")`; hex dump of
`app/lib/column-mapping.server.ts:50` shows `join("\037")` — U+001F, exactly as specified. No
collision: `["Symbol","Quantity"]` and `["SymbolQuant","ity"]` hash differently. **Not a bug.**

**Draft lifecycle.** The 24-hour sweep fires on the next `POST /upload` and deletes only drafts older
than 24 h (verified by back-dating `created_at` and watching one row disappear while the rest
survived); the swept draft then 404s. Going back to columns from review and re-mapping works and
re-runs the whole downstream chain. `/upload/01/columns` correctly resolves to draft 1.

**Injection / XSS.** A filename of `../../<img src=x onerror=alert(1)>.csv` is stored verbatim in
`upload_draft.filename` and rendered escaped (`&lt;img …`); zero raw `<img src=x` in the response.
An instrument cell of `<script>alert(1)</script>` renders escaped on the resolution screen. Draft ids
of `1;drop`, `1%20or%201%3D1`, `../../etc/passwd` all 404.

**Size cap.** A 12 MB body sent with `Transfer-Encoding: chunked` and no `Content-Length` correctly
falls through the header check to the `File.size` check and is refused with the field-level message —
the documented "guarded twice" behaviour works.

**Playwright.** Full interactive flow (pick account → drop file → map columns → resolve → tick the
removal confirmation → record) works with no page errors; a suspected "stale DOM after commit" was a
harness race in my own script, not a defect (a direct load of `/accounts/:id?uploaded=:setId` renders
the receipt correctly, and a slower settle in the browser flow does too).

---

# Documented limitations, not bugs

- **A file whose rows are all skipped can commit an empty statement that sells everything.**
  `unterm.csv` (unterminated quote) collapses into one skipped row, so the review reads
  "0 ADDED · 0 UPDATED · 7 REMOVED" and "This file removes every position this account holds — all 7."
  This is exactly the safety valve DESIGN.md §5.2 and spec 0004 describe (every removal listed in
  full, plus a mandatory tick), and `rememberMapping` deliberately allows "all rows skipped"
  ("the review screen owns what an empty statement means", `uploads.server.ts:370-380`).
- **A duplicated header name resolves to its first occurrence.** Stated in `csv.ts`'s
  `headerRowChoices` docstring and in spec 0004 ("Columns are named, not indexed").
- **Byte-exact alias lookup**, so ` AAPL` and `AAPL` are two first sightings. `instrument_alias.raw_string`
  is `collate "C"` for exactly this reason (spec 0004, "Resolution, and the guard that has to run here").
- **`combineDuplicateRows` is not a control on the screen** and is hard-coded `true`
  (`column-mapping.server.ts:244`, with the reason given).
- **The account-number guard fires at commit, not on the review screen.** Spec 0004: "caught at the
  moment it would happen".
- **No Settings → Instruments screen** (alias editing, manual prices, deleting an instrument) — spec
  0004 "Out of Scope". This is what makes finding 9 unrecoverable rather than merely annoying.
- **No deletion of a position set and no re-parse from `raw_file`** — DESIGN.md §5.2 / spec 0004
  "Out of Scope". So a committed statement cannot be undone from the application either.
- **A second upload for a date that already has one is allowed**, resolved by
  `latest_position_set`'s `created_at`-then-`id` tie-break (`uploads.server.ts:931-934`).
- **`12.5%` normalises to `12.5` unscaled** — "what a percent *means* is the caller's question"
  (`money.ts`).
- **Non-USD instruments are refused at creation** (DESIGN.md §14.6); the probe is non-blocking on a
  provider failure, and the created instrument gets `quote_type = null` — both as specified.
- **Mobile.** The mapping table is wide and no mobile layout is designed for it (spec 0004, "Mobile").
