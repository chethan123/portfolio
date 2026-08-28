# 09 — Reverse-proxy trust and operator documentation

_Part of [0001-foundation-day-zero.md](../0001-foundation-day-zero.md)._

**Superseded in one clause:** the app issues no cookie of its own now, so the auth-cookie half of the
forwarded-header criterion below is the forward-auth gate's concern
([0011-auth-gate.md](../0011-auth-gate.md),
[ADR-0005](../../adr/0005-auth-is-a-forward-auth-gate.md)). Everything else here — forwarded-header
trust, plain HTTP, backups, the environment table, the PWA constraint — still holds.

**What to build:** A self-hoster puts their own TLS-terminating reverse proxy in front of the
instance and it behaves correctly — correct scheme, correct client address, secure cookies. They can
also find, without reading source, how to back the instance up, what every setting does, and why
their phone refuses to install the app over plain HTTP.

**Blocked by:** 08.

**Status:** ready-for-agent

- [ ] The app trusts forwarded headers, so scheme and client address are correct behind a reverse
      proxy and the auth cookie is issued appropriately
- [ ] The app serves plain HTTP and never manages certificates; TLS is documented as the operator's
      concern
- [ ] A `pg_dump` backup and restore procedure is documented, with backups explicitly not a built-in
      feature
- [ ] The documentation states that the Postgres named volume is the only backup target, because the
      application container is stateless
- [ ] The full environment table is documented, matching the example environment file, including
      which variables are required and under what conditions
- [ ] The documentation explains that service workers require a secure context, so an instance served
      over plain HTTP at a LAN IP cannot install as a PWA on a phone — a deployment constraint, not
      something the app can work around
