# 04 — The in-process poller

_Part of [0002-pricing.md](../0002-pricing.md)._

**What to build:** Prices that keep themselves current while the market is open, without adding a
service. DESIGN.md §10.1 names the in-process scheduler as the reason the deployment is two
containers rather than three, so this runs inside the app, on the interval the operator already
configures, and logs one line per tick so "prices stopped updating" is answerable from
`docker compose logs`. Two things make it survive real conditions: it is pinned so a dev-server
reload replaces the timer rather than adding one, and it holds a database lock so a restart that
briefly overlaps a shutdown does not poll twice.

**Blocked by:** 03.

**Status:** ready-for-agent

- [ ] The poller starts with the server inside the application container; Compose gains no third
      service and `start` remains a plain `react-router-serve` with no custom server entry
- [ ] It ticks on the configured poll interval, defaulting to fifteen minutes, and uses the
      configured market timezone for its session check
- [ ] A tick while the market is closed makes no provider call and writes nothing
- [ ] A tick while the market is open runs exactly one refresh
- [ ] The timer is pinned on the global object, so a Vite hot-reload in development replaces the
      running poller instead of leaving the previous one polling alongside it
- [ ] Each tick is guarded by a Postgres session-level advisory lock on a key distinct from the
      migration runner's, so two overlapping containers cannot both poll
- [ ] A tick that cannot take the lock skips without error, and a refresh that outlasts its interval
      makes the next tick skip rather than pile up
- [ ] The lock is released whether the refresh succeeds or throws
- [ ] A refresh that throws does not stop the schedule — the next tick still runs
- [ ] Every tick logs its outcome: attempted or skipped, and for an attempt the counts of updated,
      stale and refused instruments
- [ ] Shutting the server down clears the timer and releases the lock
- [ ] `/healthz` continues to report only database reachability and migration state — it says
      nothing about the poller and never contacts the price provider, so a third-party outage cannot
      make Compose restart a healthy app
