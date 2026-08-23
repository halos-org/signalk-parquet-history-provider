import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance, listValue } from "@duckdb/node-api";
import type { DuckDBConnection, DuckDBValue } from "@duckdb/node-api";
import { DATA_DIR_MODE, DATA_LAYOUT } from "../data-dir.js";
import {
  BASE_DUCKDB_CONFIG,
  loadSqliteScanner,
  lockDownFileAccess,
} from "../duckdb/extension.js";
import { sqlLiteral } from "../duckdb/sql.js";
import { treeRoot, utcDateSegment } from "../roll/tree-path.js";
import { readPendingRoll, writerPaths } from "../writer/contract.js";
import { RANGE_COLUMNS } from "./duck.js";
import type { QueryRequest } from "./duck.js";

/**
 * The hot store and the Parquet tree, read as one.
 *
 * This runs in the spawned query process — it is the only file besides
 * `roll/roll.ts` that may import the engine, and it may because the process
 * exits. Everything is one statement: the tree files that intersect the range,
 * the unrolled remainder of the hot store, and one filter over both.
 *
 * **The seam between them is the interesting part.** A roll writes its rows to
 * Parquet and the writer deletes them from the store afterwards, so between
 * those two steps every covered row exists twice. `overlap` below is what
 * subtracts one copy, exactly, without a `DISTINCT` over the whole answer.
 */

/**
 * What the engine may allocate. The same ceiling the roll takes, and for the
 * same reason: DuckDB's default is 80% of system RAM, which on a 4 GB device
 * is memory the marine stack is already using.
 */
export const DEFAULT_MEMORY_LIMIT = "256MB";

/**
 * Rows one query returns before the answer is reported as truncated.
 *
 * The caller holds all of them in the Signal K process, so this is a ceiling
 * on that rather than on the engine. History playback already reads a long
 * range as a series of shorter ones; this is what makes an unbounded request
 * degrade into a truncated answer rather than into the server's heap.
 */
export const DEFAULT_ROW_LIMIT = 100_000;

/** Milliseconds in a UTC day. The tree's directories are cut on these. */
const DAY_MS = 86_400_000;

const COLUMNS = RANGE_COLUMNS.join(", ");

export interface ReaderOptions {
  dataDir: string;
  memoryLimit?: string;
}

export interface ReadResult {
  rows: unknown[][];
  truncated: boolean;
  treeFiles: number;
}

/** One Parquet file, with the UTC day its directory names. */
interface TreeFile {
  day: number;
  path: string;
  /** The file's own name, which is the id of the roll that wrote it. */
  name: string;
}

/**
 * The rows a completed-but-not-truncated roll put in both places.
 *
 * `maxRowid` bounds the set the roll covered, and `dayStarts` names the days
 * whose file it actually managed to write — a roll killed between two dates
 * has written one of them and not the other, and the store is still the only
 * copy of the rest.
 */
interface Overlap {
  maxRowid: number;
  dayStarts: number[];
}

interface Plan {
  files: TreeFile[];
  overlap: Overlap | null;
  storeExists: boolean;
}

/** An engine held open, and the queries it answers. */
export interface Reader {
  read(request: QueryRequest): Promise<ReadResult>;
  close(): void;
}

/**
 * Start the engine.
 *
 * Everything expensive happens here and once: mapping the addon, creating the
 * instance, expanding and loading `sqlite_scanner`, and locking the engine to
 * the data directory. Measured on the device, that is ~345 ms of a cold
 * query's ~600 ms, and it is why a query answers in 39–141 ms once this has
 * run.
 *
 * The extension is loaded even though no store is attached yet, because the
 * lockdown that follows would refuse it later. A device whose bundle cannot be
 * loaded still gets a reader — the tree needs no SQLite — and the reason is
 * kept for the first query that does need the store.
 */
