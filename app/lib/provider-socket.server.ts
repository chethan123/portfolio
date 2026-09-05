/**
 * The socket half of the provider seam (spec 0018 §3.3, §3.8): the app dials
 * the price worker's unix socket instead of `yahoo-finance2` directly, from
 * this ticket on. `price-provider.server.ts` keeps every conversion function
 * — `toProviderQuote`, `toProviderHistory`, `probeVerdicts` — untouched; this
 * module owns only the transport and the batching in front of it, and
 * `socketProvider()`'s `getDailyCloses` runs the very same `toProviderHistory`
 * a fetched-locally response would, ADR-0011's split arithmetic included.
 *
 * **A unix socket, not a TCP port on an internal bridge.** A bridge network is
 * symmetric — the worker could dial the app back at `app:3000` as easily as
 * the app dials it — and nothing about that direction should exist. A unix
 * socket under a mounted volume has no such symmetry: only a process that can
 * see the app's mount namespace can reach it at all, and the worker has no
 * reason to.
 *
 * **No handle, no flag, no dedup.** A connect failure is immediate — there is
 * nothing to amortise, and remembering "the worker was down a moment ago"
 * would cost a stale worker its first genuine recovery. So a dead worker
 * costs exactly one connect attempt and one log line per call site, every
 * time it is asked, and the batch abort of
 * [01](../../docs/specs/price-worker/01-one-refresh-and-the-batch-abort.md)
 * is what keeps a single tick's cost at *at most* two of each (spec §3.3) —
 * not this module, which never remembers a previous failure at all.
 *
 * **No budget crosses the socket.** The worker times its own Yahoo calls
 * against its own 30 s watchdog (spec §3.5) and answers `504` on its own
 * schedule; this module's `history` budget (35 s) is deliberately *past*
 * that watchdog so the app reads the worker's own `504` and its reason,
 * rather than winning a race against it by transit time alone and reporting
 * nothing but "no answer."
 *
 * **This module never reads the volume.** No `readdir`, no `stat`, nothing
 * that inspects what is mounted where `PRICE_WORKER_SOCKET` points — the
 * worker owns that path. It also never creates a socket of its own there: a
 * symlink planted at the path is followed by `connect()` inside the app's own
 * mount namespace regardless of what wrote it, and today that namespace holds
 * nothing else worth reaching through it (spec §8). Treating the path as
 * anything more than an opaque string `http.request` dials would be reaching
 * for a guarantee the design does not need.
 */
import http from "node:http";

import { getConfig } from "../../server/config.ts";
import { isWellFormedSymbol } from "../../server/symbol-pattern.ts";

import {
  CurrencyRefused,
  isMissingHistory,
  probeVerdicts,
  ProviderUnreachable,
  toProviderHistory,
  toProviderQuote,
  type HistoryRange,
  type PriceProvider,
  type ProbeSymbols,
  type ProviderHistory,
  type ProviderQuote,
  type SymbolProbe,
} from "./price-provider.server.ts";
import { matchKey } from "./prices.server.ts";

/** The worker's two endpoints (spec §3.2); `ask` dials `/${kind}`. */
type AskKind = "quotes" | "history";

/**
 * How long `ask` waits before abandoning each kind of call, and why —
 * `ask`'s own defaults, overridable per call for a test or for
 * {@link socketProbe}'s shorter budget.
 *
 * `quotes` (15 s): a slow quote is stale either way once it lands, so the
 * call is abandoned while the worker keeps working on it — nothing here
 * cancels the worker's own fetch.
 *
 * `history` (35 s): past the worker's own 30 s watchdog on purpose (module
 * header) — the app's own signal starts before `connect` even lands, so a
 * shorter budget would always win the race by transit time and report only
 * "no answer" where the worker's `504` already carries the reason.
 */
const BUDGET_MS: Record<AskKind, number> = {
  quotes: 15_000,
  history: 35_000,
};

/**
 * {@link socketProbe}'s own budget, shorter than an ordinary quotes call: a
 * cold worker's first probe pays a three-fetch crumb handshake, and the
 * verdict a short budget loses is `non-usd` — the one a person creating the
 * instrument can act on. Waiting the full 15 s for every symbol nobody has
 * probed before would make instrument creation feel broken for no gain a
 * refresh does not already recover.
 */
const PROBE_BUDGET_MS = 10_000;

/**
 * The response is read to this many bytes and the request destroyed past it
 * — a hundred quotes is about 400 KB, a ten-year chart answer about 300 KB,
 * so both caps leave headroom without trusting a worker that has started
 * misbehaving to bound itself.
 */
const BODY_CAP_BYTES: Record<AskKind, number> = {
  quotes: 512 * 1024,
  history: 2 * 1024 * 1024,
};

/** More than this many symbols in one call is split into consecutive `ask`s (spec §3.5's own cap). */
const BATCH_SIZE = 100;

