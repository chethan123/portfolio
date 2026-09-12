# README screenshots

Real app captures using invented data from [seed-demo.ts](../../scripts/seed-demo.ts).
The [root README](../../README.md) renders these files in light and dark themes.

## Retaking them

Use [capture-screenshots.ts](../../scripts/capture-screenshots.ts) with the
[development recipe](../developing.md#retake-screenshots-after-changing-a-screen).
It also captures the guide images. Use a separate demo database: the script creates a placeholder
passkey record and synthetic unlock grant, and refuses a database with other passkeys.

## Capture choices

- Desktop: 1600 × 1000; enough width for Holdings’ columns.
- Mobile: 390 × 900, not full-page. A full-page capture misplaces the fixed bottom navigation.
- Keep the unprotected-instance banner: the capture server has no OAuth gate.
- Show amounts except in masking examples. Never use real financial data.
- Owner-filtered Overview uses All so the withheld manual-history note appears.
- 1D shows one point per observed instant, not one point per refresh.
- Holdings correction uses a priced row with a basis. Frame the editor on desktop and the card
  on mobile.
- Upload review must show additions, updates, and a removal with its quantity and value.
- The unlocked captures use the synthetic grant. The unlock screen uses a separate browser
  without a grant; the placeholder credential is never used for a real assertion.

The script owns routes and filenames. Retake affected captures when a screen changes; do not
hand-edit images to match prose.
