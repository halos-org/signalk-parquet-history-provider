import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DiskCounters } from "./proc.js";
import {
  Dispersion,
  NOISE_FLOOR,
  STEADY_TOLERANCE,
  counterRate,
  driftFraction,
  isSteady,
  summarize,
} from "./statistics.js";
import { Counters, Sampler, SubjectSpec, subjectTarget } from "./subjects.js";

/**
 * The three-window method, in one place so every unit that reports a number
 * reports it the same way.
 *
 * Settle first, then N equal windows. Each window is differenced end to end
 * for its rate, and split in half for a steadiness check: two halves that
 * disagree mean the window measured a transition, and its mean describes
 * nothing. Gauges (memory) are sampled through the window instead, because a
 * difference of two memory readings is not a rate.
 *
 * Rates divide by the interval actually observed between the two counter
 * reads, never by the requested window length. Those differ by the sleep's
 * overshoot plus every /proc read in between, and they differ MORE under load
 * — which is when this runs. Dividing by the nominal value would inflate every
 * rate, and inflate the loaded condition more than the control, biasing the
 * one comparison the harness exists to make.
 *
 * The clock, the sleep and the sampler are all injected. The window
 * arithmetic and the half-window split are exactly where this can be wrong,
 * and neither is testable against a real 300-second window.
 */

export interface MetricResult {
  unit: string;
  perWindow: number[];
  dispersion: Dispersion;
  /**
   * One entry per window: how far its halves disagreed, as a fraction.
   * `null` where no half-window split exists — a gauge has no rate to halve,
   * and /proc/diskstats is read only at the window boundaries. Distinguishing
   * that from "the halves agreed" matters: reporting zero drift and
   * `steady: true` for a metric nobody split is a claim the data cannot
   * support.
   */
  halfWindowDrift: number[] | null;
  /** False when a window's halves disagreed by more than the tolerance;
   * `null` when the metric has no half-window split. */
  steady: boolean | null;
  /** Gauges only: the highest single reading across the whole run. Reported
   * separately from the mean because a transient peak and a 24/7 cost are
   * not the same quantity and must never be summed. */
  peak?: number;
}

export interface SubjectResult {
  name: string;
  kind: "pid" | "cgroup" | "system";
  target: string;
  metrics: Record<string, MetricResult>;
}

/**
 * Bumped whenever `RunResult`'s shape changes.
 *
 * These files are written by one unit and read by another months later, so
 * `bench compare` needs a way to refuse a file it no longer understands rather
 * than rendering it wrong — a missing field reads as an absent measurement,
 * which is indistinguishable from a real one.
 */
export const RESULT_FORMAT_VERSION = 1;

export interface RunResult {
  formatVersion: number;
  /** The version of this package that took the measurement. Which build was
   * running is not recoverable from the numbers. */
  harnessVersion: string;
  label: string;
  startedAt: string;
  host: string;
  windows: number;
  /** What was asked for. */
  windowSeconds: number;
  /** What the clock actually measured, which is what the rates used. A gap
   * between this and `windowSeconds` says the machine could not keep the
   * schedule, and is itself worth reading. */
  measuredWindowSeconds: Dispersion;
  settleSeconds: number;
  tolerance: number;
  devices: string[];
  subjects: SubjectResult[];
  /** Everything a reader needs to know that the numbers do not say: what the
   * workload was, what else ran, which device this is. */
  notes: string[];
}

