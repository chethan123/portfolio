import { redirect } from "react-router";

import { NotFoundError } from "~/lib/input.server";
import { parseDraft, requireDraft } from "~/lib/uploads.server";

import type { Route } from "./+types/index";

/**
 * `/upload/:draftId` — the draft's bare address resumes wherever it got to.
 *
 * Which step that is falls out of the row itself, through `parseDraft`: no
 * mapping (or one that no longer reads back through the schema) means the
 * columns step has not been passed; with one, the file's own strings decide
 * between instruments and review, exactly as the columns step's redirect
 * decided the first time. There is no page here — a screen at this URL would
 * be a fifth step nobody asked to stand on.
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
