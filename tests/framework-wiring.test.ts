// The one wiring the lock rests on that nothing else in this suite touches: future.v8_middleware.
// With the flag off, react-router never calls runServerMiddlewarePipeline (react-router 7.18.2
// internals), so app/root.tsx's middleware export is never read — every other test still passes
// because each calls the middleware array directly via servedThrough. Two complementary tests: a
// tripwire on the config value, and a hand-built ServerBuild driven through createRequestHandler
// with the flag forced on and off (proves the pipeline; can't notice the config changing).
// Route modules import from source, never build/server — getDb() resolves to this test's own
// transaction via async storage; the built bundle carries its own pool.
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { createRequestHandler, type ServerBuild } from "react-router";

import { TEST_DATABASE_URL, closeTestDatabase, withDatabase } from "./support/database.ts";

process.env.DATABASE_URL = TEST_DATABASE_URL;

// Imported after the environment is set (getConfig() memoises its first read).
const config = (await import("../react-router.config.ts")).default;
const rootModule = await import("../app/root.tsx");
const { stopPricePoller } = await import("~/lib/price-poller.server");

// The price-poller middleware starts the refresh loop — stopped so it doesn't outlive this file.
afterEach(() => {
  stopPricePoller();
});

afterAll(closeTestDatabase);

/** Smallest ServerBuild the 7.18.2 runtime accepts, real root module + one child so /holdings
 * matches something. entry.module's default renders a plain Response — enough to tell "let
 * through" from "refused" without a React render. */
/** Set by the child loader — a thrown loader also renders 200 "page", so the body alone can't
 * tell "served" from "error boundary". */
let childLoaderCalls = 0;

function buildWith(middlewareEnabled: boolean): ServerBuild {
  return {
    routes: {
      root: {
        id: "root",
        path: "",
        module: rootModule,
      },
      child: {
        id: "child",
        parentId: "root",
        path: "holdings",
        module: {
          default: () => null,
          loader: () => {
            childLoaderCalls += 1;
            return {};
          },
        },
      },
    },
    entry: {
      module: { default: () => new Response("page") },
    },
    assets: { entry: { imports: [], module: "" }, routes: {}, url: "", version: "" },
    future: {
      ...config.future,
      v8_middleware: middlewareEnabled,
      v8_passThroughRequests: false,
      v8_trailingSlashAwareDataRequests: false,
    },
    ssr: true,
    prerender: [],
    isSpaMode: false,
    publicPath: "/",
    assetsBuildDirectory: "",
    routeDiscovery: { mode: "lazy", manifestPath: "/__manifest" },
  };
}

async function serve(middlewareEnabled: boolean): Promise<Response> {
  const handler = createRequestHandler(buildWith(middlewareEnabled), "test");
  return handler(new Request("http://portfolio.local/holdings"));
}

describe("the framework flag the lock rests on", () => {
  it("declares middleware on, which is the only reason the root middleware export is ever read", () => {
    // Tripwire only — catches the flag flipping, proves nothing about behavior (test below is the proof).
    expect(config.future?.v8_middleware).toBe(true);
  });

  it(
    "refuses a locked, grant-less document request through the framework's own pipeline, and serves it with the flag off",
    withDatabase(async ({ seedPasskey }) => {
      await seedPasskey({ publicKey: new Uint8Array([1, 2, 3, 4]) });
      childLoaderCalls = 0;

      const refused = await serve(true);
      expect(refused.status).toBe(302);
      expect(refused.headers.get("Location")).toBe("/unlock?redirectTo=%2Fholdings");
      // Refused before anything ran, which a status alone would not say.
      expect(childLoaderCalls).toBe(0);

      // Same build, request, seeded passkey — no lock at all. Without this half, the 302 above could be anything.
      const served = await serve(false);
      expect(served.status).toBe(200);
      expect(await served.text()).toBe("page");
      // Loader ran too — entry.module's default answers 200 "page" for an error render too.
      expect(childLoaderCalls).toBe(1);
    }),
  );

  it(
    "serves the same request with middleware on once the household holds no passkey, so the refusal above is the lock's decision",
    withDatabase(async () => {
      // Control — without it, the 302 above could be anything this harness produces for /holdings.
      childLoaderCalls = 0;

      const served = await serve(true);
      expect(served.status).toBe(200);
      expect(await served.text()).toBe("page");
      expect(childLoaderCalls).toBe(1);
    }),
  );
});

/** `ServerRouteModule` types `default` as required, true only of document routes — not exported
 * from the package, so derived from `ServerBuild` itself rather than reached for by name. Cast to,
 * never satisfied structurally: a resource route's module is exactly the shape this type refuses. */
type ResourceRouteModule = NonNullable<ServerBuild["routes"][string]>["module"];

/** Root's loader has no seam of its own to count calls through, so it is spread with one added —
 * the middleware export under test stays the real one, only the loader becomes observable. */
let rootLoaderCalls = 0;

const rootModuleWithCountedLoader = {
  ...rootModule,
  loader: (...args: Parameters<typeof rootModule.loader>) => {
    rootLoaderCalls += 1;
    return rootModule.loader(...args);
  },
};

/** Same shape as buildWith above, but the child is a resource route — a loader, no `default`, no
 * `ErrorBoundary` — the shape `app/routes/healthz.ts` is, and the one this ticket rests on: the
 * framework runs middleware for it while skipping its parent's loader. */
function buildWithResourceChild(): ServerBuild {
  return {
    routes: {
      root: {
        id: "root",
        path: "",
        module: rootModuleWithCountedLoader,
      },
      child: {
        id: "child",
        parentId: "root",
        path: "healthz",
        // No `default`, no `ErrorBoundary` — same shape as `app/routes/healthz.ts`; the types below
        // insist every route has a `default`, which is only true of document routes.
        module: { loader: () => Response.json({ status: "ok" }) } as unknown as ResourceRouteModule,
      },
    },
    entry: {
      module: { default: () => new Response("page") },
    },
    assets: { entry: { imports: [], module: "" }, routes: {}, url: "", version: "" },
    future: {
      ...config.future,
      v8_middleware: true,
      v8_passThroughRequests: false,
      v8_trailingSlashAwareDataRequests: false,
    },
    ssr: true,
    prerender: [],
    isSpaMode: false,
    publicPath: "/",
    assetsBuildDirectory: "",
    routeDiscovery: { mode: "lazy", manifestPath: "/__manifest" },
  };
}

describe("the resource-route proof this ticket rests on", () => {
  it("runs the middleware pipeline, which arms the price poller, for a resource route whose parent loader never runs", async () => {
    const POLLER_SLOT = Symbol.for("portfolio.pricePoller");
    const host = globalThis as unknown as Record<symbol, unknown>;
    rootLoaderCalls = 0;
    expect(host[POLLER_SLOT]).toBeUndefined();

    const handler = createRequestHandler(buildWithResourceChild(), "test");
    // /healthz is on LOCK_EXEMPT_PATHS and needs no seeded state — the lock middleware exempts it
    // before ever reading the database.
    const response = await handler(new Request("http://portfolio.local/healthz"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    // The proof of the *middleware* path rather than of any path at all: the root loader — which
    // used to be where startPricePoller() ran — never ran for this request.
    expect(rootLoaderCalls).toBe(0);
    expect(host[POLLER_SLOT]).toBeDefined();
  });
});
