/**
 * The chrome's other control (ticket 06, docs/adr/0012, spec 0019): the most
 * direct answer to the threat this whole slice exists for — handing somebody
 * an unlocked phone. Beside `MaskingToggle`, and never mistakable for it: that
 * one dots the amounts on a screen you are reading; this one ends the reading
 * outright, on this browser, right now.
 *
 * **Drawn only while the household holds a passkey at all.** `app/root.tsx`'s
 * `Layout` is what decides that — off the root loader's `hasPasskey`, and
 * that flag decides this control and nothing else: the reentry guard
 * (`~/lib/reentry.ts`) installs on every page regardless of it — and passes
 * nothing to
 * this component when it should not render, rather than this component
 * reading the flag and rendering nothing itself: `MaskingToggle` has no such
 * flag to read, because masking has no off switch, and copying one here would
 * be a rule about *when this control exists* leaking into a component whose
 * only job is *what it looks like once it does*. With no passkey enrolled
 * there is no grant to clear and no screen a credential could satisfy sending
 * the reader to — showing the control anyway would be a button that appears
 * to do something and cannot (this ticket's own reasoning).
 *
 * **A real form posting to {@link LOCK_NOW_ACTION}** — `masking.ts`'s own
 * shape, deliberately: this half can be progressive and must be, because
 * locking has to work in a browser where unlocking cannot (ADR-0012's
 * consequence for the unlock screen does not apply here — nothing about
 * *this* action needs a passkey ceremony). A plain `<Form>`, not a fetcher's:
 * pressing this is meant to navigate the browser on to the unlock screen once
 * the action redirects there, not to refresh data behind a page that is
 * about to stop being readable.
 *
 * **One label, one direction.** "Lock now" states the action, the same rule
 * `MaskingToggle`'s own header states for itself — but with no second label
 * to write or test: a browser rendering this chrome at all is, by
 * definition, not locked, so there is no "unlocked" state left for this
 * control to announce.
 */
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
