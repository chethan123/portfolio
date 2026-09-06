# Security

**This app holds no credential to any bank or broker.** There is no account linking, no Plaid, no
Yodlee, and no password to a financial institution anywhere in it. It learns what you hold because
you upload a statement you downloaded yourself, or type a balance in. That is the whole of the
ingest path, and it is why the rest of this page can be short. The only secrets the box keeps are
its own: the database password and the gate's two Google secrets, in `.env`, plus the unlock grants
in its own database (§3). No credential to anything of yours is among them.

You are weighing this against a hosted aggregator that does hold those logins. This page covers what
leaves your box, what defends what, and what is not defended.

Three claims shape the design. Each holds with exceptions, and the exceptions are named below:

- **The containers holding your money data have no route to the internet.**
- **The container that talks to the internet holds no database credential and cannot reach the database.**
- **Once the household has enrolled a passkey, a browser that has gone idle is refused every
  screen until one is checked.** Before that, there is nothing to check and nothing is refused.

Where this page and [`../compose.yaml`](../compose.yaml) disagree, believe `compose.yaml` — it
enforces most of what follows, and the services and networks it declares are the thing itself
rather than a description of it.

## 1. What leaves the box

Two things while it runs, to two companies, and neither is a number you care about. Deploying
adds one more kind of contact: the image registries learn when you pull. Nothing in either group is
a figure.

```mermaid
graph TB
    subgraph box["Your box"]
        never["<b>Never leaves</b><br/>balances · quantities · cost basis<br/>account names and numbers · people<br/>uploaded statements · every dump"]
        gate["gate"]
        worker["worker"]
    end

    google["<b>Google</b><br/>identity only"]
    yahoo["<b>Yahoo Finance</b><br/>ticker symbols, and how far back<br/>you need prices for them"]

    gate ==>|"who signs in, and when"| google
    worker ==>|"the tickers you hold"| yahoo

    classDef keep fill:#f8eeee,stroke:#a05a5a,color:#3f2020
    classDef svc fill:#eef3f8,stroke:#4a6d8c,color:#1c2f42
    classDef ext fill:#f5f0e8,stroke:#8a7a5c,color:#3b3222
    class never keep
    class gate,worker svc
    class google,yahoo ext
```

- **Google learns who signs in and when.** That is what the sign-in gate is. It never sees a figure.
- **Yahoo learns which tickers you hold**, every fifteen minutes by default — a setting in
  Settings → Prices. Once anyone has loaded a page since the last restart, that timer runs whether
  or not anyone is still looking. Its own ticks skip the quote fetch outside market hours, but
  pressing Refresh now or committing an upload fetches at any hour, and any tick may fill in missing
  daily history — a few instruments per tick, and only ones missing prices. Yahoo never learns how
  many shares, or what they are worth to you. It does learn, for a ticker whose history is being
  filled, a date a week before the earliest you have held it.
- **Nothing else.** No analytics, no error reporting, no CDN, no third-party script of any kind in
  the page — and no web font from anyone else's server: the one typeface is a file this box serves
  itself. The service worker stores nothing on the device — no Cache Storage, no IndexedDB. That is
  not the same as nothing being kept: every response carries `no-store`, but Chrome admits such a
  page to its back/forward cache anyway for about three minutes, so a page already drawn can come
  back on a swipe. §7 has the limit in full.
- **Starting the stack contacts the image registries** — `ghcr.io`, Docker Hub, `quay.io`. The app's
  three containers are set to pull on every `docker compose up`, so those registries learn when you
  deploy, and nothing else.

## 2. If something goes wrong

