/**
 * The egress proxy (ticket 08, `server/egress-proxy.ts`): a real
 * `node:http` server on a loopback TCP port, a fake `dns.lookup` and a fake
 * upstream `net.connect` — never a socket to the internet — and raw TCP for
 * the client side, since a `CONNECT` tunnel and the TLS bytes inside it are
 * below anything `fetch` or `http.request` would let a test drive directly.
 *
 * `sendRaw` below writes the `CONNECT` request line and, for the pipelined
 * cases, the ClientHello bytes in the very same `socket.write()` call — the
 * shape the module header's step 4 depends on, and the reason a plain
 * `http.request({ method: "CONNECT" })` client cannot stand in for it: that
 * API has no way to put bytes on the wire before its own `'connect'` event
 * fires, i.e. before the `200` — which is also, precisely, the honest
 * client's shape, covered by the "arrives only after the 200" cases below.
 *
 * A raw `net.Socket` with no `'data'` listener stays *paused* and never
 * notices the peer closing — same trap `tests/price-worker.test.ts`
 * documents — so every socket below that is not read through
 * {@link waitForStatusLine} calls `.resume()` once it only needs to notice a
 * close.
 */
import net from "node:net";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  startEgressProxy,
  type DnsLookupFn,
  type NetConnectFn,
  type StartEgressProxyOptions,
} from "../server/egress-proxy.ts";

/** Short deadlines so a case pinning one does not make the suite slow; long enough that loopback IO never races them. */
const TEST_DEADLINES = { stageDeadlineMs: 200, idleTeardownMs: 300 };

const ALLOWED_HOST = "finance.yahoo.com";

// ---------------------------------------------------------------------------
// ClientHello construction — a hand-rolled encoder mirroring the parser's own
// field layout, built forward from the wire format rather than from the
// module under test.
// ---------------------------------------------------------------------------

function tlsRecord(handshake: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header[0] = 0x16; // handshake content type
  header[1] = 0x03;
  header[2] = 0x03; // TLS 1.2 record version, the common wire value
  header.writeUInt16BE(handshake.length, 3);
  return Buffer.concat([header, handshake]);
}

function sniExtension(names: string[]): Buffer {
  const entries = names.map((name) => {
    const nameBuf = Buffer.from(name, "ascii");
    const entry = Buffer.alloc(3 + nameBuf.length);
    entry[0] = 0; // host_name
    entry.writeUInt16BE(nameBuf.length, 1);
    nameBuf.copy(entry, 3);
    return entry;
  });
  const list = Buffer.concat(entries);
  const listWithLength = Buffer.alloc(2 + list.length);
  listWithLength.writeUInt16BE(list.length, 0);
  list.copy(listWithLength, 2);
  const ext = Buffer.alloc(4 + listWithLength.length);
  ext.writeUInt16BE(0x0000, 0); // extension type: server_name
  ext.writeUInt16BE(listWithLength.length, 2);
  listWithLength.copy(ext, 4);
  return ext;
}

/** A complete ClientHello record. `names` is the `server_name` list — omit for no SNI extension at all. */
function clientHello(names?: string[]): Buffer {
  const clientVersion = Buffer.from([0x03, 0x03]);
  const random = Buffer.alloc(32, 0);
  const sessionId = Buffer.from([0x00]); // length 0
  const cipherSuites = Buffer.from([0x00, 0x02, 0x00, 0x2f]); // length 2, one suite
  const compressionMethods = Buffer.from([0x01, 0x00]); // length 1, null method
  const extensions = names !== undefined ? sniExtension(names) : Buffer.alloc(0);
  const extensionsBlock = Buffer.alloc(2 + extensions.length);
  extensionsBlock.writeUInt16BE(extensions.length, 0);
  extensions.copy(extensionsBlock, 2);

  const body = Buffer.concat([
    clientVersion,
    random,
    sessionId,
    cipherSuites,
    compressionMethods,
    extensionsBlock,
  ]);

  const handshakeHeader = Buffer.alloc(4);
  handshakeHeader[0] = 0x01; // ClientHello
  handshakeHeader.writeUIntBE(body.length, 1, 3);

  return tlsRecord(Buffer.concat([handshakeHeader, body]));
}

