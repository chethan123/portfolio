import { type RouteConfig, index, route } from "@react-router/dev/routes";

/**
 * Navigation order is DESIGN.md §8.4: ordered by how often a page is opened,
 * so the daily pages come first and Settings is last. The three dashboards and
 * Upload are stubs in this slice; their content is other slices.
 */
export default [
  index("routes/overview.tsx"),
  route("holdings", "routes/holdings.tsx"),
  route("income", "routes/income.tsx"),
  route("upload", "routes/upload.tsx"),
  route("settings", "routes/settings.tsx"),

  // Resource route, no UI. Kept in the router rather than in a server wrapper
  // so it behaves identically in dev and in the container.
  route("healthz", "routes/healthz.ts"),
] satisfies RouteConfig;