| If this happens | What stops it | What still gets through |
|---|---|---|
| A device on your LAN dials the box | The **gate** — Google sign-in plus an address allowlist, enforced by this stack's own Caddy | `/healthz`, the one path that reaches the app without a check. It answers 200 only when the database is reachable and every migration is recorded, and names the pending files when it is not — with one weaker reading: if the migration ledger itself cannot be read, the answer is a 503 whose body still says `migrations: "current"`. Believe the status code over that field. `/oauth2/*` goes past the check too, but only ever to the gate's own sign-in endpoints |
| Someone picks up a family phone that is already signed in | The **lock** — every screen refused until a passkey is checked | Pages already drawn stay drawn until that tab next asks the server for something |
| A poisoned release of the market-data package | It runs in `worker`: no database credential, no shared network with `app` or `db`, one route out | It still sees the tickers — pricing them is its job. And it is in the app image too; see §5 |
| A poisoned dependency inside the app itself | `app` sits on two internal networks with no default route; read-only root filesystem, every capability dropped | Everything. `app` holds the database credential, so it reads every figure — and although it has no route out of its own, it answers your browser through `caddy`, and no CSP constrains what that page may load or where it may post. **The browser is the way out.** The narrower relay through `caddy` to `gate` is §4's |
| Someone gets the disk, a dump, or the database volume | Nothing | Everything. Data is plaintext at rest, by decision — §8 |
| A script injected into a page | Nothing at the header layer | No CSP, HSTS, frame protection or `nosniff` is set anywhere — §7 |

## 3. The lock

The gate decides which *person* may reach the instance. The lock decides which *browser* may read it
once admitted. It exists because the gate holds its answer for seven days without rolling — the
default in oauth2-proxy v7.15.4, the version this stack pins, which `compose.yaml` deliberately does
not override — and there is no working sign-out. Without the lock, an unlocked family phone in someone else's hands is a week of
unchallenged access.

```mermaid
stateDiagram-v2
    direction LR
    [*] --> Refused
    Refused --> Locked: Google sign-in,<br/>address on the allowlist
    Locked --> Unlocked: passkey checked
    Unlocked --> Unlocked: activity — the window is extended<br/>only once less than half of it remains
    Unlocked --> Locked: fifteen minutes idle
    Unlocked --> Locked: "Lock now"
    Unlocked --> Locked: that passkey removed
```

- **A household with no passkey enrolled is not locked at all.** The lock's question is whether any
  passkey exists, so until the first one is enrolled every request passes straight through. On a
  fresh instance the gate is the only check there is.
- The refusal happens before any page code runs. A locked browser is not shown a blanked page — the
  query that would have fetched your holdings is never made.
- Unlocking writes a row in the database, the **grant**. Your browser gets a cookie holding nothing
  but a random id pointing at that row — HTTPS-only, unreadable by scripts, and not sent when
  another site posts to this one. **The row is what counts**, so revoking access is a delete rather
  than an expiry you wait out.
- The app stores only the **public half** of a passkey. It never sees your face, fingerprint or
  device PIN.
- The idle window is **fifteen minutes**, extended only when less than half remains — so the lock can
  arrive as little as seven and a half minutes after your last request. **There is no setting to
  change either figure.**
- Unlocking again replaces that browser's own previous grant. It does **not** end any other
  browser's — two devices unlocked with the same passkey each hold their own, and removing the
  passkey is what ends all of them at once.

Two corrections to the mental model most people arrive with:

**It is not necessarily a fingerprint.** The check is whatever your device accepts — a face, a
fingerprint and a device PIN all count the same. The lock is only as strong as whatever unlocks
passkeys on that device.

**Nothing is encrypted by the passkey.** This is the one most often assumed. The lock decides whether
the server will answer at all. It encrypts nothing. Anyone holding the database volume reads
everything without ever meeting it — §8.

## 4. The shape of the stack

Seven services on seven networks ([`../compose.yaml`](../compose.yaml)). Four of those are
`internal: true` with `gateway_mode_ipv4: isolated` — in Docker terms, no default route and no
bridge address at all. Not a firewall rule that could be misread, but the absence of anywhere to
send a packet.

**This needs Docker Engine 28.0 or newer.** Engine 26 accepts the option and ignores it, without
saying so; containers then keep an address on the host and can reach anything else your machine is
listening with. Engine 27 refuses the option outright. `internal: true` holds on every version, so
the route to the *internet* is closed either way — but check `docker version` before believing the
stronger half.

