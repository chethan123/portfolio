// The review form's one key scheme: what the review posts is what the commit reads (spec 0024 §5).
// Browser-safe: types only from .server modules.
import type { UploadDiff } from "./uploads.server.ts";

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
