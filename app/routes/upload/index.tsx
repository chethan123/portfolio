import { redirect } from "react-router";

import { readCsv } from "~/lib/csv";
import { NotFoundError } from "~/lib/input.server";
import { unresolvedStrings } from "~/lib/instrument-resolution.server";
import { parseStatement, statementMapping } from "~/lib/statement";
import { requireDraft } from "~/lib/uploads.server";

import type { Route } from "./+types/index";

/**
 * `/upload/:draftId` — the draft's bare address resumes wherever it got to.
 *
 * Which step that is falls out of the row itself: no mapping (or one that no
 * longer reads back through the schema) means the columns step has not been
 * passed; with one, the file's own strings decide between instruments and
 * review, exactly as the columns step's redirect decided the first time.
 * There is no page here — a screen at this URL would be a fifth step nobody
 * asked to stand on.
 */
export async function loader({ params }: Route.LoaderArgs) {
  try {
    const draft = await requireDraft(params.draftId);

    const saved = statementMapping.safeParse(draft.mapping);
    if (!saved.success) return redirect(`/upload/${draft.id}/columns`);

    // The mapping's own delimiter, never a second sniff: re-reading the same
    // bytes must not depend on the sniff reaching the same verdict twice.
    const { rows } = readCsv(draft.bytes, saved.data.delimiter);
    const parsed = parseStatement(rows, saved.data);

    // A saved mapping only lands after a clean parse, so problems here mean
    // the stored row predates a rule or was written by hand — either way,
    // remapping is the fix and columns is where remapping lives.
    if (parsed.problems.length > 0) return redirect(`/upload/${draft.id}/columns`);

    const unresolved = await unresolvedStrings(
      parsed.positions.map((position) => position.instrument),
    );
    return redirect(`/upload/${draft.id}/${unresolved.length > 0 ? "instruments" : "review"}`);
  } catch (error) {
    if (error instanceof NotFoundError) throw new Response(error.message, { status: 404 });
    throw error;
  }
}
