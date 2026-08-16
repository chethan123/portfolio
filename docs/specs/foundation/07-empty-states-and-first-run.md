# 07 — Empty dashboards and the first-run prompt

_Part of [0001-foundation-day-zero.md](../0001-foundation-day-zero.md)._

**What to build:** A family member opening a fresh install is told what to do rather than left
staring at three blank dashboards wondering whether the app is broken. The prompt walks them through
People and then Accounts in that order, because an account cannot be created before an owner exists,
and it disappears once both exist. The three dashboards say plainly that there is no data yet — an
empty chart must never read as a zero balance in a finance app.

**Blocked by:** 06.

**Status:** ready-for-agent

- [ ] Navigation is ordered by frequency of use: Overview, Holdings, Income, Upload, then Settings
- [ ] On a fresh install with no people, a single prompt points at Settings → People
- [ ] Once a person exists but no account does, the prompt points at Settings → Accounts
- [ ] The prompt disappears once at least one person and one account exist
- [ ] Overview, Holdings and Income each render an empty state stating there is no data yet, rather
      than a zero figure or a blank chart
- [ ] Upload is reachable as a placeholder, since it is a primary workflow rather than configuration
- [ ] The empty states are what the dashboards slice replaces; no dashboard content is built here
