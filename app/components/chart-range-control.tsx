/**
 * The segmented range control (spec 0008) — one JSX tree for Overview and
 * the account page, where two hand-copied `<nav>`s once stayed in step only
 * by memory.
 *
 * **No JavaScript required**: every fixed preset is a plain link naming its
 * own `range`; Custom is a native popover holding a GET form — a popover
 * because the top layer sits outside every ancestor's overflow, and the
 * phone strip is a scroll container that clipped the disclosure this once
 * was (`app.css` keeps the mechanism beside the rule). Where `popover` is
 * unsupported (Safari/iOS ≤ 16, Firefox < 125) the attribute is ignored, so
 * the form renders as an always-open card in the strip and the button does
 * nothing: still a working GET form, never a dead one.
 *
 * **Every link names its range explicitly, including the default.** With the
 * choice remembered in a cookie (spec 0008), a bare `.` would read back
 * whatever the cookie held instead of the default just clicked.
 *
 * **A disabled preset is a `<span>`, never a `<Link>`** — nothing to href it
 * to; a link the loader would just fall back from is worse than none.
 *
 * **Every link carries the rest of the query.** A bare `?range=1m` is a
 * whole query string and React Router resolves it as one — on the account
 * page that silently ate the `?uploaded=`/`?recorded=` receipts mid-read.
 * Which three parameters are the control's own to rewrite is
 * `chart-range.ts`'s to say, beside the function that reads them back.
 */
import { Fragment, useId } from "react";
import { Link, useSearchParams } from "react-router";

import { carriedParams, rangeSearch } from "~/lib/chart-range";

import type { CustomSpan, RangeKey } from "~/lib/chart-range";
import type { IsoDate } from "~/lib/valuation.server";

export function ChartRangeControl({
  range,
  custom,
  options,
  customMin,
  customMax,
}: {
  range: RangeKey;
  /** The applied custom span, present only when `range` is "custom". */
  custom?: CustomSpan;
  options: ReadonlyArray<{ key: RangeKey; label: string; disabled: boolean }>;
  /** This surface's own earliest-available date, or null where it has none yet. */
  customMin: IsoDate | null;
  /** Today — a custom span can never reach into the future. */
  customMax: IsoDate;
}) {
  const [params] = useSearchParams();
  const popoverId = useId();

  return (
    <nav className="segmented" aria-label="Chart range">
      {options.map((option) => {
        if (option.key === "custom") {
          const applied = range === "custom" && custom !== undefined;

          return (
            <Fragment key="custom">
              <button
                type="button"
                className="segmented-custom"
                popoverTarget={popoverId}
                aria-current={applied ? "true" : undefined}
              >
                {/* The chosen span, once there is one, not the word "Custom"
                    — story 13: tell what you are looking at without reopening
                    the picker. */}
                {applied ? `${custom.start} – ${custom.end}` : option.label}
              </button>

              <form method="get" id={popoverId} popover="auto" className="segmented-custom-form">
                <input type="hidden" name="range" value="custom" />
                {/* A GET form submits its own fields and nothing else, so
                    everything the address held must be re-emitted here or
                    applying a span drops it. */}
                {carriedParams(params).map(([name, value], index) => (
                  <input key={`${name}-${index}`} type="hidden" name={name} value={value} />
                ))}
                <label>
                  Start
                  <input
                    type="date"
                    name="start"
                    defaultValue={custom?.start}
                    min={customMin ?? undefined}
                    max={customMax}
                  />
                </label>
                <label>
                  End
                  <input
                    type="date"
                    name="end"
                    defaultValue={custom?.end}
                    min={customMin ?? undefined}
                    max={customMax}
                  />
                </label>
                <button type="submit" className="button button--quiet">
                  Apply
                </button>
              </form>
            </Fragment>
          );
        }

        if (option.disabled) {
          return (
            <span key={option.key} aria-disabled="true">
              {option.label}
            </span>
          );
        }

        return (
          <Link
            key={option.key}
            to={rangeSearch(params, option.key)}
            aria-current={option.key === range ? "true" : undefined}
            preventScrollReset
          >
            {option.label}
          </Link>
        );
      })}
    </nav>
  );
}