/**
 * `${message}` cut here, mirroring the worker's own `ERROR_TEXT_LIMIT`
 * (`server/price-worker.ts`) — undici's own errors nest the real reason in
 * `cause`, so a message this long is already unusual on the writing side and
 * doubly so once it has crossed the wire and back.
 */
const ERROR_TEXT_LIMIT = 1000;

/**
 * A non-`200` response's `error` field, made safe for `console.error` and
 * `price_backfill.error` (a `text` column nothing prunes) the same way the
 * worker makes its own log line safe — control characters collapsed to a
 * space, the whole cut to {@link ERROR_TEXT_LIMIT}. The worker's own
 * `logSafe`/`ERROR_TEXT_LIMIT` reasons that `JSON.stringify` already escapes
 * these on the wire, which is true right up until this module `JSON.parse`s
 * the body back — the first code to do that, and so the first place this
 * reading side needs the same guard the worker's writing side already has.
 */
function scrubProviderReason(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, ERROR_TEXT_LIMIT);
}

/**
 * One call to the worker: `POST /${kind}` over the unix socket, the body
 * JSON, the answer JSON. `AbortSignal.timeout` bounds the exchange only
 * while the socket is still open — it cannot rescue a request the peer has
 * already closed, which is why outcome 6 below exists. No retry and nothing
 * remembered between calls (module header).
 *
 * `getConfig()` is read here, inside the call, never at module scope — a
 * test sets `PRICE_WORKER_SOCKET` before its first call reaches this
 * function, and `getConfig` itself is what memoises after that
 * (`server/config.ts`'s own `getConfig`).
 *
 * The outcomes, told apart in this order:
 *
 *  1. A request `error` whose `syscall` is `"connect"` — `ENOENT`,
 *     `ECONNREFUSED`, `EACCES`, `ENOTDIR`, whatever the code — is
 *     {@link ProviderUnreachable}, keyed on the syscall and never on a code
 *     list: a permission fault is exactly as persistent as a missing file,
 *     and both mean "no worker reachable," never "the endpoint changed
 *     shape."
 *  2. The budget itself expiring — `signal.aborted`, or a request `error`
 *     `http.request` wraps as an `AbortError` around the signal's own
 *     `TimeoutError` — is a plain `Error` naming the budget spent, its
 *     `cause` the raw request error so a test (or a curious log) can see the
 *     `AbortError`/`TimeoutError` chain this branch actually matched on.
 *  3. The body cap spent mid-response is a plain `Error` naming it, the
 *     request destroyed with no further read.
 *  4. A status other than `200` is a plain `Error` carrying the body's own
 *     `error` text — scrubbed and capped ({@link scrubProviderReason}) before
 *     it reaches an `Error.message`, since it can be a forged or
 *     upstream-supplied string, not only the worker's own — or the bare
 *     status when the body carries none.
 *  5. `200` is the parsed body, whatever shape it is — the caller's own Zod
 *     is the only gate past this, exactly as it was for the client this
 *     replaces. A non-empty body that fails to parse as JSON at all, `200` or
 *     not, is a plain `Error` instead of a silent `undefined` — swallowing it
 *     would read back as an empty quotes batch or a `no-history` answer,
 *     neither of which is true.
 *  6. The peer destroying the connection after the response headers arrive
 *     but before the declared body completes raises neither `error` nor
 *     `end` — the worker dying mid-answer (an OOM kill, a restart, a bare
 *     `SIGKILL`) looks exactly like this, and by the time it happens the
 *     request is already closed, past any rescue the budget could offer.
 *     `req`'s own `close` event still fires — Node's own signal that the
 *     request is finished, one way or another — so it is the backstop: a
 *     plain `Error` naming the kind, settled only if nothing has settled
 *     already. On the success path `res`'s `end` always fires before `req`'s
 *     `close` (verified directly against this Node for both a one-write
 *     answer and one written in 200 chunks), so this can never race ahead of
 *     a good answer and reject it.
 */
