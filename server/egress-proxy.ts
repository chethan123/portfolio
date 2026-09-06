/**
 * The egress proxy (spec 0018 §3.7, ticket 08): a `CONNECT`-only forward
 * proxy on `node:http`, `node:net` and `node:dns` — nothing else — admitting
 * exactly the five hosts `yahoo-finance2` 4.0.2 reaches, and only when the
 * TLS ClientHello *inside* the tunnel names the same host the client asked
 * to `CONNECT` to. It is the worker's only way out: `compose.yaml` gives
 * `worker` no other network, so a compromised worker can send bytes only to
 * what Yahoo's edge serves under a name this proxy matched.
 *
 * **Imports, and only these: `node:http`, `node:net`, `node:dns`.** No
 * `zod`, no `server/config.ts`, no `process.env` read anywhere in this file
 * — its whole closure is decorrelated from the npm tree and from the rest of
 * this repo's configuration, which is the point of writing a hundred-odd
 * lines here rather than pulling an image that already speaks CONNECT.
 *
 * **The allowlist is a module constant, not configuration**, compared
 * exactly and case-insensitively — never as a suffix, which would let
 * `evil-finance.yahoo.com.attacker.example` through a naive `endsWith`.
 * `query1`/`query2`.finance.yahoo.com and `finance.yahoo.com` are facts
 * about the pinned library: `query1` is hardcoded in the crumb path and in
 * `fundamentalsTimeSeries`, bypassing `YF_QUERY_HOST`, and `chart()` needs
 * no crumb at all, so quotes break before history does when one moves.
 * `guce.yahoo.com` and `consent.yahoo.com` are a different kind of fact —
 * they are not literal URLs anywhere in 4.0.2, only a snapshot of Yahoo's
 * *live* redirect chain (the crumb flow follows up to five hops of whatever
 * `Location` Yahoo answers, constrained only on the first hop). When Yahoo
 * moves one, this proxy answers `403` and quotes stop; the fix is a release
 * that edits this constant, not a runtime setting, which is exactly why it
 * is not one. `fc.yahoo.com`, named in older plans, is nowhere in 4.0.2 and
 * stays out. A sixth host reaches the network from the library's version
 * check — `registry.npmjs.org/yahoo-finance2/latest`, on by default — but it
 * never fires here because `yahoo-client.ts` constructs with
 * `versionCheck: false`; that coupling lives in this comment rather than in
 * the allowlist because flipping that one option elsewhere gets a silent
 * `403` from this proxy with nothing here to connect the two.
 *
 * **The order below is fixed, and it is this module's one hard invariant:**
 *
 *  1. The `CONNECT` host — port must be `443`, the host must be neither
 *     empty nor an IP literal, and it must be on {@link ALLOWED_HOSTS} — is
 *     checked with nothing upstream touched. Any failure here is `403`,
 *     logged, socket closed with a real HTTP response: nothing has been
 *     promised to this client yet.
 *  2. `dns.lookup(host, { all: true, family: 4 })`, the private-address
 *     guard, and `net.connect` to the upstream — tried against each address
 *     the lookup returned in turn — all within one {@link STAGE_DEADLINE_MS}
 *     deadline. A lookup failure or every address refusing is `502`, the
 *     whole answer containing a loopback/link-local/private address is
 *     `403` (ADR-0005's adversary: a LAN resolver must not turn this proxy
 *     into a pivot for a worker that skips certificate checks), and the
 *     deadline itself is `504`. Still nothing has been sent upstream, so the
 *     server-name property below is untouched by any of this.
 *  3. Only now is `HTTP/1.1 200 Connection Established` written to the
 *     client. Measured on Node 24.20 with `NODE_USE_ENV_PROXY=1`: an honest
 *     client sends **no bytes at all** ahead of this `200` — the `'connect'`
 *     event's `head` empty, zero bytes on the wire — and the ClientHello's
 *     `0x16` arrives only once it is written. Resolving and connecting
 *     *before* this line is what gives "Yahoo is down" and "the resolver is
 *     down" a distinct signature from an SNI teardown: undici reports a
 *     non-`200` `CONNECT` answer as `Proxy response (502) !== 200 when HTTP
 *     Tunneling` in the worker's own `fetch failed` cause, where a refusal
 *     after this line is a bare socket close. A proxy that waited for a
 *     hello before answering would deadlock every honest tunnel instead.
 *  4. The ClientHello is read via {@link readClientHelloRecord}, its record
 *     buffer **seeded from `head`** and filled from the socket after. Both
 *     halves are load-bearing, not belt-and-braces: a client *can* pipeline
 *     its hello into the very same write as the `CONNECT` line — measured,
 *     1595 bytes arriving whole in `head` — so a handler reading only
 *     `'data'` fails open on that client, while one reading only `head`
 *     never returns for the (more common) client that waits for the `200`
 *     first. The record is buffered to the length its own 5-byte header
 *     declares, capped at {@link MAX_RECORD_BYTES}, within the same
 *     {@link STAGE_DEADLINE_MS}.
 *  5. {@link parseServerName} fails closed on anything but one well-formed
 *     ClientHello carrying exactly one `server_name` — mismatched, absent,
 *     doubled, malformed, truncated, over the cap, or a first byte that
 *     is not `0x16` all take the same path. **The `200` is already
 *     written**, so refusing here can only destroy the socket: the client
 *     sees a TLS failure, never a `403`. This is why step 3 cannot move
 *     later and step 6 cannot move earlier — the `200` has to exist before
 *     a hello can arrive at all, and nothing may reach the upstream until
 *     this check passes, or a mismatched hello would already be relayed by
 *     the time it is caught.
 *  6. Only a match is replayed into the upstream socket and piped both
 *     ways, torn down on {@link IDLE_TEARDOWN_MS} of silence either side.
 *
 * **Bounds.** `server.maxConnections = 8` counts accepted sockets, not
 * tunnels — a worker that opens sockets and never sends a valid hello never
 * reaches a tunnel counter, so a cap counted there would bound nothing. Past
 * the eighth, a ninth socket is accepted and closed by Node itself, cleanly
 * and in about two milliseconds, with no error and no timeout; nothing here
 * runs for it; nothing here logs it — it never reaches a request line, so it
 * is not a refusal, the same way the price worker's own healthcheck note
 * distinguishes "the socket accepted" from "the server answered". Beneath
 * the cap, every stage that waits on the peer — the request line and
 * headers (`headersTimeout`/`requestTimeout`), step 2's resolve-and-connect,
 * step 4's read — has its own {@link STAGE_DEADLINE_MS}; an established
 * tunnel gets {@link IDLE_TEARDOWN_MS} instead, since a live tunnel is
 * exactly the thing worth keeping open.
 *
 * **Logs**, stem `Egress proxy`: one line per refusal, naming the reason and
 * the host(s), and one per upstream failure, naming the host and the cause.
 * That includes the deadline Node enforces before this file sees anything —
 * a peer that never completes a request line (`onClientError`) — since a
 * deadline nothing records is a slot a peer can hold repeatedly and
 * invisibly. None for an allowed tunnel, none for the maxConnections case
 * above, and none for an ordinary peer close. Both halves of every line go
 * through `logSafe`: the host and the `server_name` are bytes the peer
 * chooses, and this line is the audit trail it is being audited by.
 *
 * `if (import.meta.main)` guards the entry point, as `price-worker.ts` does.
 * The `SIGTERM` handler starts from that file's shape and cannot end there:
 * Node is PID 1 under the compose `entrypoint` and a stop is otherwise
 * Docker's 10 s wait plus `SIGKILL`, but `server.close()` — and
 * `closeAllConnections()` with it — leaves an *upgraded* socket alone, so a
 * proxy whose whole job is upgrading sockets has to destroy its own tunnels
 * first. Measured: one live tunnel and the close callback never fires.
 */
