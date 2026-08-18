import { Link } from "react-router";

import type { FirstRunStep } from "~/lib/first-run.server";

/**
 * The one first-run prompt (DESIGN.md §8.4).
 *
 * One prompt, not one per empty dashboard: three pages each explaining that the
 * instance is empty would read as three problems rather than one setup step.
 * It names the next step only — People, then Accounts — because an account
 * cannot be created before an owner exists, and it disappears on its own once
 * both are recorded.
 *
 * It is not dismissible. There is nothing to dismiss: doing the thing it asks
 * for is what removes it, and a dismissed prompt would leave a permanently
 * unusable instance looking finished.
 */
export function FirstRunPrompt({ step }: { step: Exclude<FirstRunStep, null> }) {
  return (
    <aside className="first-run" role="status">
      {step === "people" ? (
        <>
          <strong>Start here.</strong> Nothing is recorded yet. Add the people in your household
          under <Link to="/settings/people">Settings → People</Link> — every account belongs to
          exactly one of them.
        </>
      ) : (
        <>
          <strong>One more step.</strong> Now add the accounts the household holds under{" "}
          <Link to="/settings/accounts">Settings → Accounts</Link> — a brokerage, a workplace
          plan, a bank account or a loan. That is where an uploaded statement lands.
        </>
      )}
    </aside>
  );
}