export async function ask(
  kind: AskKind,
  body: unknown,
  { budgetMs = BUDGET_MS[kind] }: { budgetMs?: number } = {},
): Promise<unknown> {
  const socketPath = getConfig().PRICE_WORKER_SOCKET;
  const payload = JSON.stringify(body);
  const cap = BODY_CAP_BYTES[kind];
  const signal = AbortSignal.timeout(budgetMs);

  return new Promise<unknown>((resolve, reject) => {
    // Both the response handler and the error handler can fire past the
    // other having already settled the promise (a body-cap `req.destroy()`
    // below raises its own `error`) — this makes every settle after the
    // first a no-op rather than an unhandled second resolution.
    let settled = false;
    const settle = (thunk: () => void): void => {
      if (settled) return;
      settled = true;
      thunk();
    };

    const req = http.request(
      {
        socketPath,
        method: "POST",
        path: `/${kind}`,
        headers: { "content-type": "application/json" },
        agent: false,
        signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;

        res.on("data", (chunk: Buffer) => {
          total += chunk.length;
          if (total > cap) {
            req.destroy();
            settle(() => reject(new Error(`${kind} response from the worker exceeded ${cap} bytes`)));
            return;
          }
          chunks.push(chunk);
        });

        res.on("end", () => {
          settle(() => {
            const text = Buffer.concat(chunks).toString("utf8");

            // Empty is not malformed: a raw `clientError` response line
            // (`server/price-worker.ts`'s own, past the parser entirely) has
            // no body at all, and the `String(res.statusCode)` fallback below
            // is exactly the right answer for that. A *non-empty* body that
            // fails to parse is different — a bug or a compromise, never an
            // expected shape — and swallowing it here would make a `200`
            // report empty quotes with nothing logged, or an unparseable
            // history answer read back as `no-history`, `price-provider
            // .server.ts`'s own "a lie the ledger repeats."
            let parsed: unknown;
            if (text.length === 0) {
              parsed = undefined;
            } else {
              try {
                parsed = JSON.parse(text);
              } catch (error) {
                reject(
                  new Error(`${kind} response from the worker was not valid JSON`, { cause: error }),
                );
                return;
              }
            }

            if (res.statusCode !== 200) {
              const reason =
                typeof parsed === "object" &&
                parsed !== null &&
                typeof (parsed as { error?: unknown }).error === "string"
                  ? // Scrubbed and capped here, on the READING side: the
                    // worker scrubs and caps what it logs (`server/price
                    // -worker.ts`'s own `logSafe`/`ERROR_TEXT_LIMIT`) on the
                    // assumption that `JSON.stringify` already escapes every
                    // control character on the wire — true until something
                    // `JSON.parse`s the body back, which is exactly what this
                    // line does. Unscrubbed, a forged or upstream-supplied
                    // `error` field carrying a raw newline would print as
                    // several physical lines under the very `Price worker:`
                    // stem `docs/operating.md` tells the operator to grep,
                    // once it reaches `console.error` (`prices.server.ts`) or
                    // `price_backfill.error`, a column nothing prunes.
                    scrubProviderReason((parsed as { error: string }).error)
                  : String(res.statusCode);
              reject(new Error(reason));
              return;
            }

            resolve(parsed);
          });
        });
      },
    );

    req.on("error", (error) => {
      const err = error as NodeJS.ErrnoException;

      if (err.syscall === "connect") {
        settle(() =>
          reject(new ProviderUnreachable(`no worker listening at ${socketPath} (${err.code})`)),
        );
        return;
      }

      if (signal.aborted || err.name === "AbortError") {
        // `cause` carries the raw error through rather than discarding it —
        // `http.request`'s own `AbortError` wrapping the signal's
        // `TimeoutError` (module header, research §8.9) — so a test can pin
        // the discrimination itself and not just this function's friendlier
        // outer message.
        settle(() =>
          reject(
            new Error(`the worker did not answer ${kind} within ${budgetMs}ms`, { cause: error }),
          ),
        );
        return;
      }

      settle(() => reject(error));
    });

    // Backstop for outcome 6 (function header): the peer can destroy the
    // socket after the response headers land and before the declared body
    // completes, and Node then emits neither `res.on("error")` nor
    // `res.on("end")` — nothing above ever fires, and without this the
    // promise hangs forever. `close` always fires once the request is done,
    // settled or not, so this is a no-op on every path that already settled
    // (the `settled` guard) and the one path that rescues a mid-answer death.
    req.on("close", () => {
      settle(() => reject(new Error(`the worker's connection closed before the ${kind} answer completed`)));
    });

    req.end(payload);
  });
}

/**
 * `symbols` split into consecutive `ask`-sized batches, {@link BATCH_SIZE}
 * apiece — the worker's own cap on one `/quotes` body (spec §3.5), shared by
 * {@link socketProvider}'s `getQuotes` and {@link socketProbe}.
 */
function batchesOf(symbols: string[]): string[][] {
  const batches: string[][] = [];
  for (let start = 0; start < symbols.length; start += BATCH_SIZE) {
    batches.push(symbols.slice(start, start + BATCH_SIZE));
  }
  return batches;
}

/**
 * Symbols the pattern refuses, dropped before any call reaches the worker —
 * a courtesy that saves a round trip and keeps one malformed string from
 * spending the whole batch it rides with, since the worker refuses a
 * `/quotes` body outright for a single bad entry (`server/price-worker.ts`'s
 * `quotesBodySchema`). Logged every time, with no memo: a submission that
 * keeps sending the same bad symbol is worth a line every refresh, not one
 * the first time and silence after.
 */
