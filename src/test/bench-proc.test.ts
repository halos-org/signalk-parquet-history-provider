import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isWholeDisk,
  parseCgroupCpuStat,
  parseCgroupMemoryStat,
  parseDiskstats,
  parseProcIo,
  parseProcStat,
  parseProcStatusRss,
  sumDisks,
} from "../bench/proc.js";

describe("parseCgroupCpuStat", () => {
  it("reads the microsecond counters", () => {
    const stat = parseCgroupCpuStat(
      [
        "usage_usec 4530221",
        "user_usec 3011044",
        "system_usec 1519177",
        "nr_periods 0",
        "nr_throttled 0",
        "throttled_usec 0",
      ].join("\n"),
    );
    assert.equal(stat.usageUsec, 4530221);
    assert.equal(stat.userUsec, 3011044);
    assert.equal(stat.systemUsec, 1519177);
  });

  it("throws when usage_usec is absent rather than reporting zero", () => {
    assert.throws(() => parseCgroupCpuStat("nr_periods 0\n"));
  });
});

describe("parseCgroupMemoryStat", () => {
  it("reads anon separately from file", () => {
    const memory = parseCgroupMemoryStat(
      ["anon 91234304", "file 402653184", "kernel_stack 262144"].join("\n"),
    );
    assert.equal(memory.anonBytes, 91234304);
    assert.equal(memory.fileBytes, 402653184);
  });
});

describe("parseProcStat", () => {
  // Fields 1..15, with utime=1234 and stime=567 in positions 14 and 15.
  const line = (comm: string) =>
    `4242 (${comm}) S 1 4242 4242 0 -1 4194304 9876 0 3 0 1234 567 0 0 20 0 12 0 8765 123456 789`;

  it("reads utime and stime", () => {
    const stat = parseProcStat(line("node"));
    assert.equal(stat.utimeTicks, 1234);
    assert.equal(stat.stimeTicks, 567);
  });

  it("survives an executable name containing spaces and parentheses", () => {
    // Indexing by field position instead of from the last ')' reads the wrong
    // columns here, and nothing about the resulting number looks wrong.
    const stat = parseProcStat(line("Web Content (x)"));
    assert.equal(stat.utimeTicks, 1234);
    assert.equal(stat.stimeTicks, 567);
  });

  it("throws on a line it cannot read", () => {
    assert.throws(() => parseProcStat("4242 node S 1"));
  });
});

describe("parseProcIo", () => {
  const io = [
    "rchar: 123456789",
    "wchar: 987654321",
    "syscr: 1000",
    "syscw: 2000",
    "read_bytes: 40960",
    "write_bytes: 12288000",
    "cancelled_write_bytes: 4096",
  ].join("\n");

  it("distinguishes device bytes from syscall bytes", () => {
    // write_bytes is what reached the block layer; wchar counts bytes handed
    // to write(), page cache included. The success criterion is about the
    // former, and they differ by orders of magnitude.
    const parsed = parseProcIo(io);
    assert.equal(parsed.writeBytes, 12288000);
    assert.equal(parsed.wchar, 987654321);
    assert.equal(parsed.readBytes, 40960);
    assert.equal(parsed.rchar, 123456789);
  });
});

describe("parseProcStatusRss", () => {
  it("returns VmRSS in bytes", () => {
    const rss = parseProcStatusRss(
      ["Name:\tnode", "VmPeak:\t 2000000 kB", "VmRSS:\t   87040 kB"].join("\n"),
    );
    assert.equal(rss, 87040 * 1024);
  });

  it("throws when the process has no VmRSS", () => {
    // A kernel thread has none. Reporting 0 MB of memory for it would be a
    // measurement, which it is not.
    assert.throws(() => parseProcStatusRss("Name:\tkthreadd\n"));
  });
});

describe("parseDiskstats", () => {
  const diskstats = [
    "   7       0 loop0 0 0 0 0 0 0 0 0 0 0 0",
    " 179       0 mmcblk0 51234 900 2048000 12000 88123 4500 9216000 41000 0 30000 53000",
    " 179       1 mmcblk0p1 4000 100 128000 900 7000 300 512000 3000 0 2000 3900",
    " 259       0 nvme0n1 1000 0 8192 100 2000 0 16384 200 0 150 300",
  ].join("\n");

  it("reads completed operations and sector bytes per device", () => {
    const stats = parseDiskstats(diskstats);
    const mmc = stats.get("mmcblk0");
    assert.ok(mmc);
    assert.equal(mmc.readsCompleted, 51234);
    assert.equal(mmc.writesCompleted, 88123);
    assert.equal(mmc.readBytes, 2048000 * 512);
    assert.equal(mmc.writeBytes, 9216000 * 512);
  });

  it("keeps partitions out of the whole-disk list", () => {
    // A partition repeats its parent's I/O, so summing every line reports
    // roughly double the device's real traffic.
    const names = [...parseDiskstats(diskstats).keys()].filter(isWholeDisk);
    assert.deepEqual(names.sort(), ["mmcblk0", "nvme0n1"]);
  });

  it("sums only the devices it is given", () => {
    const stats = parseDiskstats(diskstats);
    const total = sumDisks(stats, ["mmcblk0", "nvme0n1"]);
    assert.equal(total.writesCompleted, 88123 + 2000);
    assert.equal(total.readsCompleted, 51234 + 1000);
  });

  it("ignores a device it does not have", () => {
    const total = sumDisks(parseDiskstats(diskstats), ["sda"]);
    assert.equal(total.writesCompleted, 0);
  });
});

describe("isWholeDisk", () => {
  it("accepts whole devices", () => {
    for (const name of ["sda", "vdb", "nvme0n1", "mmcblk0"]) {
      assert.equal(isWholeDisk(name), true, name);
    }
  });

  it("rejects partitions and virtual devices", () => {
    for (const name of [
      "sda1",
      "nvme0n1p2",
      "mmcblk0p1",
      "loop3",
      "ram0",
      "dm-0",
      "zram0",
    ]) {
      assert.equal(isWholeDisk(name), false, name);
    }
  });
});
