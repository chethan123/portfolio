// Pure derivation (spec price-health/03) — no database, no timers, no globalThis: every branch is a
// table over plain `PollerSnapshot`/`TickObservation` values, with `now` an ordinary argument.
import { describe, expect, it } from "vitest";

import { OVERDUE_GRACE_MINUTES, pricingHealth } from "~/lib/price-health";

import type { PollerSnapshot, PricingHealth, TickObservation, WorkerReachability } from "~/lib/price-health";

const NOW = new Date("2026-06-04T15:00:00Z");
const MINUTES = 15;
const CADENCE_MS = MINUTES * 60_000;
const GRACE_MS = OVERDUE_GRACE_MINUTES * 60_000;

function snapshot(overrides: {
  running?: boolean;
  msSinceLastTick?: number;
  minutes?: number;
  lastObservation?: TickObservation;
}): NonNullable<PollerSnapshot> {
  return {
    running: overrides.running ?? false,
    lastTickStartedAt: new Date(NOW.getTime() - (overrides.msSinceLastTick ?? 0)),
    minutes: overrides.minutes ?? MINUTES,
    lastObservation: overrides.lastObservation,
  };
}

const QUOTED = (
  requested: number,
  priced: number,
  providerFailed = false,
): TickObservation => ({ outcome: "quoted", requested, priced, providerFailed });

describe("pricingHealth's scheduler category", () => {
  it("is not_started with no poller slot in this process", () => {
    expect(pricingHealth(undefined, "available", NOW).scheduler).toBe("not_started");
  });

  it("is on_schedule when armed, nothing in flight, and not yet due", () => {
    expect(pricingHealth(snapshot({ msSinceLastTick: 0 }), "available", NOW).scheduler).toBe(
      "on_schedule",
    );
  });

  it("is on_schedule four minutes into a fifteen-minute cadence", () => {
    const late = snapshot({ msSinceLastTick: 4 * 60_000 });
    expect(pricingHealth(late, "available", NOW).scheduler).toBe("on_schedule");
  });

  it("is not yet overdue at exactly cadence plus the five-minute grace", () => {
    const atTheBoundary = snapshot({ msSinceLastTick: CADENCE_MS + GRACE_MS });
    expect(pricingHealth(atTheBoundary, "available", NOW).scheduler).toBe("on_schedule");
  });

  it("is overdue one millisecond past cadence plus the five-minute grace", () => {
    const pastTheBoundary = snapshot({ msSinceLastTick: CADENCE_MS + GRACE_MS + 1 });
    expect(pricingHealth(pastTheBoundary, "available", NOW).scheduler).toBe("overdue");
  });

  it("is running for a tick in flight that is not late", () => {
    const inFlight = snapshot({ running: true, msSinceLastTick: 60_000 });
    expect(pricingHealth(inFlight, "available", NOW).scheduler).toBe("running");
  });

  it("is overdue, not running, for a tick in flight that has run past cadence plus grace", () => {
    // The ordering under test: `overdue` must win even though `running` is also true, because
    // `running` is cleared only in the tick's own `finally` and the tick itself has no timeout —
    // a hung tick must not report `running` forever.
    const hung = snapshot({ running: true, msSinceLastTick: CADENCE_MS + GRACE_MS + 1 });
    expect(pricingHealth(hung, "available", NOW).scheduler).toBe("overdue");
  });

  it("moves the overdue boundary when the cadence itself was retimed", () => {
    const movedCadence = 60;
    const stillOnSchedule = snapshot({
      minutes: movedCadence,
      msSinceLastTick: (movedCadence + OVERDUE_GRACE_MINUTES) * 60_000,
    });
    expect(pricingHealth(stillOnSchedule, "available", NOW).scheduler).toBe("on_schedule");

    const nowOverdue = snapshot({
      minutes: movedCadence,
      msSinceLastTick: (movedCadence + OVERDUE_GRACE_MINUTES) * 60_000 + 1,
    });
    expect(pricingHealth(nowOverdue, "available", NOW).scheduler).toBe("overdue");
  });
});