```mermaid
graph TB
    you["A family browser<br/>on the LAN"]
    house["Your own TLS proxy<br/>— outside this stack"]

    subgraph sealed["Holds your data — no route out"]
        app["<b>app</b><br/>the tracker"]
        db[("<b>db</b><br/>PostgreSQL")]
        dump["<b>dump</b><br/>scheduled pg_dump"]
    end

    subgraph lone["Reaches the proxy only"]
        worker["<b>worker</b><br/>asks Yahoo<br/>for prices"]
    end

    subgraph out["Has a route out — stores nothing"]
        caddy["<b>caddy</b><br/>the only<br/>published port"]
        gate["<b>gate</b><br/>Google sign-in<br/>+ allowlist"]
        proxy["<b>egress-proxy</b><br/>five hostnames"]
    end

    google["Google"]
    yahoo["Yahoo Finance"]

    you --> house --> caddy
    caddy -->|"every request<br/>except /healthz"| gate
    caddy --> app
    app --> db
    dump --> db
    app -.->|"a unix socket,<br/>app always dials"| worker
    worker --> proxy
    gate --> google
    proxy --> yahoo

    classDef data fill:#f8eeee,stroke:#a05a5a,color:#3f2020
    classDef svc fill:#eef3f8,stroke:#4a6d8c,color:#1c2f42
    classDef ext fill:#f5f0e8,stroke:#8a7a5c,color:#3b3222
    class app,db,dump data
    class caddy,gate,proxy,worker svc
    class google,yahoo,house,you ext
```

- **Only `caddy` publishes a port**, so no address on your LAN reaches `app` without passing the
  gate. `app` holds the database credential and `db` holds every byte of state; neither has a route
  out.
- **`caddy` stores nothing, and reads everything.** It terminates plain HTTP in both directions, so
  every rendered page of figures and both cookies pass through it in the clear — and it sits on
  `ingress`, a plain bridge with a default route. A compromised `caddy` cannot reach the database,
  but it can copy what is already on its way to a browser and send it out. "Stores nothing" in the
  diagram means exactly that, and not that it sees nothing.
- **`db` is reachable only from `app` and `dump`**, with no published port. Its password has no
  default; the stack refuses to start without one.
- **`worker` shares no network with `app`, `gate` or `db`** — not a rule about what it may do, but no
  address on any network they are on.
- **TLS is not in this stack.** The bundled Caddy serves plain HTTP; the certificate and public
  hostname are your proxy's job. That is also why the gate is enforced *here* rather than upstairs: a
  LAN device can dial this box directly, and that device is the threat the gate exists for.
- **Privilege is dropped, with the exceptions named.** All seven containers run read-only with
  `no-new-privileges` and every Linux capability dropped. Two hold one capability back: `caddy` keeps
  `NET_BIND_SERVICE`, without which the image's binary will not start, and `gate` keeps
  `DAC_READ_SEARCH` so it can open your allowlist file whatever its mode. And one runs as root —
  `gate`, the container that faces Google, because the published image sets no user. An automated
  test in CI reads all seven postures back out of the running containers rather than trusting the
  file, and probes the worker for the others by name and by every container address.

### The two ways the no-egress claim is not absolute

**The `caddy` → `gate` relay.** A compromised `app` still reaches `caddy`, because it must; `caddy`
passes `/oauth2/*` to `gate`; `gate` has real egress, because Google's token endpoint is on the
internet. `compose.yaml` names the path where it declares those networks: neither carries a default
route off it at IP level, and `app` still reaches `gate` through Caddy's `/oauth2/*`. The opening is
narrow: not a socket,
only whatever can be smuggled through a sign-in proxy's own endpoints. But what is on the far side is
the least restricted container here — `gate` runs as root, can reach the whole internet, and through
its network can reach the Docker host and anything else your machine is listening with. One more of
the same kind: Caddy believes the headers naming the original caller if they come from any address on
the local network, and `app`'s address is one, so `app` could fake them. The app itself decides
nothing on them. The gate does read them, so its sign-in redirects carry the outside hostname — but
the address a browser is returned to is pinned to `PUBLIC_ORIGIN` rather than taken from a header,
which is what keeps a forged one cheap.

