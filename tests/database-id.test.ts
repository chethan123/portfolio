// compareIds orders bigint ids as text. Wrong, it is an owner URL that never reaches its fixed point,
// and a lock order that can deadlock (spec 0023, "The commit").
import { describe, expect, it } from "vitest";

import { compareIds } from "../app/lib/database-id.ts";

describe("compareIds", () => {
  it("orders ids of differing lengths numerically, not lexicographically", () => {
    expect(compareIds("9", "10")).toBeLessThan(0);
    expect(compareIds("10", "100")).toBeLessThan(0);
    expect(compareIds("100", "9")).toBeGreaterThan(0);
    expect(["10", "9"].sort(compareIds)).toEqual(["9", "10"]);
    expect(["100", "9", "10"].sort(compareIds)).toEqual(["9", "10", "100"]);
  });

  it("reads equal ids as equal", () => {
    expect(compareIds("42", "42")).toBe(0);
  });

  it("tells apart ids past 2^53, where Number() reads them as one", () => {
    expect(compareIds("9007199254740993", "9007199254740992")).toBeGreaterThan(0);
  });
});
