import {
  Link,
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
  AnalysisIcon,
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
 * The rail's *shape* is the Stitch screens' (§13.1): a fixed 280px column, a
 * brand tile at its head, a 4px accent stroke on the active item, and one
 * filled button at its foot. Its *contents* are §8.4's items rather than the
 * mock's three, because that ordering is a decision about frequency of use and
 * the routes it names already exist.
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

/** The mark, at both sizes it is drawn: in the rail, and in the phone's top bar. */
function Brand() {
  return (
    <Link className="app-brand" to="/">
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
        <meta name="theme-color" content="#f7f9fb" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#0b1326" media="(prefers-color-scheme: dark)" />
        <Meta />
        <Links />
      </head>
      <body>
        <div className="app">
          <nav className="app-rail" aria-label="Primary">
            <Brand />
            <ul className="app-nav">
              <NavItems items={NAVIGATION} />
            </ul>
            <ul className="app-nav app-nav--footer">
              <NavItems items={FOOTER_NAVIGATION} />
            </ul>
            <Link className="button button--block app-rail-action" to="/upload">
              <UploadIcon />
              Upload statement
            </Link>
          </nav>

          <div className="app-canvas">
            {/* Below 1024px the rail is gone, so the bar carries the mark and
             * the one action the rail's foot would have held. */}
            <header className="app-topbar">
              <Brand />
              <Link className="button" to="/upload">
                <UploadIcon />
                Upload
              </Link>
            </header>

            {rootData?.authConfigured === false ? <OpenInstanceBanner /> : null}
            <main className="app-main">
              {firstRun ? <FirstRunPrompt step={firstRun} /> : null}
              {children}
            </main>
          </div>

          {/* The phone's nav: a bottom bar, which is what every mobile mock
           * does — no drawer and no hamburger anywhere in the set (§13.1). */}
          <nav className="app-bottomnav" aria-label="Primary">
            <ul className="app-nav">
              <NavItems items={NAVIGATION} />
              <NavItems items={FOOTER_NAVIGATION} />
            </ul>
          </nav>
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
      <header className="page-header">
        <div>
          <h1 className="page-title">{title}</h1>
          <p className="page-subtitle">{String(detail)}</p>
        </div>
      </header>
    </section>
  );
}
