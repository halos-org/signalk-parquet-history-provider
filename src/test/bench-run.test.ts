import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DiskCounters } from "../bench/proc.js";
import { runBenchmark } from "../bench/run.js";
import { Sampler, SubjectSpec } from "../bench/subjects.js";

/**
 * The window arithmetic is exactly where this harness can be quietly wrong,
 * and no real 300-second window would show it. A virtual clock and a sampler
 * whose counters are a known function of time make the answer checkable: if
 * the load is 20% of a core, the harness must say 20.
 */
class FakeClock {
  ms = 0;
  sleep = async (duration: number): Promise<void> => {
    this.ms += duration;
  };
  now = (): number => this.ms;
}

interface FakeShape {
  /** Fraction of one core, as a function of elapsed virtual milliseconds. */
  cpuFraction?: (ms: number) => number;
  /** Device bytes per second. */
  writeBytesPerSecond?: (ms: number) => number;
  memoryBytes?: (ms: number) => number;
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
      return { memoryBytes: memory(clock.now()) };
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

describe("runBenchmark", () => {
  it("reports a constant load as its actual share of one core", async () => {
    const clock = new FakeClock();
    const result = await runBenchmark({
      ...short,
      label: "constant",
      subjects: [{ name: "load", kind: "pid", pid: 1 }],
      sampler: fakeSampler(clock, { cpuFraction: () => 0.2 }),
      now: clock.now,
      sleep: clock.sleep,
    });

    const cpu = result.subjects[0].metrics.cpuPercentOfCore;
    assert.equal(cpu.perWindow.length, 3);
    for (const window of cpu.perWindow) {
      assert.ok(Math.abs(window - 20) < 0.5, `expected ~20%, got ${window}`);
    }
    assert.equal(cpu.steady, true);
  });

  it("settles before the first window rather than measuring the warm-up", async () => {
    const clock = new FakeClock();
    // Idle until the settle ends, then a steady 30%.
    const result = await runBenchmark({
      ...short,
      label: "settled",
      subjects: [{ name: "load", kind: "pid", pid: 1 }],
      sampler: fakeSampler(clock, {
        cpuFraction: (ms) => (ms < 5000 ? 0 : 0.3),
      }),
      now: clock.now,
      sleep: clock.sleep,
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
    const result = await runBenchmark({
      ...short,
      label: "stepped",
      subjects: [{ name: "load", kind: "pid", pid: 1 }],
      sampler: fakeSampler(clock, {
        cpuFraction: (ms) => (ms < 10_000 ? 0.1 : 0.4),
      }),
      now: clock.now,
      sleep: clock.sleep,
    });

    const cpu = result.subjects[0].metrics.cpuPercentOfCore;
    assert.equal(cpu.steady, false, "a stepped window should not read steady");
    assert.ok(cpu.halfWindowDrift[0] > 0.1);
    // Later windows are steady again, and the flag is per metric across the
    // whole run — the drift array is what says which window it was.
    assert.ok(cpu.halfWindowDrift[2] < 0.01);
  });

  it("keeps a transient memory peak apart from the steady mean", async () => {
    const clock = new FakeClock();
    // 100 MB throughout, with a 400 MB spike lasting two seconds — the shape
    // of a roll process beside a steady writer. Summing these two numbers is
    // the mistake the separation exists to prevent.
    const result = await runBenchmark({
      ...short,
      label: "spike",
      subjects: [{ name: "writer", kind: "pid", pid: 1 }],
      sampler: fakeSampler(clock, {
        memoryBytes: (ms) => (ms >= 20_000 && ms < 22_000 ? 400e6 : 100e6),
      }),
      now: clock.now,
      sleep: clock.sleep,
    });

    const memory = result.subjects[0].metrics.memoryMb;
    assert.ok(memory.peak !== undefined && memory.peak > 399);
    assert.ok(
      memory.dispersion.min < 110,
      `the steady mean absorbed the spike: ${memory.dispersion.min}`,
    );
  });

  it("measures per-process writes for a pid and leaves them out for a cgroup", async () => {
    const clock = new FakeClock();
    const result = await runBenchmark({
      ...short,
      label: "writes",
      subjects: [
        { name: "proc", kind: "pid", pid: 1 },
        { name: "container", kind: "cgroup", path: "/sys/fs/cgroup/x" },
      ],
      sampler: fakeSampler(clock, { writeBytesPerSecond: () => 12 * 1024 }),
      now: clock.now,
      sleep: clock.sleep,
    });

    const proc = result.subjects.find((s) => s.name === "proc")!;
    assert.ok(Math.abs(proc.metrics.writeKbPerSec.dispersion.mean - 12) < 0.5);
    const container = result.subjects.find((s) => s.name === "container")!;
    assert.equal(container.metrics.writeKbPerSec, undefined);
  });

  it("always appends the whole-system disk view", async () => {
    const clock = new FakeClock();
    const result = await runBenchmark({
      ...short,
      label: "system",
      subjects: [{ name: "load", kind: "pid", pid: 1 }],
      sampler: fakeSampler(clock),
      now: clock.now,
      sleep: clock.sleep,
    });

    const system = result.subjects.at(-1)!;
    assert.equal(system.name, "system");
    assert.equal(system.kind, "system");
    assert.deepEqual(result.devices, ["mmcblk0"]);
    // 1 write per 20 virtual ms = 50/s.
    assert.ok(Math.abs(system.metrics.writeIops.dispersion.mean - 50) < 1);
  });

  it("refuses a run with no windows", async () => {
    const clock = new FakeClock();
    await assert.rejects(
      runBenchmark({
        ...short,
        windows: 0,
        label: "none",
        subjects: [{ name: "load", kind: "pid", pid: 1 }],
        sampler: fakeSampler(clock),
        now: clock.now,
        sleep: clock.sleep,
      }),
    );
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
        now: clock.now,
        sleep: clock.sleep,
      }),
      /backwards/,
    );
  });
});
