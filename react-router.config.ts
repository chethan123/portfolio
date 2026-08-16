import type { Config } from "@react-router/dev/config";

export default {
  // Server-side render by default, then hydrate. DESIGN.md §9.
  ssr: true,

  future: {
    // Route middleware. The optional login gate (DESIGN.md §10) is one
    // middleware on the root route, which is what makes it deny-by-default:
    // every route is a child of root, so a route added in a later slice is
    // covered the moment it is routable rather than when someone remembers it.
    v8_middleware: true,
  },
} satisfies Config;
