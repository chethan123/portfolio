import type { Config } from "@react-router/dev/config";

export default {
  // Server-side render by default, then hydrate. DESIGN.md §9.
  ssr: true,
} satisfies Config;
