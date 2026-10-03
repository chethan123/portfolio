import { NotFoundError } from "~/lib/input.server";
import { resumeAt } from "~/lib/upload-resume.server";
import { parseDraft, requireDraft } from "~/lib/uploads.server";

import type { Route } from "./+types/index";

/** Bare draft address resumes wherever it got to, via `parseDraft` — no page here. */
export async function loader({ params }: Route.LoaderArgs) {
  try {
    const draft = await requireDraft(params.draftId);
    const result = await parseDraft(draft);

    // Nothing links to the bare address with the stale flag.
    return resumeAt(draft.id, result.step, false);
  } catch (error) {
    if (error instanceof NotFoundError) throw new Response(error.message, { status: 404 });
    throw error;
  }
}
