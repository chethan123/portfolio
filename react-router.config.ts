import type { Config } from "@react-router/dev/config";

export default {
  // Server-side render by default, then hydrate. DESIGN.md §9.
  ssr: true,

  future: {
    // For `chart-range.ts`'s `chartRangeMiddleware`, and since ADR-0012 for the
    // lock's own root `middleware` too (`app/root.tsx`'s `lockMiddleware`): a
    // middleware wraps the *response*, letting a route write the range cookie
    // while its loader keeps returning the plain object tests read directly.
    // *Person* authentication is still not a reason for this flag — that still
    // happens in front of the app (ADR-0005); the lock decides a different
    // question, which *browser* holds a live grant, never who is asking, and
    // it is not a gate either.
    v8_middleware: true,
  },
} satisfies Config;
