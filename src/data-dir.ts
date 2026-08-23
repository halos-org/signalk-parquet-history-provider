import { isAbsolute, resolve } from "node:path";

/**
 * Where the hot store, the Parquet tree and the expanded DuckDB extension
 * live.
 *
 * The writer, the roll and every query process are spawned separately and
 * must all land on the same directory, so this resolves the configured value
 * once, in the plugin, and the answer is passed to them rather than
 * recomputed. A relative setting resolves against the Signal K plugin data
 * directory, not the current working directory: the spawned processes do not
 * share the server's, so anything cwd-relative would mean different
 * directories in different processes.
 */
export function resolveDataDir(
  configured: string,
  pluginDataDir: string,
): string {
  const trimmed = (configured ?? "").trim();
  if (trimmed === "") return resolve(pluginDataDir);
  if (isAbsolute(trimmed)) return resolve(trimmed);
  return resolve(pluginDataDir, trimmed);
}

/** Sub-directory names under the resolved data directory. Named here so the
 * writer, the roll and the query layer cannot spell them differently. */
export const DATA_LAYOUT = {
  /** The SQLite hot store the writer owns. */
  hotStore: "hot",
  /** The Parquet tree the roll writes. */
  tree: "parquet",
  /** Expanded DuckDB extension binaries, keyed by version and platform. */
  extensionCache: "duckdb-extensions",
} as const;
