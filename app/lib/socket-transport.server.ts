/**
 * The unix-socket transport every caller of the price worker shares: `ask` (`provider-socket.server.ts`)
 * for the provider operations, and the reachability probe (`worker-reachability.server.ts`) for
 * `GET /healthz`. Extracted rather than hand-copied (spec price-health/02) because it carries five
 * mechanics a second copy gets wrong: a settle-once guard (a late `error` after the body-cap
 * `destroy()` must not re-reject), a byte-accumulating cap that destroys the request rather than
 * buffering forever, the `connect` syscall branch that means "nothing is listening", the
 * abort/deadline branch, and — the one whose omission hangs a caller — a `close`-before-`end` guard:
 * a socket destroyed after the headers but before the declared body completes fires neither `error`
 * nor `end`, only `close`.
 *
 * Deliberately dumb about meaning: it returns a discriminated success/failure and leaves every
 * operator-facing word to the caller. No JSON parsing, no status-code interpretation, no retry.
 */
import http from "node:http";

export type SocketRequestOptions = {
  socketPath: string;
  method: string;
  path: string;
  /** Sent as-is; omit for a bodyless request (the probe's `GET`). */
  body?: string;
  /** Whole-exchange budget: connection, headers and body together. */
  deadlineMs: number;
  /** Response bytes read before the request is destroyed. */
  capBytes: number;
};

export type SocketResponse = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
};

export type SocketFailure =
  | { kind: "connect"; code: string | undefined }
  | { kind: "timeout"; cause: unknown }
  | { kind: "closed" }
  | { kind: "capped" }
  /** Anything else the request emitted as `error` — a mid-stream reset, not a connect failure. */
  | { kind: "error"; cause: unknown };

export type SocketResult =
  | { ok: true; response: SocketResponse }
  | { ok: false; failure: SocketFailure };

/** One request, no retry. Never rejects — every failure comes back as `{ ok: false, failure }`. */
export function socketRequest(options: SocketRequestOptions): Promise<SocketResult> {
  const { socketPath, method, path, body, deadlineMs, capBytes } = options;
  const signal = AbortSignal.timeout(deadlineMs);

  return new Promise<SocketResult>((resolve) => {
    // Either handler can fire after the other settled (the body-cap `destroy()` below raises `error`).
    let settled = false;
    const settle = (thunk: () => void): void => {
      if (settled) return;
      settled = true;
      thunk();
    };

    const req = http.request(
      {
        socketPath,
        method,
        path,
        headers: { "content-type": "application/json" },
        agent: false,
        signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;

        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > capBytes) {
            req.destroy();
            settle(() => resolve({ ok: false, failure: { kind: "capped" } }));
            return;
          }
          chunks.push(chunk);
        });

        res.on("end", () => {
          settle(() =>
            resolve({
              ok: true,
              response: {
                status: res.statusCode ?? 0,
                headers: res.headers,
                body: Buffer.concat(chunks),
              },
            }),
          );
        });
      },
    );

    req.on("error", (error) => {
      const err = error as NodeJS.ErrnoException;

      if (err.syscall === "connect") {
        settle(() => resolve({ ok: false, failure: { kind: "connect", code: err.code } }));
        return;
      }

      if (signal.aborted || err.name === "AbortError") {
        settle(() => resolve({ ok: false, failure: { kind: "timeout", cause: error } }));
        return;
      }

      settle(() => resolve({ ok: false, failure: { kind: "error", cause: error } }));
    });

    // `close` always fires; on the success path `end` beats it, via the settle-once guard above.
    req.on("close", () => {
      settle(() => resolve({ ok: false, failure: { kind: "closed" } }));
    });

    if (body === undefined) req.end();
    else req.end(body);
  });
}
