/**
 * The review form as the page posts it, for either kind of draft: one encoder (review-form.ts), so a
 * test cannot bind a commit differently from the page.
 */
import type { Kysely } from "kysely";

import type { Database } from "~/lib/db.server";
import { reviewedFields } from "~/lib/review-form";
import {
  recordUpload,
  reviewForDraft,
  type AccountDiff,
  type CommitInput,
  type CommittedUpload,
  type UploadDiff,
} from "~/lib/uploads.server";

/** The review's hidden fields, then `extra` on top. */
export function posted(review: UploadDiff, extra: CommitInput = {}): CommitInput {
  return { ...reviewedFields(review), ...extra };
}

/** Draws the review at `asOf` and records it, posting `asOf` when given. */
export async function reviewAndRecord(
  draftId: string,
  db: Kysely<Database>,
  { asOf = null, extra = {} }: { asOf?: string | null; extra?: CommitInput } = {},
) {
  const review = await reviewForDraft(draftId, asOf, db);
  if (review.reviewRevision === null) {
    throw new Error("A valid review did not produce its revision.");
  }
  return recordUpload(draftId, posted(review, asOf === null ? extra : { asOf, ...extra }), db);
}

/** A chosen-account diff's one section. */
export function onlySection(diff: UploadDiff): AccountDiff {
  const [section, ...rest] = diff.accounts;
  if (section === undefined || rest.length > 0) {
    throw new Error(`Expected one section, found ${diff.accounts.length}.`);
  }
  return section;
}

/** A chosen-account commit's one set. */
export function onlyRecorded(recorded: CommittedUpload[]): CommittedUpload {
  const [set, ...rest] = recorded;
  if (set === undefined || rest.length > 0) {
    throw new Error(`Expected one recorded set, found ${recorded.length}.`);
  }
  return set;
}
