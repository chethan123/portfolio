/**
 * Calling a route the way the framework calls it. Route modules import
 * cleanly under vitest — their one framework-shaped import, `./+types/*`,
 * is types-only and erased — so a loader or action is an ordinary async
 * function taking `{ request, params }`, and these helpers are the ceremony
 * around that: building the request, catching the `Response` a route throws
 * instead of returning. Only the route's own contribution is tested here —
 * redirects, guards, error mapping, the shape handed to the component; the
 * rules underneath are `app/lib/*`'s. Pairs with `withDatabase`, which
 * scopes `getDb()` to the test's transaction, so an argument-less loader
 * query reads the seeded rows and rolls back with everything else.
 *
 * "The way the framework calls it" includes a step it is tempting to skip:
 * every request a loader or action sees has already been rebuilt once by
 * `callRouteHandler`, which can respell its query string along the way
 * (`throughRouteHandler` below says how and why). A builder here that
 * returned the bare `new Request(url)` a hand-typed address parses to would
 * be testing a request no route ever actually receives.
 */
import { RouterContextProvider } from "react-router";

/**
 * The `Cookie` header a browser would send, or nothing.
 *
 * Optional because almost no route reads one. The masking work (spec 0007) is
 * the exception: whether a screen is masked is resolved from a cookie on the
 * way in, so a test that cannot send one cannot drive the feature at all.
 * Taking a bare value keeps the call sites reading as the question they are
 * asking — `get("/", MASKED)` — rather than as header construction.
 */
function withCookie(request: Request, cookie?: string): Request {
  if (cookie !== undefined) request.headers.set("Cookie", cookie);
  return request;
}

/**
 * The `RequestInit` react-router's own strippers pass to `new Request`,
 * widened by the one field `lib.dom.d.ts` does not yet type: `duplex` is
 * required by the Fetch spec whenever `body` is a stream rather than `null`,
 * which is exactly the branch a POST takes below.
 */
type StreamingRequestInit = RequestInit & { duplex?: "half" };

/**
 * Rebuild a request from a (possibly just-mutated) `URL`, carrying its body,
 * headers and signal across unchanged — the half both of react-router's own
 * strippers share, pulled out here rather than repeated per the way the
 * source does it.
 */
function rebuild(url: URL, request: Request): Request {
  const init: StreamingRequestInit = {
    method: request.method,
    body: request.body,
    headers: request.headers,
    signal: request.signal,
  };
  if (init.body) init.duplex = "half";

  return new Request(url.href, init);
}

/**
 * `stripIndexParam`, copied from react-router 7.18.2's
 * `lib/server-runtime/data.ts` rather than reimplemented from what it is
 * "supposed" to do: the one behaviour this whole file exists to reproduce is
 * a `URLSearchParams.delete` re-serialising the query even when the deleted
 * key was never present, and that is a fact about the form-urlencoded
 * serialiser, not a rule worth restating in fresh words that could quietly
 * stop matching it. (A same-named `stripIndexParam` also lives in
 * react-router's client bundle, for single-fetch navigation — a different
 * function, taking a `URL` rather than a `Request`, not this one.)
 */
function stripIndexParam(request: Request): Request {
  const url = new URL(request.url);
  const indexValues = url.searchParams.getAll("index");
  url.searchParams.delete("index");
  for (const value of indexValues) if (value) url.searchParams.append("index", value);

  return rebuild(url, request);
}

/** `stripRoutesParam`, same source, same reason above. */
function stripRoutesParam(request: Request): Request {
  const url = new URL(request.url);
  url.searchParams.delete("_routes");

  return rebuild(url, request);
}

