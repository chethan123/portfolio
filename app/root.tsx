import {
  Link,
  Links,
  Meta,
  NavLink,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLocation,
  useRouteError,
  useRouteLoaderData,
} from "react-router";

import { ErrorPage } from "~/components/error-page";
import { FirstRunPrompt } from "~/components/first-run-prompt";
import {
  AnalysisIcon,
  DashboardIcon,
  HoldingsIcon,
  IncomeIcon,
  SettingsIcon,
  UploadIcon,
} from "~/components/icons";
import { MaskingToggle } from "~/components/masking-toggle";
import { OpenInstanceBanner } from "~/components/open-instance-banner";
import { firstRunStep, type FirstRunStep } from "~/lib/first-run.server";
import { readMaskingCookie, resolveMasked, type MaskingPolicy } from "~/lib/masking";
import { ownerSearch, readOwnerFilter } from "~/lib/owner-filter";
import { startPricePoller } from "~/lib/price-poller.server";
import { readMaskingPolicy } from "~/lib/settings.server";
import { getConfig } from "../server/config.ts";

import type { Route } from "./+types/root";

import "./app.css";

/*
 * The gate used to be wired here as root middleware; nothing replaces it —
 * authentication happens in front, so a request reaching this process is
 * already admitted. One thing rides in on every request, recorded only here:
 * the gate attaches the verified address as `X-Auth-Request-Email`, and the
 * app reads it nowhere, deliberately. Attribution, never permission
 * (CONTEXT.md): every family member sees and can do everything. A later
 * feature may read it to record *who* did a thing; none may read it to
 * decide *whether* they may.
 */

/**
 * Every rendered page and every single-fetch payload leaves with
 * `Cache-Control: no-store`. Masking is a display state (ADR-0002), so a
 * masked page still carries every figure in its hydration payload, and the
 * household refused a cache on the phone (ADR-0007) — the browser's HTTP
 * cache, and the house proxy in front, are that cache by another route. Set
 * here once: a route that exports no `headers` inherits its parent's, and no
 * route does, so this reaches every document and `.data` response, error
 * pages included. `/healthz` states its own; hashed `/assets/*` keep the
 * server's `immutable`; a resource route answers with its own `Response`. The
 * price is back-forward restoration on Firefox and Safari: Back re-fetches
 * through the gate.
 */
export const headers: Route.HeadersFunction = () => ({ "Cache-Control": "no-store" });

/**
 * What the shell around every page needs: whether anything guards the
 * instance, whether it is set up yet, and whether this browser is masked.
 *
 * The first-run read is failure-tolerant — a hint, not data: a database that
 * is down produces a page without a prompt, not an error page over every
 * screen (`/healthz` is what reports the outage). **Masking is resolved
 * here, on the server** (§12's reason for the theme): the first paint must
 * be correct — a page that drew the amounts and then hid them is the one
 * failure this feature cannot have, and exactly what reading `localStorage`
 * after hydration would produce (story 30). The policy read fails to
 * *masked*: of the two ways to be wrong with the database down, a page of
 * dots cannot expose anything.
 */
export async function loader({ request }: Route.LoaderArgs) {
  // The quote refresh loop (§6.2), started here because root's loader is the
  // one server-side path every render passes through (no server entry file
  // under `react-router-serve`). Idempotent, not awaited, cannot throw:
  // polling must never be able to fail a page render.
  startPricePoller();

  let firstRun: FirstRunStep = null;

  try {
    firstRun = await firstRunStep();
  } catch (error) {
    console.error("First-run check failed; continuing without the prompt:", error);
  }

  let masked = true;
  // Published alongside the answer because the toggle's own script needs it:
  // the cookie's lifetime is the policy's, and the client writer has to produce
  // a byte-identical cookie to the one the action would have written.
  let maskingPolicy: MaskingPolicy = "masked";

  try {
    maskingPolicy = await readMaskingPolicy();
    masked = resolveMasked(maskingPolicy, readMaskingCookie(request));
  } catch (error) {
    console.error("Masking policy read failed; masking this render:", error);
  }

  // Read here rather than in the banner, because a component cannot: the value
  // is an environment variable and the browser has no environment.
  return { gated: getConfig().AUTH_GATE === "external", firstRun, masked, maskingPolicy };
}

/**
 * DESIGN.md §8.4 — ordered by how often each page is opened. The rail's
 * *shape* is the Stitch screens' (§13.1): fixed 280px column, brand tile at
 * its head, 4px accent stroke on the active item, one filled button at its
 * foot. Its *contents* are §8.4's items rather than the mock's three.
 */
const NAVIGATION = [
  { to: "/", label: "Overview", end: true, Icon: DashboardIcon },
  { to: "/holdings", label: "Holdings", end: false, Icon: HoldingsIcon },
  { to: "/analysis", label: "Analysis", end: false, Icon: AnalysisIcon },
  { to: "/income", label: "Income", end: false, Icon: IncomeIcon },
] as const;

/** Settings sits at the foot of the rail: a few times ever, not daily (§8.4). */
const FOOTER_NAVIGATION = [
  { to: "/settings", label: "Settings", end: false, Icon: SettingsIcon },
] as const;

