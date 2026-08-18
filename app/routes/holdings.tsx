import { EmptyState } from "~/components/empty-state";
import { currentHoldings } from "~/lib/valuation.server";

import type { Route } from "./+types/holdings";

/**
 * Holdings — every position across every account, grouped and filterable.
 *
 * The table is the dashboards slice's. This is the empty case and the count,
 * both read through the shared query module so that this page and Overview
 * cannot disagree about what is currently held (DESIGN.md §8.2).
 */
export function meta() {
  return [{ title: "Holdings · Portfolio" }];
}

export async function loader() {
  const holdings = await currentHoldings();

  return {
    holdingCount: holdings.length,
    accountCount: new Set(holdings.map((holding) => holding.accountId)).size,
  };
}

export default function Holdings({ loaderData }: Route.ComponentProps) {
  const { holdingCount, accountCount } = loaderData;

  return (
    <section className="page">
      <h1>Holdings</h1>

      {holdingCount === 0 ? (
        <EmptyState>
          Every position across every account will be listed here, grouped and filterable.
          Nothing has been uploaded to this instance yet.
        </EmptyState>
      ) : (
        <p className="page-lede">
          {holdingCount} holding{holdingCount === 1 ? "" : "s"} across {accountCount} account
          {accountCount === 1 ? "" : "s"} are recorded. The grouped, filterable table is built
          in the dashboards slice.
        </p>
      )}
    </section>
  );
}
