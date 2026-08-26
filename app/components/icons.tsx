/**
 * The icon set, inline.
 *
 * The Stitch screens pull Material Symbols from a CDN. These replace it for
 * the same two reasons the fonts are self-hosted (DESIGN.md §13.7): an
 * offline-capable PWA cannot depend on a network round trip to render its own
 * navigation, and a household finance app should not announce each visit to a
 * third party.
 *
 * Every icon inherits `currentColor` and sits on a 24px grid at 1.75px stroke
 * with round caps — the new system's corners are round everywhere (§13.1), and
 * an icon set drawn with mitred corners reads as a different drawing.
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
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
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
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
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

/** Analysis. The mock's `analytics` — a ring with a slice taken out. */
export function AnalysisIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3a9 9 0 1 0 9 9h-9z" />
      <path d="M15.5 3.6A9 9 0 0 1 20.4 8.5L15.5 10z" />
    </Icon>
  );
}

/** Income. A coin with a rising mark. */
export function IncomeIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v10" />
      <path d="M14.5 9.5A2.5 2.5 0 0 0 12 8h-.4a2.1 2.1 0 0 0-.4 4.2h1.6a2.1 2.1 0 0 1-.4 4.2H12a2.5 2.5 0 0 1-2.5-1.5" />
    </Icon>
  );
}

/** Upload. A statement going in. */
export function UploadIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 16V4" />
      <path d="m7 9 5-5 5 5" />
      <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
    </Icon>
  );
}

export function DownloadIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 4v12" />
      <path d="m7 11 5 5 5-5" />
      <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
    </Icon>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </Icon>
  );
}

/** A brokerage or investment account — the mock's `account_balance`. */
export function AccountBalanceIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 10h18" />
      <path d="m12 3 9 5H3z" />
      <path d="M6 10v7M10 10v7M14 10v7M18 10v7" />
      <path d="M3 21h18" />
    </Icon>
  );
}

/** A cash or bank account — the mock's `savings`. */
export function SavingsIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 13a6 6 0 0 1 6-6h3a6 6 0 0 1 5.7 4.1l1.6.8a1 1 0 0 1 .5.9v1.4a1 1 0 0 1-1 1h-1.3A6 6 0 0 1 16 17v2a1 1 0 0 1-1 1h-1.5a1 1 0 0 1-1-1v-1h-2v1a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1v-2.3A6 6 0 0 1 4 13z" />
      <path d="M10 7V5.5a2 2 0 0 1 3-1.7" />
      <circle cx="16.5" cy="11.5" r=".75" fill="currentColor" stroke="none" />
    </Icon>
  );
}

/** A retirement account — the mock's `business_center`. */
export function RetirementIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
      <path d="M3 13h18" />
    </Icon>
  );
}

/** A liability. A card with a downward mark — debt, not a holding. */
export function LiabilityIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 10h18" />
      <path d="M8 15h4" />
    </Icon>
  );
}

export function TrendingUpIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m3 17 6-6 4 4 8-8" />
      <path d="M15 7h6v6" />
    </Icon>
  );
}

export function TrendingDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m3 7 6 6 4-4 8 8" />
      <path d="M15 17h6v-6" />
    </Icon>
  );
}

/** No movement. The mock's `horizontal_rule`, kept so a flat row still carries
 * a mark rather than reading as a missing one. */
export function TrendingFlatIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 12h16" />
    </Icon>
  );
}

export function ArrowUpIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 20V4" />
      <path d="m5 11 7-7 7 7" />
    </Icon>
  );
}

export function ArrowDownIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 4v16" />
      <path d="m5 13 7 7 7-7" />
    </Icon>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="m9 5 7 7-7 7" />
    </Icon>
  );
}

export function EditIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16z" />
      <path d="m13.5 6.5 4 4" />
    </Icon>
  );
}

/**
 * Masking, off — the state the screen is in, drawn as the eye that can see.
 *
 * Beside a text label like every other icon here, never instead of one: the
 * control it sits in is labelled with the action it will perform, and story 5
 * is explicit that a reader who has to infer the state from a glyph is one
 * click away from revealing their balances.
 */
export function VisibleIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
    </Icon>
  );
}

/** Masking, on. The same eye, struck through. */
export function HiddenIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M3 3l18 18" />
      <path d="M10.6 6.1A9.9 9.9 0 0 1 12 5.5c6.5 0 10 6.5 10 6.5a17 17 0 0 1-3.2 4" />
      <path d="M6.4 8A17 17 0 0 0 2 12s3.5 6.5 10 6.5a10 10 0 0 0 4-.8" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </Icon>
  );
}
