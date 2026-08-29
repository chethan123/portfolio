# 05 — Stale prices on screen and the Instruments tab

_Part of [0002-pricing.md](../0002-pricing.md)._

**What to build:** What a family sees when a price goes wrong, and the screen that lets them fix it.
A stale price is shown, still carrying its last known value, and labelled as stale rather than
blanked or zeroed. And Settings → Instruments (§8.4) becomes the place that answers "which manual
prices have gone stale", where a collective investment trust gets its price by hand, and where a
ticker change is applied as the one-column update §4.3 designed it to be.

The as-of timestamp and the "Refresh now" control were split out into
[06](06-refresh-now-control.md), which also records where the design brief is superseded. The
banner below is drawn together with that timestamp rather than above it, so the two do not stack.

Note for whoever picks this up: the Stitch mock set covers none of this. Per
`docs/research/2026-08-19-stitch-screen-audit.md`, all twelve screens lack a stale-data indicator,
an empty state and an error state, there is no Settings screen anywhere in the set, and the as-of
timestamp appears on exactly one mobile screen. The design brief for this ticket is
`docs/design/pricing-ui-brief.md`.

**Blocked by:** 06, for the header slot and the timestamp the banner sits beside.

**Status:** ready-for-agent

**Stale prices**

- [ ] When any priced holding on a page is stale, a page-level banner says how many, using the
      existing `--warning` and `--warning-surface` tokens (§13.2) with no new colour values
- [ ] A stale row in the Holdings table is marked individually and still shows its last known price
      and value
- [ ] Staleness is never carried by colour alone — a word or an icon accompanies it (§12)
- [ ] A holding that has never been priced is visibly distinct from one whose price is merely old,
      so it is clear which one needs a manual price
- [ ] An instrument refused for being priced in a currency other than USD explains that as the
      reason, rather than reading as an ordinary failure

**Settings → Instruments**

- [ ] The tab lists every instrument with its symbol, name, classification, price source, last price
      and the age of that price
- [ ] Manual-priced instruments can be surfaced by how old their last price is, which is what makes
      "which CITs have gone stale" answerable on a schedule rather than from memory
- [ ] A manual price is entered in a form and takes effect immediately in current holdings, and
      carries forward to later dates until it is changed
- [ ] An instrument's symbol can be changed, and its position and price history stay one series
      across the change
- [ ] An instrument's price source and classification can be changed, so a CIT that gains a public
      symbol starts being fetched
- [ ] The aliases pointing at an instrument are visible from its row
