import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DiskCounters } from "../bench/proc.js";
import { RESULT_FORMAT_VERSION, runBenchmark } from "../bench/run.js";
import { Sampler, SubjectSpec } from "../bench/subjects.js";

/**
 * The window arithmetic is exactly where this harness can be quietly wrong,
 * and no real 300-second window would show it. A virtual clock and a sampler
 * whose counters are a known function of time make the answer checkable: if
 * the load is 20% of a core, the harness must say 20.
 */
class FakeClock {
  ms = 0;
  /** How much longer than requested each sleep actually takes. 1 is a perfect
   * scheduler, which no loaded machine is. */
  constructor(private readonly overshoot = 1) {}
  sleep = async (duration: number): Promise<void> => {
    this.ms += duration * this.overshoot;
  };
  now = (): number => this.ms;
}

interface FakeShape {
  /** Fraction of one core, as a function of elapsed virtual milliseconds. */
  cpuFraction?: (ms: number) => number;
  /** Device bytes per second. */
  writeBytesPerSecond?: (ms: number) => number;
  memoryBytes?: (ms: number) => number;
  /** What the kernel reports as the high-water mark, independent of what the
   * sampling happened to catch. */
  kernelPeakBytes?: number;
}

function fakeSampler(clock: FakeClock, shape: FakeShape = {}): Sampler {
  const cpu = shape.cpuFraction ?? (() => 0.2);
  const write = shape.writeBytesPerSecond ?? (() => 0);
  const memory = shape.memoryBytes ?? (() => 100e6);

  // Counters are integrals of the rate functions, sampled at the current
  // virtual time — the same thing the kernel's monotonic counters are.
  const integrate = (rate: (ms: number) => number, ms: number): number => {
    let total = 0;
    for (let t = 0; t < ms; t += 10) total += rate(t) * 10;
    return total;
  };

  return {
    counters(subject: SubjectSpec) {
      const ms = clock.now();
      return {
        cpuUsec: integrate(cpu, ms) * 1000,
        readBytes: subject.kind === "pid" ? 0 : null,
        writeBytes: subject.kind === "pid" ? integrate(write, ms) / 1000 : null,
      };
    },
    gauges() {
      return {
        memoryBytes: memory(clock.now()),
        peakBytes: shape.kernelPeakBytes ?? null,
      };
    },
    disks(): DiskCounters {
      const ms = clock.now();
      return {
        readsCompleted: Math.round(ms / 100),
        writesCompleted: Math.round(ms / 20),
        readBytes: 0,
        writeBytes: integrate(write, ms) / 1000,
      };
    },
    wholeDisks: () => ["mmcblk0"],
  };
}

const short = {
  windows: 3,
  windowSeconds: 10,
  settleSeconds: 5,
  gaugeIntervalSeconds: 1,
};

function run(clock: FakeClock, shape: FakeShape = {}, overrides = {}) {
  return runBenchmark({
    ...short,
    label: "test",
    subjects: [{ name: "load", kind: "pid", pid: 1 }],
    sampler: fakeSampler(clock, shape),
    monotonicNow: clock.now,
    sleep: clock.sleep,
    ...overrides,
  });
}