import dns from "node:dns";
import http from "node:http";
import net from "node:net";

/** The compose network's only route to this process (ticket 08's contract). */
const PORT = 8888;

/** Every stage that waits on the peer — request line, resolve+connect, hello — shares this deadline. */
const STAGE_DEADLINE_MS = 5_000;

/** An established tunnel silent this long, either direction, is torn down. */
const IDLE_TEARDOWN_MS = 60_000;

/**
 * How often Node sweeps for a connection that has blown {@link STAGE_DEADLINE_MS}.
 * A constructor-only option, and the default is 30 s — which would let a five
 * second deadline bind anywhere up to thirty-five. `server/price-worker.ts`
 * sets the same number for the same reason.
 */
const CONNECTIONS_CHECKING_INTERVAL_MS = 1_000;

/** A ClientHello record — 5-byte header plus payload — past this size is refused unread. */
const MAX_RECORD_BYTES = 16 * 1024;

/** The five hosts 4.0.2 reaches (module header has the argument for each). */
const ALLOWED_HOSTS = new Set(
  [
    "query1.finance.yahoo.com",
    "query2.finance.yahoo.com",
    "finance.yahoo.com",
    "guce.yahoo.com",
    "consent.yahoo.com",
  ].map((host) => host.toLowerCase()),
);

