/**
 * The review form's binding verify (spec 0028): whether a posted commit still matches the fresh
 * diff drawn under its locks. Pure — no database. At risk is the reason order (rerouted beats a
 * stale revision; a reproduced date beats a bare mismatch, but only when one was actually asked
 * for) and the "" vs null wire form (#181), shared by the baseline and the watermark.
 */
import { describe, expect, it } from "vitest";

import { dateToReproduce, sectionKey, verifyBinding } from "~/lib/review-form";
import type { FreshBinding } from "~/lib/review-form";
import type { AccountDiff, CommitInput } from "~/lib/uploads.server";

type Section = Pick<AccountDiff, "accountId" | "accountName" | "baselineSetId" | "appendWatermark">;

function section(
  id: string,
  name: string,
  fields: { baselineSetId?: string | null; appendWatermark?: string | null } = {},
): Section {
  return {
    accountId: id,
    accountName: name,
    baselineSetId: fields.baselineSetId ?? null,
    appendWatermark: fields.appendWatermark ?? null,
  };
}

function fresh({
  accountId = null,
  revision,
  sections,
  locked,
  reproduced = null,
}: {
  accountId?: string | null;
  revision: string | null;
  sections: readonly Section[];
  locked: readonly string[];
  reproduced?: string | null;
}): FreshBinding {
  return { diff: { accountId, reviewRevision: revision, accounts: sections }, locked, reproduced };
}

