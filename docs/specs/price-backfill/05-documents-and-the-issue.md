# 05 — Documents and the issue

_Part of [0017-price-backfill.md](../0017-price-backfill.md)._

**What to build:** Nothing that runs. Every document that says the spine starts when the poller
first runs, that nothing backfills it, that a weekend costs no database traffic, or that the only
way to fill a gap is `psql`, is brought level with a system that backfills on every refresh. The
operator's recipe becomes a check rather than a procedure, the pricing spec's out-of-scope line gets
its **Reversed** banner, `docs/developing.md` gains the recipe for exercising a backfill and
re-running the split verification, and issue #83 is closed with the half this slice does not do
filed as its own issue.

Separate from the code tickets because a prose diff across this many files is reviewed by reading,
and because until [03](03-the-backfill-step-in-every-refresh.md) and
[04](04-settings-prices-gap-list.md) land these documents would describe an intention.

**Blocked by:** [03](03-the-backfill-step-in-every-refresh.md), [04](04-settings-prices-gap-list.md).

**Status:** ready-for-agent

**The design record** (`DESIGN.md`)

- [ ] §6.1: the `interface PriceProvider { getQuotes(...) }` block (`:413-419`) is printed as the
      whole interface and gains the second method, with its one-line comment in the same form
- [ ] §6.2: the spine paragraph gains the backfill — gap-triggered, on every refresh, insert where
      absent, un-adjusted for splits, ledgered — and "a missed day is a visible gap rather than a
      wrong close" gains its qualification: a hole is filled as a side effect when the instrument is
      backfilled for its head gap, and is never a trigger. Links ADR-0011 as the observation log
      links ADR-0006
- [ ] §7: "History starts at day zero" stays the rule for positions and says so; the price spine
      is no longer bound by it
- [ ] §8.4: the Prices row of the Settings table (`:721`) names the gap list beside the cadence,
      and its "while the market is open" becomes true of quotes only — the market-hours
      correction, not only the list
- [ ] §14: a new accepted limitation for ticker reuse — an instrument that changed symbols gets the
      current ticker's history, spot-checked against a statement — and a sentence under it that the
      chart still draws a partially-priced past date on the ordinary line, tracked by the follow-up
      issue below
- [ ] §10.1's "no separate worker service" paragraph does not change; the batch runs where the
      poller runs

**The architecture record** (`ARCHITECTURE.md`)

- [ ] §2: the outbound dependency on Yahoo is two endpoints now — quotes and the chart history — on
      the context diagram's edge label and in "External dependencies, in full"; the trust row
      (`:111`) covers the second payload the same way
- [ ] §4.2: the "Writing a price" row names the backfill's insert-where-absent as the second write
      path in the one module; the "Importing `yahoo-finance2`" row's line reference is re-checked;
      and the stated valuation exceptions (`:358-362`) gain two entries beside `priceFreshness`,
      in the same shape — `selectBackfillCandidates` (ticket 02) and `backfillGaps` (ticket 04)
      each hand-write the join over `holding` that `:372-376` warns about, to find an instrument's
      first-held date, and each computes no money
- [ ] §4.5: a new row in the write-paths table — backfill closes, `prices.server.ts` →
      `backfillCloses`, `price_daily` (insert where absent) and `price_backfill`, append-only yes —
      and the sentence "Five operations produce history" becomes a rule rather than a count,
      `docs/README.md`'s first rule
- [ ] §5.2: `price_backfill` references `instrument … on delete cascade`, so it enters the graph,
      not the list beneath it: the ER diagram gains `INSTRUMENT ||--o{ PRICE_BACKFILL` beside
      `PRICE_DAILY`'s edge (`:525`) and an entity block beside `PRICE_DAILY`'s (`:584`); §5.3's
      cascade row for `quote` / `price_daily` / `price_observation` → `instrument` (`:632`) gains
      it, with the same reasoning — an attempt to price an instrument that never existed. The
      "reference nothing" table (`:609`) is where `price_poll` sits and is not where the ledger goes
