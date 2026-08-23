import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR_MODE, DATA_LAYOUT } from "../data-dir.js";
import { HotStore } from "./hot-store.js";
import { StoreLockedError, WriterServer } from "./server.js";
import { EXIT_LOCKED, writerPaths } from "./contract.js";

/**
 * The writer process.
 *
 * Spawned by the plugin, one per plugin run, and the only process that writes
 * the hot store. It exists so that no storage work happens on the Signal K
 * event loop; keeping it a separate process rather than a worker thread is
 * what makes that true of memory as well as CPU.
 *
 *   node dist/writer/main.js --data-dir <path>
 *
 * Exit codes are read by the plugin, which turns them into a status an
 * operator can see:
 *   0  asked to stop, stopped cleanly
 *   3  another writer already holds the hot store
 *   1  anything else
 */

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const dataDir = argValue("--data-dir");
  if (dataDir === undefined || dataDir === "") {
    process.stderr.write("usage: writer/main.js --data-dir <path>\n");
    process.exit(1);
  }

  const paths = writerPaths(dataDir);
  const hot = join(dataDir, DATA_LAYOUT.hotStore);
  mkdirSync(hot, { recursive: true, mode: DATA_DIR_MODE });
  // Before the store is opened: HotStore.open creates hot.sqlite and its WAL
  // inside this directory, and until the mode is right they are readable by
  // anyone who can reach it.
  chmodSync(hot, DATA_DIR_MODE);

  const store = HotStore.open(paths.store);
  let server;
  try {
    server = await WriterServer.listen({
      socketPath: paths.socket,
      store,
      log: (line) => process.stdout.write(`${line}\n`),
    });
  } catch (err) {
    if (err instanceof StoreLockedError) {
      // Named separately from any other failure because the plugin's remedy is
      // different: a second writer is a problem to resolve, not to retry.
      process.stderr.write(`${err.message}\n`);
      process.exit(EXIT_LOCKED);
    }
    throw err;
  }
  // Informational only. Nothing decides anything from it -- see writerPaths.
  writeFileSync(paths.pidFile, `${process.pid}\n`, { mode: 0o600 });
  process.stdout.write(`writer ready on ${paths.socket}\n`);

  let stopping = false;
  const stop = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    process.stdout.write(`writer stopping on ${signal}\n`);
    await server.close();
    store.close();
    rmSync(paths.pidFile, { force: true });
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
}

main().catch((err: unknown) => {
  process.stderr.write(
    `${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
