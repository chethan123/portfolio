import type { UploadReceipt } from "~/lib/uploads.server";

// The account page's ?uploaded= receipt and each line of /upload/done, told one way.
export function UploadReceiptSentence({
  receipt,
  accountName,
}: {
  receipt: UploadReceipt;
  accountName: string;
}) {
  return (
    <>
      {receipt.firstStatement ? (
        <>
          <span className="u-data">{receipt.counts.added}</span> added
        </>
      ) : (
        <>
          <span className="u-data">{receipt.counts.added}</span> added ·{" "}
          <span className="u-data">{receipt.counts.updated}</span> updated ·{" "}
          <span className="u-data">{receipt.counts.removed}</span> removed
        </>
      )}
      , as of <b className="u-data">{receipt.asOf}</b>.{" "}
      {receipt.isCurrent ? (
        <>
          {accountName} now holds <b className="u-data">{receipt.holdingCount}</b>{" "}
          {receipt.holdingCount === 1 ? "position" : "positions"}.
        </>
      ) : (
        // holdingCount is the set's, not the account's: docs/specs/0005-report-remediation.md §5.
        <>
          Filed behind what {accountName} already reports — it still shows its{" "}
          <b className="u-data">{receipt.currentAsOf}</b> figures.
        </>
      )}
    </>
  );
}
