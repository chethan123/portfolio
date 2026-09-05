import { type RouteConfig, index, route } from "@react-router/dev/routes";

/**
 * Navigation order is DESIGN.md §8.4: ordered by how often a page is opened,
 * so the daily pages come first and Settings is last. The three dashboards
 * carry empty states; their content is other slices.
 */
export default [
  index("routes/overview.tsx"),
  route("holdings", "routes/holdings.tsx"),
  route("analysis", "routes/analysis.tsx"),
  route("income", "routes/income.tsx"),
  route("upload", "routes/upload.tsx"),

  // Step screens over one upload draft (DESIGN.md §5.1). Not nav entries: a
  // step is reached only by working through the flow. The layout carries the
  // strip and the expired-draft page; the index resumes a draft mid-flow.
  route("upload/:draftId", "routes/upload/draft.tsx", [
    index("routes/upload/index.tsx"),
    route("columns", "routes/upload/columns.tsx"),
    // Skipped by redirect when the file carries no first sightings (ingest
    // brief §5, §7.5) — the strip dims the entry rather than dropping it.
    route("instruments", "routes/upload/instruments.tsx"),
    // The diff, then the commit — the flow's only write (ingest brief §6,
    // spec 0004 step 05): POST inserts the position set, deletes the draft,
    // redirects to /accounts/:id?uploaded=<setId> for the receipt.
    route("review", "routes/upload/review.tsx"),
  ]),

  // Per-account drill-down (DESIGN.md §13.1). §8.1 had ruled it out as "a
  // filtered Holdings table already is one"; the Stitch screen is more than
  // that filter and its queries are the dashboard's plus one predicate, so
  // the exclusion was reversed.
  route("accounts/:accountId", "routes/account.tsx"),

  // Settings is a section, not a page: `settings.tsx` is the tab strip and
  // everything that writes hangs off it (DESIGN.md §8.4).
  route("settings", "routes/settings.tsx", [
    index("routes/settings/index.tsx"),
    route("people", "routes/settings/people.tsx"),
    route("accounts", "routes/settings/accounts.tsx"),
    route("accounts/:accountId", "routes/settings/account.tsx"),
    // The capital gains rate Analysis estimates with; `0005_app_setting.sql`
    // argues why it is not an environment variable.
    route("tax", "routes/settings/tax.tsx"),
    // The poller's refresh cadence; `0008_refresh_cadence.sql` argues why it
    // moved out of the environment.
    route("prices", "routes/settings/prices.tsx"),
    // How the screens open untouched — the masking policy today, §12's theme
    // choice when it lands (spec 0007).
    route("display", "routes/settings/display.tsx"),
  ]),

  // The screen a browser holding no valid grant is shown (docs/adr/0012,
  // ticket 04) — `LOCK_EXEMPT_PATHS` in app/root.tsx names this exact path so
  // the lock's own middleware never refuses it. Grouped here, beside the
  // other routes the lock's own machinery depends on, rather than in nav
  // order: nobody clicks their way here, the middleware redirects them.
  route("unlock", "routes/unlock.tsx"),

  // "Lock now" (ticket 06, docs/adr/0012). No UI — the chrome's control and
  // the reentry guard's own automatic post (`~/lib/reentry.ts`) both target
  // this, so a press (or the guard, standing in for one) works with
  // JavaScript off where the control itself is concerned. Grouped beside
  // `unlock` for the reason above: the lock's own machinery, not nav order.
  route("lock-now", "routes/lock-now.ts"),

  // The masking toggle's writer (spec 0007). No UI — the chrome's control
  // posts here so the toggle works with JavaScript off.
  route("masking", "routes/masking.ts"),

  // "Refresh now" (spec 0002 story 5). No UI — every figure screen's header
  // control posts here, so a press works with JavaScript off.
  route("refresh", "routes/refresh.ts"),

  // Resource route, no UI. In the router rather than a server wrapper so it
  // behaves identically in dev and in the container.
  route("healthz", "routes/healthz.ts"),
] satisfies RouteConfig;
