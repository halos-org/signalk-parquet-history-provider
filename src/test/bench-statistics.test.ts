import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  NOISE_FLOOR,
  counterRate,
  driftFraction,
  formatDispersion,
  isSteady,
  summarize,
} from "../bench/statistics.js";

describe("summarize", () => {
  it("reports the spread, not only the mean", () => {
    const d = summarize([2.1, 2.3, 2.5]);
    assert.equal(d.n, 3);
    assert.ok(Math.abs(d.mean - 2.3) < 1e-9);
    assert.equal(d.min, 2.1);
    assert.equal(d.max, 2.5);
    assert.ok(d.sd !== null && Math.abs(d.sd - 0.2) < 1e-9);
  });

  it("withholds a standard deviation below three values", () => {
    // Two windows give a spread that min and max already state; an sd from
    // n=2 dresses it up as more than it is.
    assert.equal(summarize([1, 2]).sd, null);
    assert.equal(summarize([1]).sd, null);
  });

  it("throws on an empty set", () => {
    assert.throws(() => summarize([]));
  });
});

describe("counterRate", () => {
  it("turns a counter difference into a per-second rate", () => {
    assert.equal(counterRate(1000, 4000, 300), 10);
  });

  it("throws when a counter goes backwards", () => {
    // A pid reused by a restarted process, or a recreated cgroup. The window
    // is not recoverable, and a negative or enormous rate would be reported
    // as if it were a measurement.
    assert.throws(() => counterRate(4000, 1000, 300), /backwards/);
  });

  it("throws on a non-positive interval", () => {
    assert.throws(() => counterRate(0, 10, 0));
  });
});

describe("driftFraction", () => {
  it("is zero when the halves agree", () => {
    assert.equal(driftFraction(2.5, 2.5), 0);
  });

  it("scales the disagreement by the mean", () => {
    assert.ok(Math.abs(driftFraction(2, 3) - 0.4) < 1e-9);
  });

  it("treats two zeroes as agreement rather than dividing by zero", () => {
    assert.equal(driftFraction(0, 0), 0);
  });

  it("catches a workload still warming up", () => {
    // 1.0 in the first half, 3.0 in the second: the window mean of 2.0
    // describes neither state.
    assert.ok(driftFraction(1, 3) > 0.1);
  });
});

describe("isSteady", () => {
  const floor = NOISE_FLOOR["% of one core"];

  it("accepts halves that agree within the tolerance", () => {
    assert.equal(isSteady(23.1, 23.4, 0.1, floor), true);
  });

  it("rejects halves that disagree beyond it", () => {
    assert.equal(isSteady(10, 40, 0.1, floor), false);
  });

  it("does not call noise unsteady", () => {
    // 0.17% of a core against 0.50% is a 100% drift and a measurement of
    // nothing. Flagging it puts a marker on every control column, which
    // teaches the reader to ignore the marker where it matters.
    assert.ok(driftFraction(0.17, 0.5) > 0.1);
    assert.equal(isSteady(0.17, 0.5, 0.1, floor), true);
  });

  it("still flags a real change that crosses the floor", () => {
    assert.equal(isSteady(0.5, 12, 0.1, floor), false);
  });

  it("has a floor for every unit the harness reports rates in", () => {
    assert.deepEqual(Object.keys(NOISE_FLOOR).sort(), [
      "% of one core",
      "/s",
      "KB/s",
    ]);
  });
});

describe("formatDispersion", () => {
  it("shows the range alongside the mean", () => {
    assert.equal(
      formatDispersion(summarize([2.1, 2.3, 2.5])),
      "2.30 (2.10–2.50)",
    );
  });

  it("shows a single window as one number", () => {
    assert.equal(formatDispersion(summarize([2.1])), "2.10");
  });
});
