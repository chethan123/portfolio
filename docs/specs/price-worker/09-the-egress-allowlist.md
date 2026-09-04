# 09 — The egress allowlist

_Part of [0018-price-worker.md](../0018-price-worker.md) (§3.8)._

**What to build:** `server/egress-proxy.ts`, a `CONNECT`-only forward proxy of about a hundred and
fifty lines on `node:http`, `node:net` and `node:dns`, admitting exactly the five hosts
`yahoo-finance2` 4.0.2 contacts, only when the TLS ClientHello inside the tunnel names the same
host, and never to a private address; the `egress-proxy` service running it from the same image; a
**new** internal, isolated network between worker and proxy replacing `egress-worker`, so the proxy
is the worker's only way out; and the smoke assertions that prove the topology and the server-name
check, not the environment flag, are what bind.

Its own ticket, and required rather than optional: until it lands the worker's egress bridge reaches
the household LAN as well as the internet, and "Yahoo Finance and nothing else" is a sentence about
honest code. After it a compromised worker can send bytes only to what Yahoo's edge serves under a
server name the proxy matched to the `CONNECT` host, and has no resolver at all.

**Blocked by:** [08](08-the-network-lockdown.md).

**Status:** ready-for-agent

**The proxy** (`server/egress-proxy.ts`, new; `tests/egress-proxy.test.ts`, new)

- [ ] Imports `node:http`, `node:net` and `node:dns` only — its closure is decorrelated from the npm
      tree, which is the reason to write it rather than pull an image. No `zod`, no
      `server/config.ts`, and no environment read at all
- [ ] Listens on `8888`; handles `CONNECT host:443` and nothing else — any other method, port or an
      absent host is answered `403` and logged
- [ ] The allowlist is a module constant — `query1.finance.yahoo.com`, `query2.finance.yahoo.com`,
      `finance.yahoo.com`, `guce.yahoo.com`, `consent.yahoo.com` — compared exactly and
      case-insensitively, never as a suffix. `fc.yahoo.com`, which older plans named, is not in
      4.0.2. The header says why it is a constant rather than configuration (a fact about the pinned
      library; a moved consent host is fixed by a release) and what breaks when Yahoo moves one:
      quotes, while `chart()` — which needs no crumb — keeps working, and the proxy log names the
      refused host
- [ ] The host in the `CONNECT` line is not enough: all five resolve to the same two addresses as
      `mail`, `login` and `www.yahoo.com` (research note §3.1), and the edge routes on the server
      name the *client* sends. So before piping, the proxy reads the first TLS record from the
      client side, parses the ClientHello's `server_name` extension, and tears the tunnel down when
      it is absent or differs from the `CONNECT` host — logging both names. A hand-rolled parser
      over the record and handshake headers, some forty lines; the tests feed synthetic ClientHellos
      (matching, mismatched, no SNI, truncated, a non-TLS first byte) and never open a socket to the
      internet
- [ ] The destination is resolved with `dns.lookup` (injectable for the tests) and refused when any
      answer is loopback, link-local or RFC 1918 — a LAN resolver pointing `finance.yahoo.com` at a
      LAN box (ADR-0005's adversary) must not make the proxy a pivot for a worker that skips
      certificate checks. The tunnel is a `net.connect` to the resolved address, the first record
      replayed into it, then piped both ways and torn down when either side ends
- [ ] One log line per refusal naming the reason and the host(s), stem `Egress proxy`; none per
      allowed tunnel. `if (import.meta.main)` guard, as the worker has; `Dockerfile:104-110` gains
      the file

**Compose**

- [ ] A new network `worker-proxy: { internal: true, enable_ipv6: false, driver_opts: {
      com.docker.network.bridge.gateway_mode_ipv4: isolated } }` and a new plain bridge
      `egress-proxy: { enable_ipv6: false }`; `egress-worker` is **removed** from the file. A new
      name because Docker cannot turn a plain bridge internal in place and Compose recreates a
      drifted network only when it recorded a config hash on it (present at v2.35, absent at v2.30 —
      research note §1.11; the builder pins the exact first release from the compose changelog and
      states it as the floor beside the Engine's): under the old name an older Compose would leave
      the worker with its route out, the env flag would route honest traffic through the proxy, and
      smoke — which starts from nothing — would stay green
- [ ] The `egress-proxy` service on `[worker-proxy, egress-proxy]` with the app's image,
      `entrypoint: ["node", "./server/egress-proxy.ts"]`, `restart: unless-stopped`, the full
      hardening, uid 1000, no `ports:`, and a healthcheck that `net.connect`s to its own `:8888`
- [ ] `worker` on `[worker-db, worker-proxy]`, with `NODE_USE_ENV_PROXY: "1"` and `HTTPS_PROXY:
      http://egress-proxy:8888` — Node 24's `fetch` honours the pair only under the flag (research
      note §5.2, exercised: without it the fetch goes direct), the library uses global `fetch`, and
      both variables are the runtime's, not `config.ts`'s — `pg`'s connection is a raw socket and
      ignores them. The worker now has no non-internal network: no resolver for public names
      (hostnames travel inside `CONNECT` and the proxy resolves them) and no route to the host's
      published `:80`
- [ ] The upgrade note: replace `compose.yaml`, `up -d`, then `docker network rm
      portfolio_egress-worker` (Compose does not remove an unused network) and check `docker network
      inspect -f '{{.Internal}}' portfolio_worker-proxy` prints `true`. The compose header and, in
      [10](10-documents-and-runbooks.md), DESIGN.md's services block gain the service

**Smoke** (`scripts/smoke-test.sh`)

- [ ] The service lists gain `egress-proxy` (`:71`, `:342-350`, `:365-367`, `:379-385`, `:401-403`);
      no published port
- [ ] From `worker`: a `fetch` of `https://query2.finance.yahoo.com/` through the proxy gets an HTTP
      answer of any status — the point is the tunnel; `timeout 5 nslookup example.com` now fails;
      `worker-proxy` shows an empty IPAM `Gateway` and no host `inet`, as
      [08](08-the-network-lockdown.md)'s isolated networks do
- [ ] `docker compose stop egress-proxy`, then the same `fetch` from `worker` fails within its
      timeout; `start` it again. The network is the property, not the flag
- [ ] Through the proxy: `CONNECT mail.yahoo.com:443` is refused with `403`, and so is a plain
      `GET`; a `CONNECT finance.yahoo.com:443` followed by a ClientHello whose server name is
      `mail.yahoo.com` (a few lines of `node:tls` with `servername`, from `worker`) is torn down
      before any byte reaches the edge

**Docs**

- [ ] `docs/operating.md` Security (`:485`) gains the paragraph: what the proxy allows, the
      server-name rule, what a refused `CONNECT` in its log means, and the one operator action —
      upgrade — when Yahoo moves a host. "There is no price line in the log" (`:761`) gains the
      sixth cause, the proxy is down, with its signature: `docker compose ps egress-proxy` not
      healthy, and every `Price worker` line and `failed` row of that minute carrying `fetch failed`
      with the same cause — the worker stays healthy, since its heartbeat is the database poll
- [ ] ARCHITECTURE.md §2 (`:92-100`): the worker reaches Yahoo through the proxy; the full sentence,
      and the env-reader row naming `NODE_USE_ENV_PROXY` and `HTTPS_PROXY` as the runtime's, are
      [10](10-documents-and-runbooks.md)'s

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build`, `scripts/smoke-test.sh` green
