/**
 * The adaptive picker label (`account-label.ts`): quiet until two rows would
 * read the same, then one tier of facts at a time — number tail always,
 * institution · type for twins, tax treatment for twins that survive that,
 * and an honest stop when every stored attribute matches.
 *
 * Every assertion is the exact full label string. The rule under test is
 * "which parts appear when", and a substring match would pass while the
 * composition drifted.
 */
import { describe, expect, it } from "vitest";

import { accountPickerGroups, numberTail } from "../app/lib/account-label.ts";

import type { PickerAccount } from "../app/lib/account-label.ts";

const account = (overrides: Partial<PickerAccount> & { id: string }): PickerAccount => ({
  name: "Schwab",
  institution: "Charles Schwab",
  kind: "brokerage",
  taxTreatment: "taxable",
  ownerId: "1",
  ownerName: "Alex Rivera",
  externalAccountNumber: null,
  ...overrides,
});

const labelsOf = (groups: ReturnType<typeof accountPickerGroups>) =>
  groups.map((group) => ({
    owner: group.ownerName,
    labels: group.options.map((option) => option.label),
  }));

describe("accountPickerGroups", () => {
  it("renders a lone account as its name plus the recorded number's last four", () => {
    const groups = accountPickerGroups([
      account({ id: "1", name: "Fidelity Individual", externalAccountNumber: "X47-283910" }),
      account({ id: "2", name: "Empower 401(k)", kind: "401k", taxTreatment: "tax_deferred" }),
    ]);

    expect(labelsOf(groups)).toEqual([
      { owner: "Alex Rivera", labels: ["Fidelity Individual ····3910", "Empower 401(k)"] },
    ]);
  });

  it("leaves same-named accounts bare across owners because the group already tells them apart", () => {
    const groups = accountPickerGroups([
      account({ id: "1", ownerId: "1", ownerName: "Alex Rivera" }),
      account({ id: "2", ownerId: "2", ownerName: "Jordan Rivera" }),
    ]);

    expect(labelsOf(groups)).toEqual([
      { owner: "Alex Rivera", labels: ["Schwab"] },
      { owner: "Jordan Rivera", labels: ["Schwab"] },
    ]);
  });

  it("gives same-owner twins their institution and account type", () => {
    const groups = accountPickerGroups([
      account({ id: "1", kind: "brokerage" }),
      account({ id: "2", kind: "ira", taxTreatment: "tax_free" }),
    ]);

    expect(labelsOf(groups)).toEqual([
      {
        owner: "Alex Rivera",
        labels: ["Schwab — Charles Schwab · Brokerage", "Schwab — Charles Schwab · IRA"],
      },
    ]);
  });

  it("distinguishes number-bearing twins by the tail alone, without enrichment", () => {
    const groups = accountPickerGroups([
      account({ id: "1", externalAccountNumber: "8391-2245" }),
      account({ id: "2", externalAccountNumber: "4407-9913" }),
    ]);

    expect(labelsOf(groups)).toEqual([
      { owner: "Alex Rivera", labels: ["Schwab ····2245", "Schwab ····9913"] },
    ]);
  });

  it("gives twins that survive enrichment their shortened tax treatment", () => {
    const groups = accountPickerGroups([
      account({ id: "1", name: "Schwab IRA", kind: "ira", taxTreatment: "tax_deferred" }),
      account({ id: "2", name: "Schwab IRA", kind: "ira", taxTreatment: "tax_free" }),
    ]);

    expect(labelsOf(groups)).toEqual([
      {
        owner: "Alex Rivera",
        labels: [
          "Schwab IRA — Charles Schwab · IRA · Tax-deferred (Traditional)",
          "Schwab IRA — Charles Schwab · IRA · Tax-free (Roth, HSA)",
        ],
      },
    ]);
  });

  it("renders rows identical in every stored attribute identically after the whole chain", () => {
    const groups = accountPickerGroups([account({ id: "1" }), account({ id: "2" })]);

    expect(labelsOf(groups)).toEqual([
      {
        owner: "Alex Rivera",
        labels: [
          "Schwab — Charles Schwab · Brokerage · Taxable",
          "Schwab — Charles Schwab · Brokerage · Taxable",
        ],
      },
    ]);
  });

  it("enriches to the account type alone when the institution is blank", () => {
    const groups = accountPickerGroups([
      account({ id: "1", name: "Checking", institution: "", kind: "bank" }),
      account({ id: "2", name: "Checking", institution: "", kind: "liability" }),
    ]);

    expect(labelsOf(groups)).toEqual([
      {
        owner: "Alex Rivera",
        labels: ["Checking — Bank", "Checking — Loan or other liability"],
      },
    ]);
  });

  it("orders groups by person name and keeps options in the order they arrive", () => {
    const groups = accountPickerGroups([
      account({ id: "5", name: "Ally Online Savings", ownerId: "2", ownerName: "Jordan Rivera" }),
      account({ id: "1", name: "Fidelity Individual", ownerId: "1", ownerName: "Alex Rivera" }),
      account({ id: "7", name: "Zeta Brokerage", ownerId: "2", ownerName: "Jordan Rivera" }),
      account({ id: "6", name: "Chase Auto Loan", ownerId: "1", ownerName: "Alex Rivera" }),
    ]);

    expect(labelsOf(groups)).toEqual([
      { owner: "Alex Rivera", labels: ["Fidelity Individual", "Chase Auto Loan"] },
      { owner: "Jordan Rivera", labels: ["Ally Online Savings", "Zeta Brokerage"] },
    ]);
  });
});

describe("numberTail", () => {
  it("takes the last four characters of the stored number and owns the mask glyphs", () => {
    expect(numberTail("X47-283910")).toBe("····3910");
    expect(numberTail("8391-2245")).toBe("····2245");
  });

  it("shows all it has when the number is shorter than four characters", () => {
    expect(numberTail("123")).toBe("····123");
  });

  it("treats a missing or blank number as no number at all", () => {
    expect(numberTail(null)).toBeNull();
    expect(numberTail("   ")).toBeNull();
  });
});
