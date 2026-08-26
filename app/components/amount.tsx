/**
 * The one component that renders an amount (spec 0007, ADR-0002).
 *
 * Named for the glossary term. `CONTEXT.md`: an **amount** is any absolute
 * figure — a value, a balance, a cost basis, a gain, a share quantity — and a
 * **ratio** is never one. So every figure in that first list comes through here
 * and every percentage on every screen does not.
 *
 * **Why one component and not a flag on the formatters.** The guarantee this
 * feature makes is "no amount is on this screen", and a guarantee is only as
 * good as its narrowest point: a bare `formatMoney` in a route added next year
 * would leak silently, ship happily, and be noticed by the person it was
 * supposed to protect. Routing every figure through one component makes the
 * rule structural. There is no linter here, so `masking-boundary.test.ts`
 * asserts the import boundary instead — that is what stops this file being one
 * of two ways to render a figure.
 *
 * **`format.ts` learns nothing about masking**, deliberately. It keeps its
 * string-in-string-out contract; a display flag threaded through every
 * signature is exactly how that contract erodes, and it would put the decision
 * back at each call site — which is the thing being fixed.
 *
 * {@link Delta} lives here too and is not a second renderer: it draws the
 * arrow and the hue around a figure and asks {@link Amount} for the figure
 * itself, so there is still exactly one place a money value becomes text.
 */
import { ArrowDownIcon, ArrowUpIcon, TrendingFlatIcon } from "~/components/icons";
import { formatMoney, formatSignedMoney, isNegative } from "~/lib/format";
import { formatQuantity } from "~/lib/holdings-view";
import { useMasked } from "~/lib/masking";
import { render, toUnits } from "~/lib/money";

/**
 * What replaces every amount, whatever it was.
 *
 * Six dots for twelve dollars and for twelve million. ADR-0002 states the rule
 * and the reason: digit count is magnitude, and magnitude is the thing being
 * hidden.
 */
const DOTS = "••••••";

/**
 * What a masked figure is announced as.
 *
 * The dots are hidden from assistive technology and this is said instead —
 * story 6 asks not to have a run of bullets read out, and story 7 asks for
 * masking to actually mask for a screen reader too, so that a person beside
 * them cannot hear the balances. What *kind* of amount it was still comes from
 * the column header, which is untouched.
 */
const HIDDEN = "Amount hidden";

/**
 * How an amount is written when it is not masked.
 *
 * - `money` — a balance, a value, a cost basis. Negatives marked, positives not.
 * - `signed` — a movement, where the sign is the point: always marked. The
 *   arrow that usually accompanies one belongs to {@link Delta}, not here,
 *   because the Overview headline draws a different arrow in a different pill.
 * - `quantity` — a share count. No currency mark: half a fund is half a share,
 *   not fifty cents.
 */
export type AmountShape = "money" | "signed" | "quantity";

/**
 * The sign a signed figure will be printed with, decided on the figure that
 * will actually be *printed* rather than on the one behind it.
 *
 * The stored value has four decimal places and a cell shows two, so a gain of
 * `-0.0040` is a loss by the digits and `$0.00` once rounded — and
 * `formatSignedMoney`'s own guard then suppresses the sign on a zero. Reading
 * the sign off the unrounded value would print `−$••••••` next to a figure that
 * would have read `$0.00`, which is the same "channels disagreeing" failure
 * §12 names.
 */
function printedSign(amount: string): string {
  const shown = render(toUnits(amount, 2), 2);

  if (toUnits(amount, 2) === 0n) return "";
  return isNegative(shown) ? "−" : "+";
}

/**
 * An amount, masked or not — or a dash where there is no amount at all.
 *
 * **The dash survives masking.** A null is not an amount: an unpriced holding
 * is not a worthless one and a gain nobody recorded a cost basis for is not a
 * gain of zero, which is why the dash exists in the first place (§8.2). Masking
 * it would replace "nothing is known here" with "something is here and you may
 * not see it", which is a different and false claim. What it concedes is that a
 * masked screen still shows *which* rows are unpriced, and that is not a figure.
 *
 * **A masked figure keeps its currency mark**, so the cell still reads as
 * money — a column of bare dots says nothing about what it was a column of.
 * A quantity has no mark to keep.
 *
 * @param value the decimal string to render, or null where there is none.
 * @param shape how it is written. Money by default, which is most of them.
 * @param places decimal places for a money figure. The upload diff shows four,
 *        because a statement's own prices carry them.
 */
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
      {/* `.amount-dots` carries the minimum width that keeps a column from
          jumping when it is toggled (story 8): the dot run is a constant and is
          narrower than most figures it replaces, so without it every numeric
          column would visibly narrow mid-row. */}
      <span className="amount-dots" aria-hidden="true">
        {shape === "signed" ? printedSign(value) : ""}
        {shape === "quantity" ? "" : "$"}
        {DOTS}
      </span>
      {/* Announced rather than spelled. Without this the row reads as a run of
          bullet characters, which is both meaningless and — story 7 — no
          quieter than reading the balance out. */}
      <span className="visually-hidden">{HIDDEN}</span>
    </>
  );
}

/**
 * A signed money figure, said three ways at once (DESIGN.md §12) — and masked
 * without losing two of them.
 *
 * A gain, a loss or neither, classified on the rounded figure for the reason
 * {@link printedSign} gives: classifying before rounding paints a red
 * down-arrow beside an unsigned `$0.00`, leaving the arrow and the hue carrying
 * a claim the text does not make.
 *
 * Flat is its own case rather than being folded into gain: a position that has
 * not moved painted green with an up arrow would say it had.
 *
 * **Masked, the sign and the arrow stay and only the size goes.** Direction is
 * not magnitude, and dropping it would leave the hue alone to say which way the
 * figure points — the one thing §12 forbids. The concession is that a masked
 * screen still says gain or loss, and spec 0007 makes it deliberately.
 */
export function Delta({ amount }: { amount: string }) {
  const flat = toUnits(amount, 2) === 0n;
  const down = !flat && printedSign(amount) === "−";
  const Arrow = flat ? TrendingFlatIcon : down ? ArrowDownIcon : ArrowUpIcon;

  return (
    // Sign, then arrow, then hue — readable with no colour perception at all
    // (§12). `--bare` because a tinted pill on every row is noise.
    <span
      className={`delta delta--bare ${flat ? "delta--flat" : down ? "delta--loss" : "delta--gain"}`}
    >
      <Arrow />
      <Amount value={amount} shape="signed" />
    </span>
  );
}
