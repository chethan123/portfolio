import { redirect } from "react-router";

import { NotFoundError } from "~/lib/input.server";
import { parseDraft, requireDraft } from "~/lib/uploads.server";

import type { Route } from "./+types/index";

/**
 * `/upload/:draftId` — the draft's bare address resumes wherever it got to,
 * decided by the row itself through `parseDraft`: no mapping (or one that no
 * longer reads back) means columns; with one, the file's own strings decide
 * between instruments and review, exactly as the columns step's redirect did
 * the first time. No page here — a screen at this URL would be a fifth step
 * nobody asked to stand on.
 */
export async function loader({ params }: Route.LoaderArgs) {
  try {
    const draft = await requireDraft(params.draftId);
    const result = await parseDraft(draft);

    return redirect(`/upload/${draft.id}/${result.step ?? "review"}`);
  } catch (error) {
    if (error instanceof NotFoundError) throw new Response(error.message, { status: 404 });
    throw error;
  }
}
