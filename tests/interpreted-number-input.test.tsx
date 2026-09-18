import { describe, expect, it } from "vitest";

import { InterpretedNumberInput } from "~/components/interpreted-number-input";
import {
  moneyMagnitudeRule,
  parseDecimalInput,
  perShareAmountRule,
  percentRateRule,
  signedQuantityRule,
} from "~/lib/decimal-input";

import { renderRoute } from "./support/render.tsx";

function Preview({
  value,
  shape,
}: {
  value: string;
  shape: "money" | "quantity" | "percentage";
}) {
  return (
    <InterpretedNumberInput
      name="figure"
      defaultValue={value}
      noteId="figure-note"
      rule={
        shape === "money"
          ? moneyMagnitudeRule("A balance")
          : shape === "quantity"
            ? signedQuantityRule("A quantity")
            : percentRateRule("A capital gains rate")
      }
      shape={shape}
    />
  );
}

const render = (value: string, shape: "money" | "quantity" | "percentage", masked = false) =>
  renderRoute(() => <Preview value={value} shape={shape} />, "/", {}, { masked });

describe("the interpreted-number note", () => {
  it("does not present contextual correction candidates as accepted", () => {
    expect(parseDecimalInput("1.234", signedQuantityRule("A quantity").options)).toEqual({
      kind: "decimal",
      value: "1.234",
    });
    expect(parseDecimalInput("-5", signedQuantityRule("A quantity").options)).toEqual({
      kind: "decimal",
      value: "-5",
    });
  });

  it.each([
    ["balance sign", "-5", moneyMagnitudeRule("A balance"), "sign"],
    ["balance size", "1234567890123", moneyMagnitudeRule("A balance"), "size"],
    ["cost basis scale", "92.41599", perShareAmountRule("A cost basis"), "scale"],
    ["rate range", "150", percentRateRule("A capital gains rate"), "range"],
  ] as const)("refuses %s before it can be presented as interpreted", (_case, typed, rule, reason) => {
    expect(parseDecimalInput(typed, rule.options)).toEqual({ kind: "invalid", reason });
  });

  it("keeps signed quantities valid in the preview rule", () => {
    expect(parseDecimalInput("−1,234.5", signedQuantityRule("A quantity").options)).toEqual({
      kind: "decimal",
      value: "-1234.5",
    });
  });

  it("server-renders the complete interpretation rule without a stale exact echo", () => {
    const money = render("$1,234.5600", "money");
    const quantity = render("−12 345.67000000", "quantity");

    expect(money).toContain("1,234.56 is read as 1234.56");
    expect(quantity).toContain("1,234.56 is read as 1234.56");
    expect(money).not.toContain("Punctuation reads as");
    expect(quantity).not.toContain("Punctuation reads as");
  });

  it("does not claim an initial malformed value was interpreted before hydration", () => {
    const markup = render("1,5", "money");

    expect(markup).toContain("1,234.56 is read as 1234.56");
    expect(markup).not.toContain(moneyMagnitudeRule("A balance").message("grouping"));
    expect(markup).not.toContain("Punctuation reads as");
  });

  it("emits no extra amount or ratio in masked server markup before the live preview exists", () => {
    const money = render("$92.4150", "money", true);
    const rate = render("23.800000%", "percentage", true);

    expect(money.match(/92\.4150/g)).toHaveLength(1);
    expect(rate.match(/23\.800000/g)).toHaveLength(1);
    expect(money).not.toContain("Amount hidden");
    expect(money).not.toContain("••••••");
    expect(rate).not.toContain("Punctuation reads as");
  });
});
