import { createServer } from "node:net";
import { chmodSync, rmSync, writeSync } from "node:fs";
import { ownPeakBytes } from "../bench/one-shot.js";
import {
  EXIT_LOCKED,
  EXIT_NAME_TAKEN,
  writerPaths,
} from "../writer/contract.js";
import { probeLiveWriter } from "../writer/server.js";
import { NameTakenError, roll } from "./roll.js";

/**
 * The roll process.
 *
 * Spawned by the writer, once per roll, and it exits when the roll is done.
 * The exit is what returns the memory: DuckDB's allocator does not give it
 * back in-process, so a long-lived engine would turn a two-second transient
 * into a standing cost on a device chosen for not having one.
 *
 *   node dist/roll/main.js --data-dir <path> --max-rowid <n> --roll-id <ms> [--replace]
 *
 * On success it prints one JSON line describing what it wrote — including
 * this process's own peak resident size, which is the figure the design is
 * judged on and which nothing outside the process can read exactly — and
 * exits 0.
 * The writer treats that exit as "the Parquet is durable" and only then
 * deletes those rows from the hot store — nothing else may truncate it,
 * because nothing else knows the write reached the disk.
 *
 * Exit codes:
 *   0  rolled, and the files are fsynced and renamed into place
 *   3  another roll is already running against this data directory
 *   4  the filename is taken by a roll that is not this one
 *   1  anything else; the hot store is untouched and the next roll retries
 *
 * 3 and 4 are named apart from 1 because the scheduler acts differently on
 * each: 3 means wait for the next slot, and 4 means abandon this name — the
 * one failure a retry under the same id must not inherit.
 */

/**
 * Write to stderr and be sure it arrives.
 *
 * `process.stderr.write` is asynchronous when stderr is a pipe — which it
 * always is here, since the parent spawns this with piped stdio — and
 * `process.exit` right after it truncates whatever is still queued. The
 * message this loses is the one the parent logs as the reason.
 */
function writeStderr(line: string): void {
  writeSync(2, line);
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function requireNumber(flag: string): number {
  const raw = argValue(flag);
  const value = Number(raw);
  if (raw === undefined || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${flag} must be a positive whole number, not ${raw}`);
  }
  return value;
}

async function main(): Promise<void> {
  const dataDir = argValue("--data-dir");
  if (dataDir === undefined || dataDir === "") {
    writeStderr(
      "usage: roll/main.js --data-dir <path> --max-rowid <n> --roll-id <ms>\n",
    );
    process.exit(1);
  }

  // The claim on the data directory, made the way the writer claims the store:
  // if something answers here, a roll is already running and this one must not
  // race it for the same filenames. A socket carries no ambiguity across the
  // PID namespaces a container restart creates, which is why it is not a pid
  // file — that lesson is already written down in writer/server.ts.
  const paths = writerPaths(dataDir);
  if (await probeLiveWriter(paths.rollSocket)) {
    writeStderr(
      `a roll is already running against ${dataDir}; refusing to start a second one\n`,
    );
    process.exit(EXIT_LOCKED);
  }
  rmSync(paths.rollSocket, { force: true });
  const claim = createServer();
  await new Promise<void>((resolve, reject) => {
    claim.once("error", reject);
    claim.listen(paths.rollSocket, () => resolve());
  });
  chmodSync(paths.rollSocket, 0o600);
  claim.unref();

  const result = await roll({
    dataDir,
    maxRowid: requireNumber("--max-rowid"),
    rollId: requireNumber("--roll-id"),
    memoryLimit: argValue("--memory-limit"),
    // Only a retry of a roll that already wrote something may replace it.
    replace: process.argv.includes("--replace"),
  });
  // The peak belongs to the process, not to the roll, and only the process
  // can read its own high-water mark before it is gone.
  process.stdout.write(
    `${JSON.stringify({ ...result, peakRssBytes: ownPeakBytes() })}\n`,
  );
}

main().catch((err: unknown) => {
  // The message first, then the stack. The scheduler reports the first line,
  // and a stack frame tells an operator nothing about why the roll stopped.
  writeStderr(
    `${err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err)}\n`,
  );
  process.exit(err instanceof NameTakenError ? EXIT_NAME_TAKEN : 1);
});
