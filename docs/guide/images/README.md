# Guide images

Real app captures for the [user guide](../README.md), using the generated demo household.
These use light mode; the root README has separate light/dark pairs.

## Retaking them

[capture-screenshots.ts](../../../scripts/capture-screenshots.ts) captures both image sets.
Follow the [development recipe](../../developing.md#retake-screenshots-after-changing-a-screen)
with a separate demo database. The script plants a placeholder passkey record and synthetic grant;
it does not enrol a working passkey.

## Capture choices

- Use invented figures and keep the unprotected-instance banner.
- Desktop is 1600 × 1000. Phone captures are 390 × 900 and not full-page, so fixed navigation
  stays at the viewport edge.
- Capture each upload step, including unmapped and mapped columns and the removal review.
- Keep account type, owner, range, grouping, and masking consistent with the guide’s explanation.
- Capture the unlocked app with the synthetic grant and the unlock screen without one.

The script owns exact routes and filenames. Retake affected images after UI changes; never
hand-edit a capture.
