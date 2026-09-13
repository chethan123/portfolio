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

export type DeltaDirection = "gain" | "loss" | "flat";

// Sign decided on the rounded figure actually printed, not the stored one — else -0.0040 signs a cell reading $0.00 (§12).
function printedSign(amount: string): string {
  const shown = render(toUnits(amount, 2), 2);

  if (toUnits(amount, 2) === 0n) return "";
  return isNegative(shown) ? "−" : "+";
}

export function deltaDirection(amount: string): DeltaDirection {
  if (toUnits(amount, 2) === 0n) return "flat";
  return printedSign(amount) === "−" ? "loss" : "gain";
}

// Dash survives masking — null isn't an amount (§8.2); masking it would claim "something is here" instead of "nothing is known".
export function Amount({
  value,
  shape = "money",
  places,
  direction,
}: {
  /** `undefined` is a known amount deliberately omitted from this loader response. */
  value: string | null | undefined;
  shape?: AmountShape;
  places?: number;
  direction?: DeltaDirection;
}) {
  const masked = useMasked();

  if (value === null) return <>—</>;

  if (!masked && value !== undefined) {
    if (shape === "quantity") return <>{formatQuantity(value)}</>;
    if (shape === "signed") return <>{formatSignedMoney(value, places)}</>;
    return <>{formatMoney(value, places)}</>;
  }

  return (
    <>
      <span className="amount-dots" aria-hidden="true">
        {shape === "signed"
          ? value === undefined
            ? direction === "loss"
              ? "−"
              : direction === "gain"
                ? "+"
                : ""
            : printedSign(value)
          : ""}
        {shape === "quantity" ? "" : "$"}
        {MASKED_FIGURE}
      </span>
      <span className="visually-hidden">{MASKED_ANNOUNCEMENT}</span>
    </>
  );
}

// Masked, sign and arrow stay — only the size goes (§12); direction isn't magnitude.
export function Delta({
  amount,
  direction,
}: {
  amount: string | undefined;
  direction?: DeltaDirection;
}) {
  const resolved = amount === undefined ? (direction ?? "flat") : deltaDirection(amount);
  const Arrow =
    resolved === "flat" ? TrendingFlatIcon : resolved === "loss" ? ArrowDownIcon : ArrowUpIcon;

  return (
    <span className={`delta delta--bare delta--${resolved}`}>
      <Arrow />
      <Amount value={amount} shape="signed" direction={resolved} />
    </span>
  );
}
