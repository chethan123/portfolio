import { EmptyState } from "~/components/empty-state";
import { currentHoldings } from "~/lib/valuation.server";

import type { Route } from "./+types/overview";

/**
 * Overview — net worth, the trend line and the allocation breakdown.
 *
 * None of that is built here; the dashboards slice builds it. What this slice
 * owes the page is the empty case, and specifically that the empty case shows
 * no figure: a net worth of zero and an instance nothing has been uploaded to
 * look identical on screen, and only one of them is worth panicking about.
 *
 * The count comes from the shared query module rather than a `count(*)` written
 * here — "what is currently held" has exactly one definition (DESIGN.md §8.2),
 * and a page that counts holdings its own way has already left it.
 */
export function meta() {
  return [{ title: "Overview · Portfolio" }];
}

export async function loader() {
  const holdings = await currentHoldings();

  return {
    holdingCount: holdings.length,
    accountCount: new Set(holdings.map((holding) => holding.accountId)).size,
  };
}

export default function Overview({ loaderData }: Route.ComponentProps) {
  const { holdingCount, accountCount } = loaderData;

  return (
    <section className="page">
      <h1>Overview</h1>

      {holdingCount === 0 ? (
        <EmptyState>
          Net worth, the trend line and the allocation breakdown appear here once a statement
          has been uploaded. Nothing has been uploaded to this instance yet.
        </EmptyState>
      ) : (
        <p className="page-lede">
          {holdingCount} holding{holdingCount === 1 ? "" : "s"} across {accountCount} account
          {accountCount === 1 ? "" : "s"} are recorded. Net worth, the trend line and the
          allocation breakdown are built in the dashboards slice.
        </p>
      )}
    </section>
  );
}
