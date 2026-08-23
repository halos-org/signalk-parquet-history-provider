/**
 * When the next roll runs.
 *
 * Every N minutes from UTC midnight, which is why the interval has to divide
 * 1,440 — `normalizeConfig` refuses one that does not. The epoch is itself a
 * UTC midnight, so a grid of multiples of the interval from 0 lands on
 * midnight every day without the arithmetic ever naming a date.
 *
 * Anchoring to the clock rather than to the writer's start time is what makes
 * the tree's filenames predictable across a restart: a plugin restarted at
 * 09:58 still rolls at 10:00, not at 10:58.
 */

const MINUTE_MS = 60_000;
const DAY_MINUTES = 1440;

/** The next roll instant strictly after `now`. */
export function nextRollAt(now: number, intervalMinutes: number): number {
  const interval = intervalMs(intervalMinutes);
  // Strictly after: on a boundary the roll for that boundary has just run, and
  // returning it again would fire a second roll with nothing new in it.
  return Math.floor(now / interval) * interval + interval;
}

/** How long to wait for it, never negative. */
export function delayToNextRoll(now: number, intervalMinutes: number): number {
  return Math.max(0, nextRollAt(now, intervalMinutes) - now);
}

function intervalMs(intervalMinutes: number): number {
  if (
    !Number.isInteger(intervalMinutes) ||
    intervalMinutes < 1 ||
    DAY_MINUTES % intervalMinutes !== 0
  ) {
    throw new RangeError(
      `${intervalMinutes} minutes does not divide the day, so it names no schedule`,
    );
  }
  return intervalMinutes * MINUTE_MS;
}
