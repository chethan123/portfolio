import { NavLink, Outlet } from "react-router";

/**
 * Settings — everything that writes, except Upload (DESIGN.md §8.4). A
 * layout: the tab strip is navigation for a section opened a few times ever,
 * so it lives a level down rather than competing with the daily pages in the
 * rail. Only tabs that exist are listed — a tab rendering an apology is
 * worse than a tab not there yet.
 */
const TABS = [
  { to: "/settings/people", label: "People" },
  { to: "/settings/accounts", label: "Accounts" },
  { to: "/settings/tax", label: "Tax" },
  { to: "/settings/prices", label: "Prices" },
  { to: "/settings/display", label: "Display" },
] as const;

export default function SettingsLayout() {
  return (
    <section className="page">
      {/* No class on the links: the stylesheet marks the current tab off
          `aria-current`, which `NavLink` already sets, so a second active
          marker would only be a way for the two to disagree. */}
      <nav className="settings-tabs" aria-label="Settings">
        <NavLink to="/settings" end>
          Overview
        </NavLink>
        {TABS.map((tab) => (
          <NavLink key={tab.to} to={tab.to}>
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <Outlet />
    </section>
  );
}
