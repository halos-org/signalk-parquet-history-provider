/**
 * The arithmetic behind the three-window method.
 *
 * Two rules the rest of the harness exists to obey. Counters are turned into
 * rates over an explicit interval, never over "however long the loop took".
 * And a result is a spread, never a point estimate: one number from one
 * 300-second window on one device invites a comparison it cannot support.
 */

export interface Dispersion {
  n: number;
  mean: number;
  min: number;
  max: number;
  /** Sample standard deviation. `null` below three values, where it says
   * nothing that min and max do not already say. */
  sd: number | null;
}

export function summarize(values: number[]): Dispersion {
  if (values.length === 0) {
    throw new Error("Cannot summarize an empty set of values");
  }
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd =
    n < 3
      ? null
      : Math.sqrt(
          values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (n - 1),
        );
  return { n, mean, min: Math.min(...values), max: Math.max(...values), sd };
}

/**
 * A monotonic kernel counter turned into a per-second rate.
 *
 * A counter that went backwards means the thing being measured was replaced —
 * a restarted process reusing a pid, a recreated cgroup — and the window's
 * rate is not recoverable. Throwing beats reporting a negative or a huge
 * positive rate as if it were a measurement.
 */
export function counterRate(
  start: number,
  end: number,
  seconds: number,
): number {
  if (seconds <= 0) throw new Error("A window must cover a positive interval");
  if (end < start) {
    throw new Error(
      `Counter went backwards (${start} to ${end}): the process or cgroup was replaced mid-window`,
    );
  }
  return (end - start) / seconds;
}

/**
 * How far the two halves of a window disagree, as a fraction of their mean.
 *
 * This is the steady-state check: a workload still warming up shows a large
 * drift, and its window mean describes a transition rather than a rate. Both
 * halves at zero is agreement, not a division by zero.
 */
export function driftFraction(firstHalf: number, secondHalf: number): number {
  const mean = (firstHalf + secondHalf) / 2;
  if (mean === 0) return 0;
  return Math.abs(secondHalf - firstHalf) / Math.abs(mean);
}

/** Default tolerance for the half-window check. Ten percent is loose enough
 * for a real vessel's traffic and tight enough to catch a warm-up. */
export const STEADY_TOLERANCE = 0.1;

/**
 * Below these values a metric is noise, and the relative drift between two
 * halves of a window says nothing: 0.17% of a core against 0.50% is a 100%
 * drift and a measurement of nothing. Without a floor every control column
 * carries the unsteady marker, which teaches the reader to ignore it exactly
 * where it matters.
 */
export const NOISE_FLOOR: Record<string, number> = {
  "% of one core": 1,
  "KB/s": 1,
  "/s": 1,
};

/** True when the window's halves agree closely enough to call it steady, or
 * when both are small enough that their disagreement is noise. */
export function isSteady(
  firstHalf: number,
  secondHalf: number,
  tolerance: number,
  noiseFloor: number,
): boolean {
  if (firstHalf < noiseFloor && secondHalf < noiseFloor) return true;
  return driftFraction(firstHalf, secondHalf) <= tolerance;
}

export function formatDispersion(d: Dispersion, digits = 2): string {
  const f = (v: number) => v.toFixed(digits);
  if (d.n === 1) return f(d.mean);
  return `${f(d.mean)} (${f(d.min)}–${f(d.max)})`;
}
