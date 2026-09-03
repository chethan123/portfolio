/**
 * The one thing about `OwnerFilterControl`'s markup that is not decoration:
 * field order. A GET form submits its fields in DOM order, and this
 * application's canonical address spells the owner parameter first
 * (`canonicalOwnerSearch` in `owner-filter.ts`) — so the checkboxes have to
 * render ahead of the hidden fields, or every Apply on a screen carrying
 * hidden state (a `range`, a `sort`) would submit `range=1y&owner=1&owner=3`
 * and pay a respelling bounce it does not need to. No test rendered this
 * component at all before this one.
 */
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
