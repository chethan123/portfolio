# Opening the app for the first time

What a brand-new instance shows you, and the two things to do before it can hold anything.

![The Overview before anything is recorded](images/first-run-overview.png)

Open the address whoever runs the instance gave you. You land on **Overview**, and it says
**There is no data yet.** That is correct on a fresh instance: nothing has been uploaded, so no
figure is shown.

## If a warning strip says the instance has no password

**This instance has no password.** Anyone who can reach it can read and change your data. Set
`AUTH_PASSWORD` (and `SESSION_SECRET`) to put it behind a login.

That strip sits on every page and cannot be dismissed. Nothing you can do in the app removes it —
a password is set by whoever runs the instance, not from a screen in here. Ask them, and point them
at [Operating an instance](../operating.md#environment-variables).

## If you get a sign-in screen instead

The instance is password protected. Type the password and select **Sign in**. There is no username.

Three things that are not there, so you do not go looking:

- **No sign-up.** There is one password for the whole household, not an account each.
- **No password reset.** A forgotten password is changed by whoever runs the instance.
- **No sign-out control.** Signing in lasts about a month, then asks again. To end a session sooner,
  clear the site's cookies in your browser.

A wrong password comes back as **Incorrect password.** and nothing else.

## The "Start here" prompt

A highlighted card sits above every page until the instance is set up:

> **Start here.** Nothing is recorded yet. Add the people in your household under
> Settings → People — every account belongs to exactly one of them.

Do that, and it changes to **One more step**, pointing at Settings → Accounts. Once at least one
person and one account exist, it disappears for good.

It goes away at that point, **not** after your first upload. An instance with accounts and no
statements is set up and waiting, so there is nothing left to prompt about.

The prompt is not dismissible, and it is hidden while you are inside Settings — it would be telling
you to go where you already are.

## Getting around

Down the left side:

- **Overview** — net worth, the trend line, and every account.
- **Holdings** — every position you hold, filtered and grouped any way you ask.
- **Analysis** — the same total broken down by person, account type and asset class.
- **Income** — what the portfolio is projected to pay over the coming year, and how much of that
  is taxed.

Like Overview and Analysis, Income draws nothing until a statement has been uploaded: one sentence
saying so, and no ring, no zero and no empty chart frame. An instance with nothing in it and a
portfolio that genuinely pays nothing must not look alike.

**Settings** sits on its own at the foot, with the **Show amounts** / **Hide amounts** control
beneath it, and the filled **Upload statement** button below that is how a statement gets in.

## If every amount shows as dots

Amounts start hidden on a browser nobody has answered for: each shows a run of dots, while names,
dates and the shape of the chart stay readable. Press **Show amounts** in the navigation to reveal
them on this browser; hiding them again is the same control. What a fresh browser opens showing is
a household choice at [Settings → Display](settings.md#display). It is a defence against being read
over your shoulder, not a lock — the password above is the only thing that keeps anyone out.

## Light and dark

The app follows whatever your device is set to. There is no toggle in the app, and nothing to
configure — switch your system between light and dark and the next page you open matches.

## On a phone

The left rail becomes a bar across the bottom with the same items in it, and tables reflow to fit.
Nothing is held back on a small screen: adding people, adding accounts, setting a balance and the
whole of Settings all work from a phone.

You can bookmark the address to your home screen like any other page. There is no installable app —
if you were expecting one to be offered, [Installing on a phone](../operating.md#installing-on-a-phone)
explains why it is not.

---

**Next:** [People and accounts](people-and-accounts.md) — add the household, then what it owns.