**The external-database option.** If you run Postgres elsewhere and load
[`../compose.external-db.yaml`](../compose.external-db.yaml), `app` moves onto a network with a
gateway. That restores public DNS for `app` and gives it a route to the Docker host, and so to
anything else your machine is listening with. The file says so in its own header. The worker's
isolation is unaffected — the override adds no network and no variable to it — but it also removes
the `db` and `dump` containers, so on that path the stack takes **no dumps at all**, and backing up
the external database is yours. Taking this option gives up the first of the three claims at the top
of this page.

## 5. The price worker

`yahoo-finance2` is the one production dependency that opens a socket to the internet. The design
assumes it will eventually be what goes wrong, and is built so that it survives.
[`adr/0010`](adr/0010-price-fetching-is-an-egress-isolated-worker-behind-a-unix-socket.md) has the
argument, including the three adversaries it was judged against separately: a compromised app, a
compromised feed, and both at once.

It runs in `worker`. What makes that safe is not the image but what the process is denied: no
`DATABASE_URL` and no `PGPASSWORD` in its environment, no network any database is on, a capped
process count and memory, a read-only root filesystem, and one route out. Not the absence of a
database client — `pg` and the app's own pool module ride in the image like everything else, and
only the entrypoint's import graph leaves them unloaded. What makes them useless is that `worker`
sits alone with `egress-proxy`, shares no network with `db`, and holds no password to offer it.

**The honest limit of that.** `app`, `worker` and `egress-proxy` are one image started three ways, so
the package's files are physically present in the app container too. What keeps it out of your
database is that `app` never imports it, not that the app image lacks it. A package that attacks when
it is *imported* is contained by this design. A package that attacks when it is *installed*, during
the image build, is inside all three containers before any of this applies — see §6.

```mermaid
sequenceDiagram
    autonumber
    participant app as app<br/>holds the database
    participant worker as worker<br/>holds no credential
    participant proxy as egress-proxy
    participant yahoo as Yahoo Finance

    app->>worker: POST /quotes over a unix socket
    Note over app,worker: A 1 MB tmpfs volume carries the socket file,<br/>never the data — app dials, worker never dials back.
    worker->>proxy: CONNECT query1.finance.yahoo.com:443
    proxy->>proxy: On the allowlist? Port 443?<br/>Not an IP literal?<br/>DNS answer outside private ranges?
    proxy-->>worker: 200 Connection Established
    worker->>proxy: TLS ClientHello
    proxy->>proxy: Does the SNI equal the host it asked for?
    proxy->>yahoo: relays bytes, never decrypts them
    yahoo-->>worker: quotes
    worker-->>app: raw JSON, validated on arrival
    Note over app: app alone writes to the database
```

The socket is a 1 MB tmpfs volume defined in [`../compose.yaml`](../compose.yaml). The proxy is
hand-written Node in [`../server/egress-proxy.ts`](../server/egress-proxy.ts) — `node:http`,
`node:net`, `node:dns` and no other import, so it is not itself a third-party dependency. Three
things the diagram cannot show:

1. **The five hostnames are compared exactly** — a list written into that file, not read from
   configuration — never as a suffix, so `query1.finance.yahoo.com.evil.test` does not match, and a
   compromised process cannot widen it.
2. **It never decrypts anything.** It checks the hostname sent in the clear at the start of the
   handshake against the one the client asked for, then relays bytes.
3. **A DNS answer pointing back inside your network is refused**, so a poisoned resolver cannot turn
   the proxy into a way back in.

A compromised market-data package therefore gets the ticker list, the timing, and a tunnel to Yahoo.
It does not get the database, the balances, a route to your LAN, or anywhere else to send what it
learns.

## 6. Supply chain

**In place** — each is a file you can check, not a policy:

- `package-lock.json` is committed and every install path uses `npm ci`, so builds resolve to the
  exact versions and integrity hashes recorded, never to whatever the registry offers today.
