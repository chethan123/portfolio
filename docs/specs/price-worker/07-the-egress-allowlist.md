# 07 — The egress allowlist

_Part of [0018-price-worker.md](../0018-price-worker.md) (§3.8)._

**What to build:** `server/egress-proxy.ts`, a `CONNECT`-only forward proxy of about eighty lines
on `node:http` and `node:net`, admitting exactly the five hosts `yahoo-finance2` 4.0.2 contacts;
the `egress-proxy` service running it from the same image; `egress-worker` turned internal and
isolated so the proxy is the worker's only way out; and the smoke assertions that prove the
topology, not the environment flag, is what binds.

Its own ticket, and required rather than optional: until it lands the worker's egress bridge
reaches the household LAN as well as the internet, and "Yahoo Finance and nothing else" is a
sentence about honest code. After it a compromised worker can send bytes only to what five Yahoo
Finance hosts accept, and has no resolver at all.

**Blocked by:** [06](06-the-network-lockdown.md).

**Status:** ready-for-agent

**The proxy** (`server/egress-proxy.ts`, new)

- [ ] Imports `node:http` and `node:net` only — its closure is decorrelated from the npm tree, which
      is the reason to write it rather than pull an image. No `zod`, no `server/config.ts`, and no
      environment read at all
- [ ] Listens on `8888`; handles `CONNECT host:443` and nothing else — any other method, port or an
      absent host is answered `403` and logged. The tunnel is a `net.connect` to the host piped both
      ways, torn down when either side ends
- [ ] The allowlist is a module constant — `query1.finance.yahoo.com`, `query2.finance.yahoo.com`,
      `finance.yahoo.com`, `guce.yahoo.com`, `consent.yahoo.com` — compared exactly and
      case-insensitively, never as a suffix: `*.yahoo.com` would admit a mail or login host, and a
      `CONNECT` tunnel carries arbitrary bytes. `fc.yahoo.com`, which older plans named, is not in
      4.0.2. The header says why it is a constant rather than configuration (a fact about the pinned
      library; a moved consent host is fixed by a release) and what breaks when Yahoo moves one:
      quotes, while `chart()` — which needs no crumb — keeps working, and the proxy log names the
      refused host
- [ ] One log line per refused `CONNECT` naming the host, stem `Egress proxy`; none per allowed one
- [ ] `if (import.meta.main)` guard, as the worker has; `Dockerfile:104-110` gains the file

**Compose**

- [ ] `egress-worker` becomes `internal: true` with `gateway_mode_ipv4: isolated`; a new plain
      bridge `egress-proxy`; the `egress-proxy` service on `[egress-worker, egress-proxy]` with the
      app's image, `entrypoint: ["node", "./server/egress-proxy.ts"]`, `restart: unless-stopped`,
      the full hardening, uid 1000, no `ports:`, and a healthcheck that `net.connect`s to its own
      `:8888`
- [ ] `worker` gains `NODE_USE_ENV_PROXY: "1"` and `HTTPS_PROXY: http://egress-proxy:8888` — Node
      24's `fetch` honours the pair, and the library uses global `fetch`; its `pg` connection is a
      raw socket and ignores both
- [ ] `worker` keeps `[worker-db, egress-worker]` and now has no non-internal network: no resolver
      for public names (hostnames travel inside `CONNECT` and the proxy resolves them) and no route
      to the host's published `:80`
- [ ] The compose header and, in [08](08-documents-and-runbooks.md), DESIGN.md's services block
      gain the service

**Smoke** (`scripts/smoke-test.sh`)

- [ ] The service lists gain `egress-proxy` (`:71`, `:342-350`, `:365-367`, `:379-385`, `:401-403`);
      no published port
- [ ] From `worker`: a `fetch` of `https://query2.finance.yahoo.com/` through the proxy gets an HTTP
      answer of any status — the point is the tunnel; `timeout 5 nslookup example.com` now fails;
      the gateway connect from [06](06-the-network-lockdown.md) now fails
- [ ] `docker compose stop egress-proxy`, then the same `fetch` from `worker` fails; `start` it again.
      The network is the property, not the flag
- [ ] Through the proxy, `CONNECT mail.yahoo.com:443` is refused with `403`, and so is a plain `GET`

**Docs**

- [ ] `docs/operating.md` Security (`:485`) gains the paragraph: what the proxy allows, what a
      refused `CONNECT` in its log means, and the one operator action — upgrade — when Yahoo moves a
      host
- [ ] ARCHITECTURE.md §2 (`:92-100`): the worker reaches Yahoo through the proxy; the full sentence
      is [08](08-documents-and-runbooks.md)'s

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build`, `scripts/smoke-test.sh` green
