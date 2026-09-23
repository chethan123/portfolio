/**
 * Which origins may submit an action, for `allowedActionOrigins` on the server build.
 *
 * React Router 7.18.3 began comparing a mutation's `Origin` against the whole origin of
 * `request.url` rather than its host (CHANGELOG v7.18.3, #15420). Behind a TLS-terminating proxy
 * the app only ever sees `http`, so an `https` page's every POST read as cross-origin — `/unlock`
 * included, which shut a household out of its own vault.
 *
 * The **host**, never the origin: the framework matches `new URL(origin).host`, so a host keeps
 * this agreeing with `crossOriginMutationMiddleware` (`app/root.tsx`), which compares hosts, and
 * with the suite, which addresses the instance over http while the config names https
 * (`docs/specs/lock-hardening/10-refuse-a-cross-origin-post.md`). An origin here would refuse both.
 */

/** `publicOrigin` is already canonical — `server/config.ts` refuses anything else. */
export function actionOriginsOf(publicOrigin: string): string[] {
  return [new URL(publicOrigin).host];
}
