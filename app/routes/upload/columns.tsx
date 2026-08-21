import { NotFoundError } from "~/lib/input.server";
import { requireDraft } from "~/lib/uploads.server";

import type { UploadStepsData } from "~/components/upload-steps";
import type { Route } from "./+types/columns";

/**
 * Step two — map the file's columns (ingest brief §4).
 *
 * A shell: ticket 03 replaces the body with the preview table and the mapping
 * form. What is settled here and does not move is the URL, the draft read, and
 * the `steps` contract the layout's strip renders from.
 */
export function meta() {
  return [{ title: "Columns · Upload · Portfolio" }];
}

export async function loader({ params }: Route.LoaderArgs) {
  try {
    const draft = await requireDraft(params.draftId);

    return {
      steps: {
        current: 2,
        draftId: draft.id,
        instrumentsSkipped: false,
      } satisfies UploadStepsData,
      draft: { id: draft.id, filename: draft.filename, accountName: draft.accountName },
    };
  } catch (error) {
    if (error instanceof NotFoundError) throw new Response(error.message, { status: 404 });
    throw error;
  }
}

export default function Columns({ loaderData }: Route.ComponentProps) {
  const { draft } = loaderData;

  return (
    <section className="panel">
      <div className="panel-body form-intro">
        {/* The file and the account lead, because a draft survives a closed
            laptop and the reader may be resuming cold. */}
        <p>
          <strong>{draft.filename}</strong> · {draft.accountName}
        </p>
        <p className="empty-note">
          Mapping this file's columns is the next step of the ingest slice. The draft is
          holding the file, so nothing is lost while that screen is built.
        </p>
      </div>
    </section>
  );
}
