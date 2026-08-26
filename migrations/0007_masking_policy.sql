-- The household's standing answer to "what should a browser that nobody has
-- toggled yet open in?" — the masking policy (spec 0007, ADR-0002).
--
-- **Why this is a column and not a cookie.** Whether a given browser is masked
-- *right now* is a fact about that browser, and it is a cookie for exactly that
-- reason: a phone in a queue and a desktop in a locked room want opposite
-- answers, and one stored value can only give them one. What a browser should
-- *start* in is a different question with one household-wide answer, and it
-- belongs beside the capital gains rate for the reason `0005_app_setting.sql`
-- already gives for that one — it describes the household rather than the
-- deployment, and the person who wants it changed is the person reading the
-- screen it produced.
--
-- **Three values, and only three.** `masked` and `unmasked` are standing
-- answers that ignore the browser; `as_last_left` defers to whatever that
-- browser was last toggled to. A boolean could carry the first two and would
-- have no way to say the third, which is the one a household with settled
-- habits actually wants.
--
-- **Seeded to `masked`, which is the whole of the decision.** A browser with no
-- cookie — a new device, a cleared jar, a private window — resolves through this
-- column, so the seed is what a first run looks like. ADR-0002 records this as
-- the one place safety beat convenience: the counter-case, that a privacy
-- feature should be opt-in on a machine that is usually private, was considered
-- and overruled. The cost is a first run that is a page of dots, and the
-- mitigation is that the control sits in the chrome wearing a text label rather
-- than behind Settings.
alter table app_setting
  add column masking_policy text not null default 'masked'
    constraint app_setting_masking_policy_valid
    check (masking_policy in ('masked', 'unmasked', 'as_last_left'));