describe("verifyBinding", () => {
  describe("the revision gate", () => {
    const locked = ["acc-1"];
    const sections = [section("acc-1", "Acc One")];

    it.each<[string, string | undefined, string | null, boolean]>([
      ["equal revisions match", "v5.aaa", "v5.aaa", true],
      ["a missing posted revision does not match", undefined, "v5.aaa", false],
      ["a null fresh revision does not match", "v5.aaa", null, false],
      ["two different revisions do not match", "v5.aaa", "v5.bbb", false],
      ["a differing prefix is not a match", "v5.abc", "v6.abc", false],
    ])("%s", (_name, postedRevision, freshRevision, matches) => {
      const verdict = verifyBinding(
        { accountId: "acc-1", reviewRevision: postedRevision },
        fresh({ accountId: "acc-1", revision: freshRevision, sections, locked }),
      );

      expect(verdict).toEqual(
        matches
          ? { ok: true, voided: new Set() }
          : { ok: false, reason: "revision_changed", moved: [] },
      );
    });
  });

  describe("rerouted", () => {
    it("names two sections outside the lock, in section order", () => {
      const verdict = verifyBinding(
        { reviewRevision: "v5.aaa" },
        fresh({
          accountId: null,
          revision: "v5.aaa",
          sections: [
            section("acc-1", "Acc One"),
            section("acc-2", "Acc Two"),
            section("acc-3", "Acc Three"),
          ],
          locked: ["acc-2"],
        }),
      );

      expect(verdict).toEqual({ ok: false, reason: "rerouted", moved: ["Acc One", "Acc Three"] });
    });

    it("wins over a differing revision whose reviewed date would reproduce", () => {
      const sections = [section("acc-1", "Acc One")];
      const verdict = verifyBinding(
        { reviewRevision: "v5.old", asOf: "2026-01-01", reviewedAsOf: "2026-02-01" },
        fresh({
          accountId: "acc-1",
          revision: "v5.new",
          sections,
          locked: [],
          reproduced: "v5.old",
        }),
      );

      expect(verdict).toEqual({ ok: false, reason: "rerouted", moved: ["Acc One"] });
    });
  });

  describe("the reviewed date", () => {
    const sections = [section("acc-1", "Acc One")];
    const locked = ["acc-1"];

    it("reads as a date change when the reviewed date reproduces the posted revision", () => {
      const verdict = verifyBinding(
        { reviewRevision: "v5.old", asOf: "2026-01-01", reviewedAsOf: "2026-02-01" },
        fresh({ accountId: "acc-1", revision: "v5.new", sections, locked, reproduced: "v5.old" }),
      );

      expect(verdict).toEqual({ ok: false, reason: "date_changed", moved: [] });
    });

    it.each<[string, Partial<CommitInput>, string | null]>([
      [
        "the reproduction does not match the posted revision",
        { asOf: "2026-01-01", reviewedAsOf: "2026-02-01" },
        "v5.other",
      ],
      ["reviewedAsOf is missing", { asOf: "2026-01-01" }, null],
      ["asOf is missing", { reviewedAsOf: "2026-02-01" }, null],
    ])("falls back to revision_changed when %s", (_name, extra, reproduced) => {
      const verdict = verifyBinding(
        { reviewRevision: "v5.old", ...extra },
        fresh({ accountId: "acc-1", revision: "v5.new", sections, locked, reproduced }),
      );

      expect(verdict).toEqual({ ok: false, reason: "revision_changed", moved: [] });
    });

    it("never reads a missing posted revision as reproduced by a null reproduction", () => {
      const verdict = verifyBinding(
        { asOf: "2026-01-01", reviewedAsOf: "2026-02-01" },
        fresh({ accountId: "acc-1", revision: "v5.new", sections, locked, reproduced: null }),
      );

      expect(verdict).toEqual({ ok: false, reason: "revision_changed", moved: [] });
    });

    it("ignores a reproduction nobody asked for, when the dates already match", () => {
      const verdict = verifyBinding(
        { reviewRevision: "v5.old", asOf: "2026-01-01", reviewedAsOf: "2026-01-01" },
        fresh({ accountId: "acc-1", revision: "v5.new", sections, locked, reproduced: "v5.old" }),
      );

      expect(verdict).toEqual({ ok: false, reason: "revision_changed", moved: [] });
    });
  });

  describe("the watermark names, several accounts", () => {
    it("names the one section whose posted watermark differs", () => {
      const sections = [
        section("acc-1", "Acc One", { appendWatermark: "w1" }),
        section("acc-2", "Acc Two", { appendWatermark: "w2" }),
      ];
      const verdict = verifyBinding(
        {
          reviewRevision: "v5.old",
          [sectionKey("appendWatermark", "acc-1")]: "different",
          [sectionKey("appendWatermark", "acc-2")]: "w2",
        },
        fresh({ accountId: null, revision: "v5.new", sections, locked: ["acc-1", "acc-2"] }),
      );

      expect(verdict).toEqual({ ok: false, reason: "revision_changed", moved: ["Acc One"] });
    });

    it("names both sections whose posted watermark differs, in section order", () => {
      const sections = [
        section("acc-1", "Acc One", { appendWatermark: "w1" }),
        section("acc-2", "Acc Two", { appendWatermark: "w2" }),
      ];
      const verdict = verifyBinding(
        {
          reviewRevision: "v5.old",
          [sectionKey("appendWatermark", "acc-1")]: "different",
          [sectionKey("appendWatermark", "acc-2")]: "also different",
        },
        fresh({ accountId: null, revision: "v5.new", sections, locked: ["acc-1", "acc-2"] }),
      );

      expect(verdict).toEqual({
        ok: false,
        reason: "revision_changed",
        moved: ["Acc One", "Acc Two"],
      });
    });

    it("does not name a posted empty watermark against a null one", () => {
      const sections = [section("acc-1", "Acc One", { appendWatermark: null })];
      const verdict = verifyBinding(
        { reviewRevision: "v5.old", [sectionKey("appendWatermark", "acc-1")]: "" },
        fresh({ accountId: null, revision: "v5.new", sections, locked: ["acc-1"] }),
      );

      expect(verdict).toEqual({ ok: false, reason: "revision_changed", moved: [] });
    });

    it("does not name an omitted watermark", () => {
      const sections = [section("acc-1", "Acc One", { appendWatermark: "w1" })];
      const verdict = verifyBinding(
        { reviewRevision: "v5.old" },
        fresh({ accountId: null, revision: "v5.new", sections, locked: ["acc-1"] }),
      );

      expect(verdict).toEqual({ ok: false, reason: "revision_changed", moved: [] });
    });

    it("never names a section for a chosen account, even when its watermark differs", () => {
      const sections = [section("acc-1", "Acc One", { appendWatermark: "w1" })];
      const verdict = verifyBinding(
        { reviewRevision: "v5.old", [sectionKey("appendWatermark", "acc-1")]: "different" },
        fresh({ accountId: "acc-1", revision: "v5.new", sections, locked: ["acc-1"] }),
      );

      expect(verdict).toEqual({ ok: false, reason: "revision_changed", moved: [] });
    });

    it("never refuses alone: a differing watermark under a matching revision is ok", () => {
      const sections = [section("acc-1", "Acc One", { appendWatermark: "w1" })];
      const verdict = verifyBinding(
        { reviewRevision: "v5.same", [sectionKey("appendWatermark", "acc-1")]: "different" },
        fresh({ accountId: null, revision: "v5.same", sections, locked: ["acc-1"] }),
      );

      expect(verdict).toEqual({ ok: true, voided: new Set() });
    });
  });

  describe("voided ticks", () => {
    it("voids the account whose posted baseline differs from the fresh one", () => {
      const sections = [section("acc-1", "Acc One", { baselineSetId: "set-1" })];
      const verdict = verifyBinding(
        { reviewRevision: "v5.same", [sectionKey("baselineSetId", "acc-1")]: "set-2" },
        fresh({ accountId: null, revision: "v5.same", sections, locked: ["acc-1"] }),
      );

      expect(verdict).toEqual({ ok: true, voided: new Set(["acc-1"]) });
    });

    it("does not void a posted empty baseline against a null one", () => {
      const sections = [section("acc-1", "Acc One", { baselineSetId: null })];
      const verdict = verifyBinding(
        { reviewRevision: "v5.same", [sectionKey("baselineSetId", "acc-1")]: "" },
        fresh({ accountId: null, revision: "v5.same", sections, locked: ["acc-1"] }),
      );

      expect(verdict).toEqual({ ok: true, voided: new Set() });
    });

    it("does not void an omitted baseline against a null one", () => {
      const sections = [section("acc-1", "Acc One", { baselineSetId: null })];
      const verdict = verifyBinding(
        { reviewRevision: "v5.same" },
        fresh({ accountId: null, revision: "v5.same", sections, locked: ["acc-1"] }),
      );

      expect(verdict).toEqual({ ok: true, voided: new Set() });
    });

    it("voids an omitted baseline against a non-null one", () => {
      const sections = [section("acc-1", "Acc One", { baselineSetId: "set-1" })];
      const verdict = verifyBinding(
        { reviewRevision: "v5.same" },
        fresh({ accountId: null, revision: "v5.same", sections, locked: ["acc-1"] }),
      );

      expect(verdict).toEqual({ ok: true, voided: new Set(["acc-1"]) });
    });

    it("voids only the section whose baseline moved, among several", () => {
      const sections = [
        section("acc-1", "Acc One", { baselineSetId: "set-1" }),
        section("acc-2", "Acc Two", { baselineSetId: "set-2" }),
      ];
      const verdict = verifyBinding(
        {
          reviewRevision: "v5.same",
          [sectionKey("baselineSetId", "acc-1")]: "set-1",
          [sectionKey("baselineSetId", "acc-2")]: "moved",
        },
        fresh({ accountId: null, revision: "v5.same", sections, locked: ["acc-1", "acc-2"] }),
      );

      expect(verdict).toEqual({ ok: true, voided: new Set(["acc-2"]) });
    });

    it("carries no voided verdict when the same moved baseline also fails the revision", () => {
      const sections = [section("acc-1", "Acc One", { baselineSetId: "set-1" })];
      const verdict = verifyBinding(
        { reviewRevision: "v5.old", [sectionKey("baselineSetId", "acc-1")]: "moved" },
        fresh({ accountId: null, revision: "v5.new", sections, locked: ["acc-1"] }),
      );

      expect(verdict).toEqual({ ok: false, reason: "revision_changed", moved: [] });
    });
  });
});