const STATUS_TEXT: Record<number, string> = {
  403: "Forbidden",
  405: "Method Not Allowed",
  502: "Bad Gateway",
  504: "Gateway Timeout",
};

/** Thrown by {@link resolveAndConnectUpstream} when step 2's own deadline fires first. */
class DeadlineExceededError extends Error {}
/** Thrown by {@link resolveAndConnectUpstream} when the whole answer contains a non-public address. */
class PrivateAddressError extends Error {}
/** Thrown by {@link readClientHelloRecord} and {@link parseServerName} — every step-4/5 failure. */
class HelloRejectedError extends Error {}

/** The one seam onto `node:dns` — production's own below, a local listener in tests. */
export type DnsLookupFn = (
  hostname: string,
  options: { all: true; family: 4 },
  callback: (error: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void,
) => void;

/** The one seam onto `node:net`'s upstream connect — production's own below, a local listener in tests. */
export type NetConnectFn = (
  options: { host: string; port: number },
  connectionListener: () => void,
) => net.Socket;

export type StartEgressProxyOptions = {
  port?: number;
  dnsLookup?: DnsLookupFn;
  netConnect?: NetConnectFn;
  stageDeadlineMs?: number;
  idleTeardownMs?: number;
};

const defaultDnsLookup: DnsLookupFn = (hostname, options, callback) =>
  dns.lookup(hostname, options, callback);

const defaultNetConnect: NetConnectFn = (options, connectionListener) =>
  net.connect(options, connectionListener);

const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/;

/** A `CONNECT` host that is already an address rather than a name — refused before the allowlist. */
function isIpLiteral(host: string): boolean {
  return IPV4_LITERAL.test(host) || host.includes(":");
}

/**
 * Loopback, link-local and private, IPv4 and IPv6 alike, written
 * family-agnostic even though production's own {@link defaultDnsLookup asks}
 * for `family: 4` alone (module header, step 2).
 */
function isPrivateAddress(address: string): boolean {
  // An IPv4-mapped IPv6 answer is the same address wearing a different
  // notation, and the checks below would miss every one of them, so it is
  // unwrapped before any of them run rather than duplicated into each.
  const bare = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)?.[1] ?? address;

  if (
    bare === "127.0.0.1" ||
    bare === "::1" ||
    bare.startsWith("127.") ||
    bare.startsWith("10.") ||
    bare.startsWith("169.254.") ||
    bare.startsWith("192.168.") ||
    // 0.0.0.0/8. Not a host address at all, but `connect(2)` treats `0.0.0.0`
    // as "this host" and lands on loopback — measured. It is also what a
    // blackholing LAN resolver answers with by default, which is ADR-0005's
    // adversary arriving by the one route this guard exists to close.
    bare.startsWith("0.") ||
    // 100.64.0.0/10, RFC 6598 shared address space — not routable on the
    // public internet, and a plausible answer from an ISP-supplied resolver.
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(bare)
  ) {
    return true;
  }
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(bare)) return true; // 172.16.0.0/12
  if (/^fe[89ab][0-9a-f]:/i.test(bare)) return true; // fe80::/10
  if (/^f[cd][0-9a-f]{2}:/i.test(bare)) return true; // fc00::/7
  return false;
}

