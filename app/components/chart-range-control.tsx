/**
 * Segmented range control (spec 0008) — one tree shared by Overview and the
 * account page. No JavaScript required: presets are plain links, Custom is
 * a native popover holding a GET form (falls back to an always-open card
 * where `popover` is unsupported — still a working form, never dead).
 * Every link names its range explicitly, even the default, since a bare `.`
 * would read back whatever the range cookie held instead. Disabled preset
 * is a `<span>`, never a dead `<Link>`. Every link carries the rest of the
 * query — a bare `?range=1m` would silently eat `?uploaded=`/`?recorded=`.
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
  custom?: CustomSpan;
  options: ReadonlyArray<{ key: RangeKey; label: string; disabled: boolean }>;
  customMin: IsoDate | null;
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
                {/* Chosen span, not "Custom" — see what's applied without reopening the picker (story 13). */}
                {applied ? `${custom.start} – ${custom.end}` : option.label}
              </button>

              <form method="get" id={popoverId} popover="auto" className="segmented-custom-form">
                <input type="hidden" name="range" value="custom" />
                {/* GET form submits only its own fields — the address's params must be re-emitted or applying a span drops them. */}
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
