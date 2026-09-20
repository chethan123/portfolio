# Loading and responsiveness review — 20 September 2026

*Investigated against [705e758](https://github.com/chethan123/portfolio/commit/705e758d424b52f61addf8e5c20323f8c544b0c0):
a production-mode build on a disposable demo database, not a deployed household.*

Start with formatter reuse and chart-coordinate serialization, then add pending-navigation
feedback. Static caching, compression and route splitting already work. These are research
findings, not approved implementation work; no application source changed during this review.

The [archived visual report](2026-09-20-loading-responsiveness-review/report.html) preserves the
presentation reviewed alongside the architecture investigation. Download it and open it in a
browser for the diagrams; this Markdown record is readable directly on GitHub. Local evidence
links work in a checkout. The archive needs no CDN or other network resource to render.

The examined revision includes [icon PR #364](https://github.com/chethan123/portfolio/pull/364),
which was not merged into `main` when this report was published. This documentation PR is based
on `main` and does not include that PR's application changes. Treat all sizes and source links
as evidence about the pinned revision, not a claim about every deployment.

## Method and limits

- Fresh build: React Router 7.18.4, Vite 7.3.6, Node 24.21.0; installed `compression` 1.8.2.
- Disposable PostgreSQL 17 container, migrated and seeded with `scripts/seed-demo.ts`, then the
  existing [1D latency scale harness](2026-09-01-overview-1d-latency/harness/README.md):
  `cadence=15`, `days=92`. The measured shape was 21 open accounts, 97 current holdings,
  98 feed instruments, 174,636 observations across 66 sessions, and 1,620 distinct instants in
  the latest session. The fixture is calendar-derived; later reruns need not have identical bytes.
- Chromium through Playwright, 390 × 844 viewport, configured 1.5 Mbps download,
  150 ms latency and 4× CPU slowdown. One cold and one repeat visit per page, in the same
  browser context per pair. The service worker was blocked to isolate browser HTTP caching.
- Direct loopback HTTP excludes the deployed gate, TLS and VPN. Browser timings are illustrative
  single runs, not production percentiles or measurements on a real phone.
- Formatter A/B requests were separate, unthrottled loopback measurements with identity encoding.
  Geometry compression was a separate in-memory experiment, not a changed server response.
- Source, build output, ADRs, existing tests and official library documentation were checked.
  Three independent final review passes found no material issues in the reported recommendations.

The temporary app processes and database were removed after measurement. Only synthetic demo data
was used. Original measurements are preserved under [harness/](2026-09-20-loading-responsiveness-review/harness/);
its [README](2026-09-20-loading-responsiveness-review/harness/README.md) documents setup, replay,
instrumentation differences and cleanup. Nothing in the application imports this harness.

## 1. Reuse market-clock formatters — Strong

[`partsIn`](https://github.com/chethan123/portfolio/blob/705e758/app/lib/market-hours.ts#L40)
constructs a new `Intl.DateTimeFormat` for every conversion. Chart positioning and
[readouts](https://github.com/chethan123/portfolio/blob/705e758/app/components/net-worth-chart.tsx#L242)
repeat these conversions across points, on the server and during hydration.

Keep formatter instances in the existing market-hours module, keyed by the actual time zone and
formatting options. They contain formatting rules, not financial values. Reusing formatters for
repeated conversions is also the approach described by
[MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/toLocaleString).

Two processes used the same production build and database. The diagnostic process intercepted
only the matching `en-CA`/`h23`/short-weekday formatter constructor. After two warmups per process
and range, seven request pairs alternated which process was called first.

| Range | Current median first byte | Formatter reuse |
|---|---:|---:|
| 1W | 142 ms | 101 ms |
| 3M | 181 ms | 128 ms |
| 1D | 371 ms | 103 ms |

Complete HTML hashes matched within and between both processes for every range. These are server
measurements, not a measured browser improvement; browser savings still need verification after
implementation. Preserve the exact locale, zone and options, daylight-saving behavior, labels and
server/browser agreement. Retain the existing market-hours and chart tests.

Evidence: [full A/B results](2026-09-20-loading-responsiveness-review/harness/formatter-comparison.json),
[comparison script](2026-09-20-loading-responsiveness-review/harness/compare-formatters.mjs),
[constructor instrumentation](2026-09-20-loading-responsiveness-review/harness/reuse-formatters.mjs).
The constructor interception is diagnostic only, not the proposed production implementation.

## 2. Send fewer chart-coordinate digits — Strong

SVG paths, pointer widths and guides serialize full floating-point coordinates across 1,620 points.
The experiment limited SVG coordinates to two decimal places and percentages to three, deriving
hit widths from rounded cumulative edges so they still tile the plot exactly.

| Complete 1D document | Current | Limited geometry precision | Saved |
|---|---:|---:|---:|
| Raw HTML | 778,088 B | 659,504 B | 118,584 B |
| Local Brotli quality 4 | 59,599 B | 37,649 B | 21,950 B |

All 1,620 plotted points and hit targets survived. All 1,621 date and amount readouts, including
the resting readout, matched exactly. No previously positive-width target collapsed; rounded
target widths totaled exactly 100%. Monetary values were not rounded.

This reduces serialized bytes, not DOM element count. The current 1D page has 8,734 elements versus
1,324 for 1W. Preserve first/last positions, touch targeting, all observations and monetary precision;
implement identical geometry serialization in SSR and hydration and verify it in browser tests.
[ADR-0004](../adr/0004-pre-rendered-chart-interaction.md)'s pre-rendered interaction and complete
1D line stay intact. A larger readout redesign would need to revisit that decision separately.

This was an in-memory markup experiment. Both documents were recompressed locally with the same
settings; the numbers are estimates of transfer savings. The actual current server response encoded
62,149 B because live streaming and flush behavior differ from local recompression.

Code: [SVG paths](https://github.com/chethan123/portfolio/blob/705e758/app/components/net-worth-chart.tsx#L189),
[line coordinates](https://github.com/chethan123/portfolio/blob/705e758/app/components/net-worth-chart.tsx#L220),
[interaction geometry](https://github.com/chethan123/portfolio/blob/705e758/app/components/net-worth-chart.tsx#L413).
Evidence: [results and invariants](2026-09-20-loading-responsiveness-review/harness/chart-precision-results.json),
[serialization experiment](2026-09-20-loading-responsiveness-review/harness/chart-precision.mjs).

## 3. Acknowledge navigation immediately — Strong UX opportunity

[Navigation](https://github.com/chethan123/portfolio/blob/705e758/app/root.tsx#L254) uses active-state
styling only; [chart-range links](https://github.com/chethan123/portfolio/blob/705e758/app/components/chart-range-control.tsx#L95)
have no pending state. Holding the 1D data response after tapping its link left 1W visible, without
a busy or status indication. The [captured screen](2026-09-20-loading-responsiveness-review/figures/pending-1d.png)
shows the unchanged state while that response was held.

Use the router's pending-navigation state for restrained progress feedback and destination-specific
chart feedback, following [React Router v7's pending UI guidance](https://raw.githubusercontent.com/remix-run/react-router/react-router%407.18.2/docs/start/framework/pending-ui.md).
Keep the old figures correctly labelled with their current range until the new result arrives.
This improves perceived responsiveness, not network completion time.

Verify delayed navigation, rapid second selections, cancellation and completion in a browser.
Keep ordinary links and forms working without JavaScript. The screenshot is evidence from the
manual held-response check; that check is not part of the automated timing scripts.

## 4. Start independent reads sooner — Worth exploring

Root-loader parallelism already shipped. Remaining opportunities are narrower:

- [Overview](https://github.com/chethan123/portfolio/blob/705e758/app/routes/overview.tsx#L78):
  after resolving the owner reading, start account totals and freshness alongside chart reach and
  manual history.
- [Narrowed Holdings](https://github.com/chethan123/portfolio/blob/705e758/app/routes/holdings.tsx#L104):
  start household and narrowed holdings reads together instead of waiting for the household wave.
- [Holdings editor](https://github.com/chethan123/portfolio/blob/705e758/app/routes/holdings.tsx#L169):
  consider starting the current-position read alongside other reads once its identifiers are known.

These shorten the server critical path; each database query is not a browser round trip.
No benefit has been measured yet. Measure query duration and pool contention before assigning a
speed claim. Preserve owner canonicalization, mandatory lock checks, shared masking decisions and
distinct household/narrowed behavior. Attach rejection handling to work started early.

## Static caching and bloat: retain what works

- Hashed `/assets/` responses are `public, max-age=31536000, immutable`. The repeated browser
  visits transferred zero bytes for these assets.
- The server already negotiates Brotli with `Vary: Accept-Encoding`. Routed documents and data
  keep `no-store`; financial pages do not need to be stored in the service worker to cache assets.
- Routes already split. Server-only database/feed libraries are absent from emitted client files.
  Initial route discovery loads small metadata, not every route's code.
- The font is hashed, preloaded and metric-matched. Navigation preload and palette PNG icons are
  present in the examined revision, with the publication caveat about PR #364 above.
- Network requests still cross the deployed gate; browser cache hits avoid those requests.

These observations were checked against installed `@react-router/serve` 7.18.4, `compression`
1.8.2, the fresh build and live headers. Relevant references:
[HTTP cache freshness](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cache-Control),
[React Router 7.18.4 code splitting](https://reactrouter.com/7.18.4/explanation/code-splitting),
and [ADR-0007](../adr/0007-the-service-worker-stores-nothing.md).

### Smaller follow-ups

- **Metadata freshness:** fixed manifest/favicon URLs return `max-age=0` and support 304
  validation. A short TTL for successful static responses, or a versioned favicon, could avoid
  repeat requests. Exclude documents, data, redirects and `sw.js` from that rule.
- **Later worker registration:** registration after initial load could avoid first-visit contention,
  as described in [Google's guidance](https://web.dev/articles/service-workers-registration).
  The worker is only 2.8 KB raw and precaches nothing, so expected benefit is small. First-visit
  offline guidance would become available later.
- **Passkey route coupling:** moving shared predicates out of the Unlock route could stop Settings
  from importing its display chunk. The ceiling is under 2.2 KB gzip of avoidable code, often
  already cached. This is a small performance benefit, not the main reason for a workflow refactor.
- **Font range experiment:** Inter is 48.3 KB and effectively incompressible. Restricting its
  variable weight range might save bytes; savings and visual equivalence have not been measured.

Defer a framework rewrite, more tiny route chunks, global CSS splitting and custom precompression
infrastructure. Framework code dominates the existing client bundle, the whole stylesheet is only
8 KB gzip, and compression/caching already cover the main static-asset gains. These are deferred
options, not rejected measured improvements.

## Browser measurements

KB means 1,000 bytes. Transfer includes the document and recorded resources; first paint below is
first contentful paint. The method and limits above apply to every row.

| Page | Cold transfer | Repeat transfer | Cold FCP | Repeat FCP |
|---|---:|---:|---:|---:|
| Overview, 1W | 210.1 KB | 11.6 KB | 1.05 s | 0.29 s |
| Overview, 1D | 260.9 KB | 62.4 KB | 1.58 s | 0.68 s |
| Holdings | 212.4 KB | 14.2 KB | 1.99 s | 0.41 s |

Evidence: [original resource and timing measurements](2026-09-20-loading-responsiveness-review/harness/measurements.json),
[measurement script](2026-09-20-loading-responsiveness-review/harness/measure.mjs).
Browser transfer, local recompression and unmeasured proposals are deliberately kept separate.
