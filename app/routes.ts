import { type RouteConfig, index, route } from "@react-router/dev/routes";

/**
 * Navigation order is DESIGN.md §8.4: ordered by how often a page is opened,
 * so the daily pages come first and Settings is last. The three dashboards
 * carry empty states and Upload is a placeholder in this slice; their content
 * is other slices.
 */
export default [
  index("routes/overview.tsx"),
  route("holdings", "routes/holdings.tsx"),
  route("income", "routes/income.tsx"),
  route("upload", "routes/upload.tsx"),

  // Settings is a section, not a page: `settings.tsx` is the tab strip and
  // everything that writes hangs off it (DESIGN.md §8.4).
  route("settings", "routes/settings.tsx", [
    index("routes/settings/index.tsx"),
    route("people", "routes/settings/people.tsx"),
    route("accounts", "routes/settings/accounts.tsx"),
    route("accounts/:accountId", "routes/settings/account.tsx"),
  ]),

  // The optional login gate's one page (DESIGN.md §10). It renders only while
  // AUTH_PASSWORD is set; with the gate off it redirects to the overview.
  route("login", "routes/login.tsx"),

  // Resource route, no UI. Kept in the router rather than in a server wrapper
  // so it behaves identically in dev and in the container.
  route("healthz", "routes/healthz.ts"),
] satisfies RouteConfig;