// ---------------------------------------------------------------------------
// Fakes for `dns.lookup` and the upstream `net.connect` — the two injectable
// seams, per the ticket. Neither ever names a real host.
// ---------------------------------------------------------------------------

function fakeDnsLookup(addresses: string[]): DnsLookupFn {
  return (_hostname, _options, callback) => {
    queueMicrotask(() => callback(null, addresses.map((address) => ({ address, family: 4 }))));
  };
}

function failingDnsLookup(code: string, message: string): DnsLookupFn {
  return (_hostname, _options, callback) => {
    queueMicrotask(() => {
      const error = new Error(message) as NodeJS.ErrnoException;
      error.code = code;
      callback(error, []);
    });
  };
}

/** Redirects every connect attempt to a fixed local port regardless of the address the proxy resolved. */
function redirectingNetConnect(port: number): NetConnectFn {
  return (_options, listener) => net.connect({ host: "127.0.0.1", port }, listener);
}

/** A `net.connect` whose socket never connects and never errors — exercises the step-2 deadline. */
function hangingNetConnect(): { fn: NetConnectFn; sockets: net.Socket[] } {
  const sockets: net.Socket[] = [];
  const fn: NetConnectFn = () => {
    const socket = new net.Socket();
    sockets.push(socket);
    return socket;
  };
  return { fn, sockets };
}

/** Accepts a connection to `refusedAddress` and refuses it immediately; anything else redirects to `port`. */
function partiallyRefusingNetConnect(refusedAddress: string, port: number): NetConnectFn {
  return (options, listener) => {
    if (options.host === refusedAddress) {
      const socket = new net.Socket();
      queueMicrotask(() => {
        const error = new Error(`connect ECONNREFUSED ${refusedAddress}`) as NodeJS.ErrnoException;
        error.code = "ECONNREFUSED";
        socket.destroy(error);
      });
      return socket;
    }
    return net.connect({ host: "127.0.0.1", port }, listener);
  };
}

// ---------------------------------------------------------------------------
// A fake upstream — the real TLS edge, from the proxy's point of view.
// ---------------------------------------------------------------------------

type FakeUpstream = { port: number; received: Buffer[]; close: () => Promise<void> };

async function startFakeUpstream(reply: Buffer = Buffer.from("UPSTREAM-REPLY")): Promise<FakeUpstream> {
  const received: Buffer[] = [];
  const server = net.createServer((socket) => {
    socket.on("data", (chunk: Buffer) => {
      received.push(chunk);
      socket.write(reply);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ---------------------------------------------------------------------------
// Raw client helpers.
// ---------------------------------------------------------------------------

/** Accumulates bytes until a blank line (`\r\n\r\n`) arrives, splitting off whatever followed it in the same reads. */
function waitForStatusLine(socket: net.Socket): Promise<{ line: string; rest: Buffer }> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = (): void => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    function onData(chunk: Buffer): void {
      buffer = Buffer.concat([buffer, chunk]);
      const index = buffer.indexOf("\r\n\r\n");
      if (index !== -1) {
        cleanup();
        resolve({ line: buffer.subarray(0, index).toString("utf8"), rest: buffer.subarray(index + 4) });
      }
    }
    function onError(error: Error): void {
      cleanup();
      reject(error);
    }
    function onClose(): void {
      cleanup();
      reject(new Error(`socket closed before a status line arrived; got ${JSON.stringify(buffer.toString("utf8"))}`));
    }
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function waitForClose(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => socket.once("close", resolve));
}

function waitForData(socket: net.Socket, minBytes = 1): Promise<Buffer> {
  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length >= minBytes) resolve(buffer);
    });
  });
}