describe("dateToReproduce", () => {
  const sections = [section("acc-1", "Acc One")];
  const locked = ["acc-1"];

  it("names no date to reproduce when the revision already matches", () => {
    const at = dateToReproduce(
      { reviewRevision: "v5.aaa", asOf: "2026-01-01", reviewedAsOf: "2026-02-01" },
      fresh({ accountId: "acc-1", revision: "v5.aaa", sections, locked }),
    );

    expect(at).toBeNull();
  });

  it("names no date to reproduce for a rerouted commit, which refuses first", () => {
    const at = dateToReproduce(
      { reviewRevision: "v5.old", asOf: "2026-01-01", reviewedAsOf: "2026-02-01" },
      fresh({ accountId: "acc-1", revision: "v5.new", sections, locked: [] }),
    );

    expect(at).toBeNull();
  });

  it("names the reviewed date when the revision differs and the dates differ", () => {
    const at = dateToReproduce(
      { reviewRevision: "v5.old", asOf: "2026-01-01", reviewedAsOf: "2026-02-01" },
      fresh({ accountId: "acc-1", revision: "v5.new", sections, locked }),
    );

    expect(at).toBe("2026-02-01");
  });

  it.each<[string, Partial<CommitInput>]>([
    ["the dates are equal", { asOf: "2026-01-01", reviewedAsOf: "2026-01-01" }],
    ["asOf is missing", { reviewedAsOf: "2026-02-01" }],
    ["reviewedAsOf is missing", { asOf: "2026-01-01" }],
  ])("names no date to reproduce when the revision differs but %s", (_name, extra) => {
    const at = dateToReproduce(
      { reviewRevision: "v5.old", ...extra },
      fresh({ accountId: "acc-1", revision: "v5.new", sections, locked }),
    );

    expect(at).toBeNull();
  });
});
