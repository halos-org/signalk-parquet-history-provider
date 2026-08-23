import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import createPlugin from "../index.js";
import { writerPaths } from "../writer/contract.js";
import type { BusValue } from "../recorder.js";

/**
 * The whole path, with a real writer process on the end of it.
 *
 * Everything else in the suite tests one piece against stubs. This is the only
 * place that proves the pieces are wired to each other: a value handed to the
 * bus becomes a row in a SQLite file written by a different process.
 */

const SELF = "vessels.urn:mrn:signalk:uuid:self";

function stubApp(dataDirPath: string) {
  const calls = {
    status: [] as string[],
    errors: [] as string[],
    logged: [] as unknown[],
    debug: [] as string[],
  };
  let handler: ((value: BusValue) => void) | null = null;
  return {
    calls,
    feed: (value: Partial<BusValue>) =>
      handler?.({
        context: SELF,
        path: "environment.depth.belowKeel",
        value: 4.2,
        $source: "n2k.0",
        ...value,
      }),
    app: {
      debug: (...args: unknown[]) => calls.debug.push(args.join(" ")),
      error: (...args: unknown[]) => calls.logged.push(...args),
      setPluginStatus: (message: string) => calls.status.push(message),
      setPluginError: (message: string) => calls.errors.push(message),
      getDataDirPath: () => dataDirPath,
      selfContext: SELF,
      streambundle: {
        getBus: () => ({
          onValue: (fn: (value: BusValue) => void) => {
            handler = fn;
            return () => {
              handler = null;
            };
          },
        }),
      },
    },
  };
}

/** Reads the hot store while the writer still holds it, as the roll will. */
function storedRows(storePath: string): Record<string, unknown>[] {
  if (!existsSync(storePath)) return [];
  const db = new DatabaseSync(storePath, { readOnly: true });
  try {
    return db.prepare("SELECT * FROM sample ORDER BY rowid").all() as Record<
      string,
      unknown
    >[];
  } catch {
    // The writer may not have created the table yet.
    return [];
  } finally {
    db.close();
  }
}

async function eventually(
  check: () => boolean,
  what: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("a delta reaching the writer's store", () => {
  it("is recorded by a separate process, with its kind intact", async () => {
    const base = mkdtempSync(join(tmpdir(), "sk-parquet-e2e-"));
    const paths = writerPaths(base);
    const { app, feed, calls } = stubApp(base);
    const plugin = createPlugin(app);
    try {
      plugin.start({
        defaultSamplingRate: 0,
        flushIntervalMs: 50,
        flushBatchSize: 3,
      });

      feed({ path: "environment.depth.belowKeel", value: 4.25 });
      feed({ path: "navigation.state", value: "moored" });
      feed({ path: "electrical.switches.anchorLight.state", value: true });

      await eventually(
        () => storedRows(paths.store).length >= 3,
        `three rows in ${paths.store} (errors: ${JSON.stringify(calls.errors)})`,
      );

      const rows = storedRows(paths.store);
      assert.deepEqual(
        rows.map((r) => [r.path, r.value_kind, r.value_num ?? r.value_str]),
        [
          ["environment.depth.belowKeel", "number", 4.25],
          ["navigation.state", "string", "moored"],
          ["electrical.switches.anchorLight.state", "boolean", "true"],
        ],
      );
      // The context is shortened, and the source survives for the history
      // API's `path|sourceRef` filtering.
      assert.equal(rows[0].context, "self");
      assert.equal(rows[0].source, "n2k.0");
      assert.deepEqual(calls.errors, []);
    } finally {
      plugin.stop();
      // The writer removes its pid file on SIGTERM. The claim on the store is
      // the socket, not this file, but a writer that never got its stop signal
      // would leave it behind and that is worth noticing.
      await eventually(
        () => !existsSync(paths.pidFile),
        "the writer to clean up after itself",
        10_000,
      ).catch(() => {});
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("says so when the writer dies, instead of staying green", async () => {
    // The writer is a separate process, so it can die without taking the
    // server with it. What must not happen is the plugin carrying on showing
    // "Recording" while nothing lands -- the failure this whole design is
    // meant to make impossible.
    const base = mkdtempSync(join(tmpdir(), "sk-parquet-e2e-"));
    const paths = writerPaths(base);
    const { app, feed, calls } = stubApp(base);
    const plugin = createPlugin(app);
    try {
      plugin.start({
        defaultSamplingRate: 0,
        flushIntervalMs: 50,
        flushBatchSize: 1,
      });
      feed({ value: 1 });
      await eventually(
        () => storedRows(paths.store).length >= 1,
        "the first row",
      );
      await eventually(
        () => /Recording/.test(calls.status[calls.status.length - 1] ?? ""),
        "the status to say it is recording",
      );

      // The pid file exists for exactly this: finding the writer from outside.
      // Nothing in the plugin decides anything from it.
      await eventually(
        () => existsSync(paths.pidFile),
        "the writer's pid file",
      );
      const pid = Number.parseInt(
        readFileSync(paths.pidFile, "utf8").trim(),
        10,
      );
      assert.ok(
        Number.isInteger(pid) && pid > 0,
        `bad pid in ${paths.pidFile}`,
      );
      process.kill(pid, "SIGKILL");

      await eventually(
        () => calls.errors.some((line) => /writer process exited/.test(line)),
        `the death to be reported (errors: ${JSON.stringify(calls.errors)})`,
      );
    } finally {
      plugin.stop();
      rmSync(base, { recursive: true, force: true });
    }
  });
});
