/**
 * Placeholder body for the routes whose content belongs to a later slice.
 *
 * It says what the page will be rather than showing an empty frame, so a fresh
 * install never reads as broken. The dashboards slice replaces these; the
 * honest-empty-state work is that slice's, not a stub's.
 */
export function StubPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="page">
      <h1>{title}</h1>
      <p className="page-lede">{children}</p>
    </section>
  );
}
