# Spec 0010 — before/after captures

Proof shots for the chart point readout pull request, per the layout table's
`specs/<slice>/screenshots/` row. This directory is deleted once that pull
request merges; the lasting images are the README's and the guide's, retaken
in the same change.

## Before

Hovering does nothing, and nothing on the chart says what a point is worth:

![Before: the chart panel with no readout](before-overview-hover-light.png)

## After

At rest, the strip captions the last plotted point, agreeing with the headline
digit for digit:

![After: resting readout naming the last point](after-overview-resting-light.png)

Pointing moves the readout to the nearest point and the guide says which:

![After: hover readout with vertical guide](after-overview-hover-light.png)

A hand-typed pre-app point says so in words (far left of the All range):

![After: hand-typed point marked in the readout](after-overview-hover-hand-typed-light.png)

Masked, the amount is the shared dots, the date stays, and the interaction
keeps working:

![After: masked readout with dotted amount](after-overview-hover-masked-light.png)

Dark theme — the guide and the strip resolve from the theme's tokens:

![After: dark-theme hover readout](after-overview-hover-dark.png)

An account page: same strip, same place, never a hand-typed mark:

![After: account page hover readout](after-account-hover-light.png)

A phone: a tap pins the readout:

![After: tap-pinned readout on a phone](after-overview-tap-pinned-mobile.png)
