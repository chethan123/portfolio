import type { Config } from "@react-router/dev/config";

export default {
  // DESIGN.md §9.
  ssr: true,

  future: {
    // For `chartRangeMiddleware` and the lock's root middleware (ADR-0012): a
    // middleware wraps the *response*, so a route can write a cookie while its
    // loader still returns the plain object tests read.
    v8_middleware: true,
  },
} satisfies Config;
