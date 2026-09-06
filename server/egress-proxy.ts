/**
 * The egress proxy (spec 0018 §3.7, ticket 08): a `CONNECT`-only forward proxy on `node:http`,
 * `node:net` and `node:dns` — nothing else, no `zod`, no config, no `process.env` — admitting the
 * five hosts `yahoo-finance2` 4.0.2 reaches, and only when the TLS ClientHello inside the tunnel
 * names the same host the `CONNECT` asked for. `compose.yaml` gives `worker` no other network.
 *
 * The allowlist is a module constant, compared exactly and case-insensitively — never as a suffix,
 * which would admit `evil-finance.yahoo.com.attacker.example`. `guce`/`consent` are a snapshot of
 * Yahoo's live redirect chain rather than literals in 4.0.2: when Yahoo moves one, quotes stop on a
 * `403` and the fix is a release. A sixth host, the library's `registry.npmjs.org` version check,
 * is never reached only because `yahoo-client.ts` constructs with `versionCheck: false`.
 *
 * The order below is this module's one hard invariant:
 *
 *  1. The `CONNECT` host — port 443, non-empty, not an IP literal, on {@link ALLOWED_HOSTS} —
 *     checked with nothing upstream touched. Any failure is a logged `403` with a real response.
 *  2. Resolve, guard the whole answer against loopback/link-local/private addresses (ADR-0005: a
 *     LAN resolver must not make this proxy a pivot), and connect, within {@link STAGE_DEADLINE_MS}:
 *     `502` for a failed lookup or every address refusing, `403` for a private answer, `504` for the
 *     deadline. Nothing has been sent upstream yet.
 *  3. Only now is `200 Connection Established` written. An honest client sends no bytes before it
 *     (measured, Node 24.20), and resolving first is what gives "Yahoo is down" its own signature:
 *     undici reports a non-`200` CONNECT answer, where a refusal after this line is a bare close.
 *  4. The ClientHello is read with the buffer seeded from `head` *and* filled from `'data'`: a
 *     client may pipeline the hello into the `CONNECT` write (measured, 1595 bytes in `head`), and
 *     the more common one sends nothing until the `200`. Capped at {@link MAX_RECORD_BYTES}.
 *  5. {@link parseServerName} fails closed on anything but one well-formed `server_name`. The `200`
 *     is already written, so a refusal here can only destroy the socket — which is why step 3 cannot
 *     move later and step 6 cannot move earlier.
 *  6. Only a match is replayed upstream and piped both ways, torn down on {@link IDLE_TEARDOWN_MS}.
 *
 * `maxConnections = 8` counts accepted sockets, not tunnels: a socket that never sends a valid
 * hello would never reach a tunnel counter. A ninth is accepted and closed by Node itself, unlogged.
 *
 * Logs, stem `Egress proxy`: one line per refusal and per upstream failure, none for an allowed
 * tunnel. Both halves go through `logSafe` — the host and the `server_name` are bytes the audited
 * peer chooses. `SIGTERM` must destroy established tunnels itself: `server.close()` and
 * `closeAllConnections()` leave an upgraded socket alone and the close callback never fires.
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
 * How often Node sweeps for a blown {@link STAGE_DEADLINE_MS}. Constructor-only, and the 30 s
 * default would let a five-second deadline bind anywhere up to thirty-five.
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

/** Loopback, link-local and private, IPv4 and IPv6 alike, though production asks for `family: 4`. */
function isPrivateAddress(address: string): boolean {
  // An IPv4-mapped IPv6 answer is the same address in another notation, unwrapped once here rather
  // than duplicated into every check below.
  const bare = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)?.[1] ?? address;

  if (
    bare === "127.0.0.1" ||
    bare === "::1" ||
    bare.startsWith("127.") ||
    bare.startsWith("10.") ||
    bare.startsWith("169.254.") ||
    bare.startsWith("192.168.") ||
    // 0.0.0.0/8. `connect(2)` treats `0.0.0.0` as "this host" and lands on loopback — measured —
    // and it is also what a blackholing LAN resolver answers by default.
    bare.startsWith("0.") ||
    // 100.64.0.0/10, RFC 6598 shared address space — a plausible ISP-resolver answer.
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
 * Step 2: resolve, guard, and connect to the first address that accepts, within {@link deadlineMs}.
 * A success arriving after the deadline, or after another address won, is destroyed rather than leaked.
 */
function resolveAndConnectUpstream(
  host: string,
  deadlineMs: number,
  dnsLookup: DnsLookupFn,
  netConnect: NetConnectFn,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let settled = false;

    // The attempt in flight, so the deadline can destroy it. A blackholing address is the case that
    // needs it: it answers neither the connect callback nor `'error'`, so `settle`'s late-arrival
    // guard is never reached and the socket sits in `SYN_SENT` for minutes, while the client has
    // long since had its `504` and freed the only slot this proxy counts.
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
      // Only on the failure path: on success `pending` *is* the socket handed to the caller.
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
 * Step 4: accumulate `head` and then `'data'` into one TLS record, to the length its own 5-byte
 * header declares, capped at {@link MAX_RECORD_BYTES}. Resolves with the whole record (header
 * included, for replay) and whatever arrived past it — drained here, so otherwise lost to `.pipe()`.
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
 * Step 5: a hand-rolled walk to the ClientHello's `server_name` extension (record header already
 * stripped). Every read is bounds-checked against the boundary its own length field declared, so a
 * truncated or malformed hello throws {@link HelloRejectedError} rather than reading past it.
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
  // Two statements, not `offset + u24(total)`: the addition's left operand would read `offset`
  // before the call advances it. Every `…End` below is split the same way.
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
        // `latin1`, never `ascii`: the `ascii` decoder masks the high bit, so 0xE6 0xE9 0xEE would
        // decode to "finance…" and match, while the record replayed upstream carries the raw bytes.
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
 * Control bytes out of what reaches `console.error`, as `server/price-worker.ts`'s `logSafe` does:
 * the host and the `server_name` are peer-supplied, and a raw newline would let the party being
 * audited forge a refusal line under this module's own stem.
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
   * Every socket of an *established* tunnel, so `SIGTERM` can end it: `server.closeAllConnections()`
   * does not — measured, an upgraded socket survives it and `close()`'s callback never fires.
   */
  tunnels: Set<net.Socket>;
};

