# Installable PWA: home-screen app with a gated, storage-free offline posture

## Problem Statement

The tracker is self-hosted, reachable only on the home network or over the household VPN, and used
from phones as much as from desks. On a phone today it is a browser tab: no home-screen icon, no
full-screen presentation, and — because the phone is off the VPN most of the time — opening it
usually lands on a browser network-error page. It feels like a website that happens to work on
mobile, not like the household's app.

## Solution

Make the app an installable PWA for Android, without weakening any of the instance's security
posture:

- A web app manifest and icons make the app installable from Chrome on Android (manifest + HTTPS is
  sufficient for installability in current Chrome; no service worker is required for the prompt),
  opening full-screen under its own home-screen identity ("Portfolio", with a purpose-drawn glyph
  that also becomes the site's first favicon).
- A small hand-rolled service worker exists for one reason only: a deliberate offline experience.
  When the server is unreachable (VPN down, away from home), navigation lands on a branded offline
  page — inlined in the worker itself — that says what is wrong and what to do (connect the VPN),
  instead of Chrome's dinosaur.
- **Nothing persists on the device.** The service worker uses no Cache Storage at all: it is
  network-only for every request it sees, and its offline page is a template string inside the
  worker script. There is no cached document, no cached loader data, and no cache to version or
  clean up. This is a household privacy decision, recorded as ADR-0007.
- Every request — manifest, icons and service worker included — stays behind the gate. The manifest
  is fetched with credentials so installation works without punching any hole in the gate.

## User Stories

1. As a family member on my phone, I want the tracker on my home screen with its own icon and name,
   so that opening it feels like opening an app rather than hunting for a browser tab.
2. As a family member on my phone, I want the app to open full-screen without browser chrome, so
   that the screens read like a native app.
3. As a family member away from home without the VPN connected, I want the installed app to open to
   a page that tells me the server is unreachable and to connect the VPN, so that I know what to do
   instead of staring at a browser error.
4. As a family member whose phone is lost or borrowed, I want no balances, holdings or net-worth
   figures stored on the device — no caches at all — so that the install adds nothing readable
   beyond what the gate already protects.
5. As a family member back on the home network, I want the app to load live pages exactly as the
   website does today, so that installing changes how the app opens, never what it shows.
6. As a family member uploading a statement from my phone, I want the upload flow to behave exactly
   as before, so that the service worker never replays, caches or interferes with an in-flight
   draft.
7. As the household operator, I want the gate to keep challenging every request, manifest and
   service worker included, so that installing the PWA does not create a single ungated path.
8. As the household operator, I want the service worker small enough to read in one sitting, so
   that I can verify the nothing-stored rule by eye instead of trusting a framework's
   configuration.
9. As a family member, I want the offline page branded with the app's glyph and colors, so that
   even the failure state feels owned rather than broken.
10. As a family member with the app installed, I want a deployed new version of the app to take
    effect the next time I open it with the server reachable, so that the installed app never
    wedges on a stale shell.
11. As a family member using the site in a desktop browser, I want a favicon in the tab, so that
    the tracker is findable among my tabs.
12. As a family member with the app installed, I want the icon to render correctly inside
    Android's adaptive icon shapes (circle, squircle), so that it does not sit as a tiny glyph on
    a white plate.
13. As a family member who has masked the screens, I want masking to behave identically in the
    installed app, so that the display state is about the browser, not about how the app was
    opened.
14. As the household operator, I want the decision that the service worker stores nothing written
    down where future work will find it, so that a later "add offline snapshots" idea starts from
    the recorded trade-off rather than rediscovering it.
15. As a family member on a slow or flaky connection, I want a request that *fails* to fall back to
    the offline page but a request that *succeeds* to render normally, so that the offline posture
    never masks a working server.
16. As a family member signing in again after the gate session expires, I want the gate's redirect
    to sign-in to work identically through the service worker, so that installing never breaks
    getting back in.

## Implementation Decisions

- **Manifest**: a hand-written static web app manifest served from the public asset directory. It
  declares `name`, the home-screen label `short_name: "Portfolio"` (well inside the ~12-character
  guidance), `start_url` at the Overview, `display: standalone`, a light-scheme background color
  matching the existing light theme-color, and the icon set. `id` and `scope` are declared at the
  site root for stability, not necessity — current Chrome defaults both from `start_url`. It is
  linked from the document head with `crossorigin="use-credentials"`: browsers fetch a linked
  manifest **without** credentials by default even same-origin, which behind the gate would
  silently break installation, so the attribute is a named decision. The gate keeps challenging
  everything; no path is exempted (the accepted interaction with the forward-auth-gate ADR).
- **Icons**: a purpose-drawn SVG glyph that *is* the existing brand tile — the white bold "P" on
  the brand blue the rail already draws, not a second mark — as the source of truth. From it: 192px and 512px PNGs with
  `purpose: "any"` plus a separate maskable 512px PNG (artwork inside the 40%-radius safe zone;
  `any` and `maskable` kept as separate entries, never combined), and the SVG itself as the
  favicon (Chrome supports SVG favicons; the household is Android/Chrome). The PNGs are committed
  artifacts, rasterized once by a small script using the Playwright chromium already in the dev
  dependencies — the same committed-artifact-plus-regeneration-script pattern the screenshot
  tooling already uses; wired into no build step.
- **Service worker**: one hand-rolled plain-JavaScript file (small enough to read in one sitting;
  no dependencies, no Workbox), served from the public asset directory at the site root so its
  scope covers the whole app. Plain `.js`, deliberately: the TypeScript config would otherwise
  typecheck it against the wrong runtime library. Behavior, exhaustively:
  - It opens no caches and stores nothing — no Cache Storage, no IndexedDB, nothing.
  - On install: `skipWaiting`. On activate: `clients.claim`. Nothing else.
  - On fetch: act **only** on GET navigation requests, by passing the request to the network; if
    the fetch **rejects** (network failure), respond with the offline page built from a template
    string in the worker. Every other request — loaders, actions, POSTs, the upload flow's
    multipart posts, the health check, the gate's own OAuth paths — is not intercepted at all.
  - The gate interaction, precisely: a navigation carries redirect mode `manual`, so when the gate
    answers 302-to-sign-in, the worker's fetch **resolves** with an `opaqueredirect` response; the
    worker hands it back and the browser follows the redirect itself. The offline page appears
    only when fetch rejects. Corollary, recorded as a caveat in the worker: never branch on
    `response.ok` for navigations — an `opaqueredirect` has `ok === false`, and that "improvement"
    would break sign-in.
  - Updates need no cache version: the browser checks for an updated worker script on navigations
    into scope (the
    registration's update check sends the gate cookie, and its default `updateViaCache` already
    bypasses the HTTP cache), and a byte-different worker installs and activates immediately via
    `skipWaiting`. If the gate session has lapsed, the update fetch gets a redirect, which
    registration rejects for worker scripts — the installed worker is simply retained until the
    next signed-in visit. Silent by design.
- **Offline page**: a self-contained HTML template string inside the worker — inline styles, the
  glyph as inline SVG, system font stack. It renders no figures and fetches nothing. Inlining is
  chosen over a precached static file because it deletes the precache list, cache versioning and
  activation cleanup wholesale, and makes "stores nothing" structural rather than disciplined.
- **Registration**: emitted as part of the server-rendered document shell (a small inline script,
  guarded on service-worker support), so the rendered markup carries it and the existing
  layout-rendering test seam can assert it. Note for the future: the deployment currently sets no
  CSP; if one is ever added, this inline script is one more thing it must allow.
- **Document head**: the root layout gains the manifest link (with `use-credentials`) and the SVG
  favicon link alongside the existing viewport and media-scoped theme-color metas, which are kept
  as the live theme signal (the manifest's single theme color is the installed fallback).
- **No server changes, no ingress changes**: the app stays on the framework's own server; static
  files ship from the public directory as they do today; the gate's posture is untouched.
- **ADR-0007** records "the service worker stores nothing on the device" in the house ADR format
  (declarative-sentence title, context and decision as prose, considered options with rejection
  reasons, consequences): the trade-off (offline snapshot utility vs. nothing-on-device), why it
  was decided, and what revisiting it would take — installed workers on family phones make a bad
  caching decision slow to claw back.
- **Spec placement**: this spec lives as the next numbered file under the specs directory (the
  slice numbering, distinct from ADR numbering) in addition to the tracker issue, per the
  repository's layout authority.
- **Glossary**: no new CONTEXT.md terms — installability and the offline page are delivery
  mechanics, not domain concepts.

## Testing Decisions

- Good tests here assert **what the browser sees**, not how it got there: the rendered document
  head, the manifest's contract, the worker's presence. No test reaches into the service worker's
  logic, and no headless-browser service-worker harness is added — the worker stays small enough
  to audit by eye, and its rule is enforced by review plus ADR-0007.
- **Document head**: rendered through the existing `renderThroughLayout` support helper (the house
  seam that renders the real layout to static markup and fails on React warnings; the banner,
  first-run-prompt and masking-toggle tests are the prior art), asserting the manifest link
  carries `use-credentials`, the favicon link is present, and the registration script is emitted.
- **Manifest contract**: a test reads and parses the manifest file from the public directory and
  asserts the fields installation depends on: name and short name, root start URL, standalone
  display, and an icon set including 192, 512 and a separate maskable entry whose files exist on
  disk. Prior art: the migrations test asserting a contract over files on disk.
- **Worker contract**: a test reads the worker file and asserts it exists and carries the
  connect-your-VPN message — a guard against accidental deletion, not a behavior test.
- The worker's fetch logic itself is deliberately untested (see the seam decision above).

## Out of Scope

- **Offline data of any kind** — no cached holdings, net worth, or last-known snapshots, and no
  Cache Storage at all. Rejected deliberately (household privacy decision, ADR-0007), not deferred
  by accident.
- **Push notifications** — requires Apple/Google push infrastructure, against the instance's
  nothing-leaves-the-network posture, and nothing in the app is time-critical.
- **iOS support** — the household is Android; no apple-touch-icon, splash screens, or Safari
  workarounds. Nothing prevents adding them later.
- **Offline mutations / background sync** — the upload flow and all actions require the server.
- **Share-target** (sharing a CSV into the app) — a separate slice if ever wanted.
- **HTTP cache-header tuning** for static assets, and any Caddy or gate configuration change.
- **App shortcuts, badging, periodic background sync** and other PWA extras.

## Further Notes

- The cert is publicly trusted (Let's Encrypt), which service workers and installation both
  require; nothing to change there.
- Chrome dropped the service-worker requirement for installability (Chrome 108+ mobile), so the
  manifest alone makes the app installable; the worker is purely the offline-UX half of the slice
  and the two halves are independently shippable.
- Android may evict a rarely-used origin's registration; the only consequence is losing the
  offline page until the next successful visit re-registers it — the offline page must stay a
  nicety, never a dependency.
- The worker's network-only posture means a mid-session VPN drop fails exactly as the website does
  today for in-flight data fetches; only full navigations get the offline page. Accepted:
  intercepting data fetches to soften them is precisely the storage this spec forbids.
