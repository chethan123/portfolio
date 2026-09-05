# 08 — The egress allowlist

_Part of [0018-price-worker.md](../0018-price-worker.md) (§3.7)._

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

**Blocked by:** [07](07-the-network-lockdown.md).

**Status:** ready-for-agent

**The proxy** (`server/egress-proxy.ts`, new; `tests/egress-proxy.test.ts`, new)

- [ ] Imports `node:http`, `node:net` and `node:dns` only — its closure is decorrelated from the npm
      tree, which is the reason to write it rather than pull an image. No `zod`, no
      `server/config.ts`, and no environment read at all
- [ ] Listens on `8888`; handles `CONNECT host:443` and one exception, `GET /healthz`, answered
      `200` unconditionally — the healthcheck's own request, proving the server itself answers
      rather than merely accepts a socket. Every other non-`CONNECT` method or path is `405`; a
      `CONNECT` to a disallowed port, an absent host or an IP-literal host is `403` and logged
- [ ] The allowlist is a module constant — `query1.finance.yahoo.com`, `query2.finance.yahoo.com`,
      `finance.yahoo.com`, `guce.yahoo.com`, `consent.yahoo.com` — compared exactly and
      case-insensitively, never as a suffix. `fc.yahoo.com`, which older plans named, is not in
      4.0.2. The header says why it is a constant rather than configuration (a fact about the pinned
      library; a moved consent host is fixed by a release) and what breaks when Yahoo moves one:
      quotes, while `chart()` — which needs no crumb — keeps working, and the proxy log names the
      refused host
