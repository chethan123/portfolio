/**
 * Only importer of `yahoo-finance2` (ARCHITECTURE.md §4.2). Under `server/` because the
 * worker ships without `app/`: import nothing from `app/lib`, and every `import type` must be
 * its own statement (`verbatimModuleSyntax` leaves a live import behind otherwise).
 *
 * `versionCheck: false` — the default fetches registry.npmjs.org on validation failure.
 * `validateResult: false`, per call (the constructor rejects the key) — one drifted field must
 * not fail the whole response; coercion still runs and the caller's Zod is the gate.
 * Fixed 30 s `AbortSignal` per call, in per-call `fetchOptions` — the crumb handshake is memoised
 * under the first caller's, so no caller may shorten a handshake it only joined.
 */

export type ChartRequest = {
  /** Plain string, not `IsoDate` — that type lives under `app/`. */
  period1: string;
  interval: "1d";
  /** `"split"` only; the library default is `"div|split|earn"`. */
  events: "split";
};

/** Both `unknown`: `validateResult: false` means raw JSON, the caller's Zod is the only gate. */
export type YahooClient = {
  quote(symbols: string[]): Promise<unknown>;
  chart(symbol: string, request: ChartRequest): Promise<unknown>;
};

export type CreateYahooClientOptions = {
  timeoutMs?: number;
};

/** Per-call third argument. Own type: the library's overloads do not resolve against an array query. */
type ModuleOptions = {
  validateResult: false;
  fetchOptions: { signal: AbortSignal };
};

type LibraryInstance = {
  quote(symbols: string[], queryOptions: undefined, moduleOptions: ModuleOptions): Promise<unknown>;
  chart(symbol: string, queryOptions: ChartRequest, moduleOptions: ModuleOptions): Promise<unknown>;
};

/** Memoised as a promise so racing callers share one client and one cookie/crumb handshake. */
let library: Promise<LibraryInstance> | undefined;

/** The default export is a class whose methods also exist as statics that throw — construct it. */
function sharedLibrary(): Promise<LibraryInstance> {
  library ??= import("yahoo-finance2").then(
    ({ default: YahooFinance }) =>
      new YahooFinance({ versionCheck: false }) as unknown as LibraryInstance,
  );
  return library;
}

export function createYahooClient({
  timeoutMs = 30_000,
}: CreateYahooClientOptions = {}): YahooClient {
  // Fresh signal per call: `AbortSignal.timeout` starts counting when it is created.
  const moduleOptions = (): ModuleOptions => ({
    validateResult: false,
    fetchOptions: { signal: AbortSignal.timeout(timeoutMs) },
  });

  return {
    async quote(symbols) {
      const instance = await sharedLibrary();
      return instance.quote(symbols, undefined, moduleOptions());
    },
    async chart(symbol, request) {
      const instance = await sharedLibrary();
      return instance.chart(symbol, request, moduleOptions());
    },
  };
}
