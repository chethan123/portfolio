// The one component that renders an amount (spec 0007, ADR-0002); `format.ts` never learns about masking (`masking-boundary.test.ts` enforces the boundary).
import { ArrowDownIcon, ArrowUpIcon, TrendingFlatIcon } from "~/components/icons";
import { formatMoney, formatQuantity, formatSignedMoney } from "~/lib/format";
import { useMasked } from "~/lib/masking";
import { deltaDirection, type DeltaDirection } from "~/lib/money";

// Six dots for twelve dollars and for twelve million (ADR-0002) — exported for the chart axis, which can't use this component.
export const MASKED_FIGURE = "••••••";

const MASKED_ANNOUNCEMENT = "Amount hidden";

export type AmountShape = "money" | "signed" | "quantity";

function MaskedAmount({
  shape,
  direction,
}: {
  shape: AmountShape;
  direction?: DeltaDirection;
}) {
  return (
    <>
      <span className="amount-dots" aria-hidden="true">
        {shape === "signed" ? (direction === "loss" ? "−" : direction === "gain" ? "+" : "") : ""}
        {shape === "quantity" ? "" : "$"}
        {MASKED_FIGURE}
      </span>
      <span className="visually-hidden">{MASKED_ANNOUNCEMENT}</span>
    </>
  );
}

/** A known amount deliberately omitted from one loader response. */
export function OmittedAmount({
  shape = "money",
  direction,
}: {
  shape?: AmountShape;
  direction?: DeltaDirection;
}) {
  return <MaskedAmount shape={shape} direction={direction} />;
}

// Dash survives masking — null isn't an amount (§8.2); masking it would claim "something is here" instead of "nothing is known".
export function Amount({
  value,
  shape = "money",
  places,
  preservePlaces = false,
}: {
  value: string | null;
  shape?: AmountShape;
  places?: number;
  preservePlaces?: boolean;
}) {
  const masked = useMasked();

  if (value === null) return <>—</>;

  if (!masked) {
    if (shape === "quantity") return <>{formatQuantity(value, preservePlaces)}</>;
    if (shape === "signed") return <>{formatSignedMoney(value, places)}</>;
    return <>{formatMoney(value, places)}</>;
  }

  return (
    <MaskedAmount
      shape={shape}
      direction={shape === "signed" ? deltaDirection(value, places) : undefined}
    />
  );
}

// Masked, sign and arrow stay — only the size goes (§12); direction isn't magnitude.
export function Delta({
  amount,
}: {
  amount: string;
}) {
  const resolved = deltaDirection(amount);
  const Arrow =
    resolved === "flat" ? TrendingFlatIcon : resolved === "loss" ? ArrowDownIcon : ArrowUpIcon;

  return (
    <span className={`delta delta--bare delta--${resolved}`}>
      <Arrow />
      <Amount value={amount} shape="signed" />
    </span>
  );
}

/** A delta deliberately omitted from one loader response; its direction remains non-sensitive. */
export function OmittedDelta({ direction }: { direction: DeltaDirection }) {
  const Arrow =
    direction === "flat" ? TrendingFlatIcon : direction === "loss" ? ArrowDownIcon : ArrowUpIcon;

  return (
    <span className={`delta delta--bare delta--${direction}`}>
      <Arrow />
      <OmittedAmount shape="signed" direction={direction} />
    </span>
  );
}
