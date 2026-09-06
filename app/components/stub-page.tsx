// Placeholder for routes whose content belongs to a later slice.
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