export async function openReader(options: ReaderOptions): Promise<Reader> {
  const { dataDir } = options;
  // One directory for this process, not one per query. A query can spill while
  // a roll is spilling beside it, and DuckDB's default temp directory for an
  // in-memory database is the current working directory — which for a process
  // the plugin spawned is the Signal K server's.
  const scratch = join(dataDir, DATA_LAYOUT.scratch, `query-${process.pid}`);
  mkdirSync(scratch, { recursive: true, mode: DATA_DIR_MODE });

  let instance: DuckDBInstance | null = null;
  let connection: DuckDBConnection | null = null;
  try {
    instance = await DuckDBInstance.create(":memory:", {
      ...BASE_DUCKDB_CONFIG,
      memory_limit: options.memoryLimit ?? DEFAULT_MEMORY_LIMIT,
      temp_directory: scratch,
    });
    connection = await instance.connect();
  } catch (err) {
    connection?.closeSync();
    instance?.closeSync();
    rmSync(scratch, { recursive: true, force: true });
    throw err;
  }

  let scannerFailure: string | null = null;
  try {
    await loadSqliteScanner(connection, {
      cacheDir: join(dataDir, DATA_LAYOUT.extensionCache),
    });
  } catch (err) {
    // Not fatal, and not silent either. Without the extension the hot store
    // cannot be read, but the tree can — an old range still answers, and a
    // recent one says why it cannot.
    scannerFailure = err instanceof Error ? err.message : String(err);
  }

  // Everything legitimate is open, so nothing else may be. After this the
  // engine cannot read a path outside the data directory, cannot install an
  // extension and cannot have its configuration changed — which is what stops
  // a crafted path or an unknown function from turning a query into a
  // download. Attaching a database inside the allowed directory still works,
  // which is what the per-query attach below relies on.
  await lockDownFileAccess(connection, [dataDir]);

  const live = connection;
  return {
    read: (request) =>
      runOne(request, { dataDir, connection: live, scannerFailure }),
    close: () => {
      live.closeSync();
      instance.closeSync();
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}

/**
 * One query on an already-open engine.
 *
 * The hot store is attached per query and detached afterwards, for about a
 * millisecond. Holding it would work — measured across processes, a held
 * attachment still sees rows written after it and still lets the writer
 * truncate its WAL — but attaching here also picks up a store that did not
 * exist when the engine started, which on a fresh device is the first minute
 * of its life.
 */
async function runOne(
  request: QueryRequest,
  context: {
    dataDir: string;
    connection: DuckDBConnection;
    scannerFailure: string | null;
  },
): Promise<ReadResult> {
  validate(request);
  const { dataDir, connection } = context;
  const plan = planSources(dataDir, request);
  const sql = compile(request, plan);
  if (sql === null) {
    // Neither a tree file nor a hot store: a device that has recorded nothing,
    // or a range that predates the oldest date directory. An empty answer, not
    // an error — the history API's own answer for a range with no data.
    return { rows: [], truncated: false, treeFiles: 0 };
  }
  if (plan.storeExists && context.scannerFailure !== null) {
    throw new Error(
      `this range needs the hot store and sqlite_scanner could not be loaded: ${context.scannerFailure}`,
    );
  }

  let attached = false;
  try {
    if (plan.storeExists) {
      // READ_ONLY: the writer owns this file and keeps ingesting throughout.
      // SQLite in WAL mode takes concurrent readers, which is why the hot
      // store is SQLite at all.
      await connection.run(
        `ATTACH '${sqlLiteral(writerPaths(dataDir).store)}' AS hot (TYPE SQLITE, READ_ONLY)`,
      );
      attached = true;
    }

    const limit = rowLimit(request);
    const result = await connection.runAndReadAll(sql.text, sql.params);
    const rows = result.getRowsJS();
    // In place. These arrays are freshly built and nothing else holds them,
    // and mapping into new ones cost 11 MB more at 82,000 rows on the device —
    // 230 MB against 219 MB, on the largest transient in this design.
    for (const row of rows) {
      for (let i = 0; i < row.length; i += 1) {
        // `ts` is BIGINT in the tree and INTEGER in the store, so it arrives
        // as a BigInt whenever a Parquet file is one of the branches — and
        // `JSON.stringify` throws on one rather than writing a number.
        if (typeof row[i] === "bigint") row[i] = Number(row[i]);
      }
    }
    return {
      // One row over the limit is asked for, so a full answer and a truncated
      // one can be told apart. It is dropped here.
      truncated: rows.length > limit,
      rows: rows.length > limit ? rows.slice(0, limit) : rows,
      treeFiles: plan.files.length,
    };
  } finally {
    // A left-over attachment would make the next query's `ATTACH` fail on the
    // name, so every one of them would fail after the first that threw.
    if (attached) await connection.run("DETACH hot").catch(() => {});
  }
}

/**
 * Which files answer this range, and which of the store's rows they already
 * hold.
 *
 * **The order of the two reads matters.** Files are listed first and the
 * pending-roll record second, and the overlap is anchored on the file list
 * rather than on the record. A record that names a roll whose file has not
 * appeared yet therefore subtracts nothing — the tree does not hold those rows
 * yet, and subtracting them would turn a duplicate into a gap. The reverse
 * race is harmless: a record cleared after the listing means the store's rows
 * are already gone.
 */
function planSources(dataDir: string, request: QueryRequest): Plan {
  const files = treeFilesInRange(dataDir, request.from, request.to);
  return {
    files,
    overlap: rolledOverlap(dataDir, files),
    storeExists: existsSync(writerPaths(dataDir).store),
  };
}

/**
 * The tree's files whose date directory intersects `[from, to)`.
 *
 * A directory glob and a timestamp filter is all the pruning this layout
 * offers — nothing in the tree prunes on path — so this is where a long range
 * is turned into the smallest set of files that can hold it.
 *
 * `.tmp` is excluded by construction: a roll writes under that suffix and
 * renames, so a file killed mid-write does not end in `.parquet` and is not
 * matched here.
 */
export function treeFilesInRange(
  dataDir: string,
  from: number,
  to: number,
): TreeFile[] {
  const root = treeRoot(dataDir);
  let dates: string[];
  try {
    dates = readdirSync(root);
  } catch {
    // No tree yet. A device that has not rolled once is the normal case for
    // the first hour of its life.
    return [];
  }

  const found: TreeFile[] = [];
  for (const entry of dates.sort()) {
    const day = dayStartOf(entry);
    if (day === null) continue;
    if (day >= to || day + DAY_MS <= from) continue;
    const directory = join(root, entry);
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      continue; // Removed between the two reads, by expiry or by hand.
    }
    for (const name of names.sort()) {
      if (!name.endsWith(".parquet")) continue;
      found.push({ day, name, path: join(directory, name) });
    }
  }
  return found;
}

/** The UTC midnight a `date=YYYY-MM-DD` directory names, or null. */
function dayStartOf(entry: string): number | null {
  if (!entry.startsWith("date=")) return null;
  const date = entry.slice("date=".length);
  const parsed = Date.parse(`${date}T00:00:00.000Z`);
  // Round-tripped rather than range-checked: `Date.parse` accepts
  // `2026-08-32T00:00:00.000Z` in some engines and rolls it into September,
  // which would name a directory a day that is not the one it holds.
  if (!Number.isFinite(parsed) || utcDateSegment(parsed) !== date) return null;
  return parsed;
}

/**
 * What a roll has written to the tree and not yet removed from the store.
 *
 * Both phases of the record mean the same thing to a reader: some of the
 * covered rows may be in the tree already. Which ones is decided by which
 * files exist, not by the phase, so a `rolling` record that got one date
 * written and died before the next is handled by the same rule as a `written`
 * one that finished them all.
 */
function rolledOverlap(dataDir: string, files: TreeFile[]): Overlap | null {
  const pending = readPendingRoll(dataDir);
  if (pending === null) return null;
  const wanted = `${pending.rollId}.parquet`;
  const dayStarts = [
    ...new Set(
      files.filter((file) => file.name === wanted).map((file) => file.day),
    ),
  ];
  if (dayStarts.length === 0) return null;
  return { maxRowid: pending.maxRowid, dayStarts };
}

interface Compiled {
  text: string;
  params: Record<string, DuckDBValue>;
}

function compile(request: QueryRequest, plan: Plan): Compiled | null {
  const params: Record<string, DuckDBValue> = {
    fromMs: BigInt(Math.trunc(request.from)),
    toMs: BigInt(Math.trunc(request.to)),
  };
  const filters = ["ts >= $fromMs", "ts < $toMs"];
  if (request.kind !== "contexts") {
    params.context = request.context;
    filters.push("context = $context");
  }
  if (request.kind === "range" && (request.paths?.length ?? 0) > 0) {
    // Bound as a list rather than composed into the statement: these come from
    // an HTTP request, and they are the only strings in here that do.
    params.paths = listValue(request.paths as string[]);
    filters.push("list_contains($paths, path)");
  }
  const where = filters.join(" AND ");

  const branches: string[] = [];
  if (plan.files.length > 0) {
    const list = plan.files
      .map((file) => `'${sqlLiteral(file.path)}'`)
      .join(", ");
    // `union_by_name`: a file written by a build with a different column set
    // is read with the missing columns as NULL rather than failing the query.
    branches.push(
      `SELECT ${COLUMNS} FROM read_parquet([${list}], union_by_name = true) WHERE ${where}`,
    );
  }
  if (plan.storeExists) {
    branches.push(
      `SELECT ${COLUMNS} FROM hot.sample WHERE ${where}${seam(plan.overlap, params)}`,
    );
  }
  if (branches.length === 0) return null;

  const union =
    branches.length === 1 ? branches[0] : branches.join(" UNION ALL ");
  if (request.kind === "range") {
    return {
      // One over the limit, so the caller can be told the answer is partial.
      text: `SELECT ${COLUMNS} FROM (${union}) ORDER BY ts LIMIT ${rowLimit(request) + 1}`,
      params,
    };
  }
  const column = request.kind === "paths" ? "path" : "context";
  return {
    text: `SELECT DISTINCT ${column} FROM (${union}) ORDER BY ${column}`,
    params,
  };
}

/**
 * The predicate that keeps a rolled row from being counted twice.
 *
 * Read it as: a row is the store's alone unless the roll covered it *and* the
 * file for its own day is on disk. `rowid` is the same bound the roll used, so
 * the two sets are identical by construction rather than by matching
 * timestamps — a row that arrived after the roll read its bound has a higher
 * rowid and is kept, which is exactly why the roll works on rowids.
 */
function seam(
  overlap: Overlap | null,
  params: Record<string, DuckDBValue>,
): string {
  if (overlap === null) return "";
  params.maxRowid = BigInt(overlap.maxRowid);
  const days = overlap.dayStarts
    .map((day) => `(ts >= ${day} AND ts < ${day + DAY_MS})`)
    .join(" OR ");
  return ` AND (rowid > $maxRowid OR NOT (${days}))`;
}

function rowLimit(request: QueryRequest): number {
  if (request.kind !== "range") return DEFAULT_ROW_LIMIT;
  const asked = request.limit;
  if (asked === undefined) return DEFAULT_ROW_LIMIT;
  return Math.max(1, Math.min(Math.floor(asked), DEFAULT_ROW_LIMIT));
}

/** The kinds a request may name. Anything else is not a query. */
const KINDS = ["range", "paths", "contexts"] as const;

/**
 * Check the request at the boundary it crosses.
 *
 * It arrives as JSON from another process, which built it from an HTTP
 * request, and the type it is cast to on arrival is a claim rather than a
 * check. Everything user-supplied is bound rather than composed, so this is
 * about shape rather than about injection — but a shape nobody checked still
 * reaches SQL: an unrecognised `kind` compiled to the contexts query and
 * answered it, and a `limit` of `"x"` compiled to `LIMIT NaN`.
 */
function validate(request: QueryRequest): void {
  if (!KINDS.includes(request.kind)) {
    throw new Error(
      `${JSON.stringify(request.kind)} is not a query kind; expected one of ${KINDS.join(", ")}`,
    );
  }
  const time = (name: "from" | "to", value: unknown) => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`${name} must be a timestamp in milliseconds`);
    }
  };
  time("from", request.from);
  time("to", request.to);
  if (request.kind !== "contexts" && typeof request.context !== "string") {
    throw new Error("context must be a string");
  }
  if (request.kind !== "range") return;
  if (request.paths !== undefined) {
    if (
      !Array.isArray(request.paths) ||
      request.paths.some((path) => typeof path !== "string")
    ) {
      throw new Error("paths must be an array of strings");
    }
  }
  if (
    request.limit !== undefined &&
    (typeof request.limit !== "number" || !Number.isFinite(request.limit))
  ) {
    throw new Error("limit must be a number of rows");
  }
}
