# 05 — Say what the family will actually see

_Part of [0020-the-lock-hardened.md](../0020-the-lock-hardened.md). Acts on the launch review's
[F8](../../research/2026-09-05-lock-slice-launch-review.md#f8--should-fix--documents-that-state-things-the-code-does-not-do)
items 1–4 and 6, on F9, F10 and F12's copy, and on its §3 note that the guide never states the
bearer-token limit._

**What to build:** The family guide (`docs/guide/passkeys.md`) and two of its neighbours brought
level with the screens as they render, plus one CSS rule that makes a sentence true instead of
deleting it. Every change here is checked against the verbatim strings the review's drive
recorded (its §8 table) or against the code line named; nothing is reworded on taste.

Its own ticket because the guide is the one document a household reads, the review found it wrong
in four places a reader would act on, and the last round of review on it (#241) fixed one of those
sentences into a different wrong sentence. A reviewer reads each new sentence beside the code it
describes.

**Blocked by:** [07](07-hedge-cross-device-and-walk-it.md), which edits the one guide paragraph
this ticket leaves alone and is the smaller change — it lands first, this branches after it.
Tickets 08 and 11(a) wait for this one.

**Status:** ready-for-agent

**`docs/guide/passkeys.md`**

- [ ] "Doing it", the paragraph after step 5 (`:67-72`, today "If step 4 answers with a message
      …"): the likeliest failure — somebody else enrolled the household's first passkey while this
      reader was filling in the form — does *not* produce a message; the reader's next press lands
      them on the unlock screen, because the household is now locked and this browser has no grant
      (`app/root.tsx:407` refuses the POST; a POST gets no return address, `:276-280`). Say that:
      what the reader sees is **Locked** with **Unlock**, unlocking takes them to the overview, and
      the passkey they were about to make can be added from Settings → Passkeys once unlocked, now
      behind a confirmation. The messages step 4 *can* show are about the label (missing, over 60
      characters, a stray control character — `app/lib/lock.server.ts:942-946`) or an unreadable
      submission; for those the label and the tick are kept (`passkeys.tsx:640-646` clears only
      the options) and pressing **Continue** again is right
- [ ] The same paragraph's last sentences (`:70-72`): the incapable-browser case is not "no button
      to press in the first place" — **Continue** renders first and is replaced by a line once the
      page has loaded (`passkeys.tsx:769`, `:824-826`). Say "the button is replaced by a line
      saying so"
- [ ] "Setting it up", the paragraph beginning "One thing it does not do is wipe a screen"
      (`:30-34`): a page drawn before the first enrolment has no **Lock now** control (it is drawn
      only once the household holds a passkey — `app/root.tsx:823`, `:838` off `hasPasskey`), so
      "press Lock now on that device" cannot be followed there. Replace with what works: open any
      other screen, or wait — a screen hidden for about a minute locks itself on return whether or
      not it knew about the enrolment (`watchReentry` installs on every page, `:775-779`).
      Reconcile "keeps showing those figures until it asks for something new" with the later
      section that says stepping away for a minute locks it: both are true, say so once
- [ ] "When it locks itself", the sentence ending "until it does" (`:136-138`): there is no
      "until". If the request to lock cannot reach the app — no connection, a proxy error — nothing
      retries (`app/lib/reentry.ts:190-203`); the screen stays as it was until the next tap, and a
      browser in use keeps its grant alive. Say that the lock is a request, that a failed request
      is not retried, and that the idle expiry is the guarantee underneath (seven and a half to
      fifteen minutes with no request)
- [ ] Same section: a sign-in bounce (the Google sign-in the household passes about weekly) that
      happens while the app is hidden leaves the browser as unlocked as it was — the lock request
      is redirected into the sign-in and never reaches the app (`Caddyfile`'s `redir` to
      `/oauth2/sign_in`; `compose.yaml:274` skips the provider button, so it goes straight to
      Google), and the grant rides out its own idle window (review F9). The review reasoned this
      from the configuration and did not run a gate; write "may leave" rather than "leaves", and
      no more than one sentence
- [ ] Same section: a tab opened in the background — a link opened without switching to it — counts
      as hidden from the moment it opened, so the first time it is looked at after about a minute
      it locks the browser (review F10; kept, spec 0020 "Decisions"). One sentence
- [ ] "**Lock now**, beside **Show amounts**" (`:143-144`): the neighbour reads **Show amounts** or
      **Hide amounts** depending on the state (`app/components/masking-toggle.tsx:49`), and on a
      phone both are icons with no words (`app/app.css:581-590`). Name the control by its padlock
      and its place — the foot of the side rail, or the top bar on a phone — rather than by a
      neighbour whose label changes
- [ ] Step 4's "It stays greyed out" (`:56`): true only once the CSS rule below exists; keep the
      sentence and add the rule
- [ ] "What a passkey actually is", the same-provider paragraph (`:86-90`): the screen prints the
      provider's own sentence ("The authenticator was previously registered" in Chrome) and leaves
      the form waiting on a creation that cannot happen; say that reloading the page is how to
      start over. Ticket 11(a) gives the screen a way and removes that sentence
- [ ] "Being locked" or "Unlocking a browser", one sentence in the family's words on the limit the
      spec, the migration and `docs/data-model.md` state and the guide does not: being unlocked is
      a fact about this browser, carried by it, and anyone who could copy what it carries would be
      unlocked too until it runs out — which is why a phone should be handed over locked
- [ ] The cross-device paragraph under "Unlocking a browser" (`:116-119`) is ticket 07's — leave it

**Two neighbours**

- [ ] `docs/guide/when-something-is-refused.md:79`: "Nothing in this application deletes anything"
      is false since removing a passkey deletes it. Amend in place, in the shape
      `docs/guide/settings.md:107` already uses for the same fact
- [ ] `docs/guide/first-run.md:24`: "If a phone is lost … tell whoever runs the instance — that is
      done from outside the app" is now done from Settings → Passkeys on any browser that is still
      unlocked (spec 0019 story 15); the operator is the recovery only when every passkey is
      unreachable. Point at `passkeys.md`'s "Removing a passkey". If the page lists the rail's foot,
      Lock now belongs in the list

**The one rule**

- [ ] `app/app.css` gains a `.button:disabled` rule: reduced opacity, `cursor: default`, no colour
      change. Not `.refresh-button:disabled`'s shape (`app/app.css:3596`) — that rule deliberately
      keeps full contrast and `cursor: progress` because its disabled state means *busy*, and it
      says so. A `.button` is disabled for both reasons (forbidden until the label and the tick are
      done; busy while a ceremony runs — the unlock screen's own button, `app/routes/unlock.tsx:283-285`),
      so the rule claims neither: dimmer, and no cursor that says "not allowed" over a button that
      is merely working. Say that in the rule's comment

**Tests and pictures**

- [ ] The screens change (a disabled button now looks disabled), so the Settings → Passkeys
      screenshots are retaken with `scripts/capture-screenshots.ts` and committed — both captured
      states of that screen show a disabled **Continue** (`scripts/capture-screenshots.ts:714`,
      `:797`), and `docs/README.md` and `docs/developing.md` make the retake the definition of
      finished. Retake the unlock-screen shot too if the capture takes one (it does not today)
- [ ] No test asserts prose. The one code change is CSS; `npm run build` is its gate

**Verification**

1. For every sentence changed, the corresponding row of the review's §8 table or the code line
   cited above — read side by side, in the pull request body, one line each.
2. `grep -n "until it does\|Nothing in this application deletes\|done from outside the app\|no
   button to press in the first place\|beside \*\*Show amounts" docs/guide/*.md` returns nothing.
3. `npm run build`; then the capture script per `docs/developing.md:479-499`; `git status` shows
   the retaken PNGs.
4. `npm run typecheck`, `npm test` — unchanged counts.
