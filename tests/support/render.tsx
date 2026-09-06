/** Renders through the real shell (`Layout`), not a page component alone — the open-instance banner and
 * first-run prompt are shell rules a page-only test wouldn't notice failing. Warnings are failures here,
 * except `createRoutesStub`'s empty-href stub artefact (no route manifest behind `Layout`'s `<Links />`) —
 * {@link renderThroughLayout} allows only that one message. */
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

/** Renders one route's own component with data its real loader produced — unlike {@link renderThroughLayout},
 * which wraps a stand-in body in the shell. Takes hydration data, not a stub loader, since a loader resolves a
 * tick after renderToStaticMarkup reads the tree — the markup would come back empty and pass every
 * `not.toContain` vacuously. `path` may carry a search string, matched on the pathname alone. */
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

/** Renders `path` inside the real `Layout` with root loader data.
 * @throws whatever React warned about, other than the stub's unresolvable stylesheet link. */
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
