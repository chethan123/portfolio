/**
 * Placeholder body for the routes whose content belongs to a later slice.
 *
 * It says what the page will be rather than showing an empty frame, so a fresh
 * install never reads as broken. The page header is the real one (DESIGN.md
 * §13) — a stub that skipped it would announce itself as unfinished twice, in
 * its words and in its typography. The dashboards slice replaces these.
 */
export function StubPage({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="page">
      <header className="page-header">
        <div>
          <h1 className="page-title">{title}</h1>
          <p className="page-subtitle">{children}</p>
        </div>
      </header>
    </section>
  );
}