/**
 * The request as a loader or action is actually handed it. react-router
 * 7.18.2's `callRouteHandler` (`lib/server-runtime/data.ts`) rebuilds every
 * request through `stripRoutesParam(stripIndexParam(...))` before a route
 * ever sees it, and a `delete` of an **absent** key still marks
 * `URLSearchParams` dirty, so Node re-derives `.search` from the
 * form-urlencoded serialiser rather than returning the original string
 * untouched — `,` becomes `%2C`, a space becomes `+`. A helper that skipped
 * this handed a loader the URL parser's spelling, which is not the spelling
 * either a `curl` or a browser's fetch ever produces once react-router has
 * touched the request, and a test built on it settles on paper while the real
 * thing loops: the settle chain in `tests/owner-reading.test.ts` was green
 * against exactly that loop before this rebuild existed.
 *
 * This mirrors 7.18.2 behaviour, not a documented contract. Under
 * `future.v8_passThroughRequests` the framework stops rebuilding and hands a
 * loader `args.request` exactly as sent — not the fix, since it only moves
 * the fixed-point question from this serialiser to whichever one the
 * transport that sent the request used. Whoever flips that flag here must
 * delete `throughRouteHandler` and its two strippers rather than trust them
 * to still be reproducing anything real.
 */
function throughRouteHandler(request: Request): Request {
  return stripRoutesParam(stripIndexParam(request));
}

/** A GET, with search params if the route reads any, and a cookie if it reads one. */
export function get(path: string, cookie?: string): Request {
  return withCookie(throughRouteHandler(new Request(`http://portfolio.local${path}`)), cookie);
}

/**
 * A POST of form fields, encoded as a browser encodes them, then rebuilt the
 * same way a GET is — the server wraps an action in the identical
 * `callRouteHandler`, so a POST that skipped it would be faithful to nothing
 * that reads a query parameter, even though no action here reads one the
 * form serialiser would respell.
 */
export function post(
  path: string,
  fields: Record<string, string | string[]>,
  cookie?: string,
): Request {
  const body = new FormData();

  for (const [name, value] of Object.entries(fields)) {
    if (Array.isArray(value)) for (const one of value) body.append(name, one);
    else body.set(name, value);
  }

  return withCookie(
    throughRouteHandler(new Request(`http://portfolio.local${path}`, { method: "POST", body })),
    cookie,
  );
}

/**
 * A POST carrying a file part, as the upload screen's form does.
 *
 * `formFields` drops file parts by design, so the drop screen reads the file
 * off the `FormData` itself — which means a journey through it has to send a
 * real one rather than a filename in a text field. Rebuilt through the same
 * `throughRouteHandler` as the other two builders: this one used to build its
 * `Request` by hand and skip it, which made it the one builder in this file
 * still lying about what a loader is handed.
 */
export function postFile(
  path: string,
  file: { name: string; content: string; type?: string },
  fields: Record<string, string> = {},
): Request {
  const body = new FormData();

  for (const [name, value] of Object.entries(fields)) body.set(name, value);
  body.set(
    "file",
    new File([file.content], file.name, { type: file.type ?? "text/csv" }),
    file.name,
  );

  return throughRouteHandler(new Request(`http://portfolio.local${path}`, { method: "POST", body }));
}

/**
 * The arguments a loader or action destructures.
 *
 * No route in this application reads `context`, and the ones that read
 * `params` read only the values in the URL — so this is the whole surface.
 * Cast at the call site, because the generated `Route.LoaderArgs` carries the
 * framework's full shape and none of the rest of it is reachable from here.
 */
export function args(request: Request, params: Record<string, string> = {}) {
  return { request, params } as never;
}

/**
 * Run a route function and return whatever it produced — thrown or returned.
 *
 * React Router routes signal a redirect or a 404 by throwing a `Response`, and
 * report a validation failure by returning data. Both are ordinary outcomes of
 * a correct route, so a test wants them in one place rather than in a `try`.
 */
