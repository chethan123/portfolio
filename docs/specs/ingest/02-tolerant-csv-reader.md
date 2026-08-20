# 02 — The reader that survives a real brokerage export

_Part of [0004-ingest.md](../0004-ingest.md)._

**What to build:** Two pure functions, no database anywhere near them. `app/lib/csv.ts` turns bytes
into rows of strings, tolerating what §5.3 says real exports contain. `app/lib/statement.ts` turns
those rows plus a mapping into parsed positions — and it is where every number is normalised to a
decimal string, never through `parseFloat`, because 0003 made "money arithmetic stays exactly one
module wide" a structural property rather than a comment.

The value of doing it here, in isolation, is that every awkward file in existence becomes a fixture
and a test rather than a bug found on the review screen with a household's real statement in hand.

**Blocked by:** Nothing. It touches no schema and no route.

**Status:** ready-for-agent

**Reading the file**

- [ ] A leading UTF-8 BOM is stripped and never reaches a cell
- [ ] CRLF, LF and bare CR line endings all parse
- [ ] RFC 4180 quoting: a quoted field may contain the delimiter, a newline, and a doubled quote
- [ ] The delimiter is sniffed between comma, semicolon and tab, by which one yields the most
      consistent column count across the file's rows — not by counting occurrences on line one
- [ ] Ragged rows are kept as they are, short or long, rather than padded or refused; the mapping
      step is what decides whether a row is usable
- [ ] Blank rows are preserved in the row list so `headerRow` stays a stable index into the file
- [ ] A trailing newline does not produce a final empty row
- [ ] The reader never throws on content; a file it cannot make sense of yields rows the caller
      judges, so the refusal carries a sentence about the statement rather than a stack trace

**Finding the header**

- [ ] `candidateHeaderRows` returns the plausible header rows in file order, so step 03 can offer
      them and default to one
- [ ] The default is the first row whose cells are non-empty, distinct, and whose count matches the
      majority column count of the rows below it — which is what skips a preamble of "Account
      Summary", a blank line and a date stamp
- [ ] A file whose every row is a preamble candidate still returns something, and step 03 lets the
      reader pick

**Normalising a number** (in `app/lib/money.ts`, beside the existing digit-level primitives)

- [ ] Thousands separators are removed; a decimal point is kept
- [ ] A leading currency symbol and surrounding whitespace are removed
- [ ] Parenthesised values are negative: `(1,234.56)` becomes `-1234.56`
- [ ] A trailing percent sign is removed and the value returned unscaled, with the caller deciding
      what a percent means
- [ ] A true minus (U+2212) is converted to a hyphen, matching what `signedQuantity` already does
- [ ] `n/a`, `N/A`, `--`, an em dash, `-` alone and the empty string all yield null — never zero.
      A null cost basis is 0001's deliberate "no default at any layer"; a zero would report a fake
      gain equal to the whole untracked position
- [ ] Anything else non-numeric yields null and is reported as unparseable, with the row and column,
      rather than being silently dropped
- [ ] No value passes through a JavaScript number at any point

**Applying a mapping**

- [ ] Required columns are `instrument` and `quantity`; a mapping missing either is refused
- [ ] A row whose instrument cell is empty is skipped as a footer or spacer, not refused
- [ ] A row with an instrument and an unparseable quantity is refused, naming the row — a disclaimer
      line that happens to sit under the symbol column must not become a position
- [ ] `costBasisIs: "total"` divides by the row's quantity at `numeric(20, 4)`'s scale; a zero
      quantity yields a null basis rather than a division fault
- [ ] `costBasisIs: "per_share"` passes the value through unchanged
- [ ] An unmapped cost basis column yields null for every row, which is the 401k case
- [ ] `owedAsPositive: true` negates every non-zero quantity; zero keeps no sign, because "−0.00" is
      a debt of nothing written as though it were something (`setBalance` says the same)
- [ ] `owedAsPositive: false` preserves the file's own sign, including a negative balance on a bank
      export
- [ ] Quantities are held to 8 decimal places and per-share amounts to 4, matching the columns, with
      anything finer refused rather than rounded

**Duplicate rows**

- [ ] Rows sharing an instrument string are combined: quantities summed, cost basis weighted by
      quantity, at the columns' scales
- [ ] The combination is reported on the parse result — instrument, how many rows, the combined
      quantity — so step 05 can print it as its own line rather than folding it into a count
- [ ] Rows that combine to a zero quantity keep a null cost basis rather than dividing by zero
- [ ] Combining is on the raw string as written, before alias resolution, so two spellings of one
      fund are two entries here and become one row in step 04's resolution

**The as-of date**

- [ ] With `asOf` mapped, the value is read from the first row carrying one and validated by
      `recordedDate`
- [ ] Rows carrying two different as-of dates refuse the file, naming both — never picking one
- [ ] With `asOf` unmapped, the parse result says so and step 05 asks for the date

**Fixtures** (`tests/fixtures/statements/`)

- [ ] A Fidelity-shaped export: preamble rows, a footer of disclaimers, quoted descriptions
      containing commas
- [ ] A Schwab-shaped export: dollar prefixes, parenthesised negatives, a `Cash & Cash Investments`
      row
- [ ] A 401k export: no cost basis column at all, one holding with no ticker
- [ ] A lot-level export: three rows for one fund with different bases
- [ ] A liability statement: a positive balance meant as a debt
- [ ] A semicolon-delimited, CRLF, BOM-prefixed file