function connectRaw(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function connectLine(target: string): string {
  return `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`;
}

// ---------------------------------------------------------------------------
// Suite plumbing: every server, fake upstream and ad-hoc socket started by a
// case is tracked here and torn down in `afterEach`, whether the case passed
// or not.
// ---------------------------------------------------------------------------

let servers: Awaited<ReturnType<typeof startEgressProxy>>[] = [];
let upstreams: FakeUpstream[] = [];
let sockets: net.Socket[] = [];

async function start(options: Partial<StartEgressProxyOptions> = {}): Promise<number> {
  const server = await startEgressProxy({
    port: 0,
    dnsLookup: fakeDnsLookup(["203.0.113.10"]),
    netConnect: redirectingNetConnect(0),
    ...TEST_DEADLINES,
    ...options,
  });
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

/** The common case: a proxy wired to a fake upstream that echoes a reply once it receives bytes. */
async function startWithUpstream(
  options: Partial<StartEgressProxyOptions> = {},
): Promise<{ proxyPort: number; upstream: FakeUpstream }> {
  const upstream = await startFakeUpstream();
  upstreams.push(upstream);
  const proxyPort = await start({
    dnsLookup: fakeDnsLookup(["203.0.113.10"]),
    netConnect: redirectingNetConnect(upstream.port),
    ...options,
  });
  return { proxyPort, upstream };
}

function track(socket: net.Socket): net.Socket {
  sockets.push(socket);
  return socket;
}

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets = [];
  await Promise.all(upstreams.map((upstream) => upstream.close()));
  upstreams = [];
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers = [];
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe("the CONNECT target", () => {
  it("refuses a host that is not on the allowlist with 403, nothing upstream touched", async () => {
    const dnsLookup = vi.fn(fakeDnsLookup(["203.0.113.10"]));
    const port = await start({ dnsLookup });
    const socket = track(await connectRaw(port));

    socket.write(connectLine("mail.yahoo.com:443"));
    const { line } = await waitForStatusLine(socket);

    expect(line).toContain("403");
    expect(dnsLookup).not.toHaveBeenCalled();
  });

  it("refuses a disallowed port with 403", async () => {
    const port = await start();
    const socket = track(await connectRaw(port));

    socket.write(connectLine(`${ALLOWED_HOST}:8080`));
    const { line } = await waitForStatusLine(socket);

    expect(line).toContain("403");
  });

  it("refuses an IP-literal CONNECT host with 403", async () => {
    const port = await start();
    const socket = track(await connectRaw(port));

    socket.write(connectLine("93.184.216.34:443"));
    const { line } = await waitForStatusLine(socket);

    expect(line).toContain("403");
  });

  it("compares the allowlist exactly, refusing a host that merely ends with an allowed name", async () => {
    const port = await start();
    const socket = track(await connectRaw(port));

    socket.write(connectLine("evil-finance.yahoo.com:443"));
    const { line } = await waitForStatusLine(socket);

    expect(line).toContain("403");
  });

  it("compares the allowlist case-insensitively", async () => {
    const { proxyPort, upstream } = await startWithUpstream();
    const socket = track(await connectRaw(proxyPort));

    socket.write(connectLine("FINANCE.YAHOO.COM:443"));
    const { line } = await waitForStatusLine(socket);
    expect(line).toContain("200");

    socket.resume();
    socket.write(clientHello(["FINANCE.YAHOO.COM"]));
    await waitForData(socket);
    expect(upstream.received.length).toBeGreaterThan(0);
  });
});

describe("everything that is not a CONNECT tunnel", () => {
  it("answers GET /healthz with 200 unconditionally", async () => {
    const port = await start();
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
  });

  it("answers 405 to a non-CONNECT method or an unknown path", async () => {
    const port = await start();

    const wrongMethod = await fetch(`http://127.0.0.1:${port}/healthz`, { method: "POST" });
    expect(wrongMethod.status).toBe(405);

    const wrongPath = await fetch(`http://127.0.0.1:${port}/anything-else`);
    expect(wrongPath.status).toBe(405);
  });
});

describe("resolving and connecting the upstream (step 2)", () => {
  it("answers 502 when dns.lookup fails, logging the host and the cause", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const port = await start({ dnsLookup: failingDnsLookup("ENOTFOUND", "getaddrinfo ENOTFOUND finance.yahoo.com") });
    const socket = track(await connectRaw(port));

    socket.write(connectLine(`${ALLOWED_HOST}:443`));
    const { line } = await waitForStatusLine(socket);

    expect(line).toContain("502");
    expect(spy.mock.calls.some((call) => String(call[0]).includes(ALLOWED_HOST))).toBe(true);
  });

  it("answers 504 at the deadline when the upstream connect never completes", async () => {
    const { fn, sockets: hungSockets } = hangingNetConnect();
    const port = await start({ netConnect: fn });
    const socket = track(await connectRaw(port));

    const startedAt = Date.now();
    socket.write(connectLine(`${ALLOWED_HOST}:443`));
    const { line } = await waitForStatusLine(socket);

    expect(line).toContain("504");
    expect(Date.now() - startedAt).toBeLessThan(TEST_DEADLINES.stageDeadlineMs + 1000);
    for (const hung of hungSockets) hung.destroy();
  });

  it("destroys the upstream socket it was still connecting when the deadline fires", async () => {
    // A blackholing address answers neither the connect callback nor
    // `'error'`, so nothing in `tryAddress` runs again and the late-arrival
    // guard is never reached. Left alone the socket sits in `SYN_SENT` for
    // minutes while the client already has its 504 and has freed its
    // `maxConnections` slot — the proxy's only bound counts client sockets,
    // not upstream ones, so the leak is unbounded by anything.
    const { fn, sockets: hungSockets } = hangingNetConnect();
    const port = await start({ netConnect: fn });
    const socket = track(await connectRaw(port));

    socket.write(connectLine(`${ALLOWED_HOST}:443`));
    const { line } = await waitForStatusLine(socket);

    expect(line).toContain("504");
    expect(hungSockets).toHaveLength(1);
    expect(hungSockets[0]?.destroyed).toBe(true);
  });

  it("answers 403 when one address among several is private, not only when all are", async () => {
    // A single-address answer cannot tell `some` from `every`, and a mutation
    // to `every` — refusing only if the whole answer is private, the opposite
    // of the rule — survived the suite before this case existed.
    const port = await start({ dnsLookup: fakeDnsLookup(["93.184.216.34", "10.0.0.5"]) });
    const socket = track(await connectRaw(port));

    socket.write(connectLine(`${ALLOWED_HOST}:443`));
    const { line } = await waitForStatusLine(socket);

    expect(line).toContain("403");
  });

  it("answers 403 when the whole answer contains a private address", async () => {
    const port = await start({ dnsLookup: fakeDnsLookup(["10.0.0.5"]) });
    const socket = track(await connectRaw(port));

    socket.write(connectLine(`${ALLOWED_HOST}:443`));
    const { line } = await waitForStatusLine(socket);

    expect(line).toContain("403");
  });

  it("matches a lowercase server_name against an upper-case CONNECT host", async () => {
    // The comparison has to be case-insensitive on *each side independently*.
    // A case sending both in the same case cannot tell that apart from a
    // case-sensitive compare, which is what a mutation to `!==` proved.
    const { proxyPort, upstream } = await startWithUpstream();
    const socket = track(await connectRaw(proxyPort));

    socket.write(connectLine(`${ALLOWED_HOST.toUpperCase()}:443`));
    await waitForStatusLine(socket);
    socket.resume();
    socket.write(clientHello([ALLOWED_HOST]));

    await waitForData(socket);
    expect(upstream.received.length).toBeGreaterThan(0);
  });

  it("refuses a server_name whose bytes only mask to the host under a lossy decoder", async () => {
    // `ascii` masks the high bit, so 0xE6 0xE9 0xEE… decodes to "finance…".
    // Decoded losslessly they are not the host, and the record replayed
    // upstream would have carried the raw bytes either way — so the edge
    // would have seen a name the proxy never matched.
    const { proxyPort, upstream } = await startWithUpstream();
    const socket = track(await connectRaw(proxyPort));

    socket.write(connectLine(`${ALLOWED_HOST}:443`));
    await waitForStatusLine(socket);
    const highBit = Array.from(ALLOWED_HOST, (ch) => String.fromCharCode(ch.charCodeAt(0) | 0x80)).join("");
    socket.write(clientHello([highBit]));

    await waitForClose(socket);
    expect(upstream.received.length).toBe(0);
  });

  it.each([
    ["0.0.0.0", "the address a blackholing resolver answers with, which connects to loopback"],
    ["0.1.2.3", "the rest of 0.0.0.0/8, which is not a host address either"],
    ["::ffff:127.0.0.1", "loopback wearing IPv4-mapped IPv6 notation"],
  ])("answers 403 for %s — %s", async (address) => {
    const port = await start({ dnsLookup: fakeDnsLookup([address]) });
    const socket = track(await connectRaw(port));

    socket.write(connectLine(`${ALLOWED_HOST}:443`));
    const { line } = await waitForStatusLine(socket);

    expect(line).toContain("403");
  });

  it("connects through a second address when the first refuses, within the one deadline", async () => {
    const upstream = await startFakeUpstream();
    upstreams.push(upstream);
    const port = await start({
      dnsLookup: fakeDnsLookup(["203.0.113.1", "203.0.113.2"]),
      netConnect: partiallyRefusingNetConnect("203.0.113.1", upstream.port),
    });
    const socket = track(await connectRaw(port));

    socket.write(connectLine(`${ALLOWED_HOST}:443`));
    const { line } = await waitForStatusLine(socket);
    expect(line).toContain("200");

    socket.resume();
    socket.write(clientHello([ALLOWED_HOST]));
    const reply = await waitForData(socket);
    expect(reply.toString("utf8")).toContain("UPSTREAM-REPLY");
  });
});

describe("the ClientHello check (steps 3-6)", () => {
  it("establishes the tunnel and pipes both ways once the server_name matches the CONNECT host", async () => {
    const { proxyPort, upstream } = await startWithUpstream();
    const socket = track(await connectRaw(proxyPort));

    socket.write(connectLine(`${ALLOWED_HOST}:443`));
    const { line, rest } = await waitForStatusLine(socket);
    expect(line).toContain("200 Connection Established");
    expect(rest.length).toBe(0); // nothing pipelined in this case

    socket.resume();
    socket.write(clientHello([ALLOWED_HOST]));
    const reply = await waitForData(socket);

    expect(reply.toString("utf8")).toContain("UPSTREAM-REPLY");
    expect(Buffer.concat(upstream.received).includes(ALLOWED_HOST)).toBe(true);
  });

  it("establishes the tunnel when the hello is pipelined into the same write as the CONNECT line", async () => {
    const { proxyPort, upstream } = await startWithUpstream();
    const socket = track(await connectRaw(proxyPort));

    // One `.write()`, request line and ClientHello together — the shape the
    // module header's step 4 says a handler reading only `'data'` fails open
    // on, and only seeding the record buffer from `head` survives.
    socket.write(Buffer.concat([Buffer.from(connectLine(`${ALLOWED_HOST}:443`)), clientHello([ALLOWED_HOST])]));

    const { line, rest } = await waitForStatusLine(socket);
    expect(line).toContain("200");

    socket.resume();
    const reply = rest.length > 0 ? rest : await waitForData(socket);
    expect(reply.toString("utf8")).toContain("UPSTREAM-REPLY");
    expect(upstream.received.length).toBeGreaterThan(0);
  });

  it("tears the socket down with no HTTP status when the server_name does not match the CONNECT host", async () => {
    const { proxyPort, upstream } = await startWithUpstream();
    const socket = track(await connectRaw(proxyPort));

    socket.write(connectLine(`${ALLOWED_HOST}:443`));
    const { line } = await waitForStatusLine(socket);
    expect(line).toContain("200");

    socket.resume();
    socket.write(clientHello(["mail.yahoo.com"]));
    await waitForClose(socket);

    expect(upstream.received.length).toBe(0); // never written to before the check passed
  });

  it("tears the socket down when the ClientHello carries no server_name extension", async () => {
    const { proxyPort } = await startWithUpstream();
    const socket = track(await connectRaw(proxyPort));

    socket.write(connectLine(`${ALLOWED_HOST}:443`));
    await waitForStatusLine(socket);

    socket.resume();
    socket.write(clientHello(undefined));
    await waitForClose(socket);
  });

  it("tears the socket down when the ClientHello carries two server_name entries", async () => {
    const { proxyPort } = await startWithUpstream();
    const socket = track(await connectRaw(proxyPort));

    socket.write(connectLine(`${ALLOWED_HOST}:443`));
    await waitForStatusLine(socket);

    socket.resume();
    socket.write(clientHello([ALLOWED_HOST, "mail.yahoo.com"]));
    await waitForClose(socket);
  });

  it("tears the socket down when the record is truncated before a complete ClientHello arrives", async () => {
    const { proxyPort } = await startWithUpstream();
    const socket = track(await connectRaw(proxyPort));

    socket.write(connectLine(`${ALLOWED_HOST}:443`));
    await waitForStatusLine(socket);

    socket.resume();
    const full = clientHello([ALLOWED_HOST]);
    socket.write(full.subarray(0, full.length - 10));
    socket.end();
    await waitForClose(socket);
  });

  it("tears the socket down when the declared record length exceeds the 16KB cap", async () => {
    const { proxyPort } = await startWithUpstream();
    const socket = track(await connectRaw(proxyPort));

    socket.write(connectLine(`${ALLOWED_HOST}:443`));
    await waitForStatusLine(socket);

    socket.resume();
    const oversizeHeader = Buffer.from([0x16, 0x03, 0x03, 0xff, 0xff]); // declares a 65535-byte payload
    socket.write(oversizeHeader);
    await waitForClose(socket);
  });

  it("tears the socket down when the first byte is not a TLS handshake record", async () => {
    const { proxyPort } = await startWithUpstream();
    const socket = track(await connectRaw(proxyPort));

    socket.write(connectLine(`${ALLOWED_HOST}:443`));
    await waitForStatusLine(socket);

    socket.resume();
    socket.write(Buffer.from("GET / HTTP/1.1\r\n\r\n"));
    await waitForClose(socket);
  });

  it("establishes the tunnel when the hello arrives only after the 200, in its own write", async () => {
    const { proxyPort, upstream } = await startWithUpstream();
    const socket = track(await connectRaw(proxyPort));

    socket.write(connectLine(`${ALLOWED_HOST}:443`));
    const { line } = await waitForStatusLine(socket);
    expect(line).toContain("200");

    socket.resume();
    socket.write(clientHello([ALLOWED_HOST]));
    const reply = await waitForData(socket);
    expect(reply.toString("utf8")).toContain("UPSTREAM-REPLY");
  });
});

describe("the concurrency bound", () => {
  it("accepts and closes a ninth connection cleanly while eight are held open", async () => {
    const port = await start();

    const held: net.Socket[] = [];
    for (let i = 0; i < 8; i++) held.push(track(await connectRaw(port)));

    const ninth = track(await connectRaw(port));
    const startedAt = Date.now();
    await waitForClose(ninth);
    const elapsed = Date.now() - startedAt;

    // The property this pins: a clean, fast close — not a timeout. Raising
    // `maxConnections` does fail this case, but through vitest's own timeout
    // rather than the ceiling below, since `waitForClose` never resolves for
    // that mutant; the ceiling is what catches a close that arrives late.
    expect(elapsed).toBeLessThan(1000);

    for (const socket of held) socket.destroy();
  });

  it("leaves a ninth GET /healthz unanswered while eight are held, which is why the healthcheck asks for one", async () => {
    // The reason `compose.yaml` gives the proxy a `GET /healthz` healthcheck
    // rather than a bare connect. A TCP connect completes at the accept queue
    // whatever the server is doing, so it reads healthy with every slot held;
    // only a request the HTTP server itself answers proves it is not
    // saturated. The case above pins that the ninth *socket* closes cleanly —
    // this one pins that no `200` comes back with it, which is the half the
    // healthcheck actually depends on.
    const port = await start();

    const held: net.Socket[] = [];
    for (let i = 0; i < 8; i++) held.push(track(await connectRaw(port)));

    const ninth = track(await connectRaw(port));
    let answered = "";
    ninth.on("data", (chunk: Buffer) => {
      answered += chunk.toString("latin1");
    });
    ninth.write("GET /healthz HTTP/1.1\r\nHost: proxy\r\n\r\n");
    await waitForClose(ninth);

    expect(answered).not.toContain("200");

    for (const socket of held) socket.destroy();
  });

  it("tears a connected socket down at the deadline if no ClientHello ever arrives after the 200", async () => {
    const { proxyPort } = await startWithUpstream();
    const socket = track(await connectRaw(proxyPort));

    socket.write(connectLine(`${ALLOWED_HOST}:443`));
    const { line } = await waitForStatusLine(socket);
    expect(line).toContain("200");

    socket.resume();
    const startedAt = Date.now();
    await waitForClose(socket);
    expect(Date.now() - startedAt).toBeLessThan(TEST_DEADLINES.stageDeadlineMs + 1000);
  });
});

describe("logging", () => {
  it("logs nothing for a healthy tunnel", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { proxyPort } = await startWithUpstream();
    const socket = track(await connectRaw(proxyPort));

    socket.write(connectLine(`${ALLOWED_HOST}:443`));
    await waitForStatusLine(socket);
    socket.resume();
    socket.write(clientHello([ALLOWED_HOST]));
    await waitForData(socket);

    expect(spy).not.toHaveBeenCalled();
  });

  it("logs one line naming both names when the server_name does not match the CONNECT host", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { proxyPort } = await startWithUpstream();
    const socket = track(await connectRaw(proxyPort));

    socket.write(connectLine(`${ALLOWED_HOST}:443`));
    await waitForStatusLine(socket);
    socket.resume();
    socket.write(clientHello(["mail.yahoo.com"]));
    await waitForClose(socket);

    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0]?.[0]);
    expect(line).toContain("Egress proxy");
    expect(line).toContain(ALLOWED_HOST);
    expect(line).toContain("mail.yahoo.com");
  });

  it("writes a refusal as one physical line when the server_name carries control bytes", async () => {
    // The refusal line quotes bytes the peer chose. Unsanitised, one hello
    // forges as many further lines as it likes, any of them free to open
    // with this module's own stem — so the audit trail becomes writable by
    // the party being audited.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { proxyPort } = await startWithUpstream();
    const socket = track(await connectRaw(proxyPort));

    socket.write(connectLine(`${ALLOWED_HOST}:443`));
    await waitForStatusLine(socket);
    socket.resume();
    socket.write(clientHello(["a.test\nEgress proxy: refused CONNECT evil.test — allowed"]));
    await waitForClose(socket);

    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0]?.[0]);
    // One physical line is the property, so the assertion is on control
    // bytes rather than on the forged stem: a peer may put the words "Egress
    // proxy" in a server name all it likes, and it stays one line of text.
    expect(line).toMatch(/^[^\x00-\x1f\x7f]*$/);
    expect(line).toContain("Egress proxy: refused CONNECT");
  });

  it("logs once when a connection never completes a request line, and nothing when one merely closes", async () => {
    // The first of the three deadlines expires inside Node, before this
    // module has anything to refuse. A deadline nothing records is a slot a
    // peer can hold to expiry over and over, invisibly.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const port = await start();

    const silent = track(await connectRaw(port));
    await waitForClose(silent);
    const afterSilent = spy.mock.calls.length;

    const closing = track(await connectRaw(port));
    closing.end();
    await waitForClose(closing);
    await new Promise((resolve) => setTimeout(resolve, TEST_DEADLINES.stageDeadlineMs + 200));

    expect(afterSilent).toBe(1);
    expect(String(spy.mock.calls[0]?.[0])).toContain("Egress proxy");
    expect(spy.mock.calls.length).toBe(afterSilent);
  });

  it("destroys an established tunnel on SIGTERM instead of waiting for it to end", async () => {
    // `server.close()` — and `closeAllConnections()` with it — leaves an
    // upgraded socket alone, so a proxy whose whole job is upgrading sockets
    // holds its own stop open until the 60 s idle teardown, well past
    // Docker's 10 s grace. `server/price-worker.ts` upgrades nothing, which
    // is why the two lines that suffice there are silently insufficient here.
    // The handler is invoked directly rather than by signalling this process:
    // the exit is stubbed, so only the teardown is under assertion.
    // The idle teardown is pushed well out of the way on purpose: at the
    // suite's usual 300 ms it would close this tunnel by itself and the case
    // would pass whether or not `SIGTERM` did anything. That is the bug in
    // miniature — in production the same rescue arrives at 60 s, five times
    // past the grace period — so the assertion is on promptness, not on the
    // socket eventually going away.
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const before = process.listeners("SIGTERM");
    const { proxyPort } = await startWithUpstream({ idleTeardownMs: 30_000 });
    const socket = track(await connectRaw(proxyPort));

    socket.write(connectLine(`${ALLOWED_HOST}:443`));
    await waitForStatusLine(socket);
    socket.resume();
    socket.write(clientHello([ALLOWED_HOST]));
    await waitForData(socket);

    const added = process.listeners("SIGTERM").filter((fn) => !before.includes(fn));
    expect(added).toHaveLength(1);

    const startedAt = Date.now();
    added[0]?.("SIGTERM");
    await waitForClose(socket);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(socket.destroyed).toBe(true);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
