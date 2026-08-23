import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import type { DuckDBConnection } from "@duckdb/node-api";
import { DATA_DIR_MODE, DATA_LAYOUT } from "../data-dir.js";
import { commitFile } from "../durable-write.js";
import { BASE_DUCKDB_CONFIG, loadSqliteScanner } from "../duckdb/extension.js";
import { writerPaths } from "../writer/contract.js";
import {
  dateDirectory,
  rollFile,
  rollTempFile,
  sidecarFile,
  sidecarTempFile,
  utcDateSegment,
} from "./tree-path.js";

/**
 * The roll: the hot store's rows, as Parquet.
 *
 * It runs in its own process and exits, and that exit is the mechanism rather
 * than tidiness — DuckDB's allocator does not return this memory in-process,
 * so an engine held open would turn a transient into a standing cost.
 *
 * One streaming `COPY` per UTC date, never `PARTITION_BY`. A partitioned
 * write's peak rises with the row count and runs out of memory at this
 * package's path cardinality; a plain `COPY` streams and stays near 150 MB at
 * 1.27M rows. Measured in `docs/layout-decision.md`.
 *
 * The set it writes is `rowid <= maxRowid`, decided by the writer before this
 * process starts. Every row in that set lands in the date directory its own
 * timestamp names, so a roll spanning midnight writes two files and both are
 * correct.
 */

/** Milliseconds in a UTC day. The date directory is cut on these. */
const DAY_MS = 86_400_000;

/**
 * What the engine may allocate.
 *
 * Explicit because DuckDB's default is 80% of system RAM, which on a 4 GB
 * device is memory the marine stack is already using. A streaming COPY does
 * not need much; the limit is a ceiling, not a reservation.
 */
export const DEFAULT_MEMORY_LIMIT = "256MB";

/** Columns the tree carries, in the order every file writes them. */
const COLUMN_LIST = [
  "ts",
  "context",
  "path",
  "source",
  "value_kind",
  "value_num",
  "value_str",
  "value_lat",
  "value_lon",
].join(", ");

export interface RollOptions {
  dataDir: string;
  /** The highest rowid this roll covers, read by the writer beforehand. */
  maxRowid: number;
  /**
   * Names the roll's files. The writer keeps it stable across a retry, so a
   * second attempt overwrites the first attempt's files instead of leaving
   * them beside its own as duplicates.
   */
  rollId: number;
  memoryLimit?: string;
}

export interface RolledFile {
  date: string;
  path: string;
  rows: number;
}

export interface RollResult {
  rollId: number;
  maxRowid: number;
  rows: number;
  /** One per UTC date the covered rows fell in. */
  files: RolledFile[];
  sidecarRows: number;
}

