/** A GET form submits fields in DOM order, and the canonical address spells owner first — so
 * checkboxes must render ahead of hidden fields, or every Apply pays a respelling bounce. */
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { describe, expect, it } from "vitest";

import { OwnerFilterControl } from "../app/components/owner-filter-control.tsx";

describe("<OwnerFilterControl>", () => {
  it("renders the owner checkboxes before the hidden fields, so a submission spells owner first", () => {
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: () => (
          <OwnerFilterControl
            owners={[
              { id: "1", name: "Alice" },
              { id: "3", name: "Bob" },
            ]}
            selected={["1", "3"]}
            hidden={{ range: "1y" }}
          />
        ),
      },
    ]);

    const markup = renderToStaticMarkup(<Stub initialEntries={["/"]} />);

    const firstOwnerField = markup.indexOf('name="owner"');
    const hiddenField = markup.indexOf('name="range"');

    expect(firstOwnerField).toBeGreaterThan(-1);
    expect(hiddenField).toBeGreaterThan(-1);
    expect(firstOwnerField).toBeLessThan(hiddenField);
  });
});
