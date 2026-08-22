import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Config, ConfigSchema, normalizeConfig } from "./config/schema.js";
import { DATA_LAYOUT, resolveDataDir } from "./data-dir.js";
import { PLUGIN_ID } from "./plugin-id.js";

/**
 * Nothing in this file's import graph may reach `@duckdb/node-api`.
 *
 * The premise of the design is that the Signal K process does path filtering,
 * rate capping and a socket write, and no storage work at all. Importing the
 * engine here would load a 100 MB native addon into the server whether or not
 * a query ever ran, which is the cost the whole plugin exists to avoid.
 * src/test/plugin-import-graph.test.ts enforces it against the compiled
 * output.
 */
interface App {
  debug: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  setPluginStatus: (msg: string) => void;
  setPluginError: (msg: string) => void;
  getDataDirPath: () => string;
  selfContext: string;
  [key: string]: unknown;
}

export default (app: App) => {
  let dataDir: string | null = null;

  const plugin = {
    id: PLUGIN_ID,
    name: "Parquet History",

    schema: ConfigSchema,

    start(rawConfig: Config) {
      try {
        const config = normalizeConfig(rawConfig);
        dataDir = resolveDataDir(config.dataDir, app.getDataDirPath());
        for (const sub of Object.values(DATA_LAYOUT)) {
          mkdirSync(join(dataDir, sub), { recursive: true });
        }
        app.debug(`data directory: ${dataDir}`);

        // Deliberately blunt. This build carries the configuration surface and
        // the storage layout, and records nothing: the writer process is
        // halos-org/halos#164 and the query surfaces are #171 and #172. A
        // cheerful status line here would read as working history.
        app.setPluginStatus(
          `Not recording: this build is the scaffold only. ` +
            `Data directory ${dataDir}.`,
        );
      } catch (err) {
        app.setPluginError(
          `Startup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    stop() {
      dataDir = null;
    },
  };

  return plugin;
};
