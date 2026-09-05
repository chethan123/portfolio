/**
 * The one wiring the lock rests on that no other test in this suite touches:
 * `future.v8_middleware`. With the flag off, `handleDocumentRequest` passes
 * no `generateMiddlewareResponse`
 * (`node_modules/react-router/dist/development/chunk-ZA36QIGN.mjs:1430-1441`)
 * and `staticHandler.query` never calls `runServerMiddlewarePipeline`
 * (`chunk-62JRHF6Z.mjs:3522-3534`), so `app/root.tsx`'s `middleware` export
 * is never read and the lock is simply gone — with every other test in this
 * repository still green, because every one of them calls the exported
 * middleware array directly through `servedThrough`.
 *
 * Two tests, and they are complementary rather than one being the better
 * half. The first is a tripwire on the config value: it fails the moment
 * somebody flips the flag, and proves nothing about what the framework then
 * does. The second builds a `ServerBuild` by hand and puts a real request
 * through `createRequestHandler`, which is the only way here to watch the
 * pipeline actually run — and it *overrides* the config's flag deliberately,
 * driving the same build twice with it on and off, so it fails if the lock
 * stops refusing and it fails if this harness stops being able to tell the
 * difference. Because it overrides, it cannot notice the config being
 * turned off; that is the tripwire's job, and neither test covers the
 * other's.
 *
 * **The route modules are imported from source, never from `build/server`.**
 * `getDb()` resolves to the test's own transaction through async storage, and
 * the built bundle carries its own pool: run against that, this would need
 * committed rows and a cleanup pass instead of a rollback.
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";

import { createRequestHandler, type ServerBuild } from "react-router";

import { TEST_DATABASE_URL, closeTestDatabase, withDatabase } from "./support/database.ts";

process.env.DATABASE_URL = TEST_DATABASE_URL;

// Imported after the environment is set, the way every other route test in
// this suite does it: `getConfig()` memoises its first read.
const config = (await import("../react-router.config.ts")).default;
const rootModule = await import("../app/root.tsx");
const { stopPricePoller } = await import("~/lib/price-poller.server");

// The root loader starts the refresh loop, exactly as it does in
// `tests/routes/root.test.ts`; stopped rather than left to outlive this file.
afterEach(() => {
  stopPricePoller();
});

afterAll(closeTestDatabase);

/**
 * The smallest `ServerBuild` the 7.18.2 runtime accepts, with the real root
 * module and one child so `/holdings` matches something. `entry.module`'s
 * default is what a document request renders through, so answering a plain
 * `Response` is enough to tell "the lock let this through" from "the lock
 * refused it" without a React render.
 */
function buildWith(middlewareEnabled: boolean): ServerBuild {
  return {
    routes: {
      root: {
        id: "root",
        path: "",
        module: rootModule as unknown as NonNullable<ServerBuild["routes"][string]>["module"],
      },
      child: {
        id: "child",
        parentId: "root",
        path: "holdings",
        module: { default: () => null, loader: () => ({}) } as unknown as NonNullable<ServerBuild["routes"][string]>["module"],
      },
    },
    entry: {
      module: { default: () => new Response("page") } as unknown as ServerBuild["entry"]["module"],
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
  } as unknown as ServerBuild;
}

async function serve(middlewareEnabled: boolean): Promise<Response> {
  const handler = createRequestHandler(buildWith(middlewareEnabled), "test");
  return handler(new Request("http://portfolio.local/holdings"));
}

describe("the framework flag the lock rests on", () => {
  it("declares middleware on, which is the only reason the root middleware export is ever read", () => {
    // A tripwire, not a proof: it catches the flag being turned off, and
    // says nothing about what the framework then does. The test below is
    // the proof.
    expect(config.future?.v8_middleware).toBe(true);
  });

  it(
    "refuses a locked, grant-less document request through the framework's own pipeline, and serves it with the flag off",
    withDatabase(async ({ seedPasskey }) => {
      await seedPasskey({ publicKey: new Uint8Array([1, 2, 3, 4]) });

      const refused = await serve(true);
      expect(refused.status).toBe(302);
      expect(refused.headers.get("Location")).toBe("/unlock?redirectTo=%2Fholdings");

      // The same build, the same request, the same seeded passkey — and no
      // lock at all. This half is what makes the half above mean something:
      // without it a 302 could be coming from anywhere.
      const served = await serve(false);
      expect(served.status).toBe(200);
      expect(await served.text()).toBe("page");
    }),
  );
});
