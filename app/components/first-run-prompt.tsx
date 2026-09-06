import { Link } from "react-router";

import type { FirstRunStep } from "~/lib/first-run.server";

// One first-run prompt (DESIGN.md §8.4), not one per empty dashboard. Not dismissible — doing what it asks is what removes it.
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
