# 08 — Optional password gate

_Part of [0001-foundation-day-zero.md](../0001-foundation-day-zero.md)._

**Superseded.** The gate this ticket built shipped and has since been deleted — no `AUTH_PASSWORD`,
no login page, no session cookie of the app's own. Authentication now happens outside the app
entirely, in a forward-auth gate in front of it: see
[0011-auth-gate.md](../0011-auth-gate.md) and
[ADR-0005](../../adr/0005-auth-is-a-forward-auth-gate.md). What follows is the record of what was
built here and why, not how the system works.

**What to build:** A self-hoster whose instance is reachable beyond their LAN can set one password
and have the whole app sit behind a login page. Leaving it unset keeps the app open, but says so
loudly and permanently, so it cannot be forgotten. This is not multi-user authentication and is not
meant to become it: one password, one cookie, no user table.

Sequenced early so that every route added afterwards is covered by construction rather than
retrofitted.

**Blocked by:** 01.

**Status:** ready-for-agent

- [ ] With the auth password set, every route except the health endpoint requires authentication
- [ ] A single login page accepts the password and issues a signed cookie, so authentication happens
      once rather than per page
- [ ] The session secret becomes required when the auth password is set, and startup fails with a
      readable message when it is missing
- [ ] With the auth password unset, there is no authentication and a persistent warning banner
      renders on every page
- [ ] The health endpoint is reachable without credentials in both modes, so monitoring needs no
      secrets
- [ ] No user table, no sessions table, no per-person permissions are introduced