type NavItem = (typeof NAVIGATION)[number] | (typeof FOOTER_NAVIGATION)[number];

/**
 * `search` is the owner filter, a prop rather than read here (spec 0013,
 * ADR-0008). This renders four times — `NAVIGATION` in the rail and the
 * phone's bottom bar, Settings in both — and Settings never reads the
 * filter, so only the two calls that carry it say so. The owner parameter
 * alone, never `location.search`: the whole search would drag one screen's
 * `range`, `sort` or half-typed `edit` key onto another and bounce every
 * nav click through Holdings' canonical redirect.
 */
function NavItems({ items, search = "" }: { items: readonly NavItem[]; search?: string }) {
  return (
    <>
      {items.map(({ to, label, end, Icon }) => (
        <li key={to}>
          <NavLink
            // `NavLink` resolves active state on the pathname alone, so `end`
            // and `aria-current` are unchanged by a search; an empty one
            // collapses to a bare path, keeping unfiltered URLs clean.
            to={{ pathname: to, search }}
            end={end}
            className={({ isActive }) =>
              isActive ? "app-nav-link app-nav-link--active" : "app-nav-link"
            }
          >
            <Icon className="app-nav-icon" />
            <span>{label}</span>
          </NavLink>
        </li>
      ))}
    </>
  );
}

/**
 * The mark, at both sizes it is drawn: the rail, and the phone's top bar.
 * It carries the owner filter because it is a nav item in all but name —
 * landing on an unfiltered Overview from a filtered Holdings would be the
 * most-clicked way to lose the filter.
 */
function Brand({ search }: { search: string }) {
  return (
    <Link className="app-brand" to={{ pathname: "/", search }}>
      <span className="app-brand-tile" aria-hidden="true">
        P
      </span>
      <span>
        <span className="app-brand-mark">Portfolio</span>
        <span className="app-brand-meta u-label">Self-hosted</span>
      </span>
    </Link>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  // From the root loader, not a prop: `Layout` wraps error boundaries too,
  // where there is no loader data at all. The banner lives here so every
  // route — including ones that do not exist — carries it.
  const rootData = useRouteLoaderData<typeof loader>("root");
  const { pathname, search } = useLocation();

  // Read off the address, which is the whole of the filter's state
  // (ADR-0008) — a loader could not hand it down inside an error boundary.
  const owners = ownerSearch(readOwnerFilter(new URLSearchParams(search)));

  // Suppressed inside Settings — the one place it would send someone where
  // they already are; everywhere else it is the single pointer at the next
  // step (DESIGN.md §8.4).
  const firstRun =
    rootData?.firstRun && !pathname.startsWith("/settings") ? rootData.firstRun : null;

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#f7f9fb" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#0b1326" media="(prefers-color-scheme: dark)" />
        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
        {/* `use-credentials`, because Chrome fetches a manifest without cookies
            by default — behind the gate that turns install into a silent
            sign-in redirect (docs/specs/0012). */}
        <link rel="manifest" href="/manifest.webmanifest" crossOrigin="use-credentials" />
        <Meta />
        <Links />
      </head>
      <body>
        <div className="app">
          <nav className="app-rail" aria-label="Primary">
            <Brand search={owners} />
            <ul className="app-nav">
              <NavItems items={NAVIGATION} search={owners} />
            </ul>
            <ul className="app-nav app-nav--footer">
              <NavItems items={FOOTER_NAVIGATION} />
            </ul>
            {/* In the rail's foot beside Settings rather than in its nav list:
                it is a control, not a destination, and a `<li>` among the links
                would announce it as one. */}
            <MaskingToggle className="app-rail-masking" />

            <Link className="button app-rail-action" to="/upload">
              <UploadIcon />
              Upload statement
            </Link>
          </nav>

          <div className="app-canvas">
            {/* Below 1024px the rail is gone, so the bar carries the mark and
             * the one action the rail's foot would have held. */}
            <header className="app-topbar">
              <Brand search={owners} />
              <div className="app-topbar-actions">
                <MaskingToggle />
                <Link className="button" to="/upload">
                  <UploadIcon />
                  Upload
                </Link>
              </div>
            </header>

            {rootData?.gated === false ? <OpenInstanceBanner /> : null}
            <main className="app-main">
              {firstRun ? <FirstRunPrompt step={firstRun} /> : null}
              {children}
            </main>
          </div>

          {/* The phone's nav: a bottom bar, which is what every mobile mock
           * does — no drawer and no hamburger anywhere in the set (§13.1). */}
          <nav className="app-bottomnav" aria-label="Primary">
            <ul className="app-nav">
              <NavItems items={NAVIGATION} search={owners} />
              <NavItems items={FOOTER_NAVIGATION} />
            </ul>
          </nav>
        </div>
        <ScrollRestoration />
        <Scripts />
        {/* The worker exists for its offline page alone and stores nothing on
            the device (ADR-0007). Registration failing — no support, a lapsed
            gate session — is silent by design: the app works without it. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js");`,
          }}
        />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

/* Everything this used to do is in `ErrorPage`, reasoning included — a
 * component because the upload flow's boundary needs the identical page for
 * everything that is not an expired draft. */
export function ErrorBoundary() {
  return <ErrorPage error={useRouteError()} />;
}
