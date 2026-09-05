# 05 — Say what the family will actually see

_Part of [0020-the-lock-hardened.md](../0020-the-lock-hardened.md). Acts on the launch review's
[F8](../../research/2026-09-05-lock-slice-launch-review.md#f8--should-fix--documents-that-state-things-the-code-does-not-do)
items 1–4 and 6, and on F9, F10 and F12's copy._

**What to build:** The family guide (`docs/guide/passkeys.md`) and two of its neighbours brought
level with the screens as they render, plus one CSS rule that makes a sentence true instead of
deleting it. Every change here is checked against the verbatim strings the review's drive
recorded (its §8 table) or against the code line named; nothing is reworded on taste.

Its own ticket because the guide is the one document a household reads, the review found it wrong
in four places a reader would act on, and the last round of review on it (#241) fixed one of those
sentences into a different wrong sentence. A reviewer reads each new sentence beside the code it
describes.

**Blocked by:** Nothing. Tickets 07 and 08 wait for this one, because they edit the same file.

**Status:** ready-for-agent

**`docs/guide/passkeys.md`**

- [ ] "Doing it", the paragraph after step 5 (today "If step 4 answers with a message …"): the
      likeliest failure — somebody else enrolled the household's first passkey while this reader
      was filling in the form — does *not* produce a message; the reader's next press lands them
      on the unlock screen, because the household is now locked and this browser has no grant.
      Say that: what the reader sees is **Locked** with **Unlock**, unlocking takes them to the
      overview, and the passkey they were about to make can be added from Settings → Passkeys once
      unlocked, now behind a confirmation. The messages step 4 *can* show are about the label (too
      long, missing, a stray control character) or an unreadable submission — for those, the label
      and the tick are kept and pressing **Continue** again is right
- [ ] "Setting it up", the paragraph beginning "One thing it does not do is wipe a screen": a page
      drawn before the first enrolment has no **Lock now** control (it is drawn only once the
      household holds a passkey), so "press Lock now on that device" cannot be followed there.
      Replace with what works: open any other screen, or wait — a screen hidden for about a minute
      locks itself on return whether or not it knew about the enrolment. Reconcile "keeps showing
      those figures until it asks for something new" with the later section that says stepping
      away for a minute locks it: both are true, say so once
- [ ] "When it locks itself", the sentence ending "until it does": there is no "until". If the
      request to lock cannot reach the app — no connection, a proxy error — nothing retries; the
      screen stays as it was until the next tap, and a browser in use keeps its grant alive. Say
      that the lock is a request, that a failed request is not retried, and that the idle expiry
      is the guarantee underneath (seven and a half to fifteen minutes with no request)
- [ ] Same section: a sign-in bounce (the Google sign-in the household passes about weekly) that
      happens while the app is hidden leaves the browser exactly as unlocked as it was — the lock
      request is swallowed by the sign-in, and the grant rides out its own idle window (review F9).
      One sentence, in the voice the section already uses
- [ ] Same section: a tab opened in the background — a link opened without switching to it — counts
      as hidden from the moment it opened, so the first time it is looked at after about a minute
      it locks the browser (review F10, kept by decision). One sentence
- [ ] "**Lock now**, beside **Show amounts**": the neighbour reads **Show amounts** or **Hide
      amounts** depending on the state, and on a phone both are icons with no words. Name the
      control by its padlock and its place — the foot of the side rail, or the top bar on a phone —
      rather than by a neighbour whose label changes
- [ ] Step 4's "It stays greyed out": true only once the CSS rule below exists; keep the sentence
      and add the rule. Step 5's "no button to press in the first place" for an incapable browser:
      the button renders first and is replaced once the page has loaded; say "the button is
      replaced by a line saying so" rather than "no button in the first place"
- [ ] "What a passkey actually is", the same-provider paragraph: the screen prints the provider's
      own sentence ("The authenticator was previously registered" in Chrome) and leaves the form
      waiting on a creation that cannot happen; say that reloading the page is how to start over
      until ticket 11 gives the screen a way (review F12). Remove that sentence in 11's pull request
- [ ] The cross-device paragraph under "Unlocking a browser" is ticket 07's — leave it

**Two neighbours**

- [ ] `docs/guide/when-something-is-refused.md`: "Nothing in this application deletes anything" is
      false since removing a passkey deletes it. Amend in place, in the shape `settings.md` already
      uses for the same fact
- [ ] `docs/guide/first-run.md`: "If a phone is lost … tell whoever runs the instance — that is done
      from outside the app" is now done from Settings → Passkeys on any browser that is still
      unlocked (spec 0019 story 15); the operator is the recovery only when every passkey is
      unreachable. Point at `passkeys.md`'s "Removing a passkey". If the page lists the rail's foot,
      Lock now belongs in the list

**The one rule**

- [ ] `app/app.css` gains a `.button:disabled` rule in the voice of `.refresh-button:disabled` —
      reduced opacity, `cursor: not-allowed`, no colour change that could read as a different
      control — so "greyed out" describes something. Both screens that render a disabled `.button`
      (the unlock screen while confirming, Settings → Passkeys throughout) inherit it

**Tests and pictures**

- [ ] The screens change (a disabled button now looks disabled), so the screenshots are retaken
      with `scripts/capture-screenshots.ts` and committed — `docs/README.md` and
      `docs/developing.md` make that the definition of finished. At minimum the Settings → Passkeys
      shots, which show **Continue** disabled
- [ ] No test asserts prose. The one code change is CSS; `npm run build` is its gate

**Verification**

1. For every sentence changed, the corresponding row of the review's §8 table or the code line the
   review cites — read side by side, in the pull request body, one line each.
2. `grep -n "until it does\|Nothing in this application deletes\|done from outside the app"
   docs/guide/*.md` returns nothing.
3. `npm run build`; then the capture script per `docs/developing.md`'s recipe; `git status` shows
   the retaken PNGs.
4. `npm run typecheck`, `npm test` — unchanged counts.
