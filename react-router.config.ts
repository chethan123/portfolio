import type { Config } from "@react-router/dev/config";

export default {
  // Server-side render by default, then hydrate. DESIGN.md §9.
  ssr: true,

  future: {
    // Route middleware. `chart-range.ts`'s `chartRangeMiddleware` is what
    // needs it: a middleware wraps the *response*, which is how a route can
    // write the range cookie while its loader keeps returning the plain object
    // every test reads fields off directly.
    //
    // Authentication was the original reason and is no longer a reason at all —
    // it happens in front of the app now (ADR-0005), so nothing here is a gate.
    v8_middleware: true,
  },
} satisfies Config;
