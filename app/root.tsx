import {
  Links,
  Meta,
  NavLink,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useRouteError,
  useRouteLoaderData,
} from "react-router";

import { OpenInstanceBanner } from "~/components/open-instance-banner";
import { authGate } from "~/lib/auth.server";

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

/** Whether the instance is password protected, for the warning banner. */
export function loader() {
  return { authConfigured: authGate().enabled };
}

/** DESIGN.md §8.4 — ordered by how often each page is opened. */
const NAVIGATION = [
  { to: "/", label: "Overview", end: true },
  { to: "/holdings", label: "Holdings", end: false },
  { to: "/income", label: "Income", end: false },
  { to: "/upload", label: "Upload", end: false },
  { to: "/settings", label: "Settings", end: false },
] as const;

export function Layout({ children }: { children: React.ReactNode }) {
  // Read from the root loader rather than taken as a prop, because `Layout`
  // wraps error boundaries too, where there is no loader data at all. The
  // banner is placed here rather than on a page so that every route — including
  // ones that do not exist yet — carries it.
  const rootData = useRouteLoaderData<typeof loader>("root");

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
          <header className="app-header">
            <a className="app-brand" href="/">
              Portfolio
            </a>
            <nav className="app-nav" aria-label="Primary">
              {NAVIGATION.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    isActive ? "app-nav-link app-nav-link--active" : "app-nav-link"
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>
          </header>
          {rootData?.authConfigured === false ? <OpenInstanceBanner /> : null}
          <main className="app-main">{children}</main>
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
