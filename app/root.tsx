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
import { RETURN_PARAM } from "~/lib/lock";
import { clearedLockCookie, isLocked, readLockCookie, touchGrant } from "~/lib/lock.server";
import { readMaskingCookie, resolveMasked, type MaskingPolicy } from "~/lib/masking";
import { ownerSearch, readOwnerFilter } from "~/lib/owner-filter";
import { startPricePoller } from "~/lib/price-poller.server";
import { readMaskingPolicy } from "~/lib/settings.server";
import { getConfig } from "../server/config.ts";

import type { Route } from "./+types/root";

import "./app.css";

/*
 * The gate used to be wired here as root middleware; nothing filled that
 * slot until now. `middleware` below is the lock (docs/adr/0012) — the
 * first rule to run here since, not the gate come back: it answers a
 * different question, which *browser* may read rather than which *person*
 * may enter, and does not touch what this paragraph is actually about. One
 * thing still rides in on every request, recorded only here: the gate
 * attaches the verified address as `X-Auth-Request-Email`, and the app
 * reads it nowhere, deliberately. Attribution, never permission
 * (CONTEXT.md): every family member sees and can do everything. A later
 * feature may read it to record *who* did a thing; none may read it to
 * decide *whether* they may.
 */

/**
 * The two router paths the lock does not guard: the unlock screen itself —
 * refusing it would refuse the one screen that lifts the refusal — and the
 * health endpoint, which the gate in front already exempts for the same
 * reason (`healthz.ts`'s own header). Nothing else needs a line here: the
 * service worker, the manifest and the icons are static files under
 * `public/` that never reach this router, so no middleware runs for them at
 * all. Written as data and pinned by a test that fails the moment this array
 * grows, so a third exemption is a decision someone makes rather than a line
 * someone adds.
 *
 * What is *not* on this list is not necessarily reachable while locked —
 * see {@link lockMiddleware}'s own header for the two cases this array
 * cannot name because they never reach it at all.
 */
export const LOCK_EXEMPT_PATHS: readonly string[] = ["/unlock", "/healthz"];

/**
 * Normalises a pathname the way the router itself matches route paths,
 * before comparing it against {@link LOCK_EXEMPT_PATHS} — `Array.includes`
 * alone is an exact, case-sensitive compare, and the router is neither:
 * `compilePath` (react-router 7.18.2) builds every route's matcher with an
 * `i` flag unless a route opts into `caseSensitive` (none here do), and its
 * pattern's tail is `\/*$` — zero or more trailing slashes, not "at most
 * one". Lower-cased and stripped of every trailing slash for exactly that
 * reason: `/Healthz`, `/healthz/` and `/healthz//` all reach the health
 * route today, and none of them would match this array unnormalised. The
 * spelling that actually matters now lives in three places — `Caddyfile`,
 * `compose.yaml`'s healthchecks, and this array — and this function is what
 * keeps the third one honest against the router's own rule rather than a
 * guess at it.
 */
function normalizedPathname(pathname: string): string {
  const lower = pathname.toLowerCase();
  const stripped = lower.replace(/\/+$/, "");
  return stripped === "" ? "/" : stripped;
}

/** Every response the lock middleware lets through carries this. */
function withNoStore(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  return response;
}

/**
 * Where a refused request is sent, carrying its own address back as
 * {@link RETURN_PARAM}'s one encoded value (`lock.ts`'s own comment on that
 * constant says why it has to be one parameter rather than the query the
 * browser was actually on) — but only for a `GET` or a `HEAD`, which are the
 * only methods a redirect's own `GET` can actually land back on. `/masking`
 * and `/refresh` export an action only, and both are real form posts from
 * the chrome (ticket 06's lock action will be a third): a reader who taps
 * one past the idle window would otherwise be sent, after unlocking, to `GET
 * /masking` or `GET /refresh` — a route with no loader, a 400. A refused
 * non-`GET`/`HEAD` request carries no return address at all, which
 * `safeReturn` (`return-path.ts`, read back by ticket 04's unlock route)
 * already resolves to `/` for an absent parameter — the same fallback a
 * missing or unsafe one gets today.
 *
 * `clearCookie` is true only when a grant lookup came back definitively
 * empty — never on a mere read failure, which is not proof the cookie's
 * grant is actually gone.
 */
function redirectToUnlock(url: URL, method: string, clearCookie: boolean): Response {
  const target = new URL("/unlock", url);
  if (method === "GET" || method === "HEAD") {
    target.searchParams.set(RETURN_PARAM, `${url.pathname}${url.search}`);
  }

  return redirect(
    `${target.pathname}${target.search}`,
    clearCookie ? { headers: { "Set-Cookie": clearedLockCookie() } } : undefined,
  );
}

