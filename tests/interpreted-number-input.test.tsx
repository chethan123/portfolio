import { describe, expect, it } from "vitest";

import { InterpretedNumberInput } from "~/components/interpreted-number-input";

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
      shape={shape}
    />
  );
}

const render = (value: string, shape: "money" | "quantity" | "percentage", masked = false) =>
  renderRoute(() => <Preview value={value} shape={shape} />, "/", {}, { masked });

describe("the interpreted-number note", () => {
  it("server-renders the complete interpretation rule without a stale exact echo", () => {
    const money = render("$1,234.5600", "money");
    const quantity = render("−12 345.67000000", "quantity");

    expect(money).toContain("1,234.56 is read as 1234.56");
    expect(quantity).toContain("1,234.56 is read as 1234.56");
    expect(money).not.toContain("Number format reads as");
    expect(quantity).not.toContain("Number format reads as");
  });

  it("does not claim an initial malformed value was interpreted before hydration", () => {
    const markup = render("1,5", "money");

    expect(markup).toContain("1,234.56 is read as 1234.56");
    expect(markup).not.toContain("This number format is ambiguous or invalid.");
    expect(markup).not.toContain("Number format reads as");
  });

  it("emits no extra amount or ratio in masked server markup before the live preview exists", () => {
    const money = render("$92.4150", "money", true);
    const rate = render("23.800000%", "percentage", true);

    expect(money.match(/92\.4150/g)).toHaveLength(1);
    expect(rate.match(/23\.800000/g)).toHaveLength(1);
    expect(money).not.toContain("Amount hidden");
    expect(money).not.toContain("••••••");
    expect(rate).not.toContain("Number format reads as");
  });
});
