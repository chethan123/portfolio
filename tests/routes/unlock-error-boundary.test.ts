// unlock.tsx's action rethrows anything but a ValidationError instead of reporting it as a passkey refusal (ticket 04 review, finding 10).
// lock.server is mocked to provoke that non-ValidationError failure without touching the real DB; kept in its own file since vi.mock is file-wide.
import { describe, expect, it, vi } from "vitest";

import { args, post } from "../support/routes.ts";

vi.mock("~/lib/lock.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/lock.server")>();
  return {
    ...actual,
    verifyUnlock: vi.fn().mockRejectedValue(new Error("connection refused")),
  };
});

const { action } = await import("../../app/routes/unlock.tsx");

describe("the action's own catch", () => {
  it("rethrows a failure that is not a ValidationError, rather than reporting it as a passkey refusal", async () => {
    await expect(
      action(args(post("/unlock", { assertion: JSON.stringify({}), redirectTo: "/" }))),
    ).rejects.toThrow("connection refused");
  });
});
