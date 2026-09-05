# Passkeys and the lock

A browser can go from showing you everything to showing you nothing, with no warning beyond what
this page explains — and no password, ever, is what unlocks it again. This is what that is, in the
household's own words: what it means to be locked, how to get back in, and what to know before
anyone turns it on. If you are looking at a locked screen right now, unlocking happens right there —
its one control is the whole of what you need, and the next section says what to expect from it.
Everything about managing a passkey instead — enrolling one, seeing what the household holds,
removing one — lives in Settings → Passkeys, reachable only once a browser is already unlocked.

## Being locked

**Locked** is a fact about one browser, at one moment — never about you, and never about the
household. Once anybody has enrolled a passkey, every browser that reaches this app is refused every
screen until it proves itself with its own passkey check — even a browser that signed in through
Google a minute ago. Signing in again does not clear it: the sign-in at the front door and this
check answer different questions, and passing one does nothing for the other.

And it is one browser at a time. Unlocking your phone does nothing for your laptop, or for anyone
else's phone — each stays exactly as locked or unlocked as it already was.

## Setting it up: the first passkey

**The one thing most worth knowing before you press anything: enrolling the household's first
passkey locks every other browser in the household, immediately.** Not eventually — the moment it is
created. The screen tells you this before you finish, and it is not a warning to brush past: from
that instant, every other phone and laptop in the house is locked, and will ask to be unlocked the
next time anyone opens it. Only the browser doing the enrolling is spared.

Enrolling that very first passkey skips only one thing every later one needs: checking in with a
passkey you already have, first — there is nothing yet to check yourself against. It still takes two
presses of its own. The first asks for nothing more than a label and ticking that you understand what
you are about to do; the second is the one that actually makes it — your browser and whatever holds
your passkeys work together right there, the same handshake any passkey is made with, and it is the
one you will actually notice happening. Every passkey after the first, and every removal, needs that
check-in-with-a-passkey step before it even reaches that second press (see below).

## What a passkey actually is

A passkey is not the same thing as a device, in either direction.

A phone's own passkey usually lives in a vault it is signed into — iCloud Keychain, Google Password
Manager, whatever your family already uses — and a vault like that can hand the very same passkey to
every device signed into it. Set one up on your phone, and a tablet or laptop signed into the same
account may be able to answer for it too, with nothing separate to create there.

The other way round is narrower than it sounds: a single device can hold more than one passkey, but
usually only when a different provider makes the second one, or a separate authenticator sits
alongside the device's own vault. Asking the same vault for a second passkey for this app usually
does not work — it already recognises this app from the first and refuses to create another, rather
than quietly making a second. Settings → Passkeys lists each one the household holds, and marks
whether it is the kind that *can* be handed to your other devices that way, or whether it is tied to
the one device that made it.

**That mark is not proof a second copy exists anywhere.** It says the provider holding this passkey
is capable of syncing it, not that it actually has — a passkey made on a device you never signed
anything else into is exactly as stuck as one that could never sync at all, the moment that one
device is lost. Do not read it as "there is a spare somewhere" and stop there. **A household should
enrol a second passkey regardless** — from a different device if at all possible — so that losing the
first one never leaves nothing to unlock with.

## Unlocking a browser

A locked browser shows exactly one control: **Unlock**. Press it, and whatever holds your passkey —
your phone's own vault, or a password manager — decides what happens next, not this app. Often that
is the same check you would expect it to run for anything else. But if that vault is already
unlocked, it may hand back a completed check with nothing asked of you at all — no prompt, nothing to
approve, straight through. That is not a corner this app is cutting: nothing about a passkey check,
anywhere, can be made to always ask first, so this is the honest limit of what pressing **Unlock**
can promise.

Which is the thing worth actually carrying with you: **this lock is only ever as strong as whatever
already unlocks that passkey provider on that device.** A phone sitting unlocked in someone else's
hands, with its own vault already open, answers **Unlock** the same way it would for you. Narrowing
that risk is what this feature is for — it is not a promise that it closes it.

If this particular device does not hold a passkey the household has enrolled, it can still ask a
different one for help. Your browser offers a way to reach another device — usually by scanning
something with the phone or laptop that does hold one — and approving it there is what unlocks the
browser you started on.

If the check is dismissed, or it does not finish, nothing has changed and nothing is lost — press
**Unlock** and try again.

## When it locks itself, and locking it yourself

A browser does not stay unlocked forever on its own say-so, even if nobody ever presses **Lock now**.

**Going untouched for a while is enough by itself.** Somewhere between about seven and a half and
fifteen minutes with nobody asking this app for anything, and it is locked again, waiting for another
check — exactly how long depends on where in that stretch the last ask fell. Ordinary use — reading a
screen, opening another — keeps pushing that moment further off, so a browser you are actually using
stays unlocked; one left open and forgotten does not.

**Stepping away for around a minute does the same, sooner.** Switch away to another app or tab, or
lock your phone, for about that long, and coming back to this one asks the app to lock it right
away — even if the fifteen-minute clock above still had plenty of time left. That ask has to reach
the app before the lock actually takes hold, so on a slow connection, or with none at all, whatever
was already on the screen can stay up longer than you would expect, until it does. That is
deliberate, not a glitch: a browser left behind and unlocked, even briefly, is exactly the situation
this feature exists to close off.

Neither of those needs you to do anything, and neither is a fault if it catches you off guard the
first few times — it is the lock doing its job while you were not looking, not a random failure. **Lock
now**, beside **Show amounts** in the navigation, is the one you control directly, and it does not wait
on either clock — but pressing it is itself a request to the app, the same as the automatic checks
above, so on a slow connection, or with none at all, whatever was already on the screen can stay up a
moment longer than you would expect before it actually locks. Handing your phone to someone, even for a
minute, is exactly when to press it first.

## Removing a passkey

Removing one is not like anything else in this app: it deletes that passkey outright, and there is
no undo. Because of that, a removal asks for its own fresh passkey check first — being unlocked
already is not enough on its own. That is deliberate: a phone that is unlocked but not, right now,
in your own hands should not also be able to get rid of everyone else's way in.

It cuts the other way too, though. If the household holds only one passkey and it becomes
unreachable — lost, broken, simply not at hand — nobody can remove it, because there is nothing else
left to check in with. **A household on exactly one passkey should enrol a second soon after the
first**, from any browser that is already unlocked, so that losing one still leaves a way to revoke
it from the other.

## Removing the last one turns the lock off

There is no separate switch anywhere for this. The instance is locked whenever the household holds
at least one passkey, and it is open the moment it holds none — so removing the very last passkey
does not strand anyone. It turns the lock off entirely: every browser opens straight to its figures
again, exactly as a brand-new instance would, until somebody enrols a passkey once more.

## If a browser cannot run the check at all

Some browsers — most often one opened from inside another app, rather than your everyday one —
cannot run a passkey check at all, and nothing you press changes that.

If that happens: first try the same address in an ordinary browser on the same device. If that does
not help either, try a different device — one that already holds a passkey the household has
enrolled, or is signed into the same vault as one. If neither gets you in, ask whoever set this app
up for your household to help you back in.

---

**Next:** back to [the guide index](README.md).
