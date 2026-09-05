import { useEffect, useState } from "react";
import {
  Link,
  Links,
  Meta,
  NavLink,
  Outlet,
  Scripts,
  ScrollRestoration,
  redirect,
  useFetcher,
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
import { watchReentry } from "~/lib/reentry";
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
export const LOCK_EXEMPT_PATHS: readonly string[] = [UNLOCK_PATH, "/healthz"];

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

/**
 * Whether `pathname` is the unlock screen — used by the loader below to skip
 * reads a browser holding no grant has no business triggering, and by
 * `Layout` to skip the chrome around it. Deliberately its own check rather
 * than a lookup into {@link LOCK_EXEMPT_PATHS}: that array answers "does the
 * lock middleware guard this path", which `/healthz` is also on and which
 * neither of these two questions is — `Layout`'s own header already makes
 * this argument for the chrome; the loader's reads are a third question that
 * only happens to share today's answer, not a reason to fold three questions
 * into one array.
 */
function isUnlockPath(pathname: string): boolean {
  return normalizedPathname(pathname) === UNLOCK_PATH;
}

/**
 * Whether `pathname` is `/lock-now` — read only by {@link lockMiddleware}, to
 * decide whether its *own* refusal should clear the grant cookie (finding
 * 3), never to exempt the path itself. `/lock-now` is not on
 * {@link LOCK_EXEMPT_PATHS} and must not be: an unauthenticated POST there
 * still has to pass the same lock this middleware enforces everywhere else,
 * or anyone could end any household's grant with no credential at all. All
 * that changes on this one path is what a *refusal* does to the cookie —
 * argued at {@link redirectToUnlock}'s own header.
 *
 * **Path alone, deliberately — the method is a separate condition, checked
 * where this is called.** `/lock-now` is action-only (`lock-now.ts`'s own
 * header), so a `GET` or `HEAD` there is never the reader asking to end
 * their session; it is a crawler, a pasted URL, or a stray retry, same as it
 * would be for any other resource route. Folding the method in here would
 * make this function answer two different questions — "is this the path"
 * and "is this the request the exception is for" — under one name.
 */
function isLockNowPath(pathname: string): boolean {
  return normalizedPathname(pathname) === LOCK_NOW_ACTION;
}

/**
 * Every response the lock middleware lets through carries this — and it is
 * worth being exact about what that buys, because it is less than this slice
 * originally claimed.
 *
 * Firefox refuses a `no-store` document entry to its back/forward cache
 * outright, regardless of protocol. Safari/WebKit's refusal is narrower than
 * that: `Source/WebCore/history/BackForwardCache.cpp` guards it on
 * `document->url().protocolIs("https")`, so the identical response over
 * plain HTTP — `http://localhost` included — is left eligible for its cache.
 * This app refuses a non-HTTPS `PUBLIC_ORIGIN` except for `localhost`/
 * `127.0.0.1` (`server/config.ts`), so in production Safari does refuse the
 * cache too; it is the plain-HTTP development loop where it does not.
 * **Chrome admits such a page regardless of protocol.**
 * `CacheControlNoStoreEnterBackForwardCache` has been enabled by default
 * since 2025; Chrome shortens such an entry's life to three minutes and
 * evicts it when *this browser's* cookies change, unconditionally for an
 * `HttpOnly` one. That covers this browser locking itself. It does not cover
 * the case the lock exists for — a passkey or a grant removed from another
 * device, where nothing about this cookie jar changes and no eviction fires.
 * Chromium's own explainer for the feature says so in as many words ("sites
 * may log users out on the server side and clients may be unaware of this")
 * and names the answer: re-check on `pageshow` when `event.persisted`.
 *
 * That guard is ticket 06's, beside the re-entry trigger it already owns.
 * The header stays because it is free and it is the whole answer in two
 * engines of three; what changes is that no document here may go on saying
 * it is the answer in all of them. ADR-0012's statement of the limit — the
 * lock ends the reading, not every pixel already drawn — was right, and this
 * is that limit with its edges drawn where they actually fall.
 */
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
 * `clearCookie` is true when a grant lookup came back definitively empty —
 * proof the cookie's grant is actually gone — or when the refused request
 * targets `/lock-now` itself (finding 3, {@link isLockNowPath}): nowhere
 * else is a mere read failure proof of that, but a reader who posted to
 * `/lock-now` has already asked to end this browser's grant, and an outage
 * that merely stops the middleware from *confirming* it is gone is not a
 * reason to hand it back once the database recovers. `lock-now.ts`'s own
 * action already clears the cookie on every path through it; this covers
 * the one failure mode that never reaches it — a refusal thrown here, before
 * `next()` ever runs that action.
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
 * here too, and clears no cookie — with one deliberate exception (finding
 * 3): a read that merely failed to answer is not proof the grant it names
 * is actually gone, *except* when the refused request was itself a POST to
 * `/lock-now` ({@link isLockNowPath}). A reader who pressed "Lock now"
 * during an outage has already stated their intent; `/lock-now`'s own
 * action clears the cookie on every path *through* it (`lock-now.ts`'s own
 * header), but an outage in `isLocked`/`touchGrant` refuses here, before
 * that action ever runs, so this is the one place that intent can otherwise
 * go unhonoured. Honouring it — clearing the cookie on this path's refusal
 * too — is strictly safer than preserving a grant the reader asked to end.
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

  // Whether *this* refusal, whatever throws it below, should clear the
  // cookie regardless of the reason — the exception argued at this
  // function's own header and {@link redirectToUnlock}'s. The method is as
  // much a part of that condition as the path: `/lock-now` is action-only
  // (`lock-now.ts`'s own header), so a `GET` or `HEAD` there is a crawler, a
  // pasted URL, or a stray retry, never a reader asking to end this
  // browser's grant. Checking the path alone would treat such a request as
  // proof the grant is gone the way an actual POST is, and expire a
  // perfectly live grant to a mistyped or crawled `GET /lock-now` during a
  // transient outage — exactly the sign-out-over-a-blip every other refusal
  // path here is written to avoid.
  const isLockNowRequest = isLockNowPath(url.pathname) && request.method === "POST";

  let locked: boolean;
  try {
    locked = await isLocked();
  } catch (error) {
    console.error("Lock check failed; refusing rather than continuing:", error);
    throw redirectToUnlock(url, request.method, isLockNowRequest);
  }

  if (!locked) return withNoStore(await next());

  const grantId = readLockCookie(request);
  if (grantId === undefined) throw redirectToUnlock(url, request.method, isLockNowRequest);

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

export const middleware: Route.MiddlewareFunction[] = [lockMiddleware];

/**
 * The unlock screen's own answer — never the household's. `Layout` renders no
 * chrome for this route (its own header explains why), but React Router
 * serialises whatever this loader returns regardless of what `Layout` goes on
 * to do with it, so removing the chrome hid the *consumers* of `gated` and
 * `firstRun` without touching the hydration payload a browser holding no
 * grant can still read out of the page source. Each field here is this same
 * loader's own existing fail-safe default for "the read did not happen" —
 * `firstRun: null` (no step to nag about), `masked: true` and
 * `maskingPolicy: "masked"` (of the two ways to be wrong, a page of dots
 * cannot expose anything) — chosen again for the same reason: none of them
 * hands a proven-nothing browser a fact about the household. `gated: true` and
 * `hasPasskey: false` (ticket 06) are the two fields with no existing failure
 * default to reuse, so each gets a fresh one on the same principle: `gated:
 * true` is the value that keeps `OpenInstanceBanner` off, and `hasPasskey:
 * false` is the value that keeps the lock-now control and the re-entry effect
 * off — both moot in practice, since `Layout`'s bare-shell branch for this
 * route drops every control regardless of what either field says, but the
 * type this loader returns has to agree with the branch that does read them.
 */
const UNLOCK_SCREEN_ROOT_DATA = {
  gated: true,
  firstRun: null as FirstRunStep,
  masked: true,
  maskingPolicy: "masked" as MaskingPolicy,
  hasPasskey: false,
};

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
 *
 * **The unlock screen gets none of this.** `isUnlockPath` below is checked
 * after starting the price poller and before any other read: a browser
 * holding no grant can reach only this one route, and can hammer it, so
 * skipping `firstRunStep` and the masking-policy read here is a saved
 * database round trip on exactly the request an un-granted browser controls
 * — not only a data-shape decision. `startPricePoller()` runs first and
 * unconditionally regardless of that branch: it is the *only* server-side
 * path every render passes through while an instance is locked and nobody
 * has unlocked it yet, since every other route's loader is refused before it
 * ever runs (the middleware above throws before calling `next()`); skipping
 * it here would mean prices never refresh for a household that has not yet
 * unlocked anything today.
 */
export async function loader({ request }: Route.LoaderArgs) {
  // The quote refresh loop (§6.2), started here because root's loader is the
  // one server-side path every render passes through (no server entry file
  // under `react-router-serve`). Idempotent, not awaited, cannot throw:
  // polling must never be able to fail a page render.
  startPricePoller();

  const url = new URL(request.url);
  if (isUnlockPath(url.pathname)) return UNLOCK_SCREEN_ROOT_DATA;

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

  // Whether the household holds a passkey at all (ticket 06) — the same
  // question the lock middleware above already asked to let this loader run
  // at all, asked again here rather than reused: react-router 7.18.2 does
  // let a value travel from a middleware to the loader behind it
  // (`createContext`/`RouterContextProvider`, both plain exports, not
  // `unstable_`), so the second read is not forced by the framework. It
  // stays because of the test harness instead — `tests/support/routes.ts`'s
  // `args()` calls a loader directly, without running middleware, so a
  // context-fed loader could not be tested that way; moving this to
  // `createContext` would push these assertions into `servedThrough`-style
  // tests instead. Fails toward *not* drawing the control: unlike the
  // middleware, this is not the boundary — hiding a control on a database
  // hiccup costs a family member one screen's worth of chrome and, with it,
  // the re-entry effect below that gates on the same flag: a page rendered
  // while this read throws carries no visibility trigger and no `pageshow`
  // re-check for its whole lifetime, since the effect's deps do not change
  // again until a navigation. Never a figure, though — there is no reason to
  // fail toward showing a button that clears a grant which may be exactly
  // what is protecting this render.
  let hasPasskey = false;
  try {
    hasPasskey = await isLocked();
  } catch (error) {
    console.error("Lock check failed; hiding the lock-now control rather than guessing:", error);
  }

  // Read here rather than in the banner, because a component cannot: the value
  // is an environment variable and the browser has no environment.
  return {
    gated: getConfig().AUTH_GATE === "external",
    firstRun,
    masked,
    maskingPolicy,
    hasPasskey,
  };
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

/**
 * What `Layout`'s reentry effect hands `watchReentry` as its hidden-too-long
 * callback, given whether the household holds a passkey at the instant a
 * hidden-too-long return actually happens. Pulled out and exported — rather
 * than left as the inline arrow function the effect used to build — because
 * a review of this pull request found the regression test for this decision
 * constructed its own copy of that arrow function and handed *it* to
 * `watchReentry`, which stays green even if `Layout` stops making this
 * decision at all. Importing this function directly is what closes that
 * gap: `tests/reentry.test.ts` calls the very thing `Layout` wires in below,
 * not a restatement of it, so reverting that wiring back to the old
 * `hasPasskey ? callback : null` removes this function's only production
 * caller and, with it, the export the test imports — a failing import, not a
 * silently-passing copy.
 *
 * `hasPasskey` true returns `actions.postLock` — the real "Lock now" post.
 * `hasPasskey` false returns `actions.askServer`, never `null`: `~/lib/
 * reentry.ts`'s own header on `watchReentry` carries the whole argument for
 * why silence is wrong here — a page rendered while the household held no
 * passkey can go stale the moment one is enrolled from another browser, and
 * asking the server is the cheap, always-correct fallback that a stale
 * `false` must fall back to instead of installing nothing at all.
 */
export function resolveReentryCallback(
  hasPasskey: boolean,
  actions: { postLock: () => void; askServer: () => void },
): () => void {
  return hasPasskey ? actions.postLock : actions.askServer;
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

  /**
   * The one screen rendered before any grant is proven — `LOCK_EXEMPT_PATHS`
   * above is what lets the middleware serve it at all, and the chrome around
   * it assumes the opposite of that: the nav rail links to Holdings,
   * Analysis and Income; Upload assumes an account already exists to receive
   * a statement; the masking toggle writes `document.cookie` *before* any
   * network round trip, which on this screen would be a browser that has
   * proved nothing genuinely changing persistent state and then bouncing;
   * the first-run prompt and the open-instance banner both read off setup
   * state — which of three configurations the household is in, whether
   * anything guards the instance at all — that a browser holding no grant
   * has no business learning (finding 3). Fifteen interactive elements, all
   * dead ends, one of them worse than dead.
   *
   * **Hiding the chrome is not what keeps that setup state unread.** This
   * branch only decides what renders; `rootData` for this route is the
   * loader's own neutral `UNLOCK_SCREEN_ROOT_DATA` (the loader's own header),
   * so the fact that `firstRun` and the banner's `gated` go unused here is a
   * second, redundant guard rather than the one thing standing between a
   * proven-nothing browser and the hydration payload.
   *
   * Checked through {@link isUnlockPath} rather than reusing
   * `LOCK_EXEMPT_PATHS` itself: `/healthz` is on that list too and never
   * reaches `Layout` at all — it renders no component — so "the lock does
   * not guard this path" and "this path gets no chrome" are two different
   * questions that only happen to share an answer for `/unlock` today;
   * folding them into one array would make a future exemption's chrome a
   * coincidence of that array rather than a decision someone made.
   *
   * Placed here, in `Layout`, rather than inside `unlock.tsx`'s own
   * component — the existing precedent one paragraph up, suppressing the
   * first-run prompt under `/settings`, draws the same line: the chrome is
   * assembled in exactly one place for every route, and a route earns its
   * way out of a piece of it here rather than rendering past a shell it was
   * handed. It also pre-empts ticket 06's lock-now control, which is drawn
   * "in both places `MaskingToggle` is rendered" and only while the instance
   * is locked at all — both of which are true of this screen, and a stray
   * copy of `MaskingToggle` here would have carried it along for free,
   * offering to lock a browser that is already locked and, worse, discarding
   * the return address ticket 03 encoded to get the reader back to it.
   */
  const isUnlockScreen = isUnlockPath(pathname);

  // Whether the household holds a passkey at all — not `CONTEXT.md`'s
  // `Locked`, which is a fact about one browser at one moment, the opposite
  // of what gates the control below: a browser rendering this chrome may
  // itself be perfectly unlocked, and the household holding a passkey is
  // exactly the condition that makes an instance lock at all. `undefined`
  // reads as `false` here for the same reason `firstRun` above tolerates a
  // data-less error boundary: neither a browser mid-navigation nor one
  // rendering an error page has a passkey count to show one way or the
  // other, and "no control" is the fail-safe answer to that gap, not "show
  // one that may not apply".
  const hasPasskey = rootData?.hasPasskey === true;

  // Named directly in the effect's dependency array below, not stashed in a
  // ref: both are `useCallback`-memoised on stable deps in react-router
  // 7.18.2 (`useRevalidator` on `[dataRouterContext.router]`; `useFetcher`'s
  // own `submit` on `[fetcherKey, submitImpl]`, where `fetcherKey` never
  // changes here and `submitImpl` is `useSubmit()`'s callback, itself
  // memoised on the basename, current route id, `router.fetch` and
  // `router.navigate`) and neither changes for the life of this app, so
  // there is no identity churn to route around — and even if one did
  // change, naming it here is correct: a re-subscribe, not a bug.
  const { submit: submitLock, state: lockFetcherState } = useFetcher();
  const { revalidate } = useRevalidator();

  /**
   * Whether the automatic, re-entry-triggered lock post below is in
   * flight. Set synchronously inside `watchReentry`'s hidden-too-long
   * callback, in the same call that starts the fetcher submission — not
   * derived solely from {@link lockFetcherState}, because that value only
   * begins to change once `submitLock` itself has run, and the whole point
   * (finding 2, below) is for this browser to already be inert by then, not
   * a tick later. Cleared once the fetcher reports idle again, which for a
   * live grant only happens once `/lock-now`'s redirect has actually been
   * followed all the way to a rendered `/unlock` — react-router 7.18.2 marks
   * a fetcher that carried a followed redirect done only on
   * `completeNavigation` (`markFetchRedirectsDone`, the router's core
   * chunk), never earlier. That same "cleared" instant is also the settle
   * the next effect below watches for: this state's own transition back to
   * `false`, not a bare read of `lockFetcherState`, since mount already
   * presents `lockFetcherState === "idle"` with nothing having posted
   * anything — only `locking` tells the two apart.
   */
  const [locking, setLocking] = useState(false);

  /**
   * The gap `inert` alone cannot close (this pull request's own finding —
   * distinct from the stale-`hasPasskey` one the reentry effect's header
   * below still calls "finding 1", from an earlier round on this same
   * ticket). `inert` on the chrome below stops a *tap* from starting a
   * navigation while the automatic lock post is in flight, but the
   * browser's own Back/Forward controls, a swipe-back gesture, and a history
   * keyboard shortcut are not taps on this subtree — none of them are
   * disabled by it. Such a POP still runs the root middleware like any
   * navigation does, but it can win a race against `/lock-now`'s own
   * `DELETE`: read the grant while it is still live, render whatever
   * protected route the reader popped back to, and leave that page on
   * screen once this effect clears `locking` and the overlay disappears —
   * the reader is left looking at a page rendered *after* the lock was
   * asked for, with `inert` never having failed at anything it actually
   * covers.
   *
   * The fix does not try to stop that POP — nothing here can, since it never
   * touches this subtree — it stops trusting whatever the POP rendered.
   * Once `lockFetcherState` reports `idle` for a settle that was genuinely
   * mid-post (`locking` was `true`), `/lock-now`'s own action has already
   * run to completion: its `DELETE` landed before its response's redirect
   * could be produced. Revalidating *now* asks the root middleware again for
   * whatever route is actually on screen at this instant, POP-won race or
   * not — no grant, it refuses and redirects to `/unlock`; still somehow
   * live, a harmless extra database read. The outcome stops depending on
   * which navigation happened to finish last.
   *
   * **Cannot loop.** `locking` is itself a dependency here, and the
   * `setLocking(false)` below is what flips it — the *next* run of this
   * effect, the one that same state change triggers, finds `locking` already
   * `false` and returns above before calling `revalidate` a second time.
   * `revalidate()` never touches `lockFetcherState` either (a root
   * revalidation, not a fetcher submission), so nothing here re-arms this
   * effect from the other side: one settle, at most one forced
   * revalidation.
   */
  useEffect(() => {
    if (lockFetcherState !== "idle" || !locking) return;

    setLocking(false);
    revalidate();
  }, [lockFetcherState, locking, revalidate]);

  /**
   * The reentry guard (ticket 06) — `~/lib/reentry.ts`'s own header carries
   * the whole argument for what each half does and does not promise; this
   * effect is only the wiring.
   *
   * **Both halves install unconditionally now, on purpose, and neither may
   * ever go back to gating installation on `hasPasskey`.** That flag is
   * baked into this page at render time, and it is exactly the value that
   * goes stale: a page rendered while the household held no passkey used to
   * pass `null` for the `visibilitychange` half, which skipped installing
   * that listener for this tab's entire lifetime (`watchReentry`'s own
   * doc). A passkey enrolled from another browser afterward then left this
   * tab with nothing watching at all — foregrounding it past the grace
   * produced an ordinary, non-persisted `pageshow`, which the other half
   * was never wired to catch either, and the tab kept showing balances
   * (finding 1). The fix is not a different gate on the same installation;
   * it is moving the decision out of *whether this fires* and into *what it
   * does once it fires* — the callback below reads `hasPasskey` only at the
   * instant a hidden-too-long return actually happens, and even then never
   * to decide silence: with a passkey believed enrolled it posts the lock,
   * same as before; with none believed enrolled it still asks the server,
   * the identical revalidation the `pageshow` half already relies on to
   * pick up state this render never had. A database read at worst, never a
   * blind tab.
   *
   * That decision — `hasPasskey` true posts the lock, false asks the server,
   * never `null` either way — is {@link resolveReentryCallback}, imported
   * rather than written inline here: the regression test added alongside
   * this comment calls that same exported function, so this call site is
   * the only place the decision can be made without leaving the test able
   * to pass against a reverted wiring (that function's own header carries
   * the rest of the argument).
   */
  useEffect(() => {
    if (isUnlockScreen) return;

    return watchReentry(
      resolveReentryCallback(hasPasskey, {
        // Nothing this browser's own post could protect *as far as this
        // render knows* — but that belief is exactly what can be stale
        // (this effect's own header). Asking the server is the cheap,
        // always-correct fallback: the middleware answers off the live
        // database, and refuses on its own if a passkey exists now.
        askServer: revalidate,
        postLock: () => {
          // Set before `submitLock` runs, not after — see {@link locking}'s
          // own header for why the ordering here is the whole fix for
          // finding 2, not a stylistic choice.
          setLocking(true);

          // A fetcher submission, not `useSubmit`'s navigation mode:
          // react-router 7.18.2's `startNavigation` unconditionally aborts
          // the one pending navigation's `AbortController` the instant
          // another navigation starts (`pendingNavigationController`, in
          // the router core `react-router` ships), so a reader who taps a
          // link while a navigation-mode lock post is in flight can cancel
          // `deleteGrant()` before it runs and land on the page they asked
          // for with their grant still live. A fetcher's request instead
          // lives in its own entry in `fetchControllers`, keyed by the
          // fetcher and entirely untouched by `startNavigation`, so a
          // navigation elsewhere cannot cancel it. **That is not the whole
          // story, though (finding 2).** `handleFetcherAction` (same core
          // chunk) captures this fetcher's own load id before awaiting the
          // action, and once the action resolves it compares that id
          // against whatever the *last-started* navigation's id is: if a
          // newer navigation was started meanwhile — a tap on still-live
          // chrome, since nothing yet stops one — the fetcher's redirect is
          // discarded outright (`getDoneFetcher(void 0)`) rather than
          // followed, and the page that navigation rendered stays on screen
          // with the grant already gone underneath it. `Lock now`'s own
          // render below is what actually closes that gap: `inert` on the
          // chrome from the moment `locking` turns true means no tap can
          // start that newer navigation in the first place, so there is
          // nothing left for this race to discard. The chrome's own "Lock
          // now" **button** stays a real `<form method="post">`
          // (`LockNowControl`) — it must keep working with JavaScript off,
          // which is why it is a form and not a submit call at all; only
          // this automatic, re-entry-triggered post changes.
          submitLock(null, { method: "post", action: LOCK_NOW_ACTION });
        },
      }),
      () => revalidate(),
    );
  }, [isUnlockScreen, hasPasskey, submitLock, revalidate]);

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
        {isUnlockScreen ? (
          // The bare shell: no nav, no toggles, no upload button, no
          // first-run prompt, no banner — see this function's own comment
          // above. `.app`/`.app-main` are reused rather than new classes
          // invented for one screen, so this gets the same centred column
          // and padding every other page's content sits in without pulling
          // in a single rail- or topbar-specific rule.
          <div className="app" inert={locking || undefined}>
            <main className="app-main">{children}</main>
          </div>
        ) : (
          <div className="app" inert={locking || undefined}>
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
              {/* Beside masking, never mistakable for it (ticket 06): drawn
                  only while the household holds a passkey at all. */}
              {hasPasskey ? <LockNowControl className="app-rail-lock" /> : null}

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

            {/* The phone's nav: a bottom bar, which is what every mobile mock
             * does — no drawer and no hamburger anywhere in the set (§13.1). */}
            <nav className="app-bottomnav" aria-label="Primary">
              <ul className="app-nav">
                <NavItems items={NAVIGATION} search={owners} />
                <NavItems items={FOOTER_NAVIGATION} />
              </ul>
            </nav>
          </div>
        )}
        {/* Finding 2's actual fix is `inert` on the chrome above, set the
         * instant the automatic lock post goes out (`locking`'s own header
         * on the reentry effect) — this overlay is the human-readable half
         * of that, not the mechanism: `inert` alone would leave a reader
         * tapping a now-unresponsive screen with no idea why. Proportionate
         * on purpose — an ordinary return after sixty seconds hidden, not a
         * rare failure — so it says one thing and asks nothing: no button,
         * nothing to dismiss, because there is nothing here for a reader to
         * decide. It clears itself the moment the fetcher reports idle
         * again, whether that is because `/lock-now`'s redirect landed on
         * `/unlock` or because the post itself failed outright. */}
        {locking ? (
          <div className="reentry-lock-overlay" role="alert" aria-live="assertive">
            <p>Locking this browser…</p>
          </div>
        ) : null}
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
