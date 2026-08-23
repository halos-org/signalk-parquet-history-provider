import { ownPeakBytes } from "../bench/one-shot.js";
import { roll } from "./roll.js";

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
 *   1  anything else; the hot store is untouched and the next roll retries
 */

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
    process.stderr.write(
      "usage: roll/main.js --data-dir <path> --max-rowid <n> --roll-id <ms>\n",
    );
    process.exit(1);
  }

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
  process.stderr.write(
    `${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
