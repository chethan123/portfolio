import { describe, expect, it } from "vitest";

import { Amount } from "~/components/amount";

import { renderRoute } from "./support/render.tsx";

function PreciseSignedAmount() {
  return <Amount value="-0.0040" shape="signed" places={4} />;
}

describe("Amount", () => {
  it("keeps the sign of the figure rendered at the requested precision while masked", () => {
    const shown = renderRoute(PreciseSignedAmount, "/", {}, { masked: false });
    const masked = renderRoute(PreciseSignedAmount, "/", {}, { masked: true });

    expect(shown.replaceAll("<!-- -->", "")).toContain("−$0.0040");
    expect(masked.replaceAll("<!-- -->", "")).toContain("−$••••••");
  });
});