/**
 * The lock (docs/adr/0012): a browser holding no valid grant is turned away
 * *before* `next()` is called, so no loader runs and the figures are never
 * fetched — deliberately not `chart-range.ts`'s `chartRangeMiddleware` shape,
 * the only other middleware here, which awaits `next()` and only decorates
 * what comes back. This one refuses by throwing a redirect `Response`,
 * matching how every route in this app already signals one (`tests/support/
 * routes.ts`'s own doc comment) — there is no markup to grep for on a
 * refusal, only proof that {@link isLocked} and {@link touchGrant} decided
 * it, which is what `next` never being invoked pins. The framework calls
 * `next()` *for you* if a middleware returns a non-`Response` (or nothing)
 * without ever calling it — worth saying here because any future refusal
 * branch written as a bare `return` rather than a `throw` would silently
 * serve the page instead of refusing it.
 *
 * **`args.url`, never `new URL(request.url)`.** `runServerMiddlewarePipeline`
 * hands every middleware a `url` already stripped of react-router's own
 * `.data` suffix and `_routes`/`index` search params
 * (react-router 7.18.2's `lib/server-runtime/*.ts`: `getNormalizedPath` is
 * passed as `normalizePath` at all four call sites that reach middleware —
 * document requests, resource requests, and both single-fetch actions and
 * loaders — unconditionally, not only under a future flag). Reading
 * `request.url` instead happens to agree with this today only because
 * `future.v8_passThroughRequests` is off: with it off, a single-fetch
 * request is rebuilt from the already-normalized URL before this middleware
 * ever sees it, so `request.url` and `args.url` coincide by accident; `npm
 * run build` already warns that flag is changing in v8, and flipping it
 * hands `request` straight through unrebuilt — `request.url` would then
 * carry `/unlock.data`, which fails the exemption check below and traps a
 * locked browser in a redirect loop with no way to reach the screen that
 * unlocks it. Reading `args.url` is correct under both settings of that flag,
 * and closes a second, already-live gap for free: `request.url` on an
 * unrebuilt single-fetch request still carries a `_routes` parameter, which
 * `args.url` never does, so a redirect built from `request.url` alone would
 * leak that internal parameter into the address `/unlock` sends the reader
 * back to.
 *
 * **With no passkey enrolled, this calls `next()` unconditionally** —
 * `isLocked()` answers `false` and every request passes straight through, so
 * shipping this changes nothing a family member can see on an instance that
 * has never enrolled one.
 *
 * **Fails closed.** A thrown `isLocked`/`touchGrant` is not the same answer
 * as "no passkey", and is never folded into that branch: the loader below
 * catches around `firstRunStep`, which is right for a first-run hint that
 * may fail open, and wrong for a boundary — a boundary that opens the
 * moment Postgres hiccups is not a boundary. Every such failure refuses
 * here too, but clears no cookie: a read that merely failed to answer is
 * not proof the grant it names is actually gone.
 *
 * **A live grant is extended by the request that used it** — {@link
 * touchGrant} itself skips the write unless less than half the idle window
 * remains, so this is not an unconditional write on every document and
 * data request.
 *
 * **What this does not cover.** The framework answers a genuinely unmatched
 * path (no route pattern matches at all — there is no catch-all route here)
 * and the lazy route-discovery manifest at `/__manifest` before the
 * middleware pipeline ever runs: a locked browser that mistypes a URL gets
 * a rendered 404 — app chrome only, since the root loader does not run
 * either, so no figure is on it — rather than the unlock screen, and that
 * response carries no `no-store` of its own. Separately, exempting
 * `/healthz` also exempts its single-fetch (`.data`) form, which is
 * harmless: that route holds no household data either way. Neither is worth
 * code; both are worth saying, so this header's account of what the lock
 * covers stays honest about where it stops.
 */
const lockMiddleware: Route.MiddlewareFunction = async ({ request, url }, next) => {
  if (LOCK_EXEMPT_PATHS.includes(normalizedPathname(url.pathname))) {
    return withNoStore(await next());
  }

  let locked: boolean;
  try {
    locked = await isLocked();
  } catch (error) {
    console.error("Lock check failed; refusing rather than continuing:", error);
    throw redirectToUnlock(url, request.method, false);
  }

  if (!locked) return withNoStore(await next());

  const grantId = readLockCookie(request);
  if (grantId === undefined) throw redirectToUnlock(url, request.method, false);

  let grant: Awaited<ReturnType<typeof touchGrant>>;
  try {
    grant = await touchGrant(grantId);
  } catch (error) {
    console.error("Grant check failed; refusing rather than continuing:", error);
    throw redirectToUnlock(url, request.method, false);
  }

  if (grant === undefined) throw redirectToUnlock(url, request.method, true);

  return withNoStore(await next());
};

export const middleware: Route.MiddlewareFunction[] = [lockMiddleware];

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
