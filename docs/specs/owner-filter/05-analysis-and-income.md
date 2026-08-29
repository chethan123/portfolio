# 05 — Analysis and Income read as an owner

_Part of [0013-owner-filter.md](../0013-owner-filter.md)._

**What to build:** The two remaining money screens honour the filter, and the Analysis panel that
already spoke about people is retitled to match the glossary.

These two go together because they are the same change twice — a loader passing the filter to
readers it already calls, a control in the header, and a sentence naming the owners — and neither is
large enough to be worth a reviewer's separate sitting. Analysis carries the one editorial decision:
the panel grouped by owner narrows like everything else, which leaves it with a single slice at 100%
when one owner is selected. That is deliberate, and ADR-0008 records why.

**Blocked by:** 03 — it needs the control.

**Status:** ready-for-agent

**Analysis**

- [ ] The control is drawn, the filter resolved and normalised, and a non-canonical param redirects
      before any database work
- [ ] `currentHoldings` and `netWorth` are called with the filter
- [ ] All four panels narrow: net worth by owner, value by account type, value by asset class, and
      unrealized gains
- [ ] The **"Net worth by person"** panel is retitled **"Net worth by owner"**
      (`app/routes/analysis.tsx:250`), which is the one place the pre-glossary wording survives in
      the UI
- [ ] It narrows like every other panel — one owner selected leaves one slice at 100%, and this is
      not special-cased
- [ ] The capital-gains rate is untouched: it is the household's number, not an owner's, and the
      potential-tax figures narrow only because the gains they apply to do
- [ ] The owners are named beside the figures, per ADR-0008

**Income**

- [ ] The control is drawn, the filter resolved and normalised, redirect as above
- [ ] `currentHoldings` is called with the filter
- [ ] The annual dividend headline, the weighted yield, the sheltered/taxable subtotal and both
      breakdowns all narrow
- [ ] Weighted yield is recomputed over the narrowed set — it is a ratio of the group in view, per
      `CONTEXT.md`'s **Weighted yield**, and must not be carried over from the household
- [ ] The owners are named beside the figures

**Tests** (extending `tests/analysis.test.ts` and `tests/income.test.ts`)

- [ ] Each screen narrowed shows one owner's figures as exact decimal strings
- [ ] Two owners' narrowed figures sum to the household's, for net worth and for annual dividend
- [ ] The retitled panel's heading is asserted
- [ ] Narrowed to one owner, the by-owner panel renders a single slice rather than being hidden
- [ ] Weighted yield narrowed is the narrowed dividend over the narrowed value, not the household's
      ratio
- [ ] The capital-gains rate is unchanged by the filter
- [ ] Both screens preserve the filter across their own controls
