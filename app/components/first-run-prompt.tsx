import { Link } from "react-router";

import type { FirstRunStep } from "~/lib/first-run.server";

/**
 * The one first-run prompt (DESIGN.md §8.4) — one, not one per empty
 * dashboard: three pages each explaining emptiness read as three problems
 * rather than one setup step. Names the next step only (People, then
 * Accounts — an account cannot precede its owner) and disappears once both
 * exist. Not dismissible: doing what it asks is what removes it, and a
 * dismissed prompt leaves a permanently unusable instance looking finished.
 * Each step is one paragraph — the card is a flex row, so text either side
 * of a link would become its own item with the row's gap opened between.
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
