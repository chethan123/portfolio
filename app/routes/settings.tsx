import { NavLink, Outlet } from "react-router";

/**
 * Settings — everything that writes, except Upload (DESIGN.md §8.4).
 *
 * A layout rather than a page: the tab strip is the navigation for a section
 * opened a few times ever, so it lives one level down rather than competing
 * with the daily pages in the header.
 *
 * Only the tabs that exist are listed. Classifications, Instruments and History
 * are named on the index page as what they will be, because a tab that renders
 * an apology is worse than a tab that is not there yet.
 */
const TABS = [
  { to: "/settings/people", label: "People" },
  { to: "/settings/accounts", label: "Accounts" },
] as const;

export default function SettingsLayout() {
  return (
    <section className="page">
      <nav className="settings-tabs" aria-label="Settings">
        <NavLink
          to="/settings"
          end
          className={({ isActive }) =>
            isActive ? "settings-tab settings-tab--active" : "settings-tab"
          }
        >
          Overview
        </NavLink>
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            className={({ isActive }) =>
              isActive ? "settings-tab settings-tab--active" : "settings-tab"
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>

      <Outlet />
    </section>
  );
}
