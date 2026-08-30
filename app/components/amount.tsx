/**
 * The one component that renders an amount (spec 0007, ADR-0002). Named for
 * the glossary term — CONTEXT.md: an **amount** is any absolute figure (a
 * value, balance, cost basis, gain, share quantity); a **ratio** never is.
 * Every figure in that list comes through here; no percentage does.
 *
 * **One component, not a flag on the formatters**: the guarantee is "no
 * amount is on this screen", only as good as its narrowest point — a bare
 * `formatMoney` in next year's route would leak silently. One component
 * makes the rule structural; with no linter here,
 * `masking-boundary.test.ts` asserts the import boundary instead.
 * **`format.ts` learns nothing about masking**: a display flag threaded
 * through every signature is how its string-in-string-out contract erodes,
 * putting the decision back at each call site — the thing being fixed.
 * {@link Delta} is not a second renderer: it draws arrow and hue and asks
 * {@link Amount} for the figure, so exactly one place turns money to text.
 */
import { ArrowDownIcon, ArrowUpIcon, TrendingFlatIcon } from "~/components/icons";
import { formatMoney, formatSignedMoney, isNegative } from "~/lib/format";
import { formatQuantity } from "~/lib/holdings-view";
import { useMasked } from "~/lib/masking";
import { render, toUnits } from "~/lib/money";

/**
 * What replaces every amount: six dots for twelve dollars and for twelve
 * million — ADR-0002: digit count is magnitude, and magnitude is the thing
 * being masked. Exported because the chart's axis ticks are strings and
 * cannot use this component; a second constant there would be a second
 * thing a reader could learn to read as a different size.
 */
export const MASKED_FIGURE = "••••••";

/**
 * What a masked figure is announced as. The dots are kept from assistive
 * technology and this is said instead — story 6: no run of bullets read
 * out; story 7: masking must mask for a screen reader too. What *kind* of
 * amount it was still comes from the column header. "Hidden" is the spec's
 * own wording and stays, though CONTEXT.md avoids the word for the concept:
 * the glossary governs our vocabulary, not the plainest word for a stranger
 * hearing one cell read out.
 */
const MASKED_ANNOUNCEMENT = "Amount hidden";

/**
 * How an unmasked amount is written.
 *
 * - `money` — a balance, value, cost basis. Negatives marked, positives not.
 * - `signed` — a movement, where the sign is the point: always marked. The
 *   accompanying arrow belongs to {@link Delta}, because the Overview
 *   headline draws a different arrow in a different pill.
 * - `quantity` — a share count. No currency mark: half a fund is half a
 *   share, not fifty cents.
 */
export type AmountShape = "money" | "signed" | "quantity";

/**
 * The sign a signed figure prints with, decided on the figure that will
 * actually be *printed*: the stored value has four decimal places and a
 * cell shows two, so `-0.0040` is a loss by the digits and `$0.00` once
 * rounded — reading the sign unrounded would print `−$••••••` beside what
 * would have read `$0.00`, the "channels disagreeing" failure §12 names.
 */
function printedSign(amount: string): string {
  const shown = render(toUnits(amount, 2), 2);

  if (toUnits(amount, 2) === 0n) return "";
  return isNegative(shown) ? "−" : "+";
}

/**
 * An amount, masked or not — or a dash where there is no amount at all.
 *
 * **The dash survives masking.** A null is not an amount: an unpriced
 * holding is not worthless and a gain with no recorded cost basis is not
 * zero (§8.2). Masking it would replace "nothing is known here" with
 * "something is here you may not see" — a different and false claim. The
 * concession: a masked screen still shows *which* rows are unpriced, and
 * that is not a figure. **A masked figure keeps its currency mark**, so the
 * cell still reads as money; a quantity has no mark to keep.
 *
 * @param value the decimal string to render, or null where there is none.
 * @param shape how it is written. Money by default, which is most of them.
 * @param places decimal places for money. The upload diff shows four,
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
          jumping when toggled (story 8): the dot run is narrower than most
          figures it replaces. */}
      <span className="amount-dots" aria-hidden="true">
        {shape === "signed" ? printedSign(value) : ""}
        {shape === "quantity" ? "" : "$"}
        {MASKED_FIGURE}
      </span>
      {/* Announced rather than spelled: a run of bullet characters is
          meaningless and — story 7 — no quieter than the balance itself. */}
      <span className="visually-hidden">{MASKED_ANNOUNCEMENT}</span>
    </>
  );
}

/**
 * A signed money figure said three ways at once (DESIGN.md §12) — and
 * masked without losing two of them. Classified on the rounded figure, for
 * {@link printedSign}'s reason: classifying unrounded paints a red
 * down-arrow beside an unsigned `$0.00`. Flat is its own case: a position
 * that has not moved, painted green with an up arrow, would say it had.
 * **Masked, the sign and arrow stay; only the size goes** — direction is
 * not magnitude, and dropping it would leave hue alone saying which way the
 * figure points, the one thing §12 forbids (a masked screen still says gain
 * or loss; spec 0007 concedes that deliberately).
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