/** `req.url` for a `CONNECT` request is exactly `host:port` — nothing else to parse. */
function parseConnectTarget(url: string | undefined): { host: string; port: number } | undefined {
  if (url === undefined) return undefined;
  const match = /^([^:]+):(\d+)$/.exec(url);
  if (!match) return undefined;
  return { host: match[1]!, port: Number.parseInt(match[2]!, 10) };
}

/**
 * Step 2: resolve, guard, and connect to the first address that accepts,
 * all within one {@link deadlineMs}. A late success arriving after the
 * deadline (or after an earlier address already won) is destroyed rather
 * than leaked — {@link settle}'s own guard.
 */
function resolveAndConnectUpstream(
  host: string,
  deadlineMs: number,
  dnsLookup: DnsLookupFn,
  netConnect: NetConnectFn,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let settled = false;

    // The attempt currently in flight, so the deadline below can destroy it.
    // A blackholing address is the case that needs this and the only one:
    // it answers neither the connect callback nor `'error'`, so nothing in
    // `tryAddress` ever runs again and `settle`'s own late-arrival guard —
    // which does destroy a socket that connects after the deadline — is
    // never reached. Left alone the socket sits in `SYN_SENT` until the
    // kernel gives up (`tcp_syn_retries`, minutes), while the client has
    // long since had its `504` and freed its `maxConnections` slot: the one
    // bound this proxy has does not count upstream sockets, so a worker
    // driving refusals at a blackholed address accumulates them unbounded.
    let pending: net.Socket | undefined;

    const timer = setTimeout(() => {
      settle(new DeadlineExceededError(`resolving or connecting to ${host} exceeded ${deadlineMs}ms`));
    }, deadlineMs);

    function settle(error: Error | undefined, socket?: net.Socket): void {
      if (settled) {
        socket?.destroy();
        return;
      }
      settled = true;
      clearTimeout(timer);
      // Only on the failure path: on success `pending` *is* the socket being
      // handed to the caller.
      if (error && pending !== undefined && pending !== socket) pending.destroy();
      pending = undefined;
      if (error) reject(error);
      else resolve(socket!);
    }

    function tryAddress(addresses: string[], index: number, lastError: Error | undefined): void {
      if (settled) return;
      if (index >= addresses.length) {
        settle(lastError ?? new Error(`${host} resolved to no usable address`));
        return;
      }
      let attemptDone = false;
      const socket = netConnect({ host: addresses[index]!, port: 443 }, () => {
        if (attemptDone) {
          socket.destroy();
          return;
        }
        attemptDone = true;
        settle(undefined, socket);
      });
      pending = socket;
      socket.once("error", (connectError: Error) => {
        if (attemptDone) return;
        attemptDone = true;
        socket.destroy();
        if (pending === socket) pending = undefined;
        tryAddress(addresses, index + 1, connectError);
      });
    }

    dnsLookup(host, { all: true, family: 4 }, (error, addresses) => {
      if (settled) return;
      if (error) {
        settle(error);
        return;
      }
      if (addresses.length === 0) {
        settle(new Error(`${host} resolved to no addresses`));
        return;
      }
      if (addresses.some((candidate) => isPrivateAddress(candidate.address))) {
        settle(new PrivateAddressError(`${host} resolved to a private address`));
        return;
      }
      tryAddress(
        addresses.map((candidate) => candidate.address),
        0,
        undefined,
      );
    });
  });
}

/**
 * Step 4: accumulate `head` and then `'data'` into one TLS record, to the
 * length its own 5-byte header declares, capped at {@link MAX_RECORD_BYTES}.
 * Resolves with the whole record (header included, for replay) and whatever
 * arrived past it in the same reads (for replay too, since it was drained
 * from the socket by this listener and would otherwise be lost before the
 * later `.pipe()`).
 */
