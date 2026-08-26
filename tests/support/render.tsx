/**
 * Rendering a page through the real shell.
 *
 * The rules these tests protect — the open-instance banner, the first-run
 * prompt — are properties of `Layout`, not of any one page: "every page carries
 * it" is exactly what a component test rendering the banner on its own would
 * not notice the shell dropping. So the shell is rendered, with the root
 * loader's data supplied the way the framework supplies it.
 *
 * **Warnings are failures here.** `Layout` renders `<Links />`, and under
 * `createRoutesStub` there is no route manifest behind it, so React DOM emits
 * an empty `href` on the stylesheet tag it cannot resolve. That warning is an
 * artefact of the stub rather than anything this application does — but left
 * unfiltered it printed twenty times a run and would have buried a real one.
 * Rather than silence the channel, {@link renderThroughLayout} allows that one
 * known message and throws on anything else React has to say.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { Outlet, createRoutesStub } from "react-router";

import { Layout } from "../../app/root.tsx";

import type { FirstRunStep } from "~/lib/first-run.server";
import type { MaskingPolicy } from "~/lib/masking";

/** What the root loader returns, which is what `Layout` reads. */
export type RootData = {
  authConfigured: boolean;
  firstRun: FirstRunStep;
  /**
   * Whether this browser's amounts are hidden (spec 0007). Optional here and
   * only here: every test written before masking existed passes root data
   * without it, and defaulting to *masked* in those would flip assertions those
   * tests never made. `Layout` itself has no default — the loader always sends
   * one.
   */
  masked?: boolean;
  maskingPolicy?: MaskingPolicy;
};

/**
 * The one warning the stub provokes and the application does not.
 *
 * Matched on the message React formats rather than on a stack, because the
 * substitution placeholders (`%s`) arrive as separate arguments.
 */
const STUB_STYLESHEET_WARNING = 'An empty string ("") was passed to the';

/**
 * Render one route's own component, with data its real loader produced.
 *
 * Separate from {@link renderThroughLayout}, which renders the shell around a
 * stand-in body: this renders the route module's default export itself, which
 * is what a test about a *sentence on a screen* needs.
 *
 * Hydration data rather than a stub loader, deliberately. A loader resolves a
 * tick later than `renderToStaticMarkup` reads the tree, so the markup would
 * come back empty — and an empty string passes every `not.toContain` assertion
 * written against it, which is the failure mode this helper exists to avoid.
 *
 * The caller is expected to pass output from the real loader rather than a
 * hand-built object: a fixture of the loader's shape is a second copy free to
 * drift from it, and the drift looks exactly like a passing test.
 */
export function renderRoute<T>(
  Component: React.ComponentType<never>,
  path: string,
  loaderData: T,
  { masked = false }: { masked?: boolean } = {},
): string {
  // A root route above the page, carrying the one field of root loader data
  // every amount on every screen reads (spec 0007). Without it `useMasked`
  // finds no root data and falls back to *masked* — which is the right
  // fallback in an error boundary and the wrong default for a test asserting
  // on a figure, so the flag is explicit and defaults to showing them.
  const Stub = createRoutesStub([
    {
      id: "root",
      path: "/",
      Component: () => <Outlet />,
      children: [{ id: "page", path, Component: Component as React.ComponentType }],
    },
  ]);

  return renderToStaticMarkup(
    <Stub
      initialEntries={[path]}
      hydrationData={{ loaderData: { root: { masked }, page: loaderData } }}
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
