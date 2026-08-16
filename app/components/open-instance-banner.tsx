/**
 * The persistent "this instance is open" warning (DESIGN.md §10).
 *
 * Rendered on every page whenever `AUTH_PASSWORD` is unset, and it is
 * deliberately not dismissible: an open instance is a state to be noticed every
 * time, not an alert to be acknowledged once and then forgotten.
 */
export function OpenInstanceBanner() {
  return (
    <aside className="open-instance-banner" role="status">
      <strong>This instance has no password.</strong> Anyone who can reach it can read and
      change your data. Set <code>AUTH_PASSWORD</code> (and <code>SESSION_SECRET</code>) to
      put it behind a login.
    </aside>
  );
}