export async function roll(options: RollOptions): Promise<RollResult> {
  const { dataDir, maxRowid, rollId } = options;
  if (!Number.isSafeInteger(maxRowid) || maxRowid < 1) {
    throw new Error(`${maxRowid} is not a rowid to roll through`);
  }

  // 0700 like everything else under the data directory: a spill holds the
  // same rows the hot store does, and mkdir's mode is masked by umask, so the
  // roll re-creating this after removing it must ask for the mode explicitly.
  const scratch = join(dataDir, DATA_LAYOUT.scratch);
  mkdirSync(scratch, { recursive: true, mode: DATA_DIR_MODE });

  const instance = await DuckDBInstance.create(":memory:", {
    ...BASE_DUCKDB_CONFIG,
    memory_limit: options.memoryLimit ?? DEFAULT_MEMORY_LIMIT,
    // Explicit, because the default for an in-memory database is relative to
    // the current working directory — which for a process the writer spawned
    // is the Signal K server's, not anywhere this package owns.
    temp_directory: scratch,
  });
  const connection = await instance.connect();
  try {
    await loadSqliteScanner(connection, {
      cacheDir: join(dataDir, DATA_LAYOUT.extensionCache),
    });
    // READ_ONLY: the writer owns this file and keeps ingesting throughout.
    // SQLite in WAL mode takes concurrent readers, which is why the hot store
    // is SQLite at all.
    await connection.run(
      `ATTACH '${sqlLiteral(writerPaths(dataDir).store)}' AS hot (TYPE SQLITE, READ_ONLY)`,
    );

    const files: RolledFile[] = [];
    for (const day of await coveredDays(connection, maxRowid)) {
      files.push(
        await writeDay({ connection, dataDir, rollId, maxRowid, day }),
      );
    }
    const sidecarRows = await writeSidecar({ connection, dataDir, maxRowid });

    return {
      rollId,
      maxRowid,
      rows: files.reduce((total, file) => total + file.rows, 0),
      files,
      sidecarRows,
    };
  } finally {
    connection.closeSync();
    instance.closeSync();
    // This directory is one roll's alone. Left behind, a device that rolls
    // every hour accumulates one per roll.
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Which UTC days the covered rows fall in, as day numbers.
 *
 * Integer division rather than a DuckDB date function, so the tree's date and
 * `tree-path.ts`'s date come out of the same arithmetic and cannot disagree
 * about a timezone.
 */
async function coveredDays(
  connection: DuckDBConnection,
  maxRowid: number,
): Promise<number[]> {
  const result = await connection.runAndReadAll(
    `SELECT DISTINCT CAST(floor(ts / ${DAY_MS}.0) AS BIGINT) AS day
     FROM hot.sample WHERE rowid <= ${maxRowid} ORDER BY day`,
  );
  return result.getRowsJS().map((row) => Number(row[0]));
}

async function writeDay(args: {
  connection: DuckDBConnection;
  dataDir: string;
  rollId: number;
  maxRowid: number;
  day: number;
}): Promise<RolledFile> {
  const { connection, dataDir, rollId, maxRowid, day } = args;
  const from = day * DAY_MS;
  mkdirSync(dateDirectory(dataDir, from), {
    recursive: true,
    mode: DATA_DIR_MODE,
  });
  const temp = rollTempFile(dataDir, from, rollId);
  const final = rollFile(dataDir, from, rollId);

  // No ORDER BY. The scan follows rowid, which is insertion order, which is
  // arrival order — so rows come out in timestamp order already and the row
  // group statistics prune on time without paying for a sort. Sorting a
  // window this size costs three times the memory the rest of the roll uses,
  // measured in docs/layout-decision.md.
  const select =
    `SELECT ${COLUMN_LIST} FROM hot.sample ` +
    `WHERE rowid <= ${maxRowid} AND ts >= ${from} AND ts < ${from + DAY_MS}`;
  await connection.run(
    `COPY (${select}) TO '${sqlLiteral(temp)}' (FORMAT parquet, COMPRESSION zstd)`,
  );
  commitFile(temp, final);

  const counted = await connection.runAndReadAll(
    `SELECT count(*) FROM read_parquet('${sqlLiteral(final)}')`,
  );
  return {
    date: utcDateSegment(from),
    path: final,
    rows: Number(counted.getRowsJS()[0][0]),
  };
}

/**
 * Rewrite the cumulative last-value sidecar.
 *
 * Cumulative is the whole point: a sidecar holding only this roll's paths
 * answers "the latest value of everything" wrong for any path that stopped
 * reporting before this roll. The previous sidecar is folded in and the
 * newest row per `(context, path)` wins.
 *
 * Written after the tree files. If the process dies between the two, the
 * writer never sees a successful exit, never truncates, and the retry rebuilds
 * both from a store that still holds every row.
 */
async function writeSidecar(args: {
  connection: DuckDBConnection;
  dataDir: string;
  maxRowid: number;
}): Promise<number> {
  const { connection, dataDir, maxRowid } = args;
  const final = sidecarFile(dataDir);
  const temp = sidecarTempFile(dataDir);
  mkdirSync(join(dataDir, DATA_LAYOUT.sidecar), {
    recursive: true,
    mode: DATA_DIR_MODE,
  });

  // `read_parquet` on a missing file is an error rather than an empty
  // relation, so the first roll on a device has to ask for something else.
  const previous = existsSync(final)
    ? ` UNION ALL SELECT ${COLUMN_LIST} FROM read_parquet('${sqlLiteral(final)}')`
    : "";
  const sources = `SELECT ${COLUMN_LIST} FROM hot.sample WHERE rowid <= ${maxRowid}${previous}`;
  await connection.run(
    `COPY (SELECT DISTINCT ON (context, path) ${COLUMN_LIST} FROM (${sources}) ` +
      `ORDER BY context, path, ts DESC) ` +
      `TO '${sqlLiteral(temp)}' (FORMAT parquet, COMPRESSION zstd)`,
  );
  commitFile(temp, final);

  const counted = await connection.runAndReadAll(
    `SELECT count(*) FROM read_parquet('${sqlLiteral(final)}')`,
  );
  return Number(counted.getRowsJS()[0][0]);
}

/**
 * Single-quoted SQL literal. Every path here is composed from the configured
 * data directory rather than from a delta, but DuckDB has no parameter
 * binding for `COPY … TO` or `ATTACH`, and the data directory is still one
 * string in them that a person types.
 */
function sqlLiteral(value: string): string {
  return value.replaceAll("'", "''");
}
