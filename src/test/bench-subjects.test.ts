import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProcSampler,
  parseSubjectSpec,
  subjectTarget,
} from "../bench/subjects.js";

/**
 * The seam between the parsers and the window loop, which nothing else covers:
 * run.ts is tested against a fake Sampler and proc.ts against file text, so
 * which file supplies which metric — and the one scaling step in the whole
 * harness — lived between two suites and inside neither.
 *
 * A wrong clock-tick constant, or utime and stime read from the wrong columns,
 * scales every per-process CPU number by a constant and leaves every other
 * test green.
 */
function fixtureProc(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "sk-parquet-proc-"));
  mkdirSync(join(root, "4242"));
  // Fields 1..22 with utime=1234 and stime=567 in positions 14 and 15.
  writeFileSync(
    join(root, "4242", "stat"),
    "4242 (node) S 1 4242 4242 0 -1 4194304 9876 0 3 0 1234 567 0 0 20 0 12 0 8765 123456 789\n",
  );
  writeFileSync(
    join(root, "4242", "io"),
    [
      "rchar: 123456789",
      "wchar: 987654321",
      "syscr: 1000",
      "syscw: 2000",
      "read_bytes: 40960",
      "write_bytes: 12288000",
      "cancelled_write_bytes: 4096",
    ].join("\n"),
  );
  writeFileSync(
    join(root, "4242", "status"),
    ["Name:\tnode", "VmHWM:\t  218112 kB", "VmRSS:\t   87040 kB"].join("\n"),
  );
  writeFileSync(
    join(root, "diskstats"),
    [
      "   7       0 loop0 0 0 0 0 0 0 0 0 0 0 0",
      " 179       0 mmcblk0 51234 900 2048000 12000 88123 4500 9216000 41000 0 30000 53000",
      " 179       1 mmcblk0p1 4000 100 128000 900 7000 300 512000 3000 0 2000 3900",
    ].join("\n"),
  );
  return {
    root,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function fixtureCgroup(withPeak: boolean): {
  path: string;
  cleanup: () => void;
} {
  const path = mkdtempSync(join(tmpdir(), "sk-parquet-cgroup-"));
  writeFileSync(
    join(path, "cpu.stat"),
    ["usage_usec 4530221", "user_usec 3011044", "system_usec 1519177"].join(
      "\n",
    ),
  );
  writeFileSync(
    join(path, "memory.stat"),
    ["anon 91234304", "file 402653184", "kernel_stack 262144"].join("\n"),
  );
  if (withPeak) writeFileSync(join(path, "memory.peak"), "228589568\n");
  return {
    path,
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}

describe("parseSubjectSpec", () => {
  it("reads a pid subject", () => {
    assert.deepEqual(parseSubjectSpec("signalk:pid=1234"), {
      name: "signalk",
      kind: "pid",
      pid: 1234,
    });
  });

  it("reads a cgroup subject, path separators and all", () => {
    assert.deepEqual(
      parseSubjectSpec("questdb:cgroup=/sys/fs/cgroup/system.slice/q.service"),
      {
        name: "questdb",
        kind: "cgroup",
        path: "/sys/fs/cgroup/system.slice/q.service",
      },
    );
  });

  it("rejects what it cannot read rather than guessing", () => {
    for (const bad of [
      "signalk",
      "signalk:1234",
      "signalk:pid=",
      "signalk:pid=abc",
      "signalk:pid=0",
      "signalk:pid=-1",
      "signalk:pid=1.5",
      ":pid=1",
    ]) {
      assert.throws(
        () => parseSubjectSpec(bad),
        /Cannot read a subject|not a pid/,
        bad,
      );
    }
  });

  it("names its target for the report", () => {
    assert.equal(subjectTarget({ name: "a", kind: "pid", pid: 7 }), "pid 7");
    assert.equal(
      subjectTarget({ name: "a", kind: "cgroup", path: "/sys/fs/cgroup/x" }),
      "/sys/fs/cgroup/x",
    );
  });
});

describe("createProcSampler, pid subject", () => {
  const subject = { name: "sk", kind: "pid", pid: 4242 } as const;

  it("scales CPU by the clock tick and reports microseconds", () => {
    const { root, cleanup } = fixtureProc();
    try {
      // (1234 + 567) ticks at 100 Hz = 18.01 s = 18_010_000 µs.
      const sampler = createProcSampler(root, 100);
      assert.equal(sampler.counters(subject).cpuUsec, 18_010_000);
      // A different tick rate must move the answer, or the constant is not
      // being applied at all.
      assert.equal(
        createProcSampler(root, 250).counters(subject).cpuUsec,
        7_204_000,
      );
    } finally {
      cleanup();
    }
  });

  it("reports device bytes, not syscall bytes", () => {
    const { root, cleanup } = fixtureProc();
    try {
      const counters = createProcSampler(root, 100).counters(subject);
      assert.equal(counters.writeBytes, 12288000);
      assert.equal(counters.readBytes, 40960);
    } finally {
      cleanup();
    }
  });

  it("reports RSS now and the kernel's high-water mark", () => {
    const { root, cleanup } = fixtureProc();
    try {
      const gauges = createProcSampler(root, 100).gauges(subject);
      assert.equal(gauges.memoryBytes, 87040 * 1024);
      assert.equal(gauges.peakBytes, 218112 * 1024);
    } finally {
      cleanup();
    }
  });

  it("sums only whole disks", () => {
    const { root, cleanup } = fixtureProc();
    try {
      const sampler = createProcSampler(root, 100);
      assert.deepEqual(sampler.wholeDisks(), ["mmcblk0"]);
      // mmcblk0p1 repeats its parent's I/O; counting both doubles it.
      assert.equal(sampler.disks(["mmcblk0"]).writesCompleted, 88123);
    } finally {
      cleanup();
    }
  });
});

describe("createProcSampler, cgroup subject", () => {
  it("reads CPU from cpu.stat and memory from anon", () => {
    const { path, cleanup } = fixtureCgroup(true);
    try {
      const subject = { name: "q", kind: "cgroup", path } as const;
      const sampler = createProcSampler("/proc", 100);
      assert.equal(sampler.counters(subject).cpuUsec, 4530221);
      // anon, not memory.current: page cache grows to fill what is free, so
      // counting it would report the machine rather than the workload.
      assert.equal(sampler.gauges(subject).memoryBytes, 91234304);
      assert.equal(sampler.gauges(subject).peakBytes, 228589568);
    } finally {
      cleanup();
    }
  });

  it("has no per-process I/O to report", () => {
    const { path, cleanup } = fixtureCgroup(true);
    try {
      const counters = createProcSampler("/proc", 100).counters({
        name: "q",
        kind: "cgroup",
        path,
      });
      // Null, not zero. Zero would read as "this container wrote nothing",
      // which is the most flattering possible answer.
      assert.equal(counters.writeBytes, null);
      assert.equal(counters.readBytes, null);
    } finally {
      cleanup();
    }
  });

  it("reports no peak on a kernel without memory.peak", () => {
    // cgroup v2 gained it in 5.19; absence is a fact about the kernel, not a
    // failure of the run.
    const { path, cleanup } = fixtureCgroup(false);
    try {
      const gauges = createProcSampler("/proc", 100).gauges({
        name: "q",
        kind: "cgroup",
        path,
      });
      assert.equal(gauges.peakBytes, null);
      assert.equal(gauges.memoryBytes, 91234304);
    } finally {
      cleanup();
    }
  });
});
