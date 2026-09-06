import { Link } from "react-router";

// Upload flow's step strip (ingest brief §2.1) — always four entries, only
// a passed step links. A skipped step dims with "· none" rather than
// disappearing, so the flow doesn't read as three steps on one upload and four on the next.
export type UploadStepsData = {
  current: 1 | 2 | 3 | 4;
  draftId: string | null;
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
