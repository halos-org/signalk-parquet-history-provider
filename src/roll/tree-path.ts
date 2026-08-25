import { isAbsolute, join, relative, resolve } from "node:path";
import { DATA_LAYOUT } from "../data-dir.js";

/**
 * Where a roll's output goes.
 *
 * The tree carries time and nothing else: `parquet/date=<YYYY-MM-DD>/`, with
 * `context` and `path` as columns inside the file. That is the layout Unit 3a
 * settled, and it is also why there is no path guard here — no delta-supplied
 * string ever becomes a directory name, so there is nothing to sanitise.
 *
 * Rows are placed by their own timestamp, not by when the roll ran. A roll
 * that spans midnight writes one file per date and stays correct; the roll
 * interval's divisibility rule is about the schedule, not about this.
 */

/**
 * The range `YYYY-MM-DD` can express.
 *
 * Narrower than `Date`'s own ±8.64e15: `toISOString` switches to an extended
 * form outside years 0000–9999, and slicing that to ten characters yields
 * `+011476-08` — a directory name no reader can parse as a date and that does
 * not sort with the others.
 */
const MAX_TIMESTAMP = 253402300799999;
const MIN_TIMESTAMP = -62167219200000;

/**
 * The UTC date a row belongs to, as the directory segment names it.
 *
 * UTC rather than local: the device's timezone is an installation detail, and
 * a tree cut on local dates cannot be read by anything that does not know
 * which timezone wrote it.
 */
export function utcDateSegment(ts: number): string {
  if (!Number.isFinite(ts) || ts > MAX_TIMESTAMP || ts < MIN_TIMESTAMP) {
    throw new RangeError(`${ts} is not a timestamp this can name a date from`);
  }
  return new Date(ts).toISOString().slice(0, 10);
}

/** The tree root — every roll file lives under this and nothing else does. */
export function treeRoot(dataDir: string): string {
  return join(resolve(dataDir), DATA_LAYOUT.tree);
}

/**
 * The UTC midnight a `date=YYYY-MM-DD` directory names, or null for an entry
 * that is not one.
 *
 * Shared by the reader, which selects files with it, and by expiry, which
 * deletes directories with it. Two copies of this rule would be two answers to
 * "is this entry ours", and the one that says yes too readily removes a
 * directory the tree does not own.
 *
 * Round-tripped rather than range-checked: `Date.parse` accepts
 * `2026-08-32T00:00:00.000Z` in some engines and rolls it into September, which
 * would name a directory a day that is not the one it holds.
 */
export function dateDirectoryStart(entry: string): number | null {
  if (!entry.startsWith("date=")) return null;
  const date = entry.slice("date=".length);
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(parsed) || utcDateSegment(parsed) !== date) return null;
  return parsed;
}

/** The directory for one date. The roll creates it before writing into it. */
export function dateDirectory(dataDir: string, ts: number): string {
  return join(treeRoot(dataDir), `date=${utcDateSegment(ts)}`);
}

/**
 * One roll's file for one date, named by the instant the roll began.
 *
 * The name is unique per roll, and a roll that writes two dates writes the
 * same name in two directories — which is why the date is a directory rather
 * than part of the filename.
 */
export function rollFile(
  dataDir: string,
  ts: number,
  rollStartMs: number,
): string {
  return assertUnderDataDir(
    dataDir,
    join(dateDirectory(dataDir, ts), `${rollIdSegment(rollStartMs)}.parquet`),
  );
}

/**
 * Where a roll writes before it renames.
 *
 * The `.tmp` suffix is the whole mechanism that keeps a killed roll from
 * leaving something a reader treats as complete: a reader globs `*.parquet`
 * and this does not match. No marker file, no lock.
 */
export function rollTempFile(
  dataDir: string,
  ts: number,
  rollStartMs: number,
): string {
  return `${rollFile(dataDir, ts, rollStartMs)}.tmp`;
}

/**
 * The cumulative last-value sidecar, deliberately outside the tree.
 *
 * Its rows are copies of rows already in the tree, so a reader globbing the
 * tree would count every path's last value twice.
 */
export function sidecarFile(dataDir: string): string {
  return assertUnderDataDir(
    dataDir,
    join(resolve(dataDir), DATA_LAYOUT.sidecar, "latest.parquet"),
  );
}

/** Where the sidecar is written before it is renamed into place. */
export function sidecarTempFile(dataDir: string): string {
  return `${sidecarFile(dataDir)}.tmp`;
}

function rollIdSegment(rollStartMs: number): string {
  // `>= 1`, the same floor the roll process and the pending-roll record use.
  // `nextRollAt` returns 0 for any clock set before the epoch, and a roll id
  // of 0 that one side accepts and another rejects wedged every future roll.
  if (!Number.isInteger(rollStartMs) || rollStartMs < 1) {
    throw new RangeError(`${rollStartMs} is not a roll id`);
  }
  return String(rollStartMs);
}

/**
 * Assert a composed path did not escape the data directory.
 *
 * Every argument that reaches these functions is the plugin's own — a clock
 * reading and a configured directory — so this cannot fire today. It is here
 * for the change that reintroduces an untrusted segment, which is the change
 * that would otherwise write outside the data directory in silence.
 */
export function assertUnderDataDir(dataDir: string, path: string): string {
  const root = resolve(dataDir);
  const candidate = resolve(path);
  const inside = relative(root, candidate);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
    throw new Error(`${path} is not inside the data directory ${root}`);
  }
  return candidate;
}
