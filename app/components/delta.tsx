import { ArrowDownIcon, ArrowUpIcon, TrendingFlatIcon } from "~/components/icons";
import { formatSignedMoney, isNegative } from "~/lib/format";
import { render, toUnits } from "~/lib/money";

/**
 * A signed money figure, said three ways at once (DESIGN.md §12).
 *
 * Lifted out of the Holdings table when the Analysis screen grew an unrealized
 * gains column: two tables printing a gain is two chances for one of them to
 * decide that a rounded-away loss is a gain, and the rule below is subtle
 * enough that the second copy would have been the one that got it wrong.
 *
 * A gain, a loss or neither — decided on the figure that will be *printed*, not
 * on the one behind it.
 *
 * The stored value has four decimal places and the cell shows two, so an
 * unrealized gain of `-0.0040` is a loss by the digits and `$0.00` by the time
 * `formatSignedMoney` has rounded it — whose own guard then suppresses the sign
 * on a zero. Classifying before rounding therefore paints a red down-arrow
 * beside an unsigned `$0.00`, which leaves the arrow and the hue carrying a
 * claim the text does not make: exactly the "never colour alone" rule §12
 * states. Rounding first, through the same half-away-from-zero the formatter
 * uses, keeps the three channels saying one thing.
 *
 * Flat is its own case rather than being folded into gain: a position that has
 * not moved painted green with an up arrow would say it had.
 */
export function Delta({ amount }: { amount: string }) {
  const shown = render(toUnits(amount, 2), 2);
  const flat = toUnits(amount, 2) === 0n;
  const down = !flat && isNegative(shown);
  const Arrow = flat ? TrendingFlatIcon : down ? ArrowDownIcon : ArrowUpIcon;

  return (
    // Sign, then arrow, then hue — readable with no colour perception at all
    // (§12). `--bare` because a tinted pill on every row is noise.
    <span
      className={`delta delta--bare ${flat ? "delta--flat" : down ? "delta--loss" : "delta--gain"}`}
    >
      <Arrow />
      {formatSignedMoney(amount)}
    </span>
  );
}