function readClientHelloRecord(
  socket: net.Socket,
  head: Buffer,
  deadlineMs: number,
): Promise<{ record: Buffer; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buffer = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
    let settled = false;
    let declaredTotal: number | undefined;

    const timer = setTimeout(() => {
      finish(new HelloRejectedError("no complete ClientHello arrived within the deadline"));
    }, deadlineMs);

    function finish(error?: Error, result?: { record: Buffer; rest: Buffer }): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("close", onEnd);
      socket.off("error", onError);
      if (error) reject(error);
      else resolve(result!);
    }

    function evaluate(): void {
      if (buffer.length >= 1 && buffer[0] !== 0x16) {
        finish(new HelloRejectedError("first byte is not a TLS handshake record"));
        return;
      }
      if (declaredTotal === undefined && buffer.length >= 5) {
        declaredTotal = 5 + buffer.readUInt16BE(3);
        if (declaredTotal > MAX_RECORD_BYTES) {
          finish(
            new HelloRejectedError(
              `ClientHello record of ${declaredTotal} bytes exceeds the ${MAX_RECORD_BYTES}-byte cap`,
            ),
          );
          return;
        }
      }
      if (declaredTotal !== undefined && buffer.length >= declaredTotal) {
        finish(undefined, {
          record: buffer.subarray(0, declaredTotal),
          rest: buffer.subarray(declaredTotal),
        });
      }
    }

    function onData(chunk: Buffer): void {
      buffer = Buffer.concat([buffer, chunk]);
      evaluate();
    }
    function onEnd(): void {
      finish(new HelloRejectedError("the connection ended before a complete ClientHello arrived"));
    }
    function onError(error: Error): void {
      finish(error);
    }

    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("close", onEnd);
    socket.once("error", onError);

    evaluate();
  });
}

/**
 * Step 5: a hand-rolled walk over the ClientHello handshake message (the
 * record's payload, header already stripped by the caller) to its
 * `server_name` extension. Every read is bounds-checked against the
 * boundary its own length field declared — the body's, the extensions
 * block's, one extension's, or the SNI list's — so a truncated or
 * malformed hello throws {@link HelloRejectedError} rather than reading
 * past what the peer actually sent.
 */
function parseServerName(handshake: Buffer): string {
  let offset = 0;

  function need(end: number, n: number): void {
    if (offset + n > end) throw new HelloRejectedError("truncated ClientHello");
  }
  function u8(end: number): number {
    need(end, 1);
    return handshake[offset++]!;
  }
  function u16(end: number): number {
    need(end, 2);
    const value = handshake.readUInt16BE(offset);
    offset += 2;
    return value;
  }
  function u24(end: number): number {
    need(end, 3);
    const value = (handshake[offset]! << 16) | (handshake[offset + 1]! << 8) | handshake[offset + 2]!;
    offset += 3;
    return value;
  }
  function skip(end: number, n: number): void {
    need(end, n);
    offset += n;
  }

  const total = handshake.length;
  if (u8(total) !== 0x01) throw new HelloRejectedError("handshake message is not a ClientHello");
  // Two statements, deliberately not `offset + u24(total)`: the addition's
  // left operand would read `offset` *before* the call advances it, adding
  // the pre-read offset instead of the post-read one. Every `…End` below is
  // split the same way for the same reason.
  const bodyLength = u24(total);
  const bodyEnd = offset + bodyLength;
  if (bodyEnd > total) throw new HelloRejectedError("ClientHello body runs past the record");

  skip(bodyEnd, 2 + 32); // client_version, random
  skip(bodyEnd, u8(bodyEnd)); // session_id
  skip(bodyEnd, u16(bodyEnd)); // cipher_suites
  skip(bodyEnd, u8(bodyEnd)); // compression_methods

  const extensionsLength = u16(bodyEnd);
  const extensionsEnd = offset + extensionsLength;
  if (extensionsEnd > bodyEnd) throw new HelloRejectedError("extensions block runs past the ClientHello body");

  let serverName: string | undefined;
  while (offset < extensionsEnd) {
    const extensionType = u16(extensionsEnd);
    const extensionLength = u16(extensionsEnd);
    const extensionEnd = offset + extensionLength;
    if (extensionEnd > extensionsEnd) throw new HelloRejectedError("an extension runs past the extensions block");

    if (extensionType === 0x0000) {
      if (serverName !== undefined) throw new HelloRejectedError("more than one server_name extension");
      const listLength = u16(extensionEnd);
      const listEnd = offset + listLength;
      if (listEnd > extensionEnd) throw new HelloRejectedError("server_name list runs past its extension");
      let count = 0;
      while (offset < listEnd) {
        const nameType = u8(listEnd);
        const nameLength = u16(listEnd);
        need(listEnd, nameLength);
        // `latin1`, never `ascii`: the `ascii` decoder masks the high bit, so
        // bytes like 0xE6 0xE9 0xEE decode to "finance..." and would pass the
        // comparison below while the record replayed upstream still carried
        // the raw bytes — the edge would see a name the proxy never matched.
        const name = handshake.subarray(offset, offset + nameLength).toString("latin1");
        offset += nameLength;
        if (nameType === 0) {
          count += 1;
          serverName = name;
        }
      }
      if (count !== 1) throw new HelloRejectedError(`server_name list carries ${count} names, not one`);
    }
    offset = extensionEnd;
  }

  if (serverName === undefined) throw new HelloRejectedError("no server_name extension");
  return serverName;
}

