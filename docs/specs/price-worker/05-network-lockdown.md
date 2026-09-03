# 05 — Network lockdown: the app loses its route out

_Part of [0018-price-worker.md](../0018-price-worker.md) (§3.1)._

**What to build:** The seven-network topology, and the smoke assertions that make it a property
rather than a diagram. After ticket 04 the app already fetches through the mailbox, so this ticket
removes a route nothing uses — which is exactly why it can land, and be reverted, on its own.

**Blocked by:** 04 (removing the route before the app stops using it deploys an instance with no
price refresh).

**Status:** ready-for-agent

**The topology**

- [ ] Full topology from spec §3.1: `backend`, `worker-db`, `caddy-app`, `caddy-gate` internal;
      `egress-worker`, `egress-gate`, `ingress` bridges. `app` gets `[backend, caddy-app]` — **not a
      shared `frontend` with `gate`**: from a shared network the app can POST
      `/oauth2/callback?code=<bytes>` to `gate:4180` and the gate relays them to Google, which is a
      kilobyte-scale egress proxy handed to the container this whole slice exists to contain.
- [ ] `app`, `db` and `dump` end with no route out

**Smoke — the assertion set is total, not partial**

- [ ] Outbound TCP **and** external DNS resolution fail from `app`, `db` **and `dump`**. `dump` holds
      the household's finances in plaintext on a bind mount and no earlier draft asserted anything
      about it.
- [ ] `worker`, `gate` and `caddy` are asserted to *have* egress, so the set says something about
      every service
- [ ] `docker network inspect` reports `"Internal": true` for `backend`, `worker-db`, `caddy-app`
      and `caddy-gate` — one line naming the property directly rather than inferring it
- [ ] **The positive control does not use Yahoo.** "From `worker`, Yahoo resolves" couples CI to a
      third party's uptime and rate limits; the day it flakes someone relaxes it and the negative
      assertions stop being falsifiable. Any DNS name and a TCP connect.
- [ ] `app:3000` and `gate:4180` unreachable from `worker` — and note in the test's comment that
      this passes partly because Compose's DNS only resolves names on networks the querying
      container is attached to. It does **not** cover the host-gateway path (spec §3.1): the worker
      still reaches Caddy's published `:80` and the LAN through the host's default route. Assert
      against the bridge gateway address so the limit is recorded rather than implied.
- [ ] The in-container yahoo-import check (`:265-268`) re-pointed from `app` at `worker`. It only
      imports and constructs, never calls out, so it passes on a container with no internet route —
      it is not an egress assertion.
- [ ] The DNS assertion's comment says what it proves: CVE-2024-29018 leaks only where the host's
      `resolv.conf` names a loopback forwarding resolver, so a green run on a CI runner says nothing
      about an operator's systemd-resolved box on an old engine.

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build`, `scripts/smoke-test.sh` green
