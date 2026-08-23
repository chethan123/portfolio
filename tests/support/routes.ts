/**
 * Calling a route the way the framework calls it.
 *
 * Route modules import cleanly under vitest with no plugin and no manifest:
 * their one framework-shaped import, `./+types/*`, is types only and is erased
 * before the module ever runs. So a loader or an action is an ordinary async
 * function taking `{ request, params }`, and these helpers are the small amount
 * of ceremony around that — building the request, and catching the `Response`
 * a route throws instead of returning.
 *
 * What is being tested here is only ever the route's own contribution: the
 * redirects, the guards, the error mapping and the shape handed to the
 * component. The rules underneath belong to `app/lib/*` and are tested there.
 *
 * These pair with `withDatabase` from `./database.ts`, which now scopes
 * `getDb()` to the test's transaction — so a loader that queries with no
 * argument reads the seeded rows and rolls back with everything else.
 */

/** A GET, with search params if the route reads any. */
export function get(path: string): Request {
  return new Request(`http://portfolio.local${path}`);
}

/** A POST of form fields, encoded as a browser encodes them. */
export function post(path: string, fields: Record<string, string | string[]>): Request {
  const body = new FormData();

  for (const [name, value] of Object.entries(fields)) {
    if (Array.isArray(value)) for (const one of value) body.append(name, one);
    else body.set(name, value);
  }

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
