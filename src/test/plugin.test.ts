import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import createPlugin from "../index.js";
import { ConfigSchema } from "../config/schema.js";
import { DATA_LAYOUT } from "../data-dir.js";
import { PLUGIN_ID } from "../plugin-id.js";

/**
 * The plugin is the only runtime behaviour this build ships, and its catch
 * turns every startup failure into a status string and returns normally — so
 * a mis-wired error path fails nothing anywhere else.
 */
function stubApp(dataDirPath: string) {
  const calls = {
    status: [] as string[],
    errors: [] as string[],
    logged: [] as unknown[],
  };
  return {
    calls,
    app: {
      debug: () => {},
      error: (...args: unknown[]) => calls.logged.push(...args),
      setPluginStatus: (message: string) => calls.status.push(message),
      setPluginError: (message: string) => calls.errors.push(message),
      getDataDirPath: () => dataDirPath,
      selfContext: "vessels.self",
    },
  };
}

describe("the plugin", () => {
  it("declares the id and schema the server reads", () => {
    const { app } = stubApp("/nonexistent");
    const plugin = createPlugin(app);
    assert.equal(plugin.id, PLUGIN_ID);
    assert.equal(plugin.schema, ConfigSchema);
    assert.equal(typeof plugin.start, "function");
    assert.equal(typeof plugin.stop, "function");
  });

  it("creates the storage layout under the resolved data directory", () => {
    // Unit 2's writer will assume these exist. Nothing else asserts that
    // DATA_LAYOUT is used rather than merely declared.
    const base = mkdtempSync(join(tmpdir(), "sk-parquet-plugin-"));
    try {
      const { app, calls } = stubApp(base);
      createPlugin(app).start({});
      for (const sub of Object.values(DATA_LAYOUT)) {
        assert.ok(existsSync(join(base, sub)), `${sub} was not created`);
      }
      assert.equal(calls.errors.length, 0);
      assert.match(calls.status[0], /Not recording/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("honours a configured data directory over the plugin's own", () => {
    const base = mkdtempSync(join(tmpdir(), "sk-parquet-plugin-"));
    try {
      const { app } = stubApp(join(base, "plugin"));
      createPlugin(app).start({ dataDir: join(base, "elsewhere") });
      assert.ok(existsSync(join(base, "elsewhere", DATA_LAYOUT.hotStore)));
      assert.ok(!existsSync(join(base, "plugin", DATA_LAYOUT.hotStore)));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("reports a startup failure to the log as well as the status line", () => {
    // setPluginError writes to a field nobody sees unless they open the Admin
    // UI. The server log is what survives a reboot and ships in a support
    // bundle, and it is the only one that gets the stack.
    const base = mkdtempSync(join(tmpdir(), "sk-parquet-plugin-"));
    try {
      const { app, calls } = stubApp(base);
      // A path under a regular file cannot be made a directory.
      const blocked = join(base, "blocked");
      createPlugin(app).start({ dataDir: blocked });
      rmSync(join(blocked, DATA_LAYOUT.hotStore), { recursive: true });
      const { app: second, calls: secondCalls } = stubApp(base);
      createPlugin(second).start({ dataDir: "/proc/cannot-create-here" });
      assert.equal(secondCalls.status.length, 0, "reported success on failure");
      assert.equal(secondCalls.errors.length, 1);
      assert.match(secondCalls.errors[0], /Startup failed/);
      assert.equal(
        secondCalls.logged.length,
        1,
        "the failure never reached the server log",
      );
      void calls;
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("stops without throwing, whether or not it started", () => {
    const { app } = stubApp("/nonexistent");
    const plugin = createPlugin(app);
    assert.doesNotThrow(() => plugin.stop());
  });
});