/**
 * Control bytes out of what reaches `console.error`, exactly as
 * `server/price-worker.ts`'s own `logSafe` does and for the same reason: both
 * halves of a refusal line are peer-supplied. The host comes off the `CONNECT`
 * request line, and the reason quotes the `server_name` read out of the
 * ClientHello — bytes a compromised worker chooses. Left alone, one refused
 * hello could write many physical lines into the file an operator greps for
 * trouble, any of them free to open with this module's own `Egress proxy` stem
 * and so to forge a refusal that never happened. The line is the audit trail
 * this proxy is supposed to leave, which is precisely why it may not be
 * writable by the party being audited.
 */
function logSafe(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]/g, " ");
}

/** One line, stem `Egress proxy`, for every refusal — naming the reason and the host. */
function logRefusal(host: string | undefined, reason: string): void {
  console.error(`Egress proxy: refused CONNECT ${logSafe(host ?? "(unparseable target)")} — ${logSafe(reason)}`);
}

/** A refusal before the `200`: a real HTTP status, the socket then closed. */
function refuseWithStatus(socket: net.Socket, status: number, host: string | undefined, reason: string): void {
  logRefusal(host, reason);
  if (socket.writable) socket.end(`HTTP/1.1 ${status} ${STATUS_TEXT[status]}\r\n\r\n`);
  else socket.destroy();
}

/** A refusal after the `200`: no status is possible, only a torn-down socket (module header, step 5). */
function refuseTunnel(clientSocket: net.Socket, upstream: net.Socket, host: string, reason: string): void {
  logRefusal(host, reason);
  clientSocket.destroy();
  upstream.destroy();
}

type ConnectDeps = Required<Pick<StartEgressProxyOptions, "dnsLookup" | "netConnect" | "stageDeadlineMs" | "idleTeardownMs">> & {
  /**
   * Every socket of an *established* tunnel, so `SIGTERM` can end it. Node's
   * own `server.closeAllConnections()` does not: measured, a live `CONNECT`
   * tunnel survives it and `server.close()`'s callback never fires, because
   * an upgraded socket is no longer the HTTP server's to close. That is the
   * one place this file cannot simply copy `server/price-worker.ts`'s
   * shutdown — the worker upgrades nothing, so the same two lines are
   * sufficient there and silently insufficient here.
   */
  tunnels: Set<net.Socket>;
};

