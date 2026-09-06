/**
 * CONNECT-only forward proxy, `worker`'s one route out (spec 0018 §3.7). Five hosts, exact
 * case-insensitive match — never a suffix (`evil.yahoo.com.attacker.example`).
 *
 * Order is the invariant: allowlist -> resolve + reject non-public addresses (ADR-0005) ->
 * write `200` -> read ClientHello -> SNI must match. The `200` cannot move later (undici
 * needs a non-200 to report "Yahoo is down") or earlier (a mismatch after it can only
 * destroy the socket). `SIGTERM` must destroy tunnels itself: `closeAllConnections()` skips
 * upgraded sockets.
 */
import dns from "node:dns";
import http from "node:http";
import net from "node:net";

const PORT = 8888;

/** Every stage that waits on the peer — request line, resolve+connect, hello — shares this deadline. */
const STAGE_DEADLINE_MS = 5_000;

const IDLE_TEARDOWN_MS = 60_000;

/** Sweep interval for {@link STAGE_DEADLINE_MS}. Constructor-only; on the 30 s default a 5 s deadline binds at 35 s. */
const CONNECTIONS_CHECKING_INTERVAL_MS = 1_000;

/** A ClientHello record — 5-byte header plus payload — past this size is refused unread. */
const MAX_RECORD_BYTES = 16 * 1024;

/** The five hosts 4.0.2 reaches (docs/specs/price-worker/08-the-egress-allowlist.md argues each). */
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

class DeadlineExceededError extends Error {}
class PrivateAddressError extends Error {}
class HelloRejectedError extends Error {}

export type DnsLookupFn = (
  hostname: string,
  options: { all: true; family: 4 },
  callback: (error: NodeJS.ErrnoException | null, addresses: dns.LookupAddress[]) => void,
) => void;

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

function parseConnectTarget(url: string | undefined): { host: string; port: number } | undefined {
  if (url === undefined) return undefined;
  const match = /^([^:]+):(\d+)$/.exec(url);
  if (!match) return undefined;
  return { host: match[1]!, port: Number.parseInt(match[2]!, 10) };
}

/** Resolve, guard, connect to the first address that accepts. A late success is destroyed, not leaked. */
function resolveAndConnectUpstream(
  host: string,
  deadlineMs: number,
  dnsLookup: DnsLookupFn,
  netConnect: NetConnectFn,
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let settled = false;

    // The attempt in flight, so the deadline can destroy it. A blackholing address answers neither the
    // connect callback nor `'error'`, so it sits in `SYN_SENT` for minutes past the client's `504`.
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
 * Accumulates `head` then `'data'` into one TLS record, to its 5-byte header's declared length, capped
 * at {@link MAX_RECORD_BYTES}. Returns the record (for replay) plus bytes past it, else lost to `.pipe()`.
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
 * Hand-rolled walk to the ClientHello's `server_name` (record header already stripped). Every read is
 * bounds-checked against its own declared boundary, so a malformed hello throws instead of reading past.
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

/** Host and `server_name` are peer bytes: a raw newline would forge a refusal line under this stem. */
function logSafe(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]/g, " ");
}

function logRefusal(host: string | undefined, reason: string): void {
  console.error(`Egress proxy: refused CONNECT ${logSafe(host ?? "(unparseable target)")} — ${logSafe(reason)}`);
}

function refuseWithStatus(socket: net.Socket, status: number, host: string | undefined, reason: string): void {
  logRefusal(host, reason);
  if (socket.writable) socket.end(`HTTP/1.1 ${status} ${STATUS_TEXT[status]}\r\n\r\n`);
  else socket.destroy();
}

/** After the `200` no status is possible — only a torn-down socket. */
function refuseTunnel(clientSocket: net.Socket, upstream: net.Socket, host: string, reason: string): void {
  logRefusal(host, reason);
  clientSocket.destroy();
  upstream.destroy();
}

type ConnectDeps = Required<Pick<StartEgressProxyOptions, "dnsLookup" | "netConnect" | "stageDeadlineMs" | "idleTeardownMs">> & {
  /** Established tunnels, so `SIGTERM` can end them: `closeAllConnections()` skips upgraded sockets — measured. */
  tunnels: Set<net.Socket>;
};

async function handleConnect(
  req: http.IncomingMessage,
  clientSocket: net.Socket,
  head: Buffer,
  deps: ConnectDeps,
): Promise<void> {
  // Baseline for the socket's lifetime: an EventEmitter with no `'error'` listener crashes the process.
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
 * Accept-to-headers expires inside Node, unlogged, so a peer could hold slots leaving no trail.
 * `server.timeout`'s `'timeout'` is the only hook firing *at* the deadline, and never for an upgraded
 * socket (24.12.0). Attaching it replaces Node's default destroy, reproduced below.
 */
function onHeaderDeadline(socket: net.Socket): void {
  // Not `logRefusal`: no `CONNECT` arrived to name. Same stem, which is what an operator greps for.
  console.error("Egress proxy: no complete request line and headers before the deadline");
  socket.destroy();
}

/**
 * Any `clientError` listener replaces Node's default for *every* parser error, so this reproduces that
 * mapping. Duplicated from `server/price-worker.ts`: an import would end this module's closure.
 * Unlogged — the `writable` guard keeps a bare `ECONNRESET` off the log.
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

  // `connectionsCheckingInterval` is what makes the deadlines above mean it: on the 30 s default a silent socket lived 30004 ms, measured.
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
    // @types/node says `Duplex`; a TCP-bound server always gives a `net.Socket`, which `setTimeout` needs.
    const clientSocket = duplexSocket as net.Socket;
    handleConnect(req, clientSocket, head, deps).catch((error: unknown) => {
      console.error("Egress proxy: unhandled tunnel error", error);
      clientSocket.destroy();
    });
  });

  // Node is PID 1 under compose and ignores unhandled signals; without this every stop is 10 s then `SIGKILL`.
  const onSigterm = (): void => {
    // Tunnels first: `closeAllConnections()` skips upgraded sockets, so one would hold `close()` until idle teardown.
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
