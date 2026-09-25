// The risk: the refusal paragraph's markup — the class the stylesheet selects, `role="alert"`, and
// the `id` an input's `aria-describedby` names — asserted here once, whole, for every form.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FieldError, FormError } from "../app/components/error-message.tsx";

describe("a refusal paragraph", () => {
  it("carries the id an input's aria-describedby names, before its class and role", () => {
    expect(
      renderToStaticMarkup(
        <FieldError id="capital-gains-rate-error" message="A capital gains rate must be a number." />,
      ),
    ).toBe(
      '<p id="capital-gains-rate-error" class="field-error" role="alert">A capital gains rate must be a number.</p>',
    );
  });

  it("draws a field refusal without an id attribute when the input names none", () => {
    expect(renderToStaticMarkup(<FieldError message="Name is required." />)).toBe(
      '<p class="field-error" role="alert">Name is required.</p>',
    );
  });

  it("draws a form-level refusal in the form-error paragraph", () => {
    expect(renderToStaticMarkup(<FormError message="Nothing was recorded." />)).toBe(
      '<p class="form-error" role="alert">Nothing was recorded.</p>',
    );
  });

  it("draws nothing when there is no message", () => {
    for (const message of [null, undefined, ""]) {
      expect(renderToStaticMarkup(<FieldError message={message} />)).toBe("");
      expect(renderToStaticMarkup(<FormError message={message} />)).toBe("");
    }
  });
});
