/**
 * The segmented range control (spec 0008).
 *
 * Was two hand-copied `<nav>`s, one per route, in step only because someone
 * remembered to keep them that way. Both call in here now, so the eight
 * presets and Custom render identically on Overview and the account page with
 * one JSX tree to change.
 *
 * **No JavaScript required.** Every fixed preset is a plain link naming its
 * own `range`; Custom is a native `<details>` disclosure holding a GET form
 * that names `range=custom` and a `start`/`end` pair. Both work with scripting
 * off, which is the same contract the four-preset control already kept, and
 * both carry the rest of the query — see below.
 *
 * **Every link names its range explicitly, including the default.** The old
 * four-option control linked the default preset to `.`, stripping the query
 * string, because there was nothing to remember yet. Now that a choice is
 * remembered in a cookie (spec 0008), a bare `.` would read back whatever the
 * cookie already held instead of the default just clicked — so every option,
 * default included, links to its own `?range=` and lets the loader's explicit
 * request win.
 *
 * **A disabled preset is a `<span>`, never a `<Link>`.** Nothing to href it
 * to: the surface has no data before that boundary, and a link the loader
 * would just fall back from is worse than no link at all.
 *
 * **Every link carries the rest of the query.** A bare `?range=1m` is a whole
 * query string, and React Router resolves it as one — so the link replaced
 * everything else the address held. On the account page that silently ate the
 * `?uploaded=` and `?recorded=` receipts: record a statement, read the
 * confirmation, click 1M, and the sentence you were reading was gone. Both
 * the presets and Custom therefore start from the params already there.
 * Which three parameters are the control's own to rewrite is
 * `chart-range.ts`'s to say, beside the function that reads them back.
 */
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

  return (
    <nav className="segmented" aria-label="Chart range">
      {options.map((option) => {
        if (option.key === "custom") {
          const applied = range === "custom" && custom !== undefined;

          return (
            <details key="custom" className="segmented-custom">
              <summary aria-current={applied ? "true" : undefined}>
                {/* The chosen span, once there is one, rather than the word
                    "Custom" — story 13: a reader should be able to tell what
                    they are looking at without reopening the picker. */}
                {applied ? `${custom.start} – ${custom.end}` : option.label}
              </summary>

              <form method="get" className="segmented-custom-form">
                <input type="hidden" name="range" value="custom" />
                {/* A GET form submits its own fields and nothing else, so
                    everything the address already held has to be re-emitted
                    here or applying a span drops it. */}
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
            </details>
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