- [ ] §6.2: the sequence diagram or a paragraph after it shows the batch following the quotes
      under the same lock, the tiers table's `price_daily` row says the spine is written by two
      paths, and the `price_backfill` ledger is described beside `price_poll`. Two sentences there
      are corrected, not only added to: "A refresh writes five tables" (`:1092`) is a count and
      becomes a rule that names the ledger among what a refresh writes; and "The whole write is
      one transaction … all of them or in none" (`:1109`) stays true of the quotes' write and is
      qualified for the batch, which commits one transaction per attempt — that attempt's closes
      and its ledger row together, and nothing across attempts
- [ ] §7.2: the "Two poller ticks in different processes" row becomes any two refreshes — tick,
      press, or post-commit request — under one lock
- [ ] §7.4: a row for the backfill outcome — the `Price backfill` stem and the ledger
- [ ] §7.5: the seam diagram gains the second method, and the conversions gain the split
      un-adjust, stated as done at the seam on `money.ts`'s units so the writer inserts what it is
      handed
- [ ] Appendix A: `prices.server.ts`, `price-provider.server.ts` and `price-poller.server.ts` rows
      updated; `0010_price_backfill.sql` in the migrations table; the `settings/prices.tsx` row
      (`:2000`) gains the gap list and the `refresh.ts` row (`:2003`) the batch a press now runs
- [ ] Appendix B: a **Backfill** entry in `CONTEXT.md`'s words, and "The spine" entry's "a missed
      poll is a visible gap the carry-forward closes" qualified as §6.2's is

**The operator's recipe** (`docs/importing-history.md`)

- [ ] "Before you upload anything backdated: the price spine" (`:52-83`): the claim that nothing
      backfills it (`:55-58`) and the "Until issue #83 lands" sentence (`:62-65`) are replaced by
      what now happens — the spine is filled on the refreshes after a statement lands, a handful of
      instruments per refresh — and the ordering's step 5 (`:67-78`) becomes the check rather than
      the fill: most recent statement first is still right, because it creates the instruments and
      classifies them, but the fill is no longer the operator's. Step 4's first bullet (`:194-196`), "it creates the
      instrument rows the price backfill in step 5 needs", points at that manual step and is
      re-pointed at the check step 5 becomes
- [ ] §5 "Fill the price spine" (`:216-290`) is rewritten as **check** the spine: Settings → Prices
      is the list, the gap query is kept for the terminal reader with the sentence that the screen
      shows the same rows, the split and ticker-reuse traps stay as things to know about what the
      backfill did rather than things to do, the sourcing and `\copy` instructions are cut, and the
      manual-instrument paragraph (`:265-269`) stays because it is still the only answer for a CIT.
      The insert-where-absent sentence (`:281-286`) survives as the statement of what the backfill
      itself obeys
- [ ] Step 4's "ideally after step 5 has run once" (`:214`) and step 6's "until issue #83 lands, no
      screen distinguishes" (`:303-305`) re-point: the chart-side warning is the follow-up issue,
      not this one
- [ ] The `docs/README.md` deliberate-duplication entry for this document still describes it

**The reversed line** (`docs/specs/0002-pricing.md:445-447`)

- [ ] The bullet is struck through and followed by a bold **Reversed** banner, in the one form
      `docs/design/pricing-ui-brief.md:400-403` uses for its reversed rule, pointing at 0017 and
      ADR-0011, and saying which half survives: a provider-outage hole is still not a trigger.
      `docs/specs/README.md` says a landed spec is corrected by banner, not rewritten, and its
      list of specs corrected in place (`:14-17`) gains 0002

**The developer's recipe** (`docs/developing.md`, under Recipes)

- [ ] "Exercise a backfill locally": seed an instrument and a backdated position set through the
      demo seed or a short script, press **Refresh now**, read `price_backfill` and the new
      `price_daily` rows with `psql`, and what each outcome means
- [ ] "Re-verify the split convention after upgrading `yahoo-finance2`": the one-off check ticket 01
      recorded in the adapter's header, as steps, and the fallback rule to switch to if it fails

**Operating, runbook, data model** (`docs/operating.md`, `docs/runbook.md`, `docs/data-model.md`)

- [ ] `operating.md` Logs (`:716-751`): the `Price backfill` stem, what it counts, and that it is
      absent when there was nothing to fill; "There is no price line in the log has four causes"
      (`:753-779`): cause 2 now says a tick outside market hours asks for no quotes and may still
      write a backfill line; the loop's "only while the market is open" (`:262`) becomes true of
      quotes only, a backfill batch riding a tick at any hour; "Growth and limits" (`:1056`, the
      `price_poll` sentence at `:1086`): a ledger row per attempt, at most a handful per refresh,
      is nothing
