import { EmptyState } from "~/components/empty-state";

/**
 * Income — dividend and interest income over time.
 *
 * Unconditionally empty in this slice, and honestly so: nothing records income
 * yet. `quote` carries a yield and an annual dividend per share, but no slice
 * has filled them, and deriving a figure from columns nobody has written would
 * put an invented number on a finance page.
 *
 * There is no loader for the same reason — a query whose answer is known to be
 * "nothing" is a round trip that buys a page nothing.
 */
export function meta() {
  return [{ title: "Income · Portfolio" }];
}

export default function Income() {
  return (
    <section className="page">
      <h1>Income</h1>

      <EmptyState>
        Dividend and interest income over time will appear here. Nothing records income yet —
        the pricing slice is what starts collecting it.
      </EmptyState>
    </section>
  );
}
