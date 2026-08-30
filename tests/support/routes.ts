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

/** A GET, with search params if the route reads any, and a cookie if it reads one. */
export function get(path: string, cookie?: string): Request {
  return withCookie(new Request(`http://portfolio.local${path}`), cookie);
}

/** A POST of form fields, encoded as a browser encodes them. */
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

  return withCookie(new Request(`http://portfolio.local${path}`, { method: "POST", body }), cookie);
}

/**
 * A POST carrying a file part, as the upload screen's form does.
 *
 * `formFields` drops file parts by design, so the drop screen reads the file
 * off the `FormData` itself — which means a journey through it has to send a
 * real one rather than a filename in a text field.
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

  return new Request(`http://portfolio.local${path}`, { method: "POST", body });
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
 */
export async function servedThrough(
  // Untyped against a generated `Route.MiddlewareFunction[]`, deliberately —
  // there are as many of those types as there are routes, one per generated
  // `+types` module, and no single import here could name all of them. Cast
  // at the call site instead, for `args()`'s own reason above.
  middleware: readonly unknown[],
  request: Request,
  params: Record<string, string> = {},
): Promise<Response> {
  const served = new Response("the page");
  let response: Response = served;

  for (const step of middleware) {
    const run = step as (args: never, next: () => Promise<unknown>) => Promise<unknown>;
    response = (await run(
      { request, params, context: new RouterContextProvider(), url: new URL(request.url), pattern: "/" } as never,
      async () => served,
    )) as Response;
  }

  return response;
}
