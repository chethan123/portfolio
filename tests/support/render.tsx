/**
 * Renders through the real shell (`Layout`) rather than a page component
 * alone — the open-instance banner and first-run prompt are shell rules, not
 * page rules, so a test of the page in isolation wouldn't notice the shell
 * failing to carry them.
 *
 * Warnings are failures here. Under `createRoutesStub` there's no route
 * manifest behind `Layout`'s `<Links />`, so React emits an empty-href
 * warning that is a stub artefact, not an app bug; {@link renderThroughLayout}
 * allows only that one message and throws on anything else.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { Outlet, createRoutesStub } from "react-router";

import { Layout } from "../../app/root.tsx";

import type { FirstRunStep } from "~/lib/first-run.server";

/** What the root loader returns, which is what `Layout` reads. */
export type RootData = {
  /** Whether a gate fronts the instance; false is what draws the warning. */
  gated: boolean;
  firstRun: FirstRunStep;
  /** Masked amounts (spec 0007). Optional: tests predating masking pass root data without it and must not flip to *masked* by default — `Layout` itself has no default. */
  masked?: boolean;
  /** Household holds any passkey (ticket 06) — gates "Lock now" and its reentry guard. Optional for the same predates-the-feature reason as `masked`; `undefined` reads as no passkey, same as `Layout`. */
  hasPasskey?: boolean;
};

/** Matched on React's formatted message, not a stack — the `%s` placeholders arrive as separate arguments. */
const STUB_STYLESHEET_WARNING = 'An empty string ("") was passed to the';

/**
 * Renders one route's own component with data its real loader produced —
 * unlike {@link renderThroughLayout}, which renders the shell around a
 * stand-in body.
 *
 * Takes hydration data, not a stub loader: a loader resolves a tick after
 * renderToStaticMarkup reads the tree, so the markup would come back empty —
 * and an empty string passes every `not.toContain` assertion vacuously.
 * Pass the real loader's (and action's) output rather than a hand-built
 * fixture, which is a second copy free to drift from it while still passing.
 *
 * `path` may carry a search string — rendered at the whole address, matched
 * on the pathname alone, so a control built from existing params is testable.
 */
export function renderRoute<T>(
  Component: React.ComponentType<never>,
  path: string,
  loaderData: T,
  { masked = false, actionData }: { masked?: boolean; actionData?: unknown } = {},
): string {
  // Pattern is the bare pathname; the stub entry below is the whole address, so a search string in the pattern would match nothing.
  const pattern = path.split("?")[0];

  // Root route carrying the one root-data field every screen's amounts read (spec 0007); without it useMasked falls back to masked, wrong default for a test asserting a figure.
  const Stub = createRoutesStub([
    {
      id: "root",
      path: "/",
      Component: () => <Outlet />,
      children: [{ id: "page", path: pattern, Component: Component as React.ComponentType }],
    },
  ]);

  return renderToStaticMarkup(
    <Stub
      initialEntries={[path]}
      hydrationData={{
        loaderData: { root: { masked }, page: loaderData },
        ...(actionData !== undefined ? { actionData: { page: actionData } } : {}),
      }}
    />,
  );
}

/**
 * Render `path` inside the real `Layout`, with root loader data.
 *
 * @throws whatever React warned about, if it warns about anything other than
 *         the stub's unresolvable stylesheet link.
 */
export function renderThroughLayout(path: string, rootData: RootData): string {
  const warnings: string[] = [];
  const wasErroring = console.error;

  console.error = (...args: unknown[]) => {
    const message = args.map((arg) => String(arg)).join(" ");
    if (!message.startsWith(STUB_STYLESHEET_WARNING)) warnings.push(message);
  };

  const Stub = createRoutesStub([
    {
      id: "root",
      path: "*",
      Component: () => (
        <Layout>
          <p>page body</p>
        </Layout>
      ),
    },
  ]);

  try {
    return renderToStaticMarkup(
      <Stub initialEntries={[path]} hydrationData={{ loaderData: { root: rootData } }} />,
    );
  } finally {
    console.error = wasErroring;
    if (warnings.length > 0) {
      throw new Error(`Rendering ${path} warned:\n${warnings.join("\n")}`);
    }
  }
}
