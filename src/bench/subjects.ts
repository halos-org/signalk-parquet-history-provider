import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DiskCounters,
  isWholeDisk,
  parseCgroupCpuStat,
  parseCgroupMemoryStat,
  parseDiskstats,
  parseProcIo,
  parseProcStat,
  parseProcStatusRss,
  sumDisks,
} from "./proc.js";

/**
 * What to measure. A cgroup subject is the honest one for a container — it
 * counts every thread and every child — while a pid subject is what separates
 * the plugin's cost inside the Signal K process from the writer's beside it.
 * The design is judged on that separation, so both exist.
 */
export type SubjectSpec =
  | { name: string; kind: "pid"; pid: number }
  | { name: string; kind: "cgroup"; path: string };

/** `signalk:pid=1234` or `signalk:cgroup=/sys/fs/cgroup/system.slice/x.service` */
export function parseSubjectSpec(text: string): SubjectSpec {
  const match = /^([^:]+):(pid|cgroup)=(.+)$/.exec(text.trim());
  if (!match) {
    throw new Error(
      `Cannot read a subject out of "${text}". ` +
        `Expected <name>:pid=<pid> or <name>:cgroup=<path>.`,
    );
  }
  const [, name, kind, value] = match;
  if (kind === "pid") {
    const pid = Number(value);
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error(`"${value}" is not a pid`);
    }
    return { name, kind: "pid", pid };
  }
  return { name, kind: "cgroup", path: value };
}

export function subjectTarget(subject: SubjectSpec): string {
  return subject.kind === "pid" ? `pid ${subject.pid}` : subject.path;
}

/** Monotonic counters, read at a window boundary. */
export interface Counters {
  cpuUsec: number;
  /** Bytes that reached the block layer. Absent for a cgroup subject: the
   * method reads per-process io, and the whole-system view comes from
   * /proc/diskstats instead. */
  readBytes: number | null;
  writeBytes: number | null;
}

/** Sampled repeatedly through a window rather than differenced across it. */
export interface Gauges {
  memoryBytes: number;
}

export interface Sampler {
  counters(subject: SubjectSpec): Counters;
  gauges(subject: SubjectSpec): Gauges;
  disks(devices: string[]): DiskCounters;
  /** Whole disks present on this machine, for the default device list. */
  wholeDisks(): string[];
}

/**
 * Clock ticks per second, for turning `/proc/<pid>/stat` times into
 * microseconds. Effectively always 100, but reading it beats assuming it:
 * a wrong constant scales every per-process CPU number silently.
 */
export function clockTicksPerSecond(): number {
  try {
    const value = Number(
      execFileSync("getconf", ["CLK_TCK"]).toString().trim(),
    );
    if (Number.isFinite(value) && value > 0) return value;
  } catch {
    /* getconf is absent on some minimal images */
  }
  return 100;
}

export function createProcSampler(
  procRoot = "/proc",
  ticksPerSecond = clockTicksPerSecond(),
): Sampler {
  const read = (path: string) => readFileSync(path, "utf8");

  return {
    counters(subject) {
      if (subject.kind === "cgroup") {
        const cpu = parseCgroupCpuStat(read(join(subject.path, "cpu.stat")));
        return { cpuUsec: cpu.usageUsec, readBytes: null, writeBytes: null };
      }
      const { utimeTicks, stimeTicks } = parseProcStat(
        read(join(procRoot, String(subject.pid), "stat")),
      );
      const io = parseProcIo(read(join(procRoot, String(subject.pid), "io")));
      return {
        cpuUsec: ((utimeTicks + stimeTicks) / ticksPerSecond) * 1e6,
        readBytes: io.readBytes,
        writeBytes: io.writeBytes,
      };
    },

    gauges(subject) {
      if (subject.kind === "cgroup") {
        const memory = parseCgroupMemoryStat(
          read(join(subject.path, "memory.stat")),
        );
        // anon, not memory.current: page cache grows to fill whatever is free
        // and is reclaimed under pressure, so counting it would report a
        // number that says more about the machine than about the workload.
        return { memoryBytes: memory.anonBytes };
      }
      return {
        memoryBytes: parseProcStatusRss(
          read(join(procRoot, String(subject.pid), "status")),
        ),
      };
    },

    disks(devices) {
      return sumDisks(
        parseDiskstats(read(join(procRoot, "diskstats"))),
        devices,
      );
    },

    wholeDisks() {
      return [
        ...parseDiskstats(read(join(procRoot, "diskstats"))).keys(),
      ].filter(isWholeDisk);
    },
  };
}
