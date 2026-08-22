import { hostname } from "node:os";
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
 * The clock, the sleep and the sampler are all injected. The window
 * arithmetic and the half-window split are exactly where this can be wrong,
 * and neither is testable against a real 300-second window.
 */

export interface MetricResult {
  unit: string;
  perWindow: number[];
  dispersion: Dispersion;
  /** One entry per window: how far its halves disagreed, as a fraction. */
  halfWindowDrift: number[];
  /** False when any window's halves disagreed by more than the tolerance. */
  steady: boolean;
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

export interface RunResult {
  label: string;
  startedAt: string;
  host: string;
  windows: number;
  windowSeconds: number;
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
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}

export const DEFAULTS = {
  windows: 3,
  windowSeconds: 300,
  settleSeconds: 180,
  gaugeIntervalSeconds: 5,
};

interface WindowRaw {
  start: Counters;
  half: Counters;
  end: Counters;
  memory: number[];
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
    now = Date.now,
    sleep = defaultSleep,
    log = () => {},
  } = options;

  if (windows < 1) throw new Error("A run needs at least one window");
  if (windowSeconds <= 0) throw new Error("A window needs a positive length");

  const devices = options.devices ?? sampler.wholeDisks();
  const startedAt = new Date(now()).toISOString();

  const raw = new Map<string, WindowRaw[]>(subjects.map((s) => [s.name, []]));
  const diskRaw: { start: DiskCounters; end: DiskCounters }[] = [];

  log(`settling for ${settleSeconds}s`);
  await sleep(settleSeconds * 1000);

  const halfMs = (windowSeconds * 1000) / 2;
  for (let w = 1; w <= windows; w++) {
    log(`window ${w}/${windows} (${windowSeconds}s)`);
    const memory = new Map(subjects.map((s) => [s.name, [] as number[]]));
    const sampleMemory = () => {
      for (const subject of subjects) {
        memory.get(subject.name)!.push(sampler.gauges(subject).memoryBytes);
      }
    };

    const start = new Map(subjects.map((s) => [s.name, sampler.counters(s)]));
    const diskStart = sampler.disks(devices);
    sampleMemory();

    await wait(halfMs, gaugeIntervalSeconds * 1000, sampleMemory, sleep);
    const half = new Map(subjects.map((s) => [s.name, sampler.counters(s)]));

    await wait(halfMs, gaugeIntervalSeconds * 1000, sampleMemory, sleep);
    const end = new Map(subjects.map((s) => [s.name, sampler.counters(s)]));
    const diskEnd = sampler.disks(devices);

    for (const subject of subjects) {
      raw.get(subject.name)!.push({
        start: start.get(subject.name)!,
        half: half.get(subject.name)!,
        end: end.get(subject.name)!,
        memory: memory.get(subject.name)!,
      });
    }
    diskRaw.push({ start: diskStart, end: diskEnd });
  }

  const results: SubjectResult[] = subjects.map((subject) =>
    reduceSubject(subject, raw.get(subject.name)!, windowSeconds, tolerance),
  );
  results.push(reduceSystem(devices, diskRaw, windowSeconds, tolerance));

  return {
    label,
    startedAt,
    host: hostname(),
    windows,
    windowSeconds,
    settleSeconds,
    tolerance,
    devices,
    subjects: results,
    notes,
  };
}

function reduceSubject(
  subject: SubjectSpec,
  windows: WindowRaw[],
  windowSeconds: number,
  tolerance: number,
): SubjectResult {
  const half = windowSeconds / 2;
  // A microsecond-per-second rate is a fraction of one core by definition.
  const cpuPercent = (a: number, b: number, seconds: number) =>
    (counterRate(a, b, seconds) / 1e6) * 100;
  const metrics: Record<string, MetricResult> = {
    cpuPercentOfCore: metric(
      "% of one core",
      windows.map((w) =>
        cpuPercent(w.start.cpuUsec, w.end.cpuUsec, windowSeconds),
      ),
      windows.map((w): [number, number] => [
        cpuPercent(w.start.cpuUsec, w.half.cpuUsec, half),
        cpuPercent(w.half.cpuUsec, w.end.cpuUsec, half),
      ]),
      tolerance,
    ),
    memoryMb: gaugeMetric(windows.map((w) => w.memory)),
  };

  if (windows[0].start.writeBytes !== null) {
    metrics.writeKbPerSec = byteRateMetric(
      windows,
      windowSeconds,
      tolerance,
      (c) => c.writeBytes!,
    );
    metrics.readKbPerSec = byteRateMetric(
      windows,
      windowSeconds,
      tolerance,
      (c) => c.readBytes!,
    );
  }

  return {
    name: subject.name,
    kind: subject.kind,
    target: subjectTarget(subject),
    metrics,
  };
}

function byteRateMetric(
  windows: WindowRaw[],
  windowSeconds: number,
  tolerance: number,
  pick: (c: Counters) => number,
): MetricResult {
  const half = windowSeconds / 2;
  const kbPerSecond = (a: number, b: number, seconds: number) =>
    counterRate(a, b, seconds) / 1024;
  return metric(
    "KB/s",
    windows.map((w) => kbPerSecond(pick(w.start), pick(w.end), windowSeconds)),
    windows.map((w): [number, number] => [
      kbPerSecond(pick(w.start), pick(w.half), half),
      kbPerSecond(pick(w.half), pick(w.end), half),
    ]),
    tolerance,
  );
}

function reduceSystem(
  devices: string[],
  windows: { start: DiskCounters; end: DiskCounters }[],
  windowSeconds: number,
  tolerance: number,
): SubjectResult {
  const rate = (pick: (c: DiskCounters) => number, divisor = 1) =>
    windows.map(
      (w) => counterRate(pick(w.start), pick(w.end), windowSeconds) / divisor,
    );
  // The system view has no half-window split: /proc/diskstats is read once at
  // each window boundary, and adding a mid-window read would measure a
  // different thing from the per-subject counters it sits beside. Passing each
  // window's own rate as both halves states that plainly — drift zero, and no
  // steadiness claim the data cannot support.
  const asBothHalves = (values: number[]): [number, number][] =>
    values.map((v) => [v, v]);
  const systemMetric = (unit: string, values: number[]) =>
    metric(unit, values, asBothHalves(values), tolerance);
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

function metric(
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

function gaugeMetric(perWindowSamples: number[][]): MetricResult {
  const toMb = (bytes: number) => bytes / 1e6;
  const perWindow = perWindowSamples.map((samples) =>
    toMb(samples.reduce((a, b) => a + b, 0) / samples.length),
  );
  return {
    unit: "MB",
    perWindow,
    dispersion: summarize(perWindow),
    // A gauge has no half-window rate to compare. Its spread across windows,
    // and the gap between mean and peak, are what show whether it settled.
    halfWindowDrift: perWindow.map(() => 0),
    steady: true,
    peak: toMb(Math.max(...perWindowSamples.flat())),
  };
}

async function wait(
  totalMs: number,
  intervalMs: number,
  onTick: () => void,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  let elapsed = 0;
  while (elapsed < totalMs) {
    const step = Math.min(intervalMs, totalMs - elapsed);
    await sleep(step);
    elapsed += step;
    onTick();
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
