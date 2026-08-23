# Recording your first statement

Take a brokerage statement from a download to a recorded set of holdings, in four steps.

Before you start:

- **Export the CSV version** of the statement from your brokerage. A `.csv` file is the only thing
  the upload accepts — not OFX, QIF, XLSX or PDF — and there is no way to link a bank or brokerage
  directly. If you hand it something else, it refuses with *"This does not read as a text file.
  Export the CSV version of the statement and upload that instead."*
- **Bank accounts and loans are not recorded this way.** They are one number rather than a list of
  positions, so you type the balance on the account's own page instead — see
  [Account detail](account-detail.md).
- **There is a size limit**, set by whoever runs the instance. The upload screen prints the current
  one under the file box.

Nothing is written to your data until the fourth step. A column read wrongly on step two costs you
nothing but the walk back.

## Step 1 — Account and file

Select **Upload statement** from the navigation.

![Step one: choosing the account and the file](images/upload-1-account-and-file.png)

Choose the **Account** this statement describes, choose the **Statement file**, then select
**Continue to columns**.

Only open accounts are listed. If an account you expect is missing, it has been closed — see
[People and accounts](people-and-accounts.md#correcting-or-retiring-an-account).

The strip under the title shows all four steps throughout, so you can always see where you are.

## Step 2 — Columns

This is where you tell the app which column in the file is which.

![Step two, before anything is mapped](images/upload-2-columns-blank.png)

The table in the middle is your file's own header row and its first three rows of data, printed
exactly as the file wrote them — dollar signs, commas and all. **Map by looking at those values**,
not by guessing from the column names.

Work down the selects:

- **Instrument** and **Quantity** are required.
- **Name**, **Cost basis**, **As-of date** and **Account number** are optional. Each offers
  **Not in this file** — choose that rather than leaving it unanswered, so the app knows you meant
  it.
- **Cost basis is** — per share, or total for the position. It only matters when you have mapped a
  cost basis column.
- The checkbox about a file listing what is **owed** as a positive number is there for files that
  state a debt without a minus sign. Leave it alone for a brokerage.

![Step two with every column mapped](images/upload-2-columns-mapped.png)

If the header does not sit on the first row, pick the right one under **Header row** and select
**Re-read with this header row** before mapping.

Select **Save mapping and continue**.

**You only do this once per institution.** The mapping is remembered against the shape of the file's
header row, so the next export from the same brokerage arrives with every select already filled in
and a line saying where those choices came from. It is still shown to you every time, never applied
silently — that is how a changed export gets noticed. Check the choices against the sample rows and
continue.

The full reference for what each column may contain, and what the app does with awkward files, is in
[the CSV reference](upload.md).

## Step 3 — New instruments

This step only appears when the file names something the app has never seen before. If everything in
the file is already known, you go straight to the review and the strip dims this entry with
**· none**.

![Step three: resolving a name the file uses for the first time](images/upload-3-instruments.png)

The screen says how many of the file's holdings are new, then asks one question about each, showing
the name exactly as the file wrote it. Answer either:

- **This is an instrument already listed** — pick it from the **Instrument** list. Use this when your
  brokerage writes a name differently from another one you already hold.
- **This is new** — give it a **Symbol** (leave empty if it has no public ticker), a **Name**, a
  **Price source** (Feed, or a manual price you type from the statement and that carries forward
  until you change it) and a **Classification**. Choosing **New classification…** lets you name one
  and give it an asset class.

Select **Save and continue**.

Answering here writes down vocabulary — that this name means this instrument — and nothing else.
The statement is still not recorded. The answer is remembered forever, so the same brokerage's next
export passes through this step without asking.

## Step 4 — Review, then record

The last step shows exactly what recording this file will do, before it does it.

![Step four: the diff, with one position added, one updated and one removed](images/upload-4-review.png)

The heading counts the changes — `1 ADDED · 1 UPDATED · 1 REMOVED` — and the table below lists them
in those three groups. An updated row prints the old figure in grey, an arrow, then the figure that
will be true. Rows that are not changing are not listed; the line above the table counts them.

For the very first statement in an account there is nothing to compare against, so the count reads
just `14 ADDED` and a line says why.

### Read the removals

**A statement is one photograph of the whole account.** Anything the account holds that is not in
this file is treated as sold. That is what makes a partial or filtered export dangerous: a file
listing 2 of your 30 positions is a perfectly valid statement that sells the other 28.

So every removal is listed individually, with its quantity and last known value, never as a count.
Read that group before you record anything.

If a file removes **more than half** of what the account holds, you cannot record it without ticking
a sentence that states the ratio — *"This file removes 18 of the 30 positions this account holds."*
Ticking it is you saying that is what really happened.

### The statement date

If the file dates itself, the screen says so and there is nothing to fill in. If it does not, a
**Statement date** box appears, starting at today. It does not accept a future date.

### Record it

Select **Record this statement**. You land on the account, with a confirmation of what was written.

If something looks wrong — every quantity a thousand times too large, the cost basis in the wrong
column — select **Back to columns**, fix the mapping, and come back. Nothing has been written, so
there is nothing to undo.

## Leaving an upload half-finished

Every step is a real address. Bookmark it, close the laptop, and open it again later: the app puts
you back at the step you got to. The back button and a reload both behave.

An unfinished upload is kept for 24 hours and then swept. A recorded one is cleared away as soon as
it lands. Either way, returning to the address afterwards gets you a page saying **This upload has
expired or was already recorded** and offering to start a new one. Nothing is lost — nothing was
written.

Why the flow is shaped this way is in
[Upload — a statement, mapped once and diffed before it lands](../../README.md#upload--a-statement-mapped-once-and-diffed-before-it-lands).

---

**Next:** [Account detail](account-detail.md) — one account end to end, and how to set a bank or loan
balance.