export interface RunOptions {
  label: string;
  subjects: SubjectSpec[];
  sampler: Sampler;
  devices?: string[];
  windows?: number;
  windowSeconds?: number;
  settleSeconds?: number;
  gaugeIntervalSeconds?: number;
  tolerance?: number;
  notes?: string[];
  /** Monotonic milliseconds, for measuring intervals. Must not be a wall
   * clock: an NTP or GPS step would make a window appear to take a negative
   * or enormous amount of time, and a vessel's clock does step. */
  monotonicNow?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export const DEFAULTS = {
  windows: 3,
  windowSeconds: 300,
  settleSeconds: 180,
  gaugeIntervalSeconds: 5,
};

/** How far the measured window length may drift from the requested one before
 * the run says so in its own notes. */
const SCHEDULE_TOLERANCE = 0.02;

interface WindowClock {
  startedAtMs: number;
  halfAtMs: number;
  endedAtMs: number;
}

interface WindowRaw {
  start: Counters;
  half: Counters;
  end: Counters;
  memory: number[];
  /** The kernel's high-water mark for this window, when it tracks one. */
  kernelPeak: number | null;
  clock: WindowClock;
}

export async function runBenchmark(options: RunOptions): Promise<RunResult> {
  const {
    label,
    subjects,
    sampler,
    windows = DEFAULTS.windows,
    windowSeconds = DEFAULTS.windowSeconds,
    settleSeconds = DEFAULTS.settleSeconds,
    gaugeIntervalSeconds = DEFAULTS.gaugeIntervalSeconds,
    tolerance = STEADY_TOLERANCE,
    notes = [],
    monotonicNow = () => performance.now(),
    sleep = defaultSleep,
    log = () => {},
  } = options;

  requirePositive(windows, "A run needs at least one window");
  requirePositive(windowSeconds, "A window needs a positive length");
  requirePositive(
    gaugeIntervalSeconds,
    "The gauge interval must be positive — at zero the sampling loop never advances",
  );
  if (subjects.length === 0)
    throw new Error("A run needs at least one subject");
  if (new Set(subjects.map((s) => s.name)).size !== subjects.length) {
    // Every per-window store is keyed by name. Two subjects sharing one would
    // interleave into a single series and report a plausible average of two
    // processes, with nothing in the output saying so.
    throw new Error("Two subjects share a name; each needs its own");
  }

  const devices = options.devices ?? sampler.wholeDisks();
  const startedAt = new Date().toISOString();

  const raw = new Map<string, WindowRaw[]>(subjects.map((s) => [s.name, []]));
  const diskRaw: {
    start: DiskCounters;
    end: DiskCounters;
    clock: WindowClock;
  }[] = [];

  log(`settling for ${settleSeconds}s`);
  await sleep(settleSeconds * 1000);

  const halfMs = (windowSeconds * 1000) / 2;
  for (let w = 1; w <= windows; w++) {
    log(`window ${w}/${windows} (${windowSeconds}s)`);
    const memory = new Map(subjects.map((s) => [s.name, [] as number[]]));
    const kernelPeak = new Map(
      subjects.map((s) => [s.name, null as number | null]),
    );
    const sampleMemory = () => {
      for (const subject of subjects) {
        const gauges = sampler.gauges(subject);
        memory.get(subject.name)!.push(gauges.memoryBytes);
        if (gauges.peakBytes !== null) {
          const seen = kernelPeak.get(subject.name);
          kernelPeak.set(
            subject.name,
            seen === null || seen === undefined
              ? gauges.peakBytes
              : Math.max(seen, gauges.peakBytes),
          );
        }
      }
    };

    const startedAtMs = monotonicNow();
    const start = new Map(subjects.map((s) => [s.name, sampler.counters(s)]));
    const diskStart = sampler.disks(devices);
    sampleMemory();

    await wait(
      halfMs,
      gaugeIntervalSeconds * 1000,
      sampleMemory,
      sleep,
      monotonicNow,
    );
    const halfAtMs = monotonicNow();
    const half = new Map(subjects.map((s) => [s.name, sampler.counters(s)]));

    await wait(
      halfMs,
      gaugeIntervalSeconds * 1000,
      sampleMemory,
      sleep,
      monotonicNow,
    );
    const endedAtMs = monotonicNow();
    const end = new Map(subjects.map((s) => [s.name, sampler.counters(s)]));
    const diskEnd = sampler.disks(devices);

    const clock: WindowClock = { startedAtMs, halfAtMs, endedAtMs };
    for (const subject of subjects) {
      raw.get(subject.name)!.push({
        start: start.get(subject.name)!,
        half: half.get(subject.name)!,
        end: end.get(subject.name)!,
        memory: memory.get(subject.name)!,
        kernelPeak: kernelPeak.get(subject.name) ?? null,
        clock,
      });
    }
    diskRaw.push({ start: diskStart, end: diskEnd, clock });
  }

  const measuredWindowSeconds = summarize(
    diskRaw.map((w) => windowLength(w.clock)),
  );
  const results: SubjectResult[] = subjects.map((subject) =>
    summarizeSubject(subject, raw.get(subject.name)!, tolerance),
  );
  results.push(summarizeSystemDisks(devices, diskRaw, tolerance));

  const drift =
    Math.abs(measuredWindowSeconds.mean - windowSeconds) / windowSeconds;
  const runNotes = [...notes];
  if (drift > SCHEDULE_TOLERANCE) {
    runNotes.push(
      `windows ran ${measuredWindowSeconds.mean.toFixed(1)}s against the ` +
        `${windowSeconds}s requested; rates use the measured length`,
    );
  }

  return {
    formatVersion: RESULT_FORMAT_VERSION,
    harnessVersion: packageVersion(),
    label,
    startedAt,
    host: hostname(),
    windows,
    windowSeconds,
    measuredWindowSeconds,
    settleSeconds,
    tolerance,
    devices,
    subjects: results,
    notes: runNotes,
  };
}

const windowLength = (c: WindowClock) => (c.endedAtMs - c.startedAtMs) / 1000;
const firstHalfLength = (c: WindowClock) => (c.halfAtMs - c.startedAtMs) / 1000;
const secondHalfLength = (c: WindowClock) => (c.endedAtMs - c.halfAtMs) / 1000;

function summarizeSubject(
  subject: SubjectSpec,
  windows: WindowRaw[],
  tolerance: number,
): SubjectResult {
  // A microsecond-per-second rate is a fraction of one core by definition.
  const cpuPercent = (a: number, b: number, seconds: number) =>
    (counterRate(a, b, seconds) / 1e6) * 100;
  const metrics: Record<string, MetricResult> = {
    cpuPercentOfCore: rateMetric(
      "% of one core",
      windows.map((w) =>
        cpuPercent(w.start.cpuUsec, w.end.cpuUsec, windowLength(w.clock)),
      ),
      windows.map((w): [number, number] => [
        cpuPercent(w.start.cpuUsec, w.half.cpuUsec, firstHalfLength(w.clock)),
        cpuPercent(w.half.cpuUsec, w.end.cpuUsec, secondHalfLength(w.clock)),
      ]),
      tolerance,
    ),
    memoryMb: gaugeMetric(windows),
  };

  // Per-process I/O comes from /proc/<pid>/io, which a cgroup subject has no
  // equivalent of. Asked of the subject's own kind rather than inferred from a
  // null in the first sample: the union already answers this.
  if (subject.kind === "pid") {
    metrics.writeKbPerSec = byteRateMetric(windows, tolerance, (c) =>
      requireBytes(c.writeBytes),
    );
    metrics.readKbPerSec = byteRateMetric(windows, tolerance, (c) =>
      requireBytes(c.readBytes),
    );
  }

  return {
    name: subject.name,
    kind: subject.kind,
    target: subjectTarget(subject),
    metrics,
  };
}

function requireBytes(value: number | null): number {
  if (value === null) {
    throw new Error(
      "A pid subject's sampler returned no I/O counters; /proc/<pid>/io is what supplies them",
    );
  }
  return value;
}

function byteRateMetric(
  windows: WindowRaw[],
  tolerance: number,
  pick: (c: Counters) => number,
): MetricResult {
  const kbPerSecond = (a: number, b: number, seconds: number) =>
    counterRate(a, b, seconds) / 1024;
  return rateMetric(
    "KB/s",
    windows.map((w) =>
      kbPerSecond(pick(w.start), pick(w.end), windowLength(w.clock)),
    ),
    windows.map((w): [number, number] => [
      kbPerSecond(pick(w.start), pick(w.half), firstHalfLength(w.clock)),
      kbPerSecond(pick(w.half), pick(w.end), secondHalfLength(w.clock)),
    ]),
    tolerance,
  );
}

function summarizeSystemDisks(
  devices: string[],
  windows: { start: DiskCounters; end: DiskCounters; clock: WindowClock }[],
  tolerance: number,
): SubjectResult {
  const rate = (pick: (c: DiskCounters) => number, divisor = 1) =>
    windows.map(
      (w) =>
        counterRate(pick(w.start), pick(w.end), windowLength(w.clock)) /
        divisor,
    );
  // /proc/diskstats is read only at the window boundaries, so there is no
  // half-window split to check. `null` says that, rather than reporting zero
  // drift and a steadiness the data never established.
  const systemMetric = (unit: string, values: number[]) =>
    unsplitMetric(unit, values);
  void tolerance;
  return {
    name: "system",
    kind: "system",
    target: devices.join(", ") || "no whole disks found",
    metrics: {
      writeIops: systemMetric(
        "/s",
        rate((c) => c.writesCompleted),
      ),
      readIops: systemMetric(
        "/s",
        rate((c) => c.readsCompleted),
      ),
      writeKbPerSec: systemMetric(
        "KB/s",
        rate((c) => c.writeBytes, 1024),
      ),
      readKbPerSec: systemMetric(
        "KB/s",
        rate((c) => c.readBytes, 1024),
      ),
    },
  };
}

function rateMetric(
  unit: string,
  perWindow: number[],
  halves: [number, number][],
  tolerance: number,
): MetricResult {
  const floor = NOISE_FLOOR[unit] ?? 0;
  return {
    unit,
    perWindow,
    dispersion: summarize(perWindow),
    halfWindowDrift: halves.map(([a, b]) => driftFraction(a, b)),
    steady: halves.every(([a, b]) => isSteady(a, b, tolerance, floor)),
  };
}

/** A rate with no half-window split available. */
function unsplitMetric(unit: string, perWindow: number[]): MetricResult {
  return {
    unit,
    perWindow,
    dispersion: summarize(perWindow),
    halfWindowDrift: null,
    steady: null,
  };
}

function gaugeMetric(windows: WindowRaw[]): MetricResult {
  const toMb = (bytes: number) => bytes / 1e6;
  const perWindow = windows.map((w) =>
    toMb(w.memory.reduce((a, b) => a + b, 0) / w.memory.length),
  );
  // The kernel's high-water mark when it tracks one, the sampled maximum
  // otherwise. Sampling cannot see a peak that falls between two samples, and
  // a short-lived roll is exactly the shape that hides there — reporting its
  // idle memory as its "peak" would be a confident wrong answer to the
  // question this field exists for.
  const kernelPeaks = windows
    .map((w) => w.kernelPeak)
    .filter((v): v is number => v !== null);
  const sampled = Math.max(...windows.flatMap((w) => w.memory));
  return {
    unit: "MB",
    perWindow,
    dispersion: summarize(perWindow),
    // A gauge has no half-window rate to compare. Its spread across windows,
    // and the gap between mean and peak, are what show whether it settled.
    halfWindowDrift: null,
    steady: null,
    peak: toMb(
      kernelPeaks.length > 0 ? Math.max(...kernelPeaks, sampled) : sampled,
    ),
  };
}

/**
 * Sleep for `totalMs`, sampling gauges every `intervalMs`.
 *
 * Elapsed time is read from the clock rather than accumulated from the
 * requested steps: a 5-second sleep that takes 7 counts as 7, so a loaded
 * machine stops early rather than overrunning the window by the accumulated
 * overshoot of sixty ticks.
 */
async function wait(
  totalMs: number,
  intervalMs: number,
  onTick: () => void,
  sleep: (ms: number) => Promise<void>,
  monotonicNow: () => number,
): Promise<void> {
  const deadline = monotonicNow() + totalMs;
  let remaining = totalMs;
  while (remaining > 0) {
    await sleep(Math.min(intervalMs, remaining));
    onTick();
    remaining = deadline - monotonicNow();
  }
}

function requirePositive(value: number, message: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(message);
}

function packageVersion(): string {
  const path = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "package.json",
  );
  return (JSON.parse(readFileSync(path, "utf8")) as { version: string })
    .version;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
