/** Rendered by root `Layout` only when a passkey is enrolled; no guard of its own. */
import { Form } from "react-router";

import { LOCK_NOW_ACTION } from "~/lib/lock";

import { LockIcon } from "./icons";

export function LockNowControl({ className }: { className?: string }) {
  return (
    <Form method="post" action={LOCK_NOW_ACTION} className={className}>
      <button type="submit" className="lock-now-control">
        <LockIcon className="app-nav-icon" />
        <span>Lock now</span>
      </button>
    </Form>
  );
}
