import { useCallback, useEffect } from "react";
import {
  Link,
  Links,
  Meta,
  NavLink,
  Outlet,
  Scripts,
  ScrollRestoration,
  redirect,
  useLocation,
  useRevalidator,
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
import { LockNowControl } from "~/components/lock-now-control";
import { MaskingToggle } from "~/components/masking-toggle";
import { OpenInstanceBanner } from "~/components/open-instance-banner";
import { firstRunStep, type FirstRunStep } from "~/lib/first-run.server";
import { LOCK_NOW_ACTION, RETURN_PARAM, UNLOCK_PATH } from "~/lib/lock";
import { clearedLockCookie, isLocked, readLockCookie, touchGrant } from "~/lib/lock.server";
import { readMaskingCookie, resolveMasked, type MaskingPolicy } from "~/lib/masking";
import { ownerSearch, readOwnerFilter } from "~/lib/owner-filter";
import { startPricePoller } from "~/lib/price-poller.server";
import { postLockNow, watchReentry } from "~/lib/reentry";
import { readMaskingPolicy } from "~/lib/settings.server";
import { getConfig } from "../server/config.ts";

import type { Route } from "./+types/root";

import "./app.css";

/** Refusing `/unlock` would refuse the one screen that lifts the refusal. A test pins the length. */
export const LOCK_EXEMPT_PATHS: readonly string[] = [UNLOCK_PATH, "/healthz"];

/**
 * Copy of react-router 7.18.2's unexported `decodePath`: per-segment decode, re-escaping any `/`
 * a decode produces. Malformed escapes fall back to the raw value rather than throwing.
 */
function decodedPathname(pathname: string): string {
  try {
    return pathname
      .split("/")
      .map((segment) => decodeURIComponent(segment).replace(/\//g, "%2F"))
      .join("/");
  } catch {
    return pathname;
  }
}

/**
 * Path comparison the way the router matches: `compilePath` is case-insensitive and its tail is
 * `\/*$`, so `/Healthz`, `/healthz/` and `/healthz//` all reach the same route. Decoded first, or
 * `/lock%2Dnow` slips past every predicate built on this.
 */
function normalizedPathname(pathname: string): string {
  const decoded = decodedPathname(pathname);
  const lower = decoded.toLowerCase();
  const stripped = lower.replace(/\/+$/, "");
  return stripped === "" ? "/" : stripped;
}

function isUnlockPath(pathname: string): boolean {
  return normalizedPathname(pathname) === UNLOCK_PATH;
}

/** Path only, never an exemption: `/lock-now` still has to pass the lock. Method and cookie are the caller's checks. */
function isLockNowPath(pathname: string): boolean {
  return normalizedPathname(pathname) === LOCK_NOW_ACTION;
}

/**
 * Keeps documents out of Firefox's bfcache, and Safari's over HTTPS. Chrome admits them anyway,
 * so the `pageshow` re-check in `~/lib/reentry.ts` is the answer there, not this header.
 */
function withNoStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

/**
 * Return address only for `GET`/`HEAD`: `/masking` and `/refresh` are action-only, so bouncing a
 * refused POST back would land the reader on a loader-less route (400). `safeReturn` resolves an
 * absent parameter to `/`.
 */
function redirectToUnlock(url: URL, method: string, clearCookie: boolean): Response {
  const target = new URL(UNLOCK_PATH, url);
  if (method === "GET" || method === "HEAD") {
    target.searchParams.set(RETURN_PARAM, `${url.pathname}${url.search}`);
  }

  return redirect(
    `${target.pathname}${target.search}`,
    clearCookie ? { headers: { "Set-Cookie": clearedLockCookie() } } : undefined,
  );
}

/** React Router's own `validMutationMethods`, which it does not export. `OPTIONS`/`HEAD` stay out: a preflight mutates nothing. */
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * React Router 7.18.2 makes this same `Origin` check itself for document mutations and single-fetch
 * actions, but not for resource routes — which `/lock-now`, `/masking` and `/refresh` are. Compares
 * hosts, not `PUBLIC_ORIGIN`, to agree with the framework behind the proxy. A missing `Origin`
 * continues, as it does there; `Origin: null` is unparseable and refused.
 */
const crossOriginMutationMiddleware: Route.MiddlewareFunction = ({ request }) => {
  if (!MUTATION_METHODS.has(request.method.toUpperCase())) return;

  const origin = request.headers.get("Origin");
  if (origin === null) return;

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new Response(null, { status: 400 });
  }

  if (originHost !== new URL(request.url).host) throw new Response(null, { status: 400 });
};

/**
 * The lock (docs/adr/0012). Refuses by *throwing* before `next()`, so no loader runs — a refusal
 * written as a bare `return` would serve the page instead, since the framework calls `next()` for a
 * middleware that returns without one.
 *
 * `args.url`, never `request.url`: only the former is stripped of react-router's `.data` suffix and
 * `_routes` params, which would otherwise fail the exemption check and loop a locked browser.
 *
 * Fails closed — a thrown check refuses and is never folded into the no-passkey branch. Exempting
 * `/healthz` also exempts `/healthz.data`, which serves this loader's setup fields to a browser
 * holding no grant: kept deliberately (spec 0020, decided 2026-09-05); Caddy gates the `.data` form.
 */
const lockMiddleware: Route.MiddlewareFunction = async ({ request, url }, next) => {
  if (LOCK_EXEMPT_PATHS.includes(normalizedPathname(url.pathname))) {
    return withNoStore(await next());
  }

  const grantId = readLockCookie(request);

  // A refusal on this path still clears the cookie: the reader asked to lock. Cookie required as
  // well as path and method — path and method alone are forgeable cross-site, and `SameSite=Lax`
  // withholds the cookie from that request but not the response clearing it.
  const isLockNowRequest = isLockNowPath(url.pathname) && request.method === "POST" && grantId !== undefined;

  let locked: boolean;
  try {
    locked = await isLocked();
  } catch (error) {
    console.error("Lock check failed; refusing rather than continuing:", error);
    throw redirectToUnlock(url, request.method, isLockNowRequest);
  }

  if (!locked) return withNoStore(await next());

  if (grantId === undefined) throw redirectToUnlock(url, request.method, false);

  let grant: Awaited<ReturnType<typeof touchGrant>>;
  try {
    grant = await touchGrant(grantId);
  } catch (error) {
    console.error("Grant check failed; refusing rather than continuing:", error);
    throw redirectToUnlock(url, request.method, isLockNowRequest);
  }

  if (grant === undefined) throw redirectToUnlock(url, request.method, true);

  return withNoStore(await next());
};

/** Order matters: who may ask is settled before which browser may read, so a forgery costs no database call. */
export const middleware: Route.MiddlewareFunction[] = [crossOriginMutationMiddleware, lockMiddleware];

/**
 * Neutral values, telling a browser that has proven nothing no fact about the household — the
 * payload is serialised into the page whatever `Layout` renders.
 */
const UNLOCK_SCREEN_ROOT_DATA = {
  gated: true,
  firstRun: null as FirstRunStep,
  masked: true,
  maskingPolicy: "masked" as MaskingPolicy,
  hasPasskey: false,
};

/**
 * Masking is resolved server-side: a page that drew the amounts and then hid them is the one
 * failure this feature cannot have (story 30). Every read fails toward masked.
 */
export async function loader({ request }: Route.LoaderArgs) {
  // §6.2. Root's loader is the only server path every render passes through, including while
  // locked. Idempotent, not awaited, cannot throw.
  startPricePoller();

  const url = new URL(request.url);
  // Skipped deliberately, not just for shape: this is the one request an un-granted browser can hammer.
  if (isUnlockPath(url.pathname)) return UNLOCK_SCREEN_ROOT_DATA;

  let firstRun: FirstRunStep = null;

  try {
    firstRun = await firstRunStep();
  } catch (error) {
    console.error("First-run check failed; continuing without the prompt:", error);
  }

  let masked = true;
  // Published for the toggle's client writer: it has to produce a byte-identical cookie.
  let maskingPolicy: MaskingPolicy = "masked";

  try {
    maskingPolicy = await readMaskingPolicy();
    masked = resolveMasked(maskingPolicy, readMaskingCookie(request));
  } catch (error) {
    console.error("Masking policy read failed; masking this render:", error);
  }

  // Chrome only — whether to draw the lock-now control — so it fails toward hiding it. Read again
  // rather than passed down from the middleware so `tests/support/routes.ts`'s `args()` can call
  // this loader directly.
  let hasPasskey = false;
  try {
    hasPasskey = await isLocked();
  } catch (error) {
    console.error("Lock check failed; hiding the lock-now control rather than guessing:", error);
  }

  return {
    gated: getConfig().AUTH_GATE === "external",
    firstRun,
    masked,
    maskingPolicy,
    hasPasskey,
  };
}

/** DESIGN.md §8.4 */
const NAVIGATION = [
  { to: "/", label: "Overview", end: true, Icon: DashboardIcon },
  { to: "/holdings", label: "Holdings", end: false, Icon: HoldingsIcon },
  { to: "/analysis", label: "Analysis", end: false, Icon: AnalysisIcon },
  { to: "/income", label: "Income", end: false, Icon: IncomeIcon },
] as const;

const FOOTER_NAVIGATION = [
  { to: "/settings", label: "Settings", end: false, Icon: SettingsIcon },
] as const;

type NavItem = (typeof NAVIGATION)[number] | (typeof FOOTER_NAVIGATION)[number];

/** `search` is the owner parameter alone, never `location.search` — that would drag one screen's `range` or `sort` onto another. ADR-0008 */
function NavItems({ items, search = "" }: { items: readonly NavItem[]; search?: string }) {
  return (
    <>
      {items.map(({ to, label, end, Icon }) => (
        <li key={to}>
          <NavLink
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
  // From the loader, not a prop: `Layout` wraps error boundaries, where there is no loader data.
  const rootData = useRouteLoaderData<typeof loader>("root");
  const { pathname, search } = useLocation();

  // Off the address (ADR-0008): a loader could not hand it down inside an error boundary.
  const owners = ownerSearch(readOwnerFilter(new URLSearchParams(search)));

  const firstRun =
    rootData?.firstRun && !pathname.startsWith("/settings") ? rootData.firstRun : null;

  // Bare shell for the unlock screen: every piece of chrome assumes a grant this browser has not
  // proven, and the masking toggle would write `document.cookie` on the way out.
  const isUnlockScreen = isUnlockPath(pathname);

  // The household's passkey, not this browser's lock state. `undefined` reads false: no control is
  // the fail-safe answer on an error boundary.
  const hasPasskey = rootData?.hasPasskey === true;

  const { revalidate } = useRevalidator();

  // Never post the lock on a `hasPasskey` flip: a sibling tab of the browser that just enrolled
  // shares its cookie, so that would delete the grant the enrolment minted.
  const attemptLock = useCallback((): void => {
    void postLockNow(revalidate, fetch);
  }, [revalidate]);

  // A persisted restore only re-asks the middleware — it never posts the lock.
  const askServer = useCallback((): void => {
    revalidate();
  }, [revalidate]);

  // No test reaches this effect: the suite is DOM-less, so `renderToStaticMarkup` runs no effects.
  // Steps S8/S9 of the drive script under docs/research/2026-09-05-lock-slice-launch-review/harness/
  // are the evidence that it installs.
  useEffect(() => {
    if (isUnlockScreen) return;

    return watchReentry(attemptLock, askServer);
  }, [isUnlockScreen, askServer, attemptLock]);

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#f7f9fb" media="(prefers-color-scheme: light)" />
        <meta name="theme-color" content="#0b1326" media="(prefers-color-scheme: dark)" />
        <link rel="icon" href="/icon.svg" type="image/svg+xml" />
        {/* Chrome fetches a manifest without cookies by default; behind the gate that is a sign-in redirect. */}
        <link rel="manifest" href="/manifest.webmanifest" crossOrigin="use-credentials" />
        <Meta />
        <Links />
      </head>
      <body>
        {isUnlockScreen ? (
          <div className="app app--lock">
            <main className="app-main app-main--lock">{children}</main>
          </div>
        ) : (
          <div className="app">
            <nav className="app-rail" aria-label="Primary">
              <Brand search={owners} />
              <ul className="app-nav">
                <NavItems items={NAVIGATION} search={owners} />
              </ul>
              <ul className="app-nav app-nav--footer">
                <NavItems items={FOOTER_NAVIGATION} />
              </ul>
              <MaskingToggle className="app-rail-masking" />
              {hasPasskey ? <LockNowControl className="app-rail-lock" /> : null}

              <Link className="button app-rail-action" to="/upload">
                <UploadIcon />
                Upload statement
              </Link>
            </nav>

            <div className="app-canvas">
              <header className="app-topbar">
                <Brand search={owners} />
                <div className="app-topbar-actions">
                  <MaskingToggle />
                  {hasPasskey ? <LockNowControl /> : null}
                  <Link className="button" to="/upload">
                    <UploadIcon />
                    <span>Upload</span>
                  </Link>
                </div>
              </header>

              {rootData?.gated === false ? <OpenInstanceBanner /> : null}
              <main className="app-main">
                {firstRun ? <FirstRunPrompt step={firstRun} /> : null}
                {children}
              </main>
            </div>

            <nav className="app-bottomnav" aria-label="Primary">
              <ul className="app-nav">
                <NavItems items={NAVIGATION} search={owners} />
                <NavItems items={FOOTER_NAVIGATION} />
              </ul>
            </nav>
          </div>
        )}
        <ScrollRestoration />
        <Scripts />
        {/* Offline page only, stores nothing (ADR-0007). Registration failing is silent by design. */}
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

export function ErrorBoundary() {
  return <ErrorPage error={useRouteError()} />;
}
