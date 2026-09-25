// The review form's one key scheme, drawn and verified: what the review posts is what the commit
// reads (spec 0024 §5, spec 0028).
// Browser-safe: types only from .server modules.
import type { AccountDiff, CommitInput, UploadDiff } from "./uploads.server.ts";

type SectionField = "baselineSetId" | "appendWatermark" | "confirmRemovals" | "confirmFiledBehind";

export function sectionKey<F extends SectionField>(field: F, accountId: string): `${F}-${string}` {
  return `${field}-${accountId}`;
}

// Every hidden field the review posts; the ticks and `asOf` are the reader's. "" is null's wire form.
export function reviewedFields(diff: UploadDiff): Record<string, string> {
  return {
    accountId: diff.accountId ?? "",
    ...(diff.reviewRevision === null ? {} : { reviewRevision: diff.reviewRevision }),
    reviewedAsOf: diff.asOfInput,
    ...Object.fromEntries(
      diff.accounts.flatMap((section) => [
        [sectionKey("baselineSetId", section.accountId), section.baselineSetId ?? ""],
        [sectionKey("appendWatermark", section.accountId), section.appendWatermark ?? ""],
      ]),
    ),
  };
}

export type StaleReason = "date_changed" | "revision_changed" | "rerouted";

export type FreshBinding = {
  diff: Pick<UploadDiff, "accountId" | "reviewRevision"> & {
    accounts: ReadonlyArray<
      Pick<AccountDiff, "accountId" | "accountName" | "baselineSetId" | "appendWatermark">
    >;
  };
  locked: ReadonlyArray<string>; // account ids withAccountLock(s) holds
  // The revision re-assembled at dateToReproduce's date; null when it named none.
  reproduced: string | null;
};

export type BindingVerdict =
  | { ok: true; voided: ReadonlySet<string> }
  | { ok: false; reason: StaleReason; moved: string[] };

function revisionMatches(posted: CommitInput, diff: Pick<UploadDiff, "reviewRevision">): boolean {
  return (
    posted.reviewRevision !== undefined &&
    diff.reviewRevision !== null &&
    posted.reviewRevision === diff.reviewRevision
  );
}

function reroutedNames({ diff, locked }: Omit<FreshBinding, "reproduced">): string[] {
  return diff.accounts
    .filter((section) => !locked.includes(section.accountId))
    .map((section) => section.accountName);
}

// A posted date is only an assertion: the current state rebuilt at the reviewed date must reproduce
// the submitted revision before "a different date" is credible; anything else falls back to stale.
// None for a rerouted commit, which refuses first.
export function dateToReproduce(
  posted: CommitInput,
  fresh: Omit<FreshBinding, "reproduced">,
): string | null {
  if (reroutedNames(fresh).length > 0 || revisionMatches(posted, fresh.diff)) return null;
  const { asOf, reviewedAsOf } = posted;
  return asOf === undefined || reviewedAsOf === undefined || asOf === reviewedAsOf
    ? null
    : reviewedAsOf;
}

export function verifyBinding(posted: CommitInput, fresh: FreshBinding): BindingVerdict {
  const rerouted = reroutedNames(fresh);
  if (rerouted.length > 0) return { ok: false, reason: "rerouted", moved: rerouted };

  if (!revisionMatches(posted, fresh.diff)) {
    // Re-checked, not trusted from fresh.reproduced: a reproduction nobody asked for cannot turn a
    // stale review into a date change.
    const asked = dateToReproduce(posted, fresh) !== null;
    if (asked && fresh.reproduced === posted.reviewRevision) {
      return { ok: false, reason: "date_changed", moved: [] };
    }
    // Spec 0023 decision 9: several accounts name where history moved. The watermark, not the
    // baseline: a changed date alone moves baselines, never a watermark.
    const moved =
      fresh.diff.accountId === null
        ? fresh.diff.accounts.flatMap((section) => {
            const postedWatermark = posted[sectionKey("appendWatermark", section.accountId)];
            return postedWatermark !== undefined &&
              postedWatermark !== (section.appendWatermark ?? "")
              ? [section.accountName]
              : [];
          })
        : [];
    return { ok: false, reason: "revision_changed", moved };
  }

  const voided = new Set(
    fresh.diff.accounts
      .filter((section) => {
        // "" is null's wire form (#181).
        const postedBaseline = posted[sectionKey("baselineSetId", section.accountId)] ?? "";
        return postedBaseline !== (section.baselineSetId ?? "");
      })
      .map((section) => section.accountId),
  );
  return { ok: true, voided };
}
