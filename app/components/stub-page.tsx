/**
 * Placeholder body for routes whose content belongs to a later slice. Says
 * what the page will be, so a fresh install never reads as broken; the page
 * header is the real one (DESIGN.md §13) — skipping it would announce
 * "unfinished" twice, in words and in typography.
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
