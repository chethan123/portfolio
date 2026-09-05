/**
 * The one place `yahoo-finance2` is imported from — the worker's own calls
 * and, from this ticket until [06](../docs/specs/price-worker/06-the-app-cutover.md)
 * moves the app behind the socket, the app's adapter too, so there is one
 * client site at every commit rather than two that could drift apart.
 * ARCHITECTURE.md §4.2's import-site row points here.
 *
 * Lives under `server/`, not `app/lib`, because the worker (spec 0018 §3.5)
 * ships without `app/` at all: this module, `yahoo-finance2` and nothing
 * else is its closure. **Imports nothing from `app/lib`** — `matchKey`
 * would pull Kysely in, and a *type* import is not safe either: under
 * Node's type stripping the inline `{ type X }` form leaves a live
 * `import {} from "…"` behind (`tsconfig.json`'s `verbatimModuleSyntax`),
 * and `app/` is not in the image, so the worker would die at import. Every
 * `import type` in this file (and everywhere else under `server/`) must
 * therefore be its own whole statement.
 *
 * Three decisions this module makes so no caller has to:
 *
 *  - **`versionCheck: false`** at construction. The default is `true` and,
 *    on the validation-*failure* path only, fetches
 *    `registry.npmjs.org/yahoo-finance2/latest` (research
 *    `2026-09-04-price-worker-platform-facts.md` §3.2) — a process with no
 *    business resolving npm's hostname must never make that call.
 *  - **`validateResult: false`** on every call — the library's *own* result
 *    validation turned off so one drifted field cannot fail the whole
 *    response (research §3.3): `moduleExec.js` reads the flag and skips the
 *    throw, but the reshape still runs, so coercion is best-effort and the
 *    bad field arrives untouched for the caller's own Zod to refuse. It is a
 *    per-call `ModuleOptions` argument, the third one to `quote`/`chart` —
 *    the constructor refuses the key outright (`InvalidOptionsError`).
 *  - **A fixed 30 s `AbortSignal`, per call, in that same per-call
 *    `fetchOptions`** — never the constructor's, which would be one signal
 *    for the client's entire life. The signal reaches `fetch` *and* the
 *    crumb handshake (research §3.4): the handshake is memoised
 *    single-flight under the *first* caller's `fetchOptions`
 *    (`yahooFinanceFetch.js:74`), so a shorter signal from a second caller
 *    could abort a handshake it only joined. The fix is that every caller
 *    gets the same fixed budget rather than one of its own choosing — no
 *    deadline crosses into this module from outside it.
 */

/** The options one history call sends. Named so a fake can state what it saw. */
export type ChartRequest = {
  /**
   * The range's start. A plain `string`, not `IsoDate` — that type lives
   * under `app/`, which this module must never import (module header). The
   * app converts before handing a request to this client.
   */
  period1: string;
  interval: "1d";
  /**
   * `"split"` alone. The library's default is `"div|split|earn"`, and
   * dividends and earnings are neither read nor wanted on this path.
   */
  events: "split";
};

/**
 * What every caller of this client gets. Both `Promise<unknown>`, on
 * purpose: `validateResult: false` means what comes back is the library's
 * raw, best-effort-coerced JSON, and the caller's own Zod is the only gate
 * (module header) — typing these as anything narrower would be a promise
 * this module cannot keep.
 */
export type YahooClient = {
  quote(symbols: string[]): Promise<unknown>;
  chart(symbol: string, request: ChartRequest): Promise<unknown>;
};

/** Options {@link createYahooClient} takes. */
export type CreateYahooClientOptions = {
  /** The fixed budget every call gets. Defaults to 30 s (module header). */
  timeoutMs?: number;
};

/**
 * The per-call third argument every `quote`/`chart` call sends. Its own type
 * because the library's own overloads do not resolve against an array
 * query — the same reason the app's former adapter cast its client loosely
 * (moved here with it).
 */
type ModuleOptions = {
  validateResult: false;
  fetchOptions: { signal: AbortSignal };
};

/**
 * The shape actually read off the constructed instance: two methods, each
 * taking the query options that matter here and this module's own
 * {@link ModuleOptions} third argument.
 */
type LibraryInstance = {
  quote(symbols: string[], queryOptions: undefined, moduleOptions: ModuleOptions): Promise<unknown>;
  chart(symbol: string, queryOptions: ChartRequest, moduleOptions: ModuleOptions): Promise<unknown>;
};

/**
 * The shared `yahoo-finance2` instance, memoised as a promise so two calls
 * racing before the import resolves still share one client and one cookie
 * jar. A fresh instance per call would redo the library's cookie/crumb
 * handshake on every history call — exactly the burst an unofficial,
 * rate-limiting endpoint punishes.
 */
let library: Promise<LibraryInstance> | undefined;

/**
 * The shared instance, importing and constructing it on first use.
 *
 * **The default export is a class, not a client**: every method also exists
 * on the class as a static that throws (a v2-to-v4 upgrade guard), so
 * calling `quote(...)` on the export type-checks and fails at runtime on
 * every call. `tests/yahoo-client.test.ts` pins this by construction rather
 * than by inspecting the export, which is why it never asserts on the
 * export directly.
 */
function sharedLibrary(): Promise<LibraryInstance> {
  library ??= import("yahoo-finance2").then(
    ({ default: YahooFinance }) =>
      new YahooFinance({ versionCheck: false }) as unknown as LibraryInstance,
  );
  return library;
}

/**
 * `quote(symbols)` and `chart(symbol, request)`, both bounded at a fixed
 * `timeoutMs` (default 30 s, module header) that no caller can shorten or
 * lengthen. Returned synchronously: building this object touches no
 * network and imports nothing until the first call is actually made.
 */
export function createYahooClient({
  timeoutMs = 30_000,
}: CreateYahooClientOptions = {}): YahooClient {
  // A fresh signal per call, never hoisted: `AbortSignal.timeout` starts
  // counting the moment it is created, so one built here and reused across
  // calls would already have fired by the second one.
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
