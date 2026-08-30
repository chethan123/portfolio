import type { Config } from "@react-router/dev/config";

export default {
  // Server-side render by default, then hydrate. DESIGN.md §9.
  ssr: true,

  future: {
    // For `chart-range.ts`'s `chartRangeMiddleware`: a middleware wraps the
    // *response*, letting a route write the range cookie while its loader
    // keeps returning the plain object tests read directly. Auth is NOT a
    // reason — it happens in front of the app (ADR-0005); nothing here is a
    // gate.
    v8_middleware: true,
  },
} satisfies Config;
