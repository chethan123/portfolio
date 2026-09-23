import { Link } from "react-router";

// Upload flow's step strip (ingest brief §2.1) — four entries, five for a file of several
// accounts, and only a passed step links. A skipped step dims with "· none" rather than
// disappearing, so the flow doesn't read as three steps on one upload and four on the next.
export type UploadStepsData = {
  current: 1 | 2 | 3 | 4 | 5; // position in the strip as drawn
  draftId: string | null;
  instrumentsSkipped: boolean;
  // Null: one account, whose strip has no accounts step (spec 0023 "Steps").
  accountsSkipped: boolean | null;
};

const STEPS = [
  { label: "Account & file", path: null },
  { label: "Columns", path: "columns" },
  { label: "Accounts", path: "accounts" },
  { label: "New instruments", path: "instruments" },
  { label: "Review", path: "review" },
] as const;

export function UploadSteps({ steps }: { steps: UploadStepsData }) {
  const shown = STEPS.filter((step) => step.path !== "accounts" || steps.accountsSkipped !== null);

  return (
    <nav className="upload-steps" aria-label="Upload">
      <ol>
        {shown.map((step, index) => {
          const number = index + 1;
          const skipped =
            (step.path === "instruments" && steps.instrumentsSkipped) ||
            (step.path === "accounts" && steps.accountsSkipped === true);
          const completed = number < steps.current && !skipped;
          const current = number === steps.current;

          const label = (
            <>
              <span className="u-data">{number}</span> {step.label}
            </>
          );

          return (
            <li
              key={step.label}
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
