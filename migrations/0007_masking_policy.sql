-- Household default a browser with no cookie starts in (per-browser "right now" is a cookie, not this). Three values: `as_last_left` has no boolean equivalent.
-- Seeded `masked`: security over convenience by design (ADR-0002).
alter table app_setting
  add column masking_policy text not null default 'masked'
    constraint app_setting_masking_policy_valid
    check (masking_policy in ('masked', 'unmasked', 'as_last_left'));
