/**
 * Proves, on the machine it runs on, that this installation can read a SQLite
 * hot store with DuckDB without reaching the network.
 *
 * This is the check that matters for a device: passing on a development
 * machine says nothing about arm64, and a machine with networking will happily
 * paper over a missing binary by downloading one. Autoinstall and autoload are
 * off here, so a pass means the bundled binary did the work.
 *
 *   node dist/duckdb/check-extension.js [--cache-dir <path>]
 */
import { DuckDBInstance } from "@duckdb/node-api";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASE_DUCKDB_CONFIG, loadSqliteScanner } from "./extension.js";
import { currentDuckdbPlatform } from "./duckdb-version.js";

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const work = mkdtempSync(join(tmpdir(), "sk-parquet-check-"));
  const cacheDir = argValue("--cache-dir") ?? join(work, "cache");
  try {
    const instance = await DuckDBInstance.create(":memory:", {
      ...BASE_DUCKDB_CONFIG,
    });
    const connection = await instance.connect();

    const version = await scalar(connection, "select version()");
    console.log(`duckdb          ${version}`);
    console.log(`platform        ${currentDuckdbPlatform()}`);

    const path = await loadSqliteScanner(connection, { cacheDir });
    console.log(`sqlite_scanner  ${path}`);

    // LOAD alone only proves the binary links. The roll and every query
    // ATTACH the hot store and read rows out of it, so exercise that.
    const db = join(work, "probe.sqlite");
    await connection.run(`ATTACH '${db}' AS hot (TYPE SQLITE)`);
    await connection.run("CREATE TABLE hot.sample (ts BIGINT, value DOUBLE)");
    await connection.run("INSERT INTO hot.sample VALUES (1, 1.5), (2, 2.5)");
    const total = await scalar(
      connection,
      "select sum(value)::VARCHAR from hot.sample",
    );
    await connection.run("DETACH hot");
    if (total !== "4.0") {
      throw new Error(`Read back ${total} from the probe store, expected 4.0`);
    }
    console.log("attach + read   ok");
    console.log("\nOK: this installation reads a SQLite hot store offline.");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function scalar(
  connection: { runAndReadAll: (sql: string) => Promise<any> },
  sql: string,
): Promise<string> {
  const reader = await connection.runAndReadAll(sql);
  return String(reader.getRows()[0][0]);
}

main().catch((err: unknown) => {
  console.error(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
