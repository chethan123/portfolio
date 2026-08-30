/**
 * What a dashboard says when it has nothing to show. The rule: an empty
 * dashboard in a finance app never renders a figure — a zero net worth and a
 * never-uploaded instance are indistinguishable on screen, and one of them
 * is alarming. Words, no number, no axis.
 */
export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="empty-state">
      <p className="empty-state-headline">There is no data yet.</p>
      <p className="empty-state-detail">{children}</p>
    </div>
  );
}
