import { type RouteConfig, index, route } from "@react-router/dev/routes";

// Hand-written route config, not file-based routing (DESIGN.md §8.4 for nav order).
export default [
  index("routes/overview.tsx"),
  route("holdings", "routes/holdings.tsx"),
  route("analysis", "routes/analysis.tsx"),
  route("income", "routes/income.tsx"),
  route("upload", "routes/upload.tsx"),

  route("upload/:draftId", "routes/upload/draft.tsx", [
    index("routes/upload/index.tsx"),
    route("columns", "routes/upload/columns.tsx"),
    route("instruments", "routes/upload/instruments.tsx"),
    route("review", "routes/upload/review.tsx"),
  ]),

  route("accounts/:accountId", "routes/account.tsx"),

  route("settings", "routes/settings.tsx", [
    index("routes/settings/index.tsx"),
    route("people", "routes/settings/people.tsx"),
    route("accounts", "routes/settings/accounts.tsx"),
    route("accounts/:accountId", "routes/settings/account.tsx"),
    route("tax", "routes/settings/tax.tsx"),
    route("prices", "routes/settings/prices.tsx"),
    route("display", "routes/settings/display.tsx"),
    route("passkeys", "routes/settings/passkeys.tsx"),
  ]),

  route("unlock", "routes/unlock.tsx"),
  route("lock-now", "routes/lock-now.ts"),
  route("masking", "routes/masking.ts"),
  route("refresh", "routes/refresh.ts"),
  route("healthz", "routes/healthz.ts"),
] satisfies RouteConfig;
