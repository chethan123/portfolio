// Never renders a figure — zero net worth and no data yet look identical on screen.
export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="empty-state">
      <p className="empty-state-headline">There is no data yet.</p>
      <p className="empty-state-detail">{children}</p>
    </div>
  );
}
