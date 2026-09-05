# Passkeys and the lock

A browser can go from showing you everything to showing you nothing, with no warning beyond what
this page explains — and no password, ever, is what unlocks it again. This is what that is, in the
household's own words: what it means to be locked, how to get back in, and what to know before
anyone turns it on. All of it lives in one place, Settings → Passkeys, whether you are looking at a
locked screen right now or you are the one about to set the lock up for the first time.

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

Enrolling that very first passkey asks nothing of you beyond a label and ticking that you understand
what it is about to do — there is nothing yet to check yourself against. Every passkey after the
first, and every removal, is different: each one asks you to check in with a passkey again first,
right there (see below).

## What a passkey actually is

A passkey is not the same thing as a device, in either direction.

A phone's own passkey usually lives in a vault it is signed into — iCloud Keychain, Google Password
Manager, whatever your family already uses — and a vault like that can hand the very same passkey to
every device signed into it. Set one up on your phone, and a tablet or laptop signed into the same
account may be able to answer for it too, with nothing separate to create there.

The other way round holds as well: one single device can hold more than one passkey, if more than
one person has set theirs up there, or if you made a second one on it on purpose. Settings →
Passkeys lists each one the household holds, and says for each whether it is synced like that or
bound to the one device that made it — which is how you actually tell how strong any one of them is,
rather than guessing.

## Unlocking a browser

A locked browser shows exactly one control: **Unlock**. Press it, and your device asks whatever it
normally asks to prove it is you — its own prompt, whatever that looks like here. Nothing new to
remember, and no separate password: your device already knows how to check you.

If this particular device does not hold a passkey the household has enrolled, it can still ask a
different one for help. Your browser offers a way to reach another device — usually by scanning
something with the phone or laptop that does hold one — and approving it there is what unlocks the
browser you started on.

If the check is dismissed, or it does not finish, nothing has changed and nothing is lost — press
**Unlock** and try again.

## Locking a browser yourself

You do not have to wait for it to happen on its own. **Lock now**, beside **Show amounts** in the
navigation, locks this one browser immediately. Handing your phone to someone, even for a minute, is
exactly when to press it first.

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
