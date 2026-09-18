import { afterAll, describe, expect, it } from "vitest";

import Tax, { action, loader } from "../../app/routes/settings/tax.tsx";

import { TEST_DATABASE_URL, closeTestDatabase, withDatabase } from "../support/database.ts";
import { renderRoute } from "../support/render.tsx";
import { args, post } from "../support/routes.ts";

process.env.DATABASE_URL = TEST_DATABASE_URL;

afterAll(closeTestDatabase);

describe("a refused capital gains rate without JavaScript", () => {
  it(
    "links the returned field error to the invalid rate input",
    withDatabase(async () => {
      const path = "/settings/tax";
      const refused = await action(args(post(path, { capitalGainsRate: "1,5" })));
      const markup = renderRoute(Tax, path, await loader(), { actionData: refused });

      expect(markup).toContain(
        '<p id="capital-gains-rate-error" class="field-error" role="alert">',
      );
      expect(markup).toMatch(
        /<input(?=[^>]*id="capital-gains-rate")(?=[^>]*aria-describedby="[^"]*capital-gains-rate-error[^"]*")(?=[^>]*aria-invalid="true")[^>]*>/,
      );
    }),
  );
});