async function handleConnect(
  req: http.IncomingMessage,
  clientSocket: net.Socket,
  head: Buffer,
  deps: ConnectDeps,
): Promise<void> {
  // A defensive baseline for the whole lifetime of this socket: an
  // EventEmitter with zero 'error' listeners crashes the process on one,
  // and every later stage below attaches and removes its own more specific
  // listener rather than relying on this one to do real cleanup.
  clientSocket.on("error", () => {});

  const target = parseConnectTarget(req.url);
  if (target === undefined) {
    refuseWithStatus(clientSocket, 403, req.url, "CONNECT target is missing or malformed");
    return;
  }
  const { host, port } = target;

  if (port !== 443) {
    refuseWithStatus(clientSocket, 403, host, `disallowed port ${port}`);
    return;
  }
  if (isIpLiteral(host)) {
    refuseWithStatus(clientSocket, 403, host, "CONNECT host is an IP literal");
    return;
  }
  if (!ALLOWED_HOSTS.has(host.toLowerCase())) {
    refuseWithStatus(clientSocket, 403, host, "host is not on the allowlist");
    return;
  }

  let upstream: net.Socket;
  try {
    upstream = await resolveAndConnectUpstream(host, deps.stageDeadlineMs, deps.dnsLookup, deps.netConnect);
  } catch (error) {
    const status =
      error instanceof DeadlineExceededError ? 504 : error instanceof PrivateAddressError ? 403 : 502;
    refuseWithStatus(clientSocket, status, host, error instanceof Error ? error.message : String(error));
    return;
  }

  clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");

  let hello: { record: Buffer; rest: Buffer };
  try {
    hello = await readClientHelloRecord(clientSocket, head, deps.stageDeadlineMs);
    const serverName = parseServerName(hello.record.subarray(5));
    if (serverName.toLowerCase() !== host.toLowerCase()) {
      throw new HelloRejectedError(`server_name ${serverName} does not match CONNECT host ${host}`);
    }
  } catch (error) {
    refuseTunnel(clientSocket, upstream, host, error instanceof Error ? error.message : String(error));
    return;
  }

  deps.tunnels.add(clientSocket);
  deps.tunnels.add(upstream);
  const teardown = (): void => {
    deps.tunnels.delete(clientSocket);
    deps.tunnels.delete(upstream);
    clientSocket.destroy();
    upstream.destroy();
  };
  clientSocket.once("close", teardown);
  upstream.once("close", teardown);
  clientSocket.once("error", teardown);
  upstream.once("error", teardown);
  clientSocket.setTimeout(deps.idleTeardownMs, teardown);
  upstream.setTimeout(deps.idleTeardownMs, teardown);

  upstream.write(hello.record);
  if (hello.rest.length > 0) upstream.write(hello.rest);
  clientSocket.pipe(upstream);
  upstream.pipe(clientSocket);
}

/**
 * The first of the three deadlines — accept to a complete request line and
 * headers — expires inside Node, before {@link handleConnect} has anything to
 * refuse. Ticket 08 requires every deadline to log once, and measured, this
 * one logged nothing: a peer could hold slots to their deadline over and over
 * and leave no `Egress proxy` trail at all.
 *
 * `server.timeout` is what actually ends that socket, and its `'timeout'`
 * event is the only hook that fires *at* the deadline rather than on the next
 * `connectionsCheckingInterval` sweep — which is a race the short deadlines a
 * test uses lose outright, the socket being gone before the sweep looks.
 * Measured on 24.12.0: it does not fire for an upgraded socket, because
 * {@link handleConnect} gives every established tunnel a `setTimeout` of its
 * own and that replaces the server's — so this covers the pre-`CONNECT` stage
 * and nothing else, and an allowed tunnel still logs nothing.
 *
 * Attaching a listener replaces Node's own default here, which is to destroy
 * the socket; that is reproduced rather than skipped.
 */
function onHeaderDeadline(socket: net.Socket): void {
  // Not `logRefusal`: no `CONNECT` was ever received, so naming one — even as
  // "(unparseable target)" — would describe a request the peer never made.
  // The stem is the same, which is what an operator greps for.
  console.error("Egress proxy: no complete request line and headers before the deadline");
  socket.destroy();
}

/**
 * Attaching any `clientError` listener replaces Node's own default handling
 * for *every* parser error, not just the deadline above, so this reproduces
 * that mapping rather than collapsing the rest to `400`.
 * `server/price-worker.ts`'s `onClientError` is the same reasoning at more
 * length; it is duplicated rather than shared because this module's closure is
 * deliberately `node:http`, `node:net` and `node:dns` and nothing else, which
 * importing the worker would end.
 *
 * Nothing is logged here. The deadline is {@link onHeaderDeadline}'s to
 * report, and it has already destroyed the socket by the time the sweep
 * raises `ERR_HTTP_REQUEST_TIMEOUT` for it — so the `writable` guard, which
 * is Node's own, both keeps the contract at one line per refusal and keeps a
 * bare `ECONNRESET` from becoming the log flood that contract exists to
 * prevent.
 */
