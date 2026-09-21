/**
 * The server build as `react-router-serve` loads it, plus the one thing the build cannot carry: the
 * host this deployment answers on. `react-router.config.ts` would bake it into the published image,
 * and the image serves whatever hostname a household gives it, so it is read here from the
 * environment instead (`server/action-origins.ts` for why this is needed at all).
 *
 * `export *` does not re-export `default`, which is what keeps `react-router-serve` treating this
 * as a classic build rather than an RSC one; the local `allowedActionOrigins` below wins over the
 * build's own by the same rule that makes a local export shadow a star export.
 */
import { actionOriginsOf } from "./action-origins.ts";
import { getConfig } from "./config.ts";

// @ts-expect-error -- `tsconfig.json` excludes `build/`, which exists only after `npm run
// build`. Declaring it would be a second hand-written copy of a generated shape.
export * from "../build/server/index.js";

export const allowedActionOrigins = actionOriginsOf(getConfig().PUBLIC_ORIGIN);