- `npm ci` fails when a tarball does not match the SHA-512 hash `package-lock.json` records for it,
  so a pinned name and version republished with different contents is refused on every install path,
  the image build included. CI adds `npm audit signatures`, which verifies the registry's own
  signature over each package's name, version and hash — the thing a lockfile cannot do for you,
  since a lockfile only guarantees you keep getting the bytes it recorded, whether or not those were
  the bytes the registry published. CI also blocks on `npm audit --omit=dev --audit-level=high`.
- CI **fails the build if any production entry in the lockfile declares `hasInstallScript`, `os` or
  `cpu`**, and the image publish depends on that job. It removes the most common way a poisoned
  package runs. It is a check on what the lockfile *declares*, not on what a tarball holds: a package
  shipping a prebuilt native addon or a WASM blob and loading it at import time declares none of the
  three and passes.
- The release image prunes the dev tree and unreachable runtime dependencies, and deletes the
  TypeScript compiler.
- The container hardening and the worker's quarantine, in §4 and §5.

**Not in place** — do not assume these:

- **No Dependabot or Renovate.** Updates are manual and deliberate. Nothing sweeps for a
  newly-disclosed advisory between releases.
- **No SBOM and no build provenance** for the published image; both are explicitly disabled in CI.
  **No image signing.**
- **No digest pinning anywhere.** Base images and the app image are pinned by tag, which trusts the
  publisher not to move it. Pinning `APP_VERSION` to a `tag@sha256:` digest is the only form that
  holds against a compromised publisher, and it is not the documented default.
- **`--ignore-scripts` is used only in the audit job**, not in the build. An install script in a dev
  dependency still runs on the path that produces the release image — the gap §5's honest limit
  points at.
- **No reproducible build, and no runtime integrity check.**

## 7. What this does not protect against

- **No encryption at rest** — a deliberate choice, argued in
  [`adr/0009`](adr/0009-the-stack-takes-dumps-not-backups.md).
- **No security response headers at all** — no CSP, no HSTS, no `X-Frame-Options`, no `nosniff`.
  Neither the app nor the bundled Caddy sets one.
- **No rate limiting** — not on sign-in, not on unlocking.
- **No CSRF token.** Instead, every request that changes data must say which site it came from, and
  neither cookie is sent when another site posts to this one. A request naming no site at all passes
  that check — but browsers always name one when posting across sites, so anything exploiting the gap
  is not a browser, and has no cookie to abuse.
- **No authorization inside the app.** Everyone the allowlist admits sees everything. Choosing whose
  accounts a screen shows is a filter on the view, never a permission.
- **Request bodies are effectively unbounded.** An upload that declares its size is refused if it is
  too big. One that declares no size is not, only the file part is measured at all, and every other
  form buffers whatever arrives. No size limit is set at either proxy.
- **The lock does not un-draw pixels.** A tab already showing figures keeps showing them until it
  next asks the server for something, and a browser's back/forward cache can serve a rendered stale
  page for minutes after a grant is revoked elsewhere.
- **A passkey check does not prove someone was just there.** A device whose passkeys are already
  unlocked may answer without prompting anyone. That raises the cost of a borrowed phone; it does not
  close it.
- **A household whose only passkey becomes unreachable cannot recover by itself** — removing a
  passkey needs a check from a reachable one, and the only one that will do is the one that is gone.
  That falls back to you, at a shell. A synced passkey may outlive the phone it was enrolled on: the
  stack records whether each is backup-eligible and hands its transports back so a browser can offer
  the cross-device flow. Do not plan on it. **Enrol a second passkey.**
- **A poisoned price is not detected.** The feed's answers are checked for shape, never for truth,
  and nothing compares them against a second source. A compromised feed cannot read what you hold,
  but it can change what a screen says you are worth.
- **The documented external-Postgres path never requires TLS** to the database.
- **This is not safe to publish on the open internet as it stands.** It is built for a box behind
  your own proxy, on your own network.

The list above is what a reader deciding whether to run this most needs. `DESIGN.md` §14 carries the
full recorded set, including the ones that matter more to someone changing the code than to someone
installing it: the socket volume is fenced on the app's side only, the app is still the database
superuser, and the worker's own rate caps bound an honest worker rather than a compromised one.