- [ ] `runbook.md`: a new symptom, "a holding is unpriced on a past date" — confirm at Settings →
      Prices, read the outcome, and what each one means for what to do; "Prices have stopped
      updating" (`:270-310`) is corrected, not only cross-referenced: its first bullet
      (`:285-286`), "The tick returns before it logs anything outside market hours. Expected.",
      is false once a weekend tick runs the batch — the tick asks for no quotes and writes no
      `Price refresh` line, and may write a `Price backfill` line
- [ ] `data-model.md` §4.4 (`:288-357`): `price_backfill` described beside `price_poll`, every
      column and constraint; the ER diagram gains `instrument ||--o{ price_backfill` beside
      `price_daily`'s edge (`:56`) and an entity block beside `price_daily`'s (`:114`) — not the
      "referencing nothing" list at `:139`, where `price_poll` sits (`:146`), because the ledger
      references `instrument` and cascades with it; and the pricing dataflow sentence near `:553`
      that says what a refresh writes

**The guide and the README** (`docs/guide/`, `README.md`)

- [ ] `guide/settings.md` Prices (`:122-135`): the gap list, and the sentence that the refresh only
      runs while the market is open becomes true of quotes only
- [ ] `guide/prices.md`: two passages are falsified — `:7`, prices refresh "while the market is
      open", and the first bullet (`:17-20`), "Outside trading hours, nothing refreshes on its
      own" — and each becomes true of quotes only, the bullet adding that a holding recorded on a
      weekend now gets its past closes filled by the next tick rather than only its first price
      from a press; "This holding shows a dash" (`:35-56`) carries no
      false claim and gains one sentence: a dash on a past date is the same honesty, and Settings →
      Prices says whether the spine is still being filled or why it cannot be
- [ ] `README.md` "Where prices come from" (`:594-597`): two sentences are rewritten — quotes are
      asked for "only while the market is open" becomes true of quotes only, with the backfill
      batch riding any refresh, and "the one-method interface §6.1 mandates" names the second
      method. The deployment diagram's edge to Yahoo (`:465`, "market hours, or Refresh now") is
      relabelled beside them, since a batch may cross it at any hour. Not a further numbered
      decision: the backfill is described in the paragraph's own words — history is backfilled
      from the feed's own history, inserted where absent and never over a close the instance
      recorded itself

**Vocabulary**

- [ ] `CONTEXT.md`'s **Refresh cadence** entry (`:96-98`): "Outside market hours no cadence spends
      anything" is falsified. The entry says quotes are asked for only while the market is open and
      that a backfill batch may ride a tick at any hour — glossary wording, no implementation detail
- [ ] The **Backfill** entry landed in `CONTEXT.md` with the decision, as **Dump** did for 0014.
      Every use of "backfill", "historical import" or "catch-up" for this concept across the files
      above is brought to the glossary's word; `tests/refresh-quotes.test.ts:528` uses "backfills"
      for `quote_type` and may keep it — that is not this concept. The sweep runs the other way
      too: `docs/importing-history.md:81, :180, :191, :302, :308` and `DESIGN.md:496` say
      "backfill" or "backfilled era" for loading position history from backdated statements,
      which the glossary's entry now reserves for filling closes. Each becomes "backdated
      statements" or "loading history", whichever the sentence reads with; `:195`'s "price backfill"
      already means the glossary's concept and stays

**The issue**

- [ ] Issue #83 is closed by this ticket's pull request, with a comment naming what landed (the root
      cause, item 4 of its fix list) and the follow-up issue carrying every chart-side item the
      issue holds — per-point coverage in the readout, a truthful note, coverage on the change
      figure, and "partial computed suppresses accurate manual points" (DESIGN.md §7 rule 2) —
      filed before it is closed, so the half this slice does not do stays tracked with its evidence
      linked rather than lost
- [ ] `docs/specs/README.md` already carries 0017 and `price-backfill/` — landed with the spec, not
      here; this ticket re-checks that the row's sentence still describes what shipped