describe("pricingHealth's quotes category", () => {
  it("is not_attempted with no poller slot at all", () => {
    expect(pricingHealth(undefined, "available", NOW).quotes).toBe("not_attempted");
  });

  it("is not_attempted with a poller slot that has not yet recorded an observation", () => {
    expect(pricingHealth(snapshot({}), "available", NOW).quotes).toBe("not_attempted");
  });

  it("is market_closed for a tick that deliberately skipped quotes", () => {
    const closed = snapshot({ lastObservation: { outcome: "market_closed" } });
    expect(pricingHealth(closed, "available", NOW).quotes).toBe("market_closed");
  });

  it("is unknown for a tick an internal or database error stopped", () => {
    const errored = snapshot({ lastObservation: { outcome: "error" } });
    expect(pricingHealth(errored, "available", NOW).quotes).toBe("unknown");
  });

  it("is ok for the valid zero-instrument case, with no clause of its own", () => {
    const empty = snapshot({ lastObservation: QUOTED(0, 0) });
    expect(pricingHealth(empty, "available", NOW).quotes).toBe("ok");
  });

  it("is ok when every selected instrument was priced", () => {
    const allPriced = snapshot({ lastObservation: QUOTED(3, 3) });
    expect(pricingHealth(allPriced, "available", NOW).quotes).toBe("ok");
  });

  it("is partial when some, but not every, selected instrument was priced", () => {
    const somePriced = snapshot({ lastObservation: QUOTED(3, 1) });
    expect(pricingHealth(somePriced, "available", NOW).quotes).toBe("partial");
  });

  it("is failed when instruments were requested and none was priced", () => {
    const nonePriced = snapshot({ lastObservation: QUOTED(3, 0) });
    expect(pricingHealth(nonePriced, "available", NOW).quotes).toBe("failed");
  });

  it("is failed for a provider-wide failure even if some prices somehow came back", () => {
    const providerFailed = snapshot({ lastObservation: QUOTED(3, 3, true) });
    expect(pricingHealth(providerFailed, "available", NOW).quotes).toBe("failed");
  });
});

describe("pricingHealth's ok rollup", () => {
  const CASES: Array<{ name: string; worker: WorkerReachability; snap: PollerSnapshot; expected: boolean }> = [
    { name: "worker available, on_schedule, ok quotes", worker: "available", snap: snapshot({ lastObservation: QUOTED(1, 1) }), expected: true },
    { name: "worker available, running, not_attempted quotes", worker: "available", snap: snapshot({ running: true }), expected: true },
    { name: "worker available, on_schedule, market_closed quotes", worker: "available", snap: snapshot({ lastObservation: { outcome: "market_closed" } }), expected: true },
    { name: "worker unavailable", worker: "unavailable", snap: snapshot({ lastObservation: QUOTED(1, 1) }), expected: false },
    { name: "scheduler not_started", worker: "available", snap: undefined, expected: false },
    { name: "scheduler overdue", worker: "available", snap: snapshot({ msSinceLastTick: CADENCE_MS + GRACE_MS + 1 }), expected: false },
    { name: "quotes partial", worker: "available", snap: snapshot({ lastObservation: QUOTED(3, 1) }), expected: false },
    { name: "quotes failed", worker: "available", snap: snapshot({ lastObservation: QUOTED(3, 0) }), expected: false },
    { name: "quotes unknown", worker: "available", snap: snapshot({ lastObservation: { outcome: "error" } }), expected: false },
  ];

  it.each(CASES)("is $expected for $name", ({ worker, snap, expected }) => {
    expect(pricingHealth(snap, worker, NOW).ok).toBe(expected);
  });

  it("is always one of exactly the published closed-set values, never a stray shape", () => {
    const result: PricingHealth = pricingHealth(snapshot({ lastObservation: QUOTED(1, 1) }), "available", NOW);
    expect(Object.keys(result).sort()).toEqual(["ok", "quotes", "scheduler", "worker"]);
  });
});
