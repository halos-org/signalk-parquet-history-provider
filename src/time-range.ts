import { Temporal } from "@js-temporal/polyfill";

interface TimeRangeParams {
  from?: Temporal.Instant;
  to?: Temporal.Instant;
  duration?: Temporal.Duration | number;
}

export interface ResolvedRange {
  from: string;
  to: string;
}

function toTemporalDuration(d: Temporal.Duration | number): Temporal.Duration {
  if (typeof d === "number") {
    return Temporal.Duration.from({ seconds: d });
  }
  return d;
}

export function resolveTimeRange(params: TimeRangeParams): ResolvedRange {
  const now = Temporal.Now.instant();
  // Tested for presence, not truthiness. A numeric 0 is a legitimate duration
  // — a client asking for a zero-length window — and under a truthiness test
  // every duration branch is skipped: `{from, duration: 0}` fell through to
  // the from-only branch and returned everything from `from` until now, and
  // `{to, duration: 0}` fell all the way through and threw.
  const hasDuration = params.duration !== undefined;

  if (params.from && params.to) {
    return { from: params.from.toString(), to: params.to.toString() };
  }

  if (params.from && hasDuration) {
    const dur = toTemporalDuration(params.duration!);
    const to = params.from.add(dur);
    return { from: params.from.toString(), to: to.toString() };
  }

  if (params.to && hasDuration) {
    const dur = toTemporalDuration(params.duration!);
    const from = params.to.subtract(dur);
    return { from: from.toString(), to: params.to.toString() };
  }

  if (params.from) {
    return { from: params.from.toString(), to: now.toString() };
  }

  if (hasDuration) {
    const dur = toTemporalDuration(params.duration!);
    const from = now.subtract(dur);
    return { from: from.toString(), to: now.toString() };
  }

  throw new Error("Invalid time range: provide at least from or duration");
}

export function durationToSeconds(d: Temporal.Duration | number): number {
  if (typeof d === "number") return d;
  return d.total({
    unit: "seconds",
    relativeTo: Temporal.Now.plainDateTimeISO(),
  });
}
