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
 *
 * Each step is one paragraph. The card is a flex row, so the sentence has to be
 * a single element or its text either side of the link becomes an item of its
 * own with the row's gap opened between them.
 */
export function FirstRunPrompt({ step }: { step: Exclude<FirstRunStep, null> }) {
  return (
    <aside className="first-run" role="status">
      {step === "people" ? (
        <p>
          <strong>Start here.</strong> Nothing is recorded yet. Add the people in your household
          under <Link to="/settings/people">Settings → People</Link> — every account belongs to
          exactly one of them.
        </p>
      ) : (
        <p>
          <strong>One more step.</strong> Now add the accounts the household holds under{" "}
          <Link to="/settings/accounts">Settings → Accounts</Link> — a brokerage, a workplace
          plan, a bank account or a loan. That is where an uploaded statement lands.
        </p>
      )}
    </aside>
  );
}
