/**
 * The socket half of the provider seam (spec 0018 §3.3, §3.8): the app dials the worker's unix
 * socket instead of `yahoo-finance2`; `price-provider.server.ts` still owns every conversion.
 * Unix socket, not TCP on a bridge — a bridge is symmetric, and the worker dialling the app back
 * should not exist. Nothing is remembered between calls, so a recovery is never delayed.
 * The socket path stays an opaque string here — never stat'ed, read, or created (spec §8).
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

type AskKind = "quotes" | "history";

/** `quotes`: a slow quote is stale on arrival. `history`: past the worker's own 30 s watchdog, so the app reads its `504`. */
const BUDGET_MS: Record<AskKind, number> = {
  quotes: 15_000,
  history: 35_000,
};

/** Shorter than quotes: a cold worker pays a three-fetch crumb handshake, and the lost `non-usd` verdict returns next refresh. */
const PROBE_BUDGET_MS = 10_000;

/** Read to here, then the request is destroyed. 100 quotes ≈ 400 KB, a ten-year chart ≈ 300 KB. */
const BODY_CAP_BYTES: Record<AskKind, number> = {
  quotes: 512 * 1024,
  history: 2 * 1024 * 1024,
};

/** Spec §3.5's own cap on one `/quotes` body. */
const BATCH_SIZE = 100;

/** Mirrors the worker's own `ERROR_TEXT_LIMIT` (`server/price-worker.ts`). */
const ERROR_TEXT_LIMIT = 1000;

/** The worker scrubs its log assuming `JSON.stringify` escapes on the wire — true until this module parses it back. */
function scrubForLog(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, ERROR_TEXT_LIMIT);
}

/**
 * `POST /${kind}` over the unix socket, JSON both ways. No retry. `getConfig()` inside the call, not
 * at module scope, so a test can set `PRICE_WORKER_SOCKET` first.
 *
 * Rejections: `syscall === "connect"` is {@link ProviderUnreachable}, keyed on the syscall and never
 * a code list; an expired budget carries the raw abort as `cause`; a non-`200` carries the body's
 * scrubbed `error`. A `200` resolves whatever shape — the caller's Zod is the only gate.
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
    // Either handler can fire after the other settled (the body-cap `destroy()` raises `error`).
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

            // Empty is legitimate only from Node's own `clientError` status line. On a `200` it is a
            // drifted `undefined` that `JSON.stringify` wrote as nothing, reading back as an empty batch.
            let parsed: unknown;
            if (text.length === 0) {
              if (res.statusCode === 200) {
                reject(new Error(`the worker answered ${kind} with 200 and an empty body`));
                return;
              }
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
                  ? // Scrubbed on the READING side: a forged or upstream-supplied `error` field
                    // with a raw newline would forge lines under the `Price worker:` stem.
                    scrubForLog((parsed as { error: string }).error)
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
        // `cause` is the raw `AbortError` wrapping the signal's `TimeoutError`, so a test can pin it.
        settle(() =>
          reject(
            new Error(`the worker did not answer ${kind} within ${budgetMs}ms`, { cause: error }),
          ),
        );
        return;
      }

      settle(() => reject(error));
    });

    // A socket destroyed after the headers but before the body emits neither `error` nor `end`, so
    // without this the promise hangs. `close` always fires; on the success path `end` beats it.
    req.on("close", () => {
      settle(() => reject(new Error(`the worker's connection closed before the ${kind} answer completed`)));
    });

    req.end(payload);
  });
}

function batchesOf(symbols: string[]): string[][] {
  const batches: string[][] = [];
  for (let start = 0; start < symbols.length; start += BATCH_SIZE) {
    batches.push(symbols.slice(start, start + BATCH_SIZE));
  }
  return batches;
}

/** Dropped before the call: the worker refuses a whole `/quotes` body over one bad entry. Logged every refresh. */
function wellFormedSymbols(symbols: string[]): string[] {
  const good: string[] = [];
  const bad: string[] = [];

  for (const symbol of symbols) {
    (isWellFormedSymbol(symbol) ? good : bad).push(symbol);
  }

  if (bad.length > 0) {
    // Scrubbed: a stored feed symbol may hold any character, so a newline would forge log lines.
    const named = bad.map((symbol) => scrubForLog(symbol)).join(", ");
    console.warn(`Price provider: dropping symbols the pattern refuses: ${named}`);
  }

  return good;
}

/**
 * **Must not throw when built, only when called**: it is `runRefresh`'s default parameter, evaluated
 * before that function's `try`, so a throw here would reach the route's error boundary.
 */
export function socketProvider(): PriceProvider {
  return {
    async getQuotes(symbols: string[]): Promise<ProviderQuote[]> {
      const wellFormed = wellFormedSymbols(symbols);
      if (wellFormed.length === 0) return [];

      const fetchedAt = new Date();
      const quotes: ProviderQuote[] = [];

      // Sequential: pacing costs one unnoticed round trip, against a worker whose `maxConnections` is eight.
      for (const batch of batchesOf(wellFormed)) {
        const raw = await ask("quotes", { symbols: batch });

        for (const entry of Array.isArray(raw) ? raw : []) {
          try {
            const quote = toProviderQuote(entry, fetchedAt);
            if (quote !== null) quotes.push(quote);
          } catch (error) {
            if (!(error instanceof CurrencyRefused)) throw error;
            // A foreign listing must not cost the rest of the batch its prices.
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
        throw error;
      }
    },
  };
}

/**
 * Batches are independent: only a failed batch's symbols become `unavailable`. Never throws — a
 * provider failure must not block creating the instrument.
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
      // The only other trace of a lost verdict is an instrument that never prices (`docs/operating.md`).
      console.warn(
        `Price probe failed for a batch of ${batch.length} symbols; created anyway and priced by the next refresh:`,
        error,
      );
      for (const symbol of batch) verdicts.set(symbol, { status: "unavailable" });
    }
  }

  // A symbol the pattern refused never reached a batch: unavailable, as an unknown ticker is.
  for (const symbol of symbols) {
    if (!verdicts.has(symbol)) verdicts.set(symbol, { status: "unavailable" });
  }

  return verdicts;
};
