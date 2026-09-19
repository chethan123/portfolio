# 06 — The demo has five sessions to draw

_Part of [0022-chart-grain.md](../0022-chart-grain.md)._

**What to build:** `scripts/seed-demo.ts` seeds observations and poll rows for the five latest
sessions instead of one, so a grained 1W on the demo household has something to draw. Its own
commit, so the seed's diff is read on its own.

**Blocked by:** Nothing in code; it lands after [04](04-seam-and-routes.md) so it can be checked in
the running app.

**Status:** ready-for-agent

**Read first:** `scripts/seed-demo.ts` lines 395–430 (`findSession`, `walkSession`) and 893–952
(the observation and poll writes); `docs/developing.md` "the demo"; spec 0022 "The demo seeds five
sessions".

- [ ] `findSession` becomes `findSessions(priceDates, timeZone, count)` returning the latest
      `count` sessions oldest-first, each with its instants; the seed asks for five
- [ ] Each session's observations walk from the close before it to its own close
      (`walkSession`, with each session's close and the one before it read off the instrument's
      `Series` by date rather than the last two entries), oldest session first so the latest
      session's walk ends on today's close as it does now; the mutual fund one NAV per session at
      the session's last instant; the stale instrument observing nothing; `price_poll` rows for
      every session's instants; the observation insert's single `market_date` parameter becomes
      one per row
- [ ] `SESSION_SEED` still seeds the walk; the "Rows written" block the script prints counts every
      session's rows, and every other table's line is unchanged from a run on the previous commit

**Done when** `npm run typecheck` is green, and `node --env-file=.env ./scripts/seed-demo.ts` on
a fresh database followed by `npm run dev` shows a 1W line with instants on five sessions on the
Overview and on an account page.
