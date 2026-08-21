import { redirect } from "react-router";

import { NotFoundError } from "~/lib/input.server";
import { requireDraft } from "~/lib/uploads.server";

import type { Route } from "./+types/index";

/**
 * `/upload/:draftId` — the draft's bare address resumes wherever it got to.
 *
 * Which step that is falls out of the row itself: a null `mapping` means the
 * columns step has not been passed. There is no page here — a screen at this
 * URL would be a fifth step nobody asked to stand on.
 */
export async function loader({ params }: Route.LoaderArgs) {
  try {
    const draft = await requireDraft(params.draftId);

    // With a mapping the draft belongs further on — tickets 03/04 branch this
    // to instruments or review; until those screens exist, columns is the only
    // step there is to resume at.
    const step = draft.mapping === null ? "columns" : "columns";

    return redirect(`/upload/${draft.id}/${step}`);
  } catch (error) {
    if (error instanceof NotFoundError) throw new Response(error.message, { status: 404 });
    throw error;
  }
}
