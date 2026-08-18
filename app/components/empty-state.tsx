/**
 * What a dashboard says when it has nothing to show.
 *
 * The rule this component exists to keep is narrow and absolute: an empty
 * dashboard in a finance app must never render a figure. A zero net worth and
 * an instance that has never been uploaded to are indistinguishable on screen,
 * and one of them is alarming — so the empty case says, in words, that there is
 * no data, and shows no number and no axis at all.
 *
 * The dashboards slice replaces these. Until then this is the whole of the
 * three read pages.
 */
export function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="empty-state">
      <p className="empty-state-headline">There is no data yet.</p>
      <p className="empty-state-detail">{children}</p>
    </div>
  );
}
