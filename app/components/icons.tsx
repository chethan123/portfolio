/**
 * The icon set, inline.
 *
 * The Stitch screen pulled Material Symbols from a CDN. These replace it for
 * the same two reasons the fonts are self-hosted (DESIGN.md §13.3): an
 * offline-capable PWA cannot depend on a network round trip to render its own
 * navigation, and a household finance app should not announce each visit to a
 * third party.
 *
 * Every icon inherits `currentColor` and sits on a 24px grid at 1.5px stroke,
 * matching the chart line weight so the interface reads as one drawing.
 *
 * They are decorative throughout: each is `aria-hidden`, and every icon in the
 * app sits beside a real text label rather than standing in for one.
 */

type IconProps = { className?: string };

function Icon({ className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** Overview. Four panes — the dashboard itself. */
export function DashboardIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="3" width="7" height="9" />
      <rect x="14" y="3" width="7" height="5" />
      <rect x="14" y="12" width="7" height="9" />
      <rect x="3" y="16" width="7" height="5" />
    </Icon>
  );
}

/** Holdings. Bars against an axis. */
export function HoldingsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 3v18h18" />
      <path d="M7 17v-5" />
      <path d="M12 17V7" />
      <path d="M17 17v-8" />
    </Icon>
  );
}

/** Income. A yield curve rising off the axis. */
export function IncomeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 3v18h18" />
      <path d="M7 16c4 0 6-9 13-10" />
    </Icon>
  );
}

/** Upload. A statement going in. */
export function UploadIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 16V4" />
      <path d="M7 9l5-5 5 5" />
      <path d="M4 15v5h16v-5" />
    </Icon>
  );
}

/**
 * Settings. Sliders rather than a gear: at 18px a gear's teeth collapse into a
 * circle with a halo and read as a brightness control instead.
 */
export function SettingsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 7h11M18 7h3M3 17h5M12 17h9" />
      <rect x="14" y="4" width="4" height="6" />
      <rect x="8" y="14" width="4" height="6" />
    </Icon>
  );
}

/** The accounts panel. */
export function AccountBalanceIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 9l9-5 9 5" />
      <path d="M5 9v9M10 9v9M14 9v9M19 9v9" />
      <path d="M3 21h18" />
    </Icon>
  );
}

/**
 * The direction arrows.
 *
 * These are the redundant channel that §12 requires: the gain/loss pair is the
 * app's most important signal and it is carried on the axis of the most common
 * colour-vision deficiency, so the figure is readable — sign, then arrow, then
 * hue — without perceiving colour at all.
 */
export function TrendingUpIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 17l6-6 4 4 8-8" />
      <path d="M14 7h7v7" />
    </Icon>
  );
}

export function TrendingDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 7l6 6 4-4 8 8" />
      <path d="M14 17h7v-7" />
    </Icon>
  );
}