function wellFormedSymbols(symbols: string[]): string[] {
  const good: string[] = [];
  const bad: string[] = [];

  for (const symbol of symbols) {
    (isWellFormedSymbol(symbol) ? good : bad).push(symbol);
  }

  if (bad.length > 0) {
    console.warn(`Price provider: dropping symbols the pattern refuses: ${bad.join(", ")}`);
  }

  return good;
}

/**
 * The socket-backed {@link PriceProvider} — `runRefresh`'s and
 * `startPricePoller`'s default from this ticket on. **Must not throw when
 * built, only when called**: it is `runRefresh`'s default parameter,
 * evaluated before that function's own `try` runs, so a constructor that
 * threw here would escape "never throws" straight into the route's error
 * boundary and replace the page the refresh control promises to leave
 * standing. Nothing below does any work at construction — building this
 * object touches no socket and reads no configuration — which is what keeps
 * that promise; the two methods are the only place either happens.
 */
export function socketProvider(): PriceProvider {
  return {
    async getQuotes(symbols: string[]): Promise<ProviderQuote[]> {
      const wellFormed = wellFormedSymbols(symbols);
      if (wellFormed.length === 0) return [];

      const fetchedAt = new Date();
      const quotes: ProviderQuote[] = [];

      // Sequential, like the backfill batch's own history calls
      // (`prices.server.ts`'s `backfillCloses`): a household large enough to
      // need a second batch is rare, and pacing conservatively costs one
      // round trip nobody will notice rather than opening several requests
      // against a worker whose `maxConnections` is eight.
      for (const batch of batchesOf(wellFormed)) {
        const raw = await ask("quotes", { symbols: batch });

        for (const entry of Array.isArray(raw) ? raw : []) {
          try {
            const quote = toProviderQuote(entry, fetchedAt);
            if (quote !== null) quotes.push(quote);
          } catch (error) {
            if (!(error instanceof CurrencyRefused)) throw error;
            // Exactly as `yahooPriceProvider` logged this
            // (`price-provider.server.ts`'s former `getQuotes`): a foreign
            // listing must not cost the rest of the batch its prices, and the
            // currency is known only here, at the boundary.
            console.warn(`Price refused: ${error.message}`);
          }
        }
      }

      return quotes;
    },

    async getDailyCloses(
      symbol: string,
      range: HistoryRange,
      marketTimeZone: string,
    ): Promise<ProviderHistory> {
      try {
        const raw = await ask("history", { symbol: matchKey(symbol), from: range.from });
        return toProviderHistory(raw, range, marketTimeZone);
      } catch (error) {
        if (isMissingHistory(error)) return { status: "no-history" };
        // Everything else propagates: the caller's ledger wants the text,
        // exactly as it did from the direct adapter.
        throw error;
      }
    },
  };
}

/**
 * The creation-time probe over the socket ([02](../../docs/specs/price-worker/02-the-batched-probe.md)'s
 * type), `ask("quotes", …)` in batches of {@link BATCH_SIZE} — the same split
 * `getQuotes` uses, because the endpoint is the same one. Each batch's
 * outcome is independent of every other's: a batch that answered goes through
 * {@link probeVerdicts} and keeps whatever it said, `non-usd` included; only
 * the symbols of a batch whose `ask` itself threw become `unavailable`. Never
 * throws: a provider failure must not block creating the instrument, since
 * the next refresh marks it stale regardless.
 */
export const socketProbe: ProbeSymbols = async (symbols) => {
  const wellFormed = wellFormedSymbols(symbols);
  const fetchedAt = new Date();
  const verdicts = new Map<string, SymbolProbe>();

  for (const batch of batchesOf(wellFormed)) {
    try {
      const raw = await ask("quotes", { symbols: batch }, { budgetMs: PROBE_BUDGET_MS });
      for (const [symbol, verdict] of probeVerdicts(batch, raw, fetchedAt)) {
        verdicts.set(symbol, verdict);
      }
    } catch (error) {
      // [02] made one bad batch cost every symbol in it its guard, where a
      // serial probe used to cost only the one symbol asked — the only trace
      // left today is instruments that are never priced, so this is the one
      // line `socketProbe` writes that nothing before it did
      // (`docs/operating.md`'s list, [09] adds the stem).
      console.warn(
        `Price probe failed for a batch of ${batch.length} symbols; created anyway and priced by the next refresh:`,
        error,
      );
      for (const symbol of batch) verdicts.set(symbol, { status: "unavailable" });
    }
  }

  // A symbol the pattern refused never reached a batch above — unavailable
  // for the same reason an unknown ticker is: nothing here can tell them
  // apart, and neither blocks creation.
  for (const symbol of symbols) {
    if (!verdicts.has(symbol)) verdicts.set(symbol, { status: "unavailable" });
  }

  return verdicts;
};
