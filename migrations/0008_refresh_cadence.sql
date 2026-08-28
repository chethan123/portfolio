-- How often the app asks the price feed for fresh quotes while the market is
-- open — the refresh cadence, moving from the environment into `app_setting`.
--
-- **Why this stops being an environment variable.** `PRICE_POLL_INTERVAL_MINUTES`
-- sat on the deployment side of the rule `0005_app_setting.sql` states, on the
-- argument that request spend against an unofficial API is the operator's
-- business. In a self-hosted household the operator and the person reading the
-- screen are the same person — minus the shell. Making them SSH into the
-- container to change a cadence they experience in the browser serves the rule's
-- letter and defeats its point, so the value moves to the side where the person
-- who wants it changed already is. The environment variable is deleted rather
-- than kept as a fallback: two places to set a figure is two places to read a
-- different answer from, which is the same sentence that kept
-- `CAPITAL_GAINS_RATE` from ever existing.
--
-- **The default stays 15.** This migration moves the dial; it does not turn it.
-- A deployment whose operator never opens the new Settings tab keeps exactly the
-- request rate it had, and one that had set the variable re-enters the value
-- once in the UI (docs/operating.md carries the upgrade note).
--
-- **Bounds unchanged, enforced here.** 1–1440 was the environment schema's
-- range; the check constraint keeps it now that the environment schema no
-- longer exists to.
alter table app_setting
  add column refresh_cadence_minutes integer not null default 15
    constraint app_setting_refresh_cadence_range
    check (refresh_cadence_minutes >= 1 and refresh_cadence_minutes <= 1440);
