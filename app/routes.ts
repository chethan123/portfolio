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

  // The step screens over one upload draft (DESIGN.md §5.1). Not nav entries:
  // a step is reached only by working through the flow, and the rail's filled
  // button stays the one way in. The layout carries the strip and the
  // expired-draft page; the index resumes a draft at whichever step it got to.
  route("upload/:draftId", "routes/upload/draft.tsx", [
    index("routes/upload/index.tsx"),
    route("columns", "routes/upload/columns.tsx"),
    // Skipped by redirect when the file carries no first sightings (ingest
    // brief §5, §7.5) — the strip dims the entry rather than dropping it.
    route("instruments", "routes/upload/instruments.tsx"),
    // The diff, then the commit — the flow's only write (ingest brief §6,
    // spec 0004 step 05). POST inserts the position set, deletes the draft
    // and redirects to /accounts/:id?uploaded=<setId> for the receipt.
    route("review", "routes/upload/review.tsx"),
  ]),

  // The per-account drill-down (DESIGN.md §13.1). §8.1 had ruled it out on the
  // grounds that a filtered Holdings table already is one; the Stitch "Account
  // Details" screen is more than that filter, and the queries it needs are the
  // dashboard's with one predicate added, so the exclusion was reversed.
  route("accounts/:accountId", "routes/account.tsx"),

  // Settings is a section, not a page: `settings.tsx` is the tab strip and
  // everything that writes hangs off it (DESIGN.md §8.4).
  route("settings", "routes/settings.tsx", [
    index("routes/settings/index.tsx"),
    route("people", "routes/settings/people.tsx"),
    route("accounts", "routes/settings/accounts.tsx"),
    route("accounts/:accountId", "routes/settings/account.tsx"),
    // The one preference in an application whose settings are otherwise all
    // domain rows: the capital gains rate the Analysis screen estimates with.
    // `0005_app_setting.sql` argues why it is not an environment variable.
    route("tax", "routes/settings/tax.tsx"),
  ]),

  // The optional login gate's one page (DESIGN.md §10). It renders only while
  // AUTH_PASSWORD is set; with the gate off it redirects to the overview.
  route("login", "routes/login.tsx"),

  // The masking toggle's server-side writer (spec 0007). No UI: the control is
  // in the chrome on every page, and this is the target its form posts to so
  // that it keeps working with JavaScript off. Inside the gate like everything
  // else — a display preference is not a reason to open a hole in §10.
  route("masking", "routes/masking.ts"),

  // Resource route, no UI. Kept in the router rather than in a server wrapper
  // so it behaves identically in dev and in the container.
  route("healthz", "routes/healthz.ts"),
] satisfies RouteConfig;
