/** "Lock now": clears this browser's grant + cookie, then sends it to /unlock. docs/adr/0012 */
import { redirect } from "react-router";

import { UNLOCK_PATH } from "~/lib/lock";
import { clearedLockCookie, deleteGrant, readLockCookie } from "~/lib/lock.server";

import type { Route } from "./+types/lock-now";

export async function action({ request }: Route.ActionArgs) {
  const grantId = readLockCookie(request);
  if (grantId !== undefined) {
    try {
      await deleteGrant(grantId);
    } catch (error) {
      // Cookie must clear even if the delete fails, else the browser keeps a live grant.
      console.error("Grant delete failed; locking this browser anyway:", error);
    }
  }

  return redirect(UNLOCK_PATH, { headers: { "Set-Cookie": clearedLockCookie() } });
}
