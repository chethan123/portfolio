import { Link } from "react-router";

/**
 * The upload flow's step strip (ingest brief §2.1), on every step screen —
 * `/upload` included, since the drop screen is step one. The rule: **four
 * entries, always, and only a step already passed is a link** — a flow that
 * is four steps on one upload and three on the next reads as a different
 * flow, so a step with nothing to do dims with "· none" rather than
 * disappearing. Completed steps 2 and 3 link over the draft (going back is
 * free — the draft holds every answer); step 1 never links, since no URL
 * reopens account-and-file for a draft that has both; a future step's anchor
 * would be a link to a refusal. Quiet breadcrumb text, not chips: a chip
 * claims clickability, and two of the four entries deliberately have none.
 */

/** What a step screen's loader hands the strip — the `steps` field contract. */
export type UploadStepsData = {
  /** Which of the four steps the reader is standing on, 1-based. */
  current: 1 | 2 | 3 | 4;
  /** The draft the strip's links run over. Null on `/upload`, where none exists yet. */
  draftId: string | null;
  /** True when the file carries no first sightings, dimming entry 3 with "· none". */
  instrumentsSkipped: boolean;
};

const STEPS = [
  { number: 1, label: "Account & file", path: null },
  { number: 2, label: "Columns", path: "columns" },
  { number: 3, label: "New instruments", path: "instruments" },
  { number: 4, label: "Review", path: "review" },
] as const;

export function UploadSteps({ steps }: { steps: UploadStepsData }) {
  return (
    <nav className="upload-steps" aria-label="Upload">
      <ol>
        {STEPS.map((step) => {
          const skipped = step.path === "instruments" && steps.instrumentsSkipped;
          const completed = step.number < steps.current && !skipped;
          const current = step.number === steps.current;

          // Numbers set tabular so the strip does not shimmer between steps.
          const label = (
            <>
              <span className="u-data">{step.number}</span> {step.label}
            </>
          );

          return (
            <li
              key={step.number}
              aria-current={current ? "step" : undefined}
              className={skipped ? "upload-steps--skipped" : undefined}
            >
              {completed && step.path !== null && steps.draftId !== null ? (
                <Link to={`/upload/${steps.draftId}/${step.path}`}>{label}</Link>
              ) : (
                <span>
                  {label}
                  {skipped ? " · none" : null}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