An older audit,
[`research/2026-09-02-security-and-privacy-audit.md`](research/2026-09-02-security-and-privacy-audit.md),
has the longer argument behind several of these, but it is a snapshot against one commit and some of
what it found has since been fixed.

## 8. What you carry

The stack cannot do these for you.

1. **Encrypt the disk.** Everything above only decides who gets an answer from the running app. None
   of it helps once someone has the disk.
2. **Encrypt the dumps and keep them off the host.** A dump is every balance, every statement and
   every original uploaded CSV, in plaintext. Encryption is the collecting tool's job.
3. **Pin `APP_VERSION` to a digest** if you want the image tag to hold against a compromised
   publisher.
4. **Enrol a second passkey**, on a second device, before you need it.
5. **Terminate TLS yourself**, and keep the box off the open internet.
6. **Keep the address allowlist short.** It is the whole of who may enter; there is no second check
   behind it.

[`operating.md`](operating.md) covers three of these and points somewhere useful for a fourth:
"Reverse proxy and TLS" for terminating it yourself, its allowlist section for who may enter, and
its recovery section for why the second passkey matters. The rest are genuinely yours — there is no
disk-encryption procedure there, "Backups" says nothing about encrypting a dump or moving it off the
host, and "Upgrading" documents the floating `APP_VERSION` tag rather than pinning to a digest.

## 9. Checking this yourself

Do not take the diagrams on trust. Against your own running stack:

```sh
docker version --format '{{.Server.Version}}'   # 28.0+, or §4's stronger half does not hold

# The worker holds no database credential — expect no output at all.
docker compose exec worker env | grep -E 'DATABASE_URL|PGPASSWORD'

# The app has no route out — expect a refusal, not a page. The abort budget is
# load-bearing: a SYN into a route that does not exist can hang far longer than
# a DNS failure does.
docker compose exec app node -e "fetch('https://example.com',{signal:AbortSignal.timeout(5000)}).then(r=>console.log('REACHED',r.status),e=>console.log('refused:',e.cause?.message??e.message))"

# The worker's route out is the allowlist only — expect a refusal for anything but Yahoo.
docker compose exec worker node -e "fetch('https://example.com',{signal:AbortSignal.timeout(5000)}).then(r=>console.log('REACHED',r.status),e=>console.log('refused:',e.cause?.message??e.message))"

# Only one published port in the whole stack: exactly one row shows a host
# mapping (`->`). Bare entries like `3000/tcp` are ports nothing publishes.
docker compose ps -a --format '{{.Service}}\t{{.Ports}}'
```

If any of these surprises you, trust the result over this page and check
[`../compose.yaml`](../compose.yaml).

## Where the detail lives

- [`operating.md`](operating.md) — the decisions that are yours: the gate's admission conditions, the
  proxy's refusal shapes, recovery when every passkey is gone, upgrades.
- `ARCHITECTURE.md` §7.6 — the control table, for someone reading the code.
- [`adr/0005`](adr/0005-auth-is-a-forward-auth-gate.md) — why authentication is a sidecar rather than
  code, and why a VPN was rejected for this threat model.
- [`adr/0010`](adr/0010-price-fetching-is-an-egress-isolated-worker-behind-a-unix-socket.md) — why
  the price worker is a separate process behind a socket, and what the shape was chosen against.
- [`adr/0012`](adr/0012-a-browser-past-the-gate-is-shown-nothing.md) — why the lock exists and what
  it deliberately does not promise.
- [`adr/0002`](adr/0002-masking-is-a-display-state.md) — why masking is a display state and must
  never be described as access control.
- `DESIGN.md` §14 — every limitation this project has accepted on purpose, in its own words.
- [`guide/passkeys.md`](guide/passkeys.md) — the family-facing version of §3.
- [`data-model.md`](data-model.md) — every table explained, with extraction queries. This is the
  answer to "what if this project stops being maintained": the data is ordinary Postgres, and that
  document is written for someone rebuilding around a dump without the app.
