/**
 * A load generator with a known duty cycle, used only by `bench selftest`.
 *
 * Its point is that the harness's own numbers can be checked against
 * something whose answer is known in advance: a 20% duty cycle should read as
 * roughly 20% of one core, and a process fsyncing 32 KB four times a second
 * should read as roughly 128 KB/s of device writes. If the harness disagrees
 * with that, the harness is wrong.
 *
 *   node dist/bench/load.js --duty 0.2 --write-kb 32 --interval-ms 250 --dir <path>
 */
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { LoadStats, STATS_FILE } from "./load-stats.js";

const { values } = parseArgs({
  options: {
    duty: { type: "string", default: "0.2" },
    "write-kb": { type: "string", default: "32" },
    "interval-ms": { type: "string", default: "250" },
    dir: { type: "string" },
  },
});

const duty = Math.min(Math.max(Number(values.duty), 0), 1);
const writeKb = Number(values["write-kb"]);
const intervalMs = Number(values["interval-ms"]);
const dir = required(values.dir, "--dir");
mkdirSync(dir, { recursive: true });

function required(value: string | undefined, flag: string): string {
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

// A fixed slice, spun for `duty` of its length and slept for the rest. Short
// enough that the average holds over a few seconds, long enough that the
// timer's own overhead does not dominate.
const SLICE_MS = 100;
const payload = Buffer.alloc(writeKb * 1024, 0x61);

let running = true;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    running = false;
  });
}

const fd = writeKb > 0 ? openSync(join(dir, "load.bin"), "w") : -1;
let lastWrite = 0;
let bytesWritten = 0;
let writes = 0;
const startedAt = Date.now();

async function main(): Promise<void> {
  while (running) {
    const sliceStart = Date.now();
    const spinUntil = sliceStart + SLICE_MS * duty;
    // Deliberately a busy loop: the whole point is to consume a known share
    // of one core, which no amount of waiting would do.
    while (Date.now() < spinUntil) {
      /* burn */
    }

    if (fd >= 0 && Date.now() - lastWrite >= intervalMs) {
      writeSync(fd, payload, 0, payload.length, 0);
      // Without the fsync the bytes sit in page cache and never reach the
      // block layer, so /proc/<pid>/io write_bytes stays at zero and the
      // selftest would compare the harness against no I/O at all.
      fsyncSync(fd);
      bytesWritten += payload.length;
      writes++;
      lastWrite = Date.now();
    }

    const remaining = sliceStart + SLICE_MS - Date.now();
    if (remaining > 0) {
      await new Promise((resolve) => setTimeout(resolve, remaining));
    }
  }
  if (fd >= 0) closeSync(fd);

  // Written only here, on the way out. Writing it periodically would put this
  // process's own bookkeeping into the very /proc/<pid>/io counters the
  // harness is reading, which would show up as write traffic in the idle
  // condition that is supposed to have none.
  const cpu = process.cpuUsage();
  const stats: LoadStats = {
    elapsedMs: Date.now() - startedAt,
    cpuUsec: cpu.user + cpu.system,
    bytesWritten,
    writes,
  };
  writeFileSync(join(dir, STATS_FILE), JSON.stringify(stats));
}

await main();
