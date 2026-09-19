# 05 — The documents this slice makes false

_Part of [0022-chart-grain.md](../0022-chart-grain.md)._

**What to build:** Every edit under spec 0022's "Documents this change makes false", so each
document describes what the chart now does. State rules, not counts that drift; keep each rule in
its owning document and link from the others (`docs/README.md`). The measured figures come from
ticket 02's pull request description.

**Blocked by:** [04](04-seam-and-routes.md), so every line number and behaviour is final.

**Status:** ready-for-agent

**Read first:** spec 0022 "Documents this change makes false"; ADR-0014; `docs/README.md` for the
writing rules; each document below at the section named.

- [ ] `DESIGN.md` §8.1, the paragraph "The chart has a range control, and two ADRs govern the
      line": after the ADR-0003 sentence, two sentences saying a range of at most 92 days is drawn
      at a grain from the observation log on an axis that gives every day the same width, dated
      closes on the days nothing was observed, with ADR-0014 linked; "1D is the exception" reworded
      so 1D is the one range drawn unsampled
- [ ] `DESIGN.md` §14 limitation 13: cut back to what still holds. An older session cannot be chosen
      *as 1D*; a short range draws the sessions inside it (ADR-0014); the archive is not market
      data; the line is drawn once. The sentence naming the three deferred costs goes
- [ ] `DESIGN.md` §14 limitation 2: "The line holds today's positions constant across the
      session" becomes a statement about 1D alone, with a clause that a grained range values each
      instant at the position set in force on its date
- [ ] `ADR-0006`: the note ADR-0014 adds is already in place; check it reads true against the
      shipped behaviour and touch nothing else in the file
- [ ] `ADR-0004`: the note ADR-0014 adds is already in place (about 225 points at 3M); check it
      reads true against the shipped behaviour and touch nothing else in the file
- [ ] `ARCHITECTURE.md` §4.2, the "Valuing holdings" row and its `readSessionSeries` bullet
      (`:432-437`, whose `valuation.server.ts` line number is already stale): the grained reader is
      the second valuation outside the two SQL objects, in the same module
- [ ] `ARCHITECTURE.md` §5, the tiers table row for `price_observation` (`:1346`): read by the
      1D readers and the grained readers; §5.5, the `price_observation_pkey` and
      `price_observation_market_date_idx` rows (`:896-897`): what the grained reader's per-step
      maximum and per-holding lookup ride; Appendix B (`:2487`): "read by the 1D chart and by
      nothing else" corrected
- [ ] `ARCHITECTURE.md` §6.3 "The three intra-session reads are the module's second front": a
      paragraph for the grained reader as a third front, where each of its two narrowings sits and
      why (the dated branch inside the `holding_valued_at` lateral, the instant branch in the
      holdings CTE), and that it re-values per plotted instant because the grain bounds the count
      where the cadence would not
- [ ] `ARCHITECTURE.md` §10: a trade-off row for the grained line with ticket 02's measured 1W and
      3M figures and what it would break at; the "Four indexes carry the read path" paragraph names
      which index each of the grained reader's lookups rides; §10's opening sentence about what has
      been measured lists it
- [ ] `ARCHITECTURE.md` Appendix A: the `chart-range.ts` row names the grain, `grainFor` and
      `dayOf`; the `chart-series.server.ts` row names the third reader; the `net-worth-chart.tsx`
      row names the per-day axis and the dated point
- [ ] `docs/data-model.md` §4.4 (`:379-380`): the log is what the 1D chart and a grained range
      draw; §5.3.1: a paragraph for the grained series beside the 1D one, in its words: which days
      are dated, how a step's point is chosen and valued, that the first day is dated
- [ ] `docs/guide/overview.md`: under "The range control", a short section on what 1W, 1M and 3M
      draw (the grain per range, every day the same width with the session across it, the weekend
      a flat stretch, a gap a straight bridge, the readout's time the moment the price was struck,
      YTD's grain changing through the year); the 1D section's "Current quantities are used across
      the session" becomes the thing 1D alone does
- [ ] `docs/guide/account-detail.md`: the sentence on 1D gains its sibling for short ranges, in one
      line
- [ ] `README.md`: the bullet on 1D gains a sibling for short ranges, one line
- [ ] `docs/specs/README.md`: a row for 0022 in the table and `chart-grain/` in the ticket
      directories paragraph
- [ ] `docs/research/README.md`: ticket 02's figures are recorded under the latency note's entry
      if ticket 02 did not already; `harness/README.md`'s file table has a row for `grained.sql`
- [ ] `CONTEXT.md`'s "Grain" entry (already landed): check it still reads true; no edit expected
- [ ] Nothing is added to `migrations/*.sql` text, `docs/design/pricing-ui-brief.md`, or
      `docs/specs/0008-chart-ranges.md` (spec 0022, "Deliberately not on the list")

**Done when** every box is ticked, `grep -n "deliberately deferred" DESIGN.md` finds nothing in
limitation 13, and a reader of `DESIGN.md` §8.1 and limitation 13 alone would predict what a 1W
chart draws.
