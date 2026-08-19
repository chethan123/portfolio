import {
  Links,
  Meta,
  NavLink,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useLocation,
  useRouteError,
  useRouteLoaderData,
} from "react-router";

import { FirstRunPrompt } from "~/components/first-run-prompt";
import {
  DashboardIcon,
  HoldingsIcon,
  IncomeIcon,
  SettingsIcon,
  UploadIcon,
} from "~/components/icons";
import { OpenInstanceBanner } from "~/components/open-instance-banner";
import { authGate } from "~/lib/auth.server";
import { firstRunStep, type FirstRunStep } from "~/lib/first-run.server";

import type { Route } from "./+types/root";

import "./app.css";

/**
 * The login gate, DESIGN.md §10 — one middleware, on the route every other
 * route descends from.
 *
 * This is the whole enforcement point. It is deny-by-default: it refuses any
 * request without a session except the handful of paths `auth.server.ts` lists
 * as open, so a route added by a later slice needs nothing done to it to be
 * protected. With `AUTH_PASSWORD` unset the gate lets everything through and
 * the banner below says so.
 */
export const middleware: Route.MiddlewareFunction[] = [
  async ({ request }, next) => {
    await authGate().requireSession(request);
    return next();
  },
];

/**
 * What the shell around every page needs: whether the instance is password
 * protected, and whether it has been set up yet.
 *
 * The first-run read is deliberately failure-tolerant. It is a hint, not data —
 * so a database that is down produces a page without a prompt rather than an
 * error page, and in particular leaves the login page working when the database
 * is unreachable. `/healthz` is what reports the database being down, and it
 * reports it without needing credentials.
 */
export async function loader() {
  let firstRun: FirstRunStep = null;

  try {
    firstRun = await firstRunStep();
  } catch (error) {
    console.error("First-run check failed; continuing without the prompt:", error);
  }

  return { authConfigured: authGate().enabled, firstRun };
}

/**
 * DESIGN.md §8.4 — ordered by how often each page is opened.
 *
 * The rail's *shape* is the Stitch screen's (§13.1): fixed 200px, a 2px accent
 * stroke on the active item's leading edge. Its *contents* are §8.4's five
 * items rather than the mock's three, because the ordering there is a decision
 * about frequency of use and the routes it names already exist.
 */
const NAVIGATION = [
  { to: "/", label: "Overview", end: true, Icon: DashboardIcon },
  { to: "/holdings", label: "Holdings", end: false, Icon: HoldingsIcon },
  { to: "/income", label: "Income", end: false, Icon: IncomeIcon },
  { to: "/upload", label: "Upload", end: false, Icon: UploadIcon },
] as const;

/** Settings sits at the foot of the rail: a few times ever, not daily (§8.4). */
const FOOTER_NAVIGATION = [
  { to: "/settings", label: "Settings", end: false, Icon: SettingsIcon },
] as const;

type NavItem = (typeof NAVIGATION)[number] | (typeof FOOTER_NAVIGATION)[number];

function NavItems({ items }: { items: readonly NavItem[] }) {
  return (
    <>
      {items.map(({ to, label, end, Icon }) => (
        <li key={to}>
          <NavLink
            to={to}
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

export function Layout({ children }: { children: React.ReactNode }) {
  // Read from the root loader rather than taken as a prop, because `Layout`
  // wraps error boundaries too, where there is no loader data at all. The
  // banner is placed here rather than on a page so that every route — including
  // ones that do not exist yet — carries it.
  const rootData = useRouteLoaderData<typeof loader>("root");
  const { pathname } = useLocation();

  // The prompt is suppressed inside Settings, which is the one place it would
  // be telling someone to go where they already are. Everywhere else it is the
  // single pointer at the next step (DESIGN.md §8.4).
  const firstRun =
    rootData?.firstRun && !pathname.startsWith("/settings") ? rootData.firstRun : null;

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <div className="app">
          <nav className="app-rail" aria-label="Primary">
            <a className="app-brand" href="/">
              <span className="app-brand-mark">PORTFOLIO</span>
              <span className="app-brand-meta u-label">Self-hosted</span>
            </a>
            <ul className="app-nav">
              <NavItems items={NAVIGATION} />
            </ul>
            <ul className="app-nav app-nav--footer">
              <NavItems items={FOOTER_NAVIGATION} />
            </ul>
          </nav>
          <div className="app-canvas">
            {rootData?.authConfigured === false ? <OpenInstanceBanner /> : null}
            <main className="app-main">
              {firstRun ? <FirstRunPrompt step={firstRun} /> : null}
              {children}
            </main>
          </div>
        </div>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary() {
  const error = useRouteError();

  const title = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : "Something went wrong";
  const detail = isRouteErrorResponse(error)
    ? error.data
    : error instanceof Error
      ? error.message
      : "Unknown error";

  return (
    <section className="page">
      <h1>{title}</h1>
      <p className="page-lede">{String(detail)}</p>
    </section>
  );
}