function onClientError(error: Error, socket: net.Socket): void {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "HPE_HEADER_OVERFLOW") {
    socket.write("HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n");
  } else if (code === "HPE_CHUNK_EXTENSIONS_OVERFLOW") {
    socket.write("HTTP/1.1 413 Payload Too Large\r\nConnection: close\r\n\r\n");
  } else if (code === "ERR_HTTP_REQUEST_TIMEOUT") {
    socket.write("HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n");
  } else {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  }
  socket.destroy();
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.method === "GET" && req.url === "/healthz") {
    res.writeHead(200);
    res.end();
    return;
  }
  res.writeHead(405);
  res.end();
}

/** Starts the proxy and returns the listening server — the test seam, and the entry's one call below. */
export async function startEgressProxy(options: StartEgressProxyOptions = {}): Promise<http.Server> {
  const port = options.port ?? PORT;
  const deps: ConnectDeps = {
    dnsLookup: options.dnsLookup ?? defaultDnsLookup,
    netConnect: options.netConnect ?? defaultNetConnect,
    stageDeadlineMs: options.stageDeadlineMs ?? STAGE_DEADLINE_MS,
    idleTeardownMs: options.idleTeardownMs ?? IDLE_TEARDOWN_MS,
    tunnels: new Set<net.Socket>(),
  };

  // `connectionsCheckingInterval` is the one that makes the two above mean
  // what they say. Node sweeps for expired headers on that interval and the
  // default is 30 s, so a 5 s deadline left alone binds anywhere up to 35 —
  // measured here before it was set: a silent socket lived 30004 ms. That is
  // the same trap `server/price-worker.ts` documents and sets past, and a
  // looser bound here is a cheaper denial of the proxy's own healthcheck,
  // which shares the `maxConnections` budget with every tunnel.
  const server = http.createServer(
    {
      headersTimeout: deps.stageDeadlineMs,
      requestTimeout: deps.stageDeadlineMs,
      connectionsCheckingInterval: CONNECTIONS_CHECKING_INTERVAL_MS,
    },
    handleRequest,
  );

  server.maxConnections = 8;
  server.timeout = deps.stageDeadlineMs;

  server.on("clientError", onClientError);
  server.on("timeout", onHeaderDeadline);

  server.on("connect", (req, duplexSocket, head) => {
    // Typed `stream.Duplex` by @types/node (the same generality `upgrade`
    // and `clientError` get), but always the real underlying `net.Socket`
    // for an HTTP server bound to a TCP port — `setTimeout` below is a
    // `net.Socket` method a bare `Duplex` does not have.
    const clientSocket = duplexSocket as net.Socket;
    handleConnect(req, clientSocket, head, deps).catch((error: unknown) => {
      console.error("Egress proxy: unhandled tunnel error", error);
      clientSocket.destroy();
    });
  });

  // Node is PID 1 under the compose `entrypoint` and ignores a signal it
  // has no handler for; without this every stop is Docker's 10 s wait plus
  // `SIGKILL` (price-worker.ts's own `SIGTERM` shape and its own reasoning).
  const onSigterm = (): void => {
    // Tunnels first: `closeAllConnections()` leaves an upgraded socket
    // alone, so without this a single live tunnel holds `close()`'s
    // callback until the 60 s idle teardown — well past Docker's 10 s
    // grace, ending in the `SIGKILL` this handler exists to avoid.
    for (const socket of deps.tunnels) socket.destroy();
    deps.tunnels.clear();
    server.closeAllConnections();
    server.close(() => process.exit(0));
  };
  process.on("SIGTERM", onSigterm);
  server.once("close", () => process.removeListener("SIGTERM", onSigterm));

  await new Promise<void>((resolve, reject) => {
    const onListenError = (error: Error): void => {
      process.removeListener("SIGTERM", onSigterm);
      reject(error);
    };
    server.once("error", onListenError);
    server.listen(port, () => {
      server.removeListener("error", onListenError);
      resolve();
    });
  });

  console.log(`Egress proxy listening on ${port}`);

  return server;
}

// `undefined` under vitest (Node ≥ 24.2) — the loop below never runs under the test suite.
if (import.meta.main) {
  startEgressProxy().catch((error: unknown) => {
    console.error(`Egress proxy: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