export async function outcomeOf<T>(run: () => Promise<T>): Promise<T | Response> {
  try {
    return await run();
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

/**
 * The `Response` a route threw, or a failure if it did not throw one.
 *
 * Use where the redirect *is* the rule under test, so that a route which
 * quietly starts returning data fails here rather than several assertions later
 * against `undefined`.
 */
export async function responseOf(run: () => Promise<unknown>): Promise<Response> {
  const outcome = await outcomeOf(run);

  if (!(outcome instanceof Response)) {
    throw new Error(
      `Expected the route to throw a Response, and it returned ${JSON.stringify(outcome)}.`,
    );
  }
  return outcome;
}

/** Where a redirect points, which is the only part of one a test cares about. */
export async function redirectTo(run: () => Promise<unknown>): Promise<string> {
  const response = await responseOf(run);

  if (response.status < 300 || response.status >= 400) {
    throw new Error(`Expected a redirect, and the route answered ${response.status}.`);
  }
  return response.headers.get("Location") ?? "";
}

/**
 * Runs a route's middleware chain the way the framework does, around a
 * stand-in response.
 *
 * A route's middleware wraps the *response*, not the loader's return value —
 * `chart-range.ts`'s `chartRangeMiddleware` works this way, precisely so its
 * loaders keep returning the plain object every other test in this suite reads
 * fields off directly. What a
 * middleware adds to (or refuses) that response is what this helper is for;
 * what the loader underneath it returns is `loader(args(...))`'s question,
 * not this one's. A middleware step may throw a `Response` instead of
 * returning one — `outcomeOf`/`responseOf` above are what unwrap that.
 *
 * **`onNext`, for a middleware whose whole point is refusing before `next()`
 * runs** (the lock, `app/root.tsx`'s `middleware`). Asserting "the markup
 * contains no figure" against a refusal that renders nothing passes
 * unconditionally — the vacuous test that boundary exists to forbid — so a
 * caller proving a refusal passes a callback here and asserts it was never
 * invoked, rather than inspecting the response `next()` would have produced.
 * Optional and side-effect-only, so every existing caller — which reads the
 * response `chartRangeMiddleware` decorated and has no reason to care whether
 * `next` ran, since it always does — is unaffected.
 *
 * **One thing this does not reproduce.** `callRouteHandler`'s rebuild is a
 * loader/action-only step — the pipeline calls middleware with the request as
 * it arrived, before `throughRouteHandler` above would ever touch it — so
 * `servedThrough(middleware, get(...))` hands a middleware the request
 * builders' already-rebuilt (form-normal) spelling where the real pipeline
 * would still hand it the URL parser's. Harmless today: `chartRangeMiddleware`
 * reads only `range`, which no owner-filter respelling touches. Worth stating
 * rather than leaving for whoever adds the next middleware to discover cold.
 */
export async function servedThrough(
  // Untyped against a generated `Route.MiddlewareFunction[]`, deliberately —
  // there are as many of those types as there are routes, one per generated
  // `+types` module, and no single import here could name all of them. Cast
  // at the call site instead, for `args()`'s own reason above.
  middleware: readonly unknown[],
  request: Request,
  params: Record<string, string> = {},
  onNext?: () => void,
): Promise<Response> {
  const served = new Response("the page");
  let response: Response = served;

  for (const step of middleware) {
    const run = step as (args: never, next: () => Promise<unknown>) => Promise<unknown>;
    response = (await run(
      { request, params, context: new RouterContextProvider(), url: new URL(request.url), pattern: "/" } as never,
      async () => {
        onNext?.();
        return served;
      },
    )) as Response;
  }

  return response;
}

/**
 * The canonical, repeated-key owner parameter for two or more ids — sorted
 * numerically the way `canonicalise` (`owner-filter.ts`) orders them — for
 * asserting a bounce target or building a request that is already canonical.
 * Hand-built, deliberately not calling `toOwnerParam`: a test pinning the
 * canonical spelling by calling the function under test would pass no matter
 * what that function produced.
 */
export function ownerParam(...ids: string[]): string {
  return [...ids]
    .sort((a, b) => Number(a) - Number(b))
    .map((id) => `owner=${id}`)
    .join("&");
}
