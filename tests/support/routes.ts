/**
 * Calls a route the way react-router calls it — builds the Request, catches the Response a
 * loader/action throws for redirects/404s. Pairs with withDatabase (getDb() resolves to the test's transaction).
 */
import { RouterContextProvider } from "react-router";

function withCookie(request: Request, cookie?: string): Request {
  if (cookie !== undefined) request.headers.set("Cookie", cookie);
  return request;
}

// `duplex` is required by the Fetch spec once body is a stream; lib.dom.d.ts doesn't type it yet.
type StreamingRequestInit = RequestInit & { duplex?: "half" };

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
 * Copied from react-router 7.18.2's callRouteHandler (server-runtime/data.ts): URLSearchParams.delete
 * re-serialises the whole query even for an absent key (`,`→`%2C`, space→`+`), so a hand-typed URL doesn't match what a route actually sees.
 */
function stripIndexParam(request: Request): Request {
  const url = new URL(request.url);
  const indexValues = url.searchParams.getAll("index");
  url.searchParams.delete("index");
  for (const value of indexValues) if (value) url.searchParams.append("index", value);

  return rebuild(url, request);
}

/** Same reproduction as stripIndexParam, for `_routes`. */
function stripRoutesParam(request: Request): Request {
  const url = new URL(request.url);
  url.searchParams.delete("_routes");

  return rebuild(url, request);
}

/**
 * The request a loader/action is actually handed, after react-router's own stripRoutesParam(stripIndexParam(...))
 * rebuild. Under future.v8_passThroughRequests that rebuild goes away — delete both strippers with it.
 */
function throughRouteHandler(request: Request): Request {
  return stripRoutesParam(stripIndexParam(request));
}

export function get(path: string, cookie?: string): Request {
  return withCookie(throughRouteHandler(new Request(`http://portfolio.local${path}`)), cookie);
}

export function post(
  path: string,
  fields: Record<string, string | string[]>,
  cookie?: string,
  // Origin: crossOriginMutationMiddleware (app/root.tsx) cares whether it's set;
  // omitting it is itself a case that rule decides.
  headers?: Record<string, string>,
): Request {
  const body = new FormData();

  for (const [name, value] of Object.entries(fields)) {
    if (Array.isArray(value)) for (const one of value) body.append(name, one);
    else body.set(name, value);
  }

  const request = withCookie(
    throughRouteHandler(new Request(`http://portfolio.local${path}`, { method: "POST", body })),
    cookie,
  );
  for (const [name, value] of Object.entries(headers ?? {})) request.headers.set(name, value);
  return request;
}

/** POST with a real file part — the drop screen reads the file off FormData, not a filename field. */
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

/** {request, params} only — no route here reads context. Cast at the call site; generated Route.LoaderArgs isn't reachable here. */
export function args(request: Request, params: Record<string, string> = {}) {
  return { request, params } as never;
}

/** Runs a route fn; routes signal redirects/404s by throwing a Response, so both outcomes land here rather than in a try. */
export async function outcomeOf<T>(run: () => Promise<T>): Promise<T | Response> {
  try {
    return await run();
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

export async function responseOf(run: () => Promise<unknown>): Promise<Response> {
  const outcome = await outcomeOf(run);

  if (!(outcome instanceof Response)) {
    throw new Error(
      `Expected the route to throw a Response, and it returned ${JSON.stringify(outcome)}.`,
    );
  }
  return outcome;
}

export async function redirectTo(run: () => Promise<unknown>): Promise<string> {
  const response = await responseOf(run);

  if (response.status < 300 || response.status >= 400) {
    throw new Error(`Expected a redirect, and the route answered ${response.status}.`);
  }
  return response.headers.get("Location") ?? "";
}

/** Runs a route's middleware chain around a stand-in response (middleware wraps the response, not the loader's
 * return value). `onNext` asserts a pre-next() refusal short-circuited — "no figure in the markup" passes
 * vacuously against a refusal too. Flat loop, not nested: can't assert order between two middleware directly,
 * and doesn't reproduce callRouteHandler's request rebuild. */
export async function servedThrough(
  middleware: readonly unknown[], // untyped against generated Route.MiddlewareFunction[]; cast at call site
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

/** Canonical sorted owner= param for 2+ ids. Hand-built, not via toOwnerParam, so a test can't pass by matching the function it's testing. */
export function ownerParam(...ids: string[]): string {
  return [...ids]
    .sort((a, b) => Number(a) - Number(b))
    .map((id) => `owner=${id}`)
    .join("&");
}
