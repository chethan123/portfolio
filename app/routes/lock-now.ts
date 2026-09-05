/**
 * "Lock now" (ticket 06, docs/adr/0012): the chrome's explicit control posts
 * here, and so does the reentry guard's own automatic post
 * (`~/lib/reentry.ts`) — both want the identical thing done: this browser's
 * grant gone, its cookie gone with it, before the reader (or the guard, on
 * their behalf) is sent to the one screen a gone grant can still reach.
 *
 * A resource route, action only — `masking.ts`'s own shape, and the same
 * shape's own behaviour for a stray `GET` here: react-router 7.18.2's
 * `getInternalRouterError` reserves 405 for a route missing an **action**;
 * a route missing a **loader**, which is this file's actual shape, gets 400
 * (`{"message":"Unexpected Server Error"}`) and a full stack logged to
 * stderr. That is the framework's behaviour for every resource route in this
 * app, `masking.ts` included, never this file's to answer alone — giving
 * only this one a loader to answer `GET` would make two identical routes
 * disagree. The control that posts here is a real `<form>`, so it works with
 * JavaScript off, because locking has to (ADR-0012's consequence for
 * unlocking does not run the other way); the reentry guard's own post is
 * JavaScript-only by construction, since nothing runs its timer without it.
 *
 * **No return address**, unlike `/masking`'s `redirectTo`. Landing back on
 * the screen just locked is not a courtesy this control owes: the point of
 * pressing it is to stop that screen being readable, not to make it the
 * first thing offered the moment somebody unlocks again. `/unlock` renders
 * with nothing to bounce back to, and the household lands on `/` once they
 * do — `safeReturn`'s own fallback for an absent parameter, the same one an
 * already-locked browser's refused POST gets today (`app/root.tsx`'s
 * `redirectToUnlock`).
 *
 * Deletes the grant this browser's cookie names, if it names one at all —
 * `deleteGrant` is a plain `DELETE ... WHERE id = ...`, so a cookie already
 * gone (a stale value, a grant the idle window or a concurrent removal
 * already ended) costs nothing to call it against. **Not** every browser
 * that reaches this action is holding a live grant, though — while the
 * household holds no passkey at all, `lockMiddleware` calls `next()` without
 * ever reading the cookie (`app/root.tsx`'s own header on that branch), so a
 * `POST` here with no cookie at all runs this action same as any other:
 * reachable in practice by pressing the control on a page rendered before
 * another tab removed the household's last passkey. `deleteGrant` against no
 * id, and a redirect to the unlock screen nothing was protecting any more,
 * is exactly the no-op that case deserves — which is what the test below
 * with no seeded passkey asserts.
 */
import { redirect } from "react-router";

import { UNLOCK_PATH } from "~/lib/lock";
import { clearedLockCookie, deleteGrant, readLockCookie } from "~/lib/lock.server";

import type { Route } from "./+types/lock-now";

export async function action({ request }: Route.ActionArgs) {
  const grantId = readLockCookie(request);
  if (grantId !== undefined) await deleteGrant(grantId);

  return redirect(UNLOCK_PATH, { headers: { "Set-Cookie": clearedLockCookie() } });
}
