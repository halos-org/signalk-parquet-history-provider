/**
 * Parsers for the kernel counters the measurement method reads.
 *
 * Every function here takes file *contents*, never a path. The files only
 * exist on Linux and the numbers only mean anything on the device, but the
 * parsing is where the mistakes are — an off-by-one field index in
 * /proc/diskstats reports merged writes as completed ones and nothing looks
 * wrong. Taking text keeps that testable on any machine.
 */

/** Linux reports disk transfer in 512-byte sectors regardless of the device's
 * real sector size. */
export const SECTOR_BYTES = 512;

export interface CpuStat {
  usageUsec: number;
  userUsec: number;
  systemUsec: number;
}

/** cgroup v2 `cpu.stat`: `key value` per line, microseconds. */
export function parseCgroupCpuStat(text: string): CpuStat {
  const fields = parseKeyValue(text);
  const usageUsec = fields.get("usage_usec");
  if (usageUsec === undefined) {
    throw new Error("cpu.stat has no usage_usec line");
  }
  return {
    usageUsec,
    userUsec: fields.get("user_usec") ?? 0,
    systemUsec: fields.get("system_usec") ?? 0,
  };
}

/** cgroup v2 `memory.stat`. `anon` is the closest thing to "memory this
 * workload actually needs": `memory.current` also counts page cache, which
 * grows to whatever is available and is reclaimed under pressure. */
export function parseCgroupMemoryStat(text: string): {
  anonBytes: number;
  fileBytes: number;
} {
  const fields = parseKeyValue(text);
  return {
    anonBytes: fields.get("anon") ?? 0,
    fileBytes: fields.get("file") ?? 0,
  };
}

export interface ProcCpuTicks {
  utimeTicks: number;
  stimeTicks: number;
}

/**
 * `/proc/<pid>/stat`. The second field is the executable name in parentheses
 * and may itself contain spaces and parentheses ("(Web Content)"), so
 * everything is indexed from the LAST `)` rather than by splitting the line.
 */
export function parseProcStat(text: string): ProcCpuTicks {
  const close = text.lastIndexOf(")");
  if (close < 0) throw new Error("/proc/<pid>/stat has no comm field");
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  // fields[0] is `state`, i.e. stat field 3. utime is field 14, stime 15.
  const utimeTicks = Number(fields[11]);
  const stimeTicks = Number(fields[12]);
  if (!Number.isFinite(utimeTicks) || !Number.isFinite(stimeTicks)) {
    throw new Error("/proc/<pid>/stat has no readable utime/stime");
  }
  return { utimeTicks, stimeTicks };
}

export interface ProcIo {
  readBytes: number;
  writeBytes: number;
  rchar: number;
  wchar: number;
}

/**
 * `/proc/<pid>/io`. `read_bytes`/`write_bytes` are what actually reached the
 * block layer; `rchar`/`wchar` count bytes passed to syscalls, page cache
 * included. The success criterion is about device writes, so the former is
 * the number that matters and the latter is kept to show the difference.
 */
export function parseProcIo(text: string): ProcIo {
  const fields = parseKeyValue(text, /^(\w+):\s+(-?\d+)$/);
  return {
    readBytes: fields.get("read_bytes") ?? 0,
    writeBytes: fields.get("write_bytes") ?? 0,
    rchar: fields.get("rchar") ?? 0,
    wchar: fields.get("wchar") ?? 0,
  };
}

/** `VmRSS` from `/proc/<pid>/status`, in bytes. */
export function parseProcStatusRss(text: string): number {
  const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(text);
  if (!match) throw new Error("/proc/<pid>/status has no VmRSS line");
  return Number(match[1]) * 1024;
}

export interface DiskCounters {
  readsCompleted: number;
  writesCompleted: number;
  readBytes: number;
  writeBytes: number;
}

/**
 * `/proc/diskstats`, one entry per device. Partitions and their parent both
 * appear and both count the same I/O, so a caller summing every line double
 * counts; `sumDisks` takes an explicit device list for that reason.
 */
export function parseDiskstats(text: string): Map<string, DiskCounters> {
  const result = new Map<string, DiskCounters>();
  for (const line of text.split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || f[2] === undefined) continue;
    const readsCompleted = Number(f[3]);
    const writesCompleted = Number(f[7]);
    if (!Number.isFinite(readsCompleted) || !Number.isFinite(writesCompleted)) {
      continue;
    }
    result.set(f[2], {
      readsCompleted,
      writesCompleted,
      readBytes: Number(f[5]) * SECTOR_BYTES,
      writeBytes: Number(f[9]) * SECTOR_BYTES,
    });
  }
  return result;
}

/**
 * Whole-device names only — `sda`, `nvme0n1`, `mmcblk0`. Partitions repeat
 * their parent's I/O, and loop/ram devices are not storage the vessel has.
 */
export function isWholeDisk(name: string): boolean {
  if (/^(loop|ram|dm-|zram|sr)/.test(name)) return false;
  // nvme0n1 is a device, nvme0n1p1 a partition; mmcblk0 vs mmcblk0p1 likewise.
  if (/^(nvme\d+n\d+|mmcblk\d+)p\d+$/.test(name)) return false;
  // sda1, vdb2 and friends.
  if (/^(sd|vd|hd)[a-z]+\d+$/.test(name)) return false;
  return true;
}

export function sumDisks(
  counters: Map<string, DiskCounters>,
  devices: string[],
): DiskCounters {
  const total: DiskCounters = {
    readsCompleted: 0,
    writesCompleted: 0,
    readBytes: 0,
    writeBytes: 0,
  };
  for (const device of devices) {
    const entry = counters.get(device);
    if (!entry) continue;
    total.readsCompleted += entry.readsCompleted;
    total.writesCompleted += entry.writesCompleted;
    total.readBytes += entry.readBytes;
    total.writeBytes += entry.writeBytes;
  }
  return total;
}

function parseKeyValue(
  text: string,
  pattern = /^(\S+)\s+(-?\d+)$/,
): Map<string, number> {
  const result = new Map<string, number>();
  for (const line of text.split("\n")) {
    const match = pattern.exec(line.trim());
    if (match) result.set(match[1], Number(match[2]));
  }
  return result;
}
