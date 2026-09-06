import { NavLink, Outlet } from "react-router";

// Everything that writes, except Upload (DESIGN.md §8.4). Only tabs that exist are listed.
const TABS = [
  { to: "/settings/people", label: "People" },
  { to: "/settings/accounts", label: "Accounts" },
  { to: "/settings/tax", label: "Tax" },
  { to: "/settings/prices", label: "Prices" },
  { to: "/settings/display", label: "Display" },
  { to: "/settings/passkeys", label: "Passkeys" },
] as const;

export default function SettingsLayout() {
  return (
    <section className="page">
      {/* No class on the links — stylesheet marks current tab off `aria-current`, which `NavLink` already sets. */}
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
