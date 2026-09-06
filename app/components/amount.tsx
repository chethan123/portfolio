// The one component that renders an amount (spec 0007, ADR-0002); `format.ts` never learns about masking (`masking-boundary.test.ts` enforces the boundary).
import { ArrowDownIcon, ArrowUpIcon, TrendingFlatIcon } from "~/components/icons";
import { formatMoney, formatSignedMoney, isNegative } from "~/lib/format";
import { formatQuantity } from "~/lib/holdings-view";
import { useMasked } from "~/lib/masking";
import { render, toUnits } from "~/lib/money";

// Six dots for twelve dollars and for twelve million (ADR-0002) — exported for the chart axis, which can't use this component.
export const MASKED_FIGURE = "••••••";

const MASKED_ANNOUNCEMENT = "Amount hidden";

export type AmountShape = "money" | "signed" | "quantity";

// Sign decided on the rounded figure actually printed, not the stored one — else -0.0040 signs a cell reading $0.00 (§12).
function printedSign(amount: string): string {
  const shown = render(toUnits(amount, 2), 2);

  if (toUnits(amount, 2) === 0n) return "";
  return isNegative(shown) ? "−" : "+";
}

// Dash survives masking — null isn't an amount (§8.2); masking it would claim "something is here" instead of "nothing is known".
export function Amount({
  value,
  shape = "money",
  places,
}: {
  value: string | null;
  shape?: AmountShape;
  places?: number;
}) {
  const masked = useMasked();

  if (value === null) return <>—</>;

  if (!masked) {
    if (shape === "quantity") return <>{formatQuantity(value)}</>;
    if (shape === "signed") return <>{formatSignedMoney(value, places)}</>;
    return <>{formatMoney(value, places)}</>;
  }

  return (
    <>
      <span className="amount-dots" aria-hidden="true">
        {shape === "signed" ? printedSign(value) : ""}
        {shape === "quantity" ? "" : "$"}
        {MASKED_FIGURE}
      </span>
      <span className="visually-hidden">{MASKED_ANNOUNCEMENT}</span>
    </>
  );
}

// Masked, sign and arrow stay — only the size goes (§12); direction isn't magnitude.
export function Delta({ amount }: { amount: string }) {
  const flat = toUnits(amount, 2) === 0n;
  const down = !flat && printedSign(amount) === "−";
  const Arrow = flat ? TrendingFlatIcon : down ? ArrowDownIcon : ArrowUpIcon;

  return (
    <span
      className={`delta delta--bare ${flat ? "delta--flat" : down ? "delta--loss" : "delta--gain"}`}
    >
      <Arrow />
      <Amount value={amount} shape="signed" />
    </span>
  );
}
