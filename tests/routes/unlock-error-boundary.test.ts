/**
 * `app/routes/unlock.tsx`'s action treats only a `ValidationError` as a
 * printable refusal; everything else it rethrows for the framework's own
 * error page, rather than folding it into "This passkey could not be
 * verified" — the worst of the mutations a scratch copy of this route let
 * through unnoticed (ticket 04's review, finding 10): a database outage
 * reported to the family as a passkey problem, and nothing failing loud
 * enough for anyone to notice.
 *
 * `~/lib/lock.server` is mocked so this file can provoke that exact
 * non-`ValidationError` failure without breaking the real database — the one
 * behaviour under test is the route's own `catch`, not anything
 * `verifyUnlock` itself refuses (that belongs to `tests/lock.test.ts`).
 * Kept in its own file, rather than folded into `tests/routes/unlock.test.ts`,
 * because `vi.mock` applies to every test in a file and the rest of that
 * suite needs the real domain module against the real test database.
 */
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