describe("runBenchmark", () => {
  it("reports a constant load as its actual share of one core", async () => {
    const clock = new FakeClock();
    const result = await run(clock, { cpuFraction: () => 0.2 });

    const cpu = result.subjects[0].metrics.cpuPercentOfCore;
    assert.equal(cpu.perWindow.length, 3);
    for (const window of cpu.perWindow) {
      assert.ok(Math.abs(window - 20) < 0.5, `expected ~20%, got ${window}`);
    }
    assert.equal(cpu.steady, true);
  });

  it("divides by the interval it measured, not the one it asked for", async () => {
    // setTimeout is a floor, never a ceiling, and it overshoots most on a
    // loaded machine — which is the machine under measurement. A 3× overshoot
    // with one gauge tick per half makes each half take 15s instead of 5s.
    // Dividing the counter delta by the nominal 10s would report a 20% load
    // as 60%, and would inflate the candidate column more than the control it
    // is being compared against.
    const clock = new FakeClock(3);
    const result = await run(
      clock,
      { cpuFraction: () => 0.2 },
      { gaugeIntervalSeconds: 5 },
    );

    const cpu = result.subjects[0].metrics.cpuPercentOfCore;
    for (const window of cpu.perWindow) {
      assert.ok(
        Math.abs(window - 20) < 0.5,
        `a 20% load read as ${window}% — the nominal window length leaked in`,
      );
    }
    // The overshoot is reported rather than hidden: a machine that cannot keep
    // the schedule is itself worth knowing about.
    assert.ok(
      Math.abs(result.measuredWindowSeconds.mean - 30) < 0.5,
      `measured ${result.measuredWindowSeconds.mean}s, expected ~30s`,
    );
    assert.equal(result.windowSeconds, 10);
    assert.ok(
      result.notes.some((note) => note.includes("against the 10s requested")),
      `expected a note about the schedule, got ${JSON.stringify(result.notes)}`,
    );
  });

  it("keeps a window close to its requested length when the clock behaves", async () => {
    // The counterpart: wait() measures against a deadline rather than
    // accumulating requested steps, so a mild overshoot is absorbed by the
    // last tick instead of stretching the window by the sum of sixty of them.
    const clock = new FakeClock(1.2);
    const result = await run(clock);
    assert.ok(
      Math.abs(result.measuredWindowSeconds.mean - 10) < 0.2,
      `measured ${result.measuredWindowSeconds.mean}s, expected ~10s`,
    );
  });

  it("settles before the first window rather than measuring the warm-up", async () => {
    const clock = new FakeClock();
    // Idle until the settle ends, then a steady 30%.
    const result = await run(clock, {
      cpuFraction: (ms) => (ms < 5000 ? 0 : 0.3),
    });

    const cpu = result.subjects[0].metrics.cpuPercentOfCore;
    assert.ok(
      Math.abs(cpu.dispersion.mean - 30) < 0.5,
      `settle window leaked into the measurement: ${cpu.dispersion.mean}`,
    );
  });

  it("flags a window whose halves disagree", async () => {
    const clock = new FakeClock();
    // Steps up in the middle of the first window: 10% then 40%.
    const result = await run(clock, {
      cpuFraction: (ms) => (ms < 10_000 ? 0.1 : 0.4),
    });

    const cpu = result.subjects[0].metrics.cpuPercentOfCore;
    assert.equal(cpu.steady, false, "a stepped window should not read steady");
    assert.ok(cpu.halfWindowDrift !== null);
    assert.ok(cpu.halfWindowDrift[0] > 0.1);
    // Later windows are steady again, and the flag is per metric across the
    // whole run — the drift array is what says which window it was.
    assert.ok(cpu.halfWindowDrift[2] < 0.01);
  });

  it("keeps a transient memory peak out of the windows that did not see it", async () => {
    const clock = new FakeClock();
    // 100 MB throughout, with a 400 MB spike lasting two seconds inside the
    // second window — the shape of a roll process beside a steady writer.
    const result = await run(clock, {
      memoryBytes: (ms) => (ms >= 20_000 && ms < 22_000 ? 400e6 : 100e6),
    });

    const memory = result.subjects[0].metrics.memoryMb;
    assert.ok(memory.peak !== undefined && memory.peak > 399);
    // Assert on the window that contained the spike and on the run's upper
    // bound. dispersion.min is the clean window and would pass under a
    // per-window max as readily as under a per-window mean, so it proves
    // nothing about how the spike was folded in.
    assert.ok(
      Math.abs(memory.perWindow[1] - 154.5) < 1,
      `the spiked window read ${memory.perWindow[1]}, expected ~154.5`,
    );
    assert.ok(
      memory.dispersion.max < 200,
      `a 2s spike moved the window mean to ${memory.dispersion.max}`,
    );
    assert.deepEqual(
      [memory.perWindow[0], memory.perWindow[2]],
      [100, 100],
      "the windows without the spike must be untouched by it",
    );
  });

  it("makes no steadiness claim for a metric it never split", async () => {
    // A gauge has no rate to halve and /proc/diskstats is read only at the
    // boundaries. Reporting `steady: true` for either would be a claim the
    // data cannot support, and would render identically to a metric that was
    // checked and agreed.
    const clock = new FakeClock();
    const result = await run(clock);

    const memory = result.subjects[0].metrics.memoryMb;
    assert.equal(memory.steady, null);
    assert.equal(memory.halfWindowDrift, null);

    const system = result.subjects.at(-1)!;
    assert.equal(system.metrics.writeIops.steady, null);
    assert.equal(system.metrics.writeKbPerSec.halfWindowDrift, null);
  });

  it("measures per-process writes for a pid and leaves them out for a cgroup", async () => {
    const clock = new FakeClock();
    const result = await run(
      clock,
      { writeBytesPerSecond: () => 12 * 1024 },
      {
        subjects: [
          { name: "proc", kind: "pid", pid: 1 },
          { name: "container", kind: "cgroup", path: "/sys/fs/cgroup/x" },
        ],
      },
    );

    const proc = result.subjects.find((s) => s.name === "proc")!;
    assert.ok(Math.abs(proc.metrics.writeKbPerSec.dispersion.mean - 12) < 0.5);
    const container = result.subjects.find((s) => s.name === "container")!;
    assert.equal(container.metrics.writeKbPerSec, undefined);
  });

  it("always appends the whole-system disk view", async () => {
    const clock = new FakeClock();
    const result = await run(clock);

    const system = result.subjects.at(-1)!;
    assert.equal(system.name, "system");
    assert.equal(system.kind, "system");
    assert.deepEqual(result.devices, ["mmcblk0"]);
    // 1 write per 20 virtual ms = 50/s.
    assert.ok(Math.abs(system.metrics.writeIops.dispersion.mean - 50) < 1);
  });

  it("stamps the result format and the build that measured", async () => {
    // These files are read back by `bench compare` months later, by a
    // different unit. Without them there is no way to tell what produced the
    // numbers or whether the reader still understands the shape.
    const clock = new FakeClock();
    const result = await run(clock);
    assert.equal(result.formatVersion, RESULT_FORMAT_VERSION);
    assert.match(result.harnessVersion, /^\d+\.\d+\.\d+/);
  });

  describe("input validation", () => {
    // Each of these produced a plausible-looking but meaningless run, or a
    // loop that never returned, rather than an error naming the bad flag.
    const cases: [string, Record<string, unknown>, RegExp][] = [
      ["no windows", { windows: 0 }, /at least one window/],
      ["a NaN window count", { windows: Number.NaN }, /at least one window/],
      ["a zero-length window", { windowSeconds: 0 }, /positive length/],
      ["a NaN window length", { windowSeconds: Number.NaN }, /positive length/],
      [
        "a zero gauge interval",
        { gaugeIntervalSeconds: 0 },
        /gauge interval must be positive/,
      ],
      [
        "a negative gauge interval",
        { gaugeIntervalSeconds: -5 },
        /gauge interval must be positive/,
      ],
      ["no subjects", { subjects: [] }, /at least one subject/],
    ];

    for (const [name, overrides, message] of cases) {
      it(`refuses ${name}`, async () => {
        const clock = new FakeClock();
        await assert.rejects(run(clock, {}, overrides), message);
      });
    }

    it("refuses two subjects with the same name", async () => {
      // Every per-window store is keyed by name, so these would interleave
      // into one series and report an average of two processes.
      const clock = new FakeClock();
      await assert.rejects(
        run(
          clock,
          {},
          {
            subjects: [
              { name: "signalk", kind: "pid", pid: 1 },
              { name: "signalk", kind: "pid", pid: 2 },
            ],
          },
        ),
        /share a name/,
      );
    });
  });

  it("fails rather than report a rate when the subject was replaced", async () => {
    const clock = new FakeClock();
    const sampler = fakeSampler(clock);
    let calls = 0;
    const resetting: Sampler = {
      ...sampler,
      counters(subject) {
        // A restarted process reusing the pid: its counters start over.
        calls++;
        const real = sampler.counters(subject);
        return calls > 2 ? { ...real, cpuUsec: 0 } : real;
      },
    };
    await assert.rejects(
      runBenchmark({
        ...short,
        label: "restarted",
        subjects: [{ name: "load", kind: "pid", pid: 1 }],
        sampler: resetting,
        monotonicNow: clock.now,
        sleep: clock.sleep,
      }),
      /backwards/,
    );
  });
});
