import { redirect } from "react-router";

import { NotFoundError } from "~/lib/input.server";
import { parseDraft, requireDraft } from "~/lib/uploads.server";

import type { Route } from "./+types/index";

/** Bare draft address resumes wherever it got to, via `parseDraft` — no page here. */
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
