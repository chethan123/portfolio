-- Moved from PRICE_POLL_INTERVAL_MINUTES (env) into app_setting; default 15 preserves existing deployments' behavior. Bounds (1-1440) carried over from the old env schema.
alter table app_setting
  add column refresh_cadence_minutes integer not null default 15
    constraint app_setting_refresh_cadence_range
    check (refresh_cadence_minutes >= 1 and refresh_cadence_minutes <= 1440);
