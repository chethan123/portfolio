import {
  Links,
  Meta,
  NavLink,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
  useRouteError,
} from "react-router";

import "./app.css";

/** DESIGN.md §8.4 — ordered by how often each page is opened. */
const NAVIGATION = [
  { to: "/", label: "Overview", end: true },
  { to: "/holdings", label: "Holdings", end: false },
  { to: "/income", label: "Income", end: false },
  { to: "/upload", label: "Upload", end: false },
  { to: "/settings", label: "Settings", end: false },
] as const;

export function Layout({ children }: { children: React.ReactNode }) {
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
