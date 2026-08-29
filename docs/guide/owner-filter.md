# Reading a screen as one owner

Four screens show the household's money: Overview, Holdings, Analysis and Income. Any of them can be
read as one person instead — or as two of five, or as everyone but one.

![Holdings narrowed to one owner](images/holdings-owner.png)

## How to narrow

The control sits at the top right of each of those four screens, beside the "As of" line. It is a
tick box per person and an **Apply** button.

1. Tick one or more names.
2. Press **Apply**.

Everything on the screen is now those people's: the total, the chart, every table, every ring, every
subtotal.

**To widen again**, press **Show everyone**, which appears beside Apply once something is ticked.
Ticking every name does the same thing — everybody is the household, so the app treats it as no
filter at all and tidies the address to match.

## It follows you between screens

Narrow on Holdings, click **Analysis**, and Analysis is narrowed too. That is the point: "what does
this look like for just Alex?" is a question you hold while you move around, not a property of one
page.

Three places deliberately do not follow:

- **An account's own page** is already one account, which has exactly one owner. There is nothing
  left to narrow, so no control is drawn.
- **Settings** and **Uploading a statement** are about records rather than about money. They ignore
  the filter, and the links to them do not carry it — so a trip into either ends the reading and you
  set it again on the way back.

## It lasts as long as the address does

The whole of the filter is in the address bar, as `?owner=3` or `?owner=1,3`. Nothing is stored.

- **Reload, bookmark or share it** and you get the same reading. Sending the address to the other
  person in the household shows them exactly what you were looking at.
- **Close the tab and it is gone.** Opening the app fresh — or typing an address by hand — starts
  with everyone, every time.

## It is about noise, not privacy

**Everyone sees everything.** Anyone can set the filter, clear it, and set it to anybody. It narrows
what is *shown*; it decides nothing about what may be *seen*. The Google sign-in at the front door
is the only thing that keeps anyone out.

It is also never chosen for you. The app does not know which person you are — a person here is a
name on an account and nothing else, with no e-mail and no login attached — so a screen never opens
on "your" money. It opens on the household's, and you say if you want less.

## Two things a narrowed screen does differently

**It says who it is showing**, in words, beside the figure it narrowed: *"Showing Alex Rivera
only."* Holdings also adds `· filtered from 18` to its count. A filter that follows you between
screens is a filter you can forget you set, and a total that quietly means something else is worse
than no total.

**The Overview chart cannot reach as far back.** Any hand-typed history from before the app existed
is the household's — there is no owner on it — so a narrowed chart does not draw it and starts at
the selected people's first recorded holdings instead. **All** gets shorter, and the long ranges may
grey out. A note above the line says so, rather than leaving you with a line that starts
suspiciously late. See [Overview](overview.md#the-second-dashed-line).

## When a narrowed screen is empty

Two different things, and the screen tells them apart.

- **"Alex holds nothing that has been recorded here."** They are in the household and this reading
  reaches nothing of theirs. Not an error, and everything else is still there — **Show everyone**
  brings it back.
- **"This view is set to an owner the household can no longer be read as."** The address names
  somebody who has since been removed, or somebody whose accounts have all been closed. Show
  everyone, or pick a name from the control, which is still on screen.

Neither of those is the first-run message. "Nothing has been uploaded to this instance yet" appears
only when that is true.

## Who appears in the list

Everyone who owns at least one **open** account. Somebody whose accounts have all been closed is not
offered, because the screens would come back empty with nothing explaining why — their figures are
still in the household's totals and their history is still recorded, they simply cannot be picked
out with this control. A household with only one owner gets no control at all: there is nothing to
choose between.

---

**Next:** [Overview](overview.md#the-second-dashed-line) — the chart, and why a narrowed one starts
later.