async function handleConnect(
  req: http.IncomingMessage,
  clientSocket: net.Socket,
  head: Buffer,
  deps: ConnectDeps,
): Promise<void> {
  // A baseline for the socket's whole lifetime: an EventEmitter with no `'error'` listener crashes
  // the process. Every later stage attaches its own more specific one.
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
 * The first deadline — accept to a complete request line and headers — expires inside Node, before
 * {@link handleConnect} has anything to refuse, and logged nothing: a peer could hold slots to the
 * deadline repeatedly and leave no trail. `server.timeout`'s `'timeout'` event is the only hook
 * that fires *at* the deadline rather than on the next sweep, and it does not fire for an upgraded
 * socket (24.12.0), whose own `setTimeout` replaces the server's. Attaching a listener replaces
 * Node's default, which is to destroy the socket; that is reproduced below.
 */
function onHeaderDeadline(socket: net.Socket): void {
  // Not `logRefusal`: no `CONNECT` was received, so naming one would describe a request the peer
  // never made. The stem is the same, which is what an operator greps for.
  console.error("Egress proxy: no complete request line and headers before the deadline");
  socket.destroy();
}

/**
 * Attaching any `clientError` listener replaces Node's default for *every* parser error, so this
 * reproduces that mapping rather than collapsing the rest to `400`. Duplicated from
 * `server/price-worker.ts` rather than shared: importing it would end this module's closure.
 *
 * Nothing is logged here — the deadline is {@link onHeaderDeadline}'s to report, and the `writable`
 * guard (Node's own) keeps a bare `ECONNRESET` from becoming a log flood.
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

  // `connectionsCheckingInterval` is what makes the two deadlines above mean what they say: on the
  // 30 s default a silent socket lived 30004 ms here, measured, against a 5 s deadline.
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
    // Typed `stream.Duplex` by @types/node but always the real `net.Socket` for a server bound to a
    // TCP port — `setTimeout` below is a `net.Socket` method a bare `Duplex` lacks.
    const clientSocket = duplexSocket as net.Socket;
    handleConnect(req, clientSocket, head, deps).catch((error: unknown) => {
      console.error("Egress proxy: unhandled tunnel error", error);
      clientSocket.destroy();
    });
  });

  // Node is PID 1 under the compose `entrypoint` and ignores a signal it has no handler for;
  // without this every stop is Docker's 10 s wait plus `SIGKILL`.
  const onSigterm = (): void => {
    // Tunnels first: `closeAllConnections()` leaves an upgraded socket alone, so one live tunnel
    // would hold `close()`'s callback until the 60 s idle teardown, well past Docker's grace.
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
