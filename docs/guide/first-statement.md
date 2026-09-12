# Recording your first statement

Choose an open account and a UTF-8 CSV export. PDFs and spreadsheets are not accepted.
Bank and loan accounts also offer [Set balance](account-detail.md#set-balance) for a single amount.
Account positions change only when you record the statement; earlier steps can save mappings
and instrument names.

## Step 1 — Account and file

![Step one: choosing the account and the file](images/upload-1-account-and-file.png)

Open **Upload statement**, choose the account and file, then **Continue to columns**.
The file limit appears below the file box. Closed accounts are not offered.

## Step 2 — Columns

![Step two, before anything is mapped](images/upload-2-columns-blank.png)

![Step two with every column mapped](images/upload-2-columns-mapped.png)

Check the preview against your file. If needed, select the correct header row and press
**Re-read with this header row** before mapping.

- Map Instrument and Quantity to different columns.
- Map any optional columns you have. Choose **Not in this file** for absent ones.
- If mapping cost basis, choose per-share or total-position basis.
- Use the debt checkbox only when the file lists amounts owed as positive quantities.

Select **Save mapping and continue**. Mappings are remembered by institution and header shape,
but this screen remains visible on later uploads so you can check them. See the
[CSV reference](upload.md) for supported values.

## Step 3 — New instruments

![Step three: resolving a name the file uses for the first time](images/upload-3-instruments.png)

This step appears only for new instrument names. Otherwise the step strip shows **· none** and
takes you straight to review. Known instrument names use saved aliases. Resolve each new name by linking an existing instrument
or creating one with a classification and price source. A known non-USD quote is refused.

These instrument and alias choices are saved before the statement is committed. Once every name
is resolved, continue to review.

## Step 4 — Review, then record

![Step four: the diff, with one position added, one updated and one removed](images/upload-4-review.png)

Review additions, changed quantities or bases, and removals against the account’s current holdings.
A first statement has no earlier holdings to compare.

### Read the removals

A statement is the whole account snapshot. Any held instrument missing from the file is treated
as sold. Read every listed removal. Removing more than half the current positions requires an
explicit acknowledgement; a filtered export can otherwise remove holdings you meant to keep.

### The statement date

Use the file’s date when present. Otherwise enter the date at review. Dates after tomorrow are
refused; tomorrow accommodates households ahead of the server’s time zone.

### Record it

Select **Record this statement** to append the snapshot and open the account. Before committing,
you can return to Columns to fix a mapping. A dated upload may change historical values; an older
statement does not displace a newer current snapshot.

## Leaving an upload half-finished

The draft has a bookmarkable URL. Starting another upload removes unfinished drafts more than
24 hours old; there is no exact expiry timer. Commit removes its draft immediately. Saved
mappings and instrument vocabulary remain if a draft is abandoned or removed.

---

**Next:** [An account](account-detail.md) — the statement you just recorded, its holdings, and history.