- [ ] The host in the `CONNECT` line is not enough: all five resolve to the same two addresses as
      `mail`, `login` and `www.yahoo.com` (research note §3.1), and the edge routes on the server
      name the *client* sends. So the hello is checked too — but **after** the `200`, never before
      it: probed live on Node 24.20 with `NODE_USE_ENV_PROXY=1`, the client sent no bytes at all
      ahead of the proxy's `200 Connection Established` — the `'connect'` event's `head` empty, zero
      bytes on the socket — and the ClientHello's first byte (`0x16`) arrived only once the `200`
      was written. A proxy that waits for a hello before answering deadlocks every honest tunnel.
      The order is fixed, and it is the ticket's one hard sequence: (1) the `CONNECT` host against
      the allowlist — a host not on it is answered `403` and logged, with nothing upstream touched;
      (2) `dns.lookup`, the private-address guard below, and `net.connect` to the upstream, each
      under its 5 s deadline — a lookup failure or a refused connect is answered `502`, a deadline
      `504`, a private answer `403`, each logged once with the host and the cause, and nothing is
      *sent* upstream yet, so the server-name property is untouched; (3) write the `200`; (4) read
      the ClientHello, the record buffer **seeded from `head`** for a client that does pipeline and
      filled from the socket after — a handler reading `'data'` alone fails open on such a client,
      one reading `head` alone never returns for the clients probed; (5) fail closed on anything but
      one well-formed ClientHello carrying exactly one `server_name` equal to the `CONNECT` host,
      logging both names, the upstream socket destroyed with nothing written to it; (6) only then
      replay the record into the upstream and pipe. A refusal at (5) — mismatch, no SNI, two names,
      malformed, over the cap, end of stream — **destroys the socket**, since the `200` is already
      written: the client sees a TLS failure, not a `403`, and the smoke assertion below is written
      to that. Resolving and connecting *before* the `200` is what gives "Yahoo is down" and "the
      resolver is down" a signature: undici reports a non-`200` `CONNECT` answer as `Proxy response
      (502) !== 200 when HTTP Tunneling` in the worker's `fetch failed` cause, distinct from the bare
      socket close of an SNI teardown. The record is buffered to the length its 5-byte header
      declares, capped at 16 KB. A hand-rolled parser over the record and handshake headers, some
      forty lines; the tests feed synthetic ClientHellos — matching, mismatched, no SNI, two server
      names, truncated, over the cap, a non-TLS first byte — one of them **pipelined in the same
      write as the `CONNECT` line** and one arriving only after the `200`, and never open a socket
      to the internet: the upstream `net.connect` is injectable beside `dns.lookup`, and the tests
      point it at a local listener; a lookup that fails answers `502`, a connect that never
      completes answers `504` at the deadline, each logged once
- [ ] The destination is resolved with `dns.lookup(host, { all: true, family: 4 })` (injectable for
      the tests; IPv4 because every bridge has `enable_ipv6: false`) and the whole answer refused
      when any address in it is loopback, link-local or private — the check written family-agnostic
      all the same, `::1`, `fe80::/10` and `fc00::/7` included — since a LAN resolver pointing
      `finance.yahoo.com` at a LAN box (ADR-0005's adversary) must not make the proxy a pivot for a
      worker that skips certificate checks. The tunnel is the `net.connect` of step (2), tried
      against each address the lookup returned in turn within that one step's 5 s deadline overall —
      a multi-address answer whose first address refuses a connection must not fail a host whose
      second address would have answered — the buffered record replayed into whichever address
      connects, then piped both ways and torn down when either side ends; a tunnel silent for 60 s
      is torn down. Test: a lookup answering two addresses, the first refused and the second
      accepting, connects through the second within the one deadline
- [ ] The concurrency bound is on **accepted sockets, not tunnels** — a hostile worker that opens
      sockets and never sends a valid hello never reaches a tunnel counter, so a cap counted there
      bounds nothing. `server.maxConnections = 8` on the `node:http` server is the bound, and it
      holds for a socket's whole lifecycle, from accept to close, the healthcheck's own connection
      included. Beneath it, every stage that waits on the peer has an explicit deadline, each 5 s:
      accept to a complete request line and headers; the `dns.lookup` and the upstream connect; the
      `200` to a complete ClientHello. A deadline destroys the socket and logs once, with the 60 s
      idle teardown covering an established tunnel. This is the bound on a worker-driven denial
      (spec §8), and what makes the proxy's own exhaustion a denial of price refresh and nothing
      else. Tests: a ninth socket is not served while eight are held, and a socket that connects
      and says nothing is gone at the first deadline; with eight sockets held, a `GET /healthz` on a
      ninth gets nothing back within the healthcheck's own timeout — the case that pins why the
      healthcheck asks for a `200` and not a bare `net.connect`, which the accept queue can complete
      at the TCP level regardless
- [ ] One log line per refusal naming the reason and the host(s), and one per upstream failure
      naming the host and the cause, stem `Egress proxy`; none per allowed tunnel, and a connection
      that closes without a request line — the healthcheck's — is not a refusal and is not logged.
      `if (import.meta.main)` guard, as the worker has, and the worker's `SIGTERM` handler
      (`server.close(() => process.exit(0))` — Node is PID 1 under the compose `entrypoint`, and a
      stop is otherwise Docker's 10 s plus `SIGKILL`); `Dockerfile:104-110` gains the file

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
      `entrypoint: ["node", "./server/egress-proxy.ts"]`, `restart: unless-stopped`, `logging:
      *container-logging` (a compromised worker can flood the refusal log), the full hardening, uid
      1000, no `ports:`, the worker's bounds from [05](05-deploy-the-worker-alongside.md) —
      `pids_limit: 64`, the `256m` memory limit in the attribute 05 settled on, `tmpfs:
      ["/tmp:size=64m"]` — and a healthcheck that sends `GET /healthz` over its own `:8888` and
      requires the `200`, asking the server rather than merely connecting to it, as the worker's own
      asks its socket: a bare `net.connect` would read healthy with all eight `maxConnections` slots
      held by stalled tunnels, since the accept queue shakes hands at the TCP level regardless —
      only a request the HTTP server itself answers proves it is not saturated
- [ ] `compose.dev.yaml` gains an `egress-proxy` stanza with the same `build`, `image:
      portfolio-app:dev` and `pull_policy: build` shape [05](05-deploy-the-worker-alongside.md)
      gives `worker`; without it smoke would pull a GHCR release that lacks `server/egress-proxy.ts`
      and certify code this ticket did not write
- [ ] `worker` on `[worker-proxy]` alone, the socket volume still mounted, with `NODE_USE_ENV_PROXY:
      "1"` and `HTTPS_PROXY: http://egress-proxy:8888` — Node 24's `fetch` honours the pair only
      under the flag (research note §5.2, exercised: without it the fetch goes direct), the library
      uses global `fetch`, and both variables are the runtime's, not `config.ts`'s; `app` sets
      neither, and its calls to the worker travel a unix path no proxy setting touches. The worker
      now has no non-internal network: no resolver for public names (hostnames travel inside
      `CONNECT` and the proxy resolves them) and no route to the host's published `:80`
- [ ] The upgrade note: replace `compose.yaml`, `up -d`, then `docker network rm
      portfolio_egress-worker` (Compose does not remove an unused network) and check `docker network
      inspect -f '{{.Internal}}' portfolio_worker-proxy` prints `true`. The rollback note, mirroring
      [07](07-the-network-lockdown.md)'s: rolling `APP_VERSION` below this release under this
      compose file crash-loops `egress-proxy` — the old image has no `server/egress-proxy.ts` — and
      leaves the worker with no route out, `fetch failed` on every call and `Price provider failed`
      every tick with health green; roll `compose.yaml` back with the image. The compose header
      and, in [09](09-documents-and-runbooks.md), DESIGN.md's services block gain the service

**Smoke** (`scripts/smoke-test.sh`)

- [ ] The service lists gain `egress-proxy` (`:71`, `:342-350`, `:365-367`, `:379-385`, `:401-403`);
      no published port; `docker inspect` shows its pids and memory limits as
      [05](05-deploy-the-worker-alongside.md) asserts for `worker`
- [ ] From `worker`: a `fetch` of `https://query2.finance.yahoo.com/` through the proxy gets an HTTP
      answer of any status — best-effort, skipped with a notice when the runner cannot reach Yahoo,
      since the `403`, the SNI teardown and the stopped-proxy case below prove the control without
      it; `timeout 5 nslookup example.com` now fails;
      `worker-proxy` shows an empty IPAM `Gateway` and no host `inet`, as
      [07](07-the-network-lockdown.md)'s isolated networks do
- [ ] `docker compose stop egress-proxy`, then the same `fetch` from `worker` fails within its
      timeout; `start` it again. The network is the property, not the flag
- [ ] Through the proxy: `CONNECT mail.yahoo.com:443` is refused with `403`; `GET /healthz` answers
      `200`, and a plain `GET` to any other path answers `405`; a `CONNECT finance.yahoo.com:443`
      followed by a ClientHello whose server name is `mail.yahoo.com` (a few lines of `node:tls`
      with `servername`, from `worker`) is answered `200` and then torn down before any byte
      reaches the edge — the assertion is a TLS-level failure on that socket, never a `403`, which
      is what the order above buys

**Docs**

- [ ] `docs/operating.md` Security (`:485`) gains the paragraph: what the proxy allows, the
      server-name rule, what a refused `CONNECT` in its log means, and the one operator action —
      upgrade — when Yahoo moves a host. The Logs bullet for the `Price provider failed` stem
      (`:738`) — not `:761`'s "no price line" list, whose causes are a refresh that never ran —
      gains two signatures beside [06](06-the-app-cutover.md)'s dead worker: **the proxy is down**
      — `docker compose ps egress-proxy` not healthy, and every `Price worker` line of that minute
      carrying `fetch failed` with the same `ECONNREFUSED`/`ENOTFOUND egress-proxy` cause, answered
      to the app as a `502`; and **Yahoo or the resolver unreachable behind a healthy proxy** —
      `fetch failed: Proxy response (502)` (or `504`) on every `Price worker` line and one `Egress
      proxy` line per failed upstream naming the host and the cause. The worker stays healthy in
      both, since its healthcheck asks the socket and not Yahoo
- [ ] ARCHITECTURE.md §2 (`:92-100`): the worker reaches Yahoo through the proxy; the full sentence,
      and the env-reader row naming `NODE_USE_ENV_PROXY` and `HTTPS_PROXY` as the runtime's, are
      [09](09-documents-and-runbooks.md)'s

**Gates**

- [ ] `npm run typecheck`, `npm test`, `npm run build`, `scripts/smoke-test.sh` green
