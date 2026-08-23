import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ConfigSchema,
  StoredConfig,
  normalizeConfig,
} from "./config/schema.js";
import type { Config } from "./config/schema.js";
import { DATA_DIR_MODE, DATA_LAYOUT, resolveDataDir } from "./data-dir.js";
import { FlushBuffer } from "./flush-buffer.js";
import { PLUGIN_ID } from "./plugin-id.js";
import { Recorder } from "./recorder.js";
import type { BusValue } from "./recorder.js";
import { WriterClient } from "./writer/client.js";
import {
  EXIT_LOCKED,
  WRITER_EXIT_TIMEOUT_MS,
  writerPaths,
} from "./writer/contract.js";

/**
 * Nothing in this file's import graph may reach `@duckdb/node-api`.
 *
 * The premise of the design is that the Signal K process does path filtering,
 * rate capping and a socket write, and no storage work at all. Importing the
 * engine here would load a 100 MB native addon into the server whether or not
 * a query ever ran, which is the cost the whole plugin exists to avoid. The
 * writer process is spawned, not imported, for the same reason: it holds a
 * SQLite handle and a WAL, and neither belongs in the server's heap.
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
  streambundle: {
    getBus: (path?: string) => {
      onValue: (fn: (value: BusValue) => void) => () => void;
    };
  };
  [key: string]: unknown;
}

const WRITER_ENTRY = fileURLToPath(
  new URL("./writer/main.js", import.meta.url),
);

/** How often the status line is refreshed while recording. */
const STATUS_INTERVAL_MS = 10_000;

/** How long the buffer gets to reach the writer on a graceful stop. */
const DRAIN_TIMEOUT_MS = 2000;

/** A held store is usually a predecessor still exiting, so retry before giving up. */
const MAX_LOCKED_RETRIES = 3;
const LOCKED_RETRY_MS = 500;

export default (app: App) => {
  let unsubscribe: (() => void) | null = null;
  let client: WriterClient | null = null;
  let writer: ChildProcess | null = null;
  let statusTimer: NodeJS.Timeout | null = null;
  let recorder: Recorder | null = null;
  let fatal: string | null = null;
  let stopping = false;
  let dataDir = "";
  let lockedRetries = 0;

  function spawnWriter(
    dataDir: string,
    rollIntervalMinutes: number,
  ): ChildProcess {
    // An argument array, never a shell: a data directory an operator typed
    // into the Admin UI would otherwise be a command line.
    //
    // --disable-warning=ExperimentalWarning because node:sqlite still warns on
    // Node 22, and that warning would reach the Signal K log once per start
    // saying nothing an operator can act on. Scoped to that one warning rather
    // than --no-warnings, which would hide real ones.
    const child = spawn(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        WRITER_ENTRY,
        "--data-dir",
        dataDir,
        "--roll-interval-minutes",
        String(rollIntervalMinutes),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout?.on("data", (chunk: Buffer) =>
      app.debug(`writer: ${chunk.toString().trimEnd()}`),
    );
    child.stderr?.on("data", (chunk: Buffer) =>
      app.error(`writer: ${chunk.toString().trimEnd()}`),
    );
    // A ChildProcess is an EventEmitter, and an EventEmitter with no `error`
    // listener rethrows the event. Node emits it when the process cannot be
    // spawned at all -- EAGAIN or ENOMEM under memory pressure, ENOENT,
    // EACCES -- and when a kill fails. The event arrives a tick after start()
    // returned, so start()'s catch cannot see it, and the uncaught exception
    // exits the Signal K server: the whole process, for a failure that should
    // cost one plugin its recording. The streams need the same treatment,
    // since EPIPE on a dead pipe throws the same way.
    child.stdout?.on("error", (err) => app.error(`writer stdout: ${err.name}`));
    child.stderr?.on("error", (err) => app.error(`writer stderr: ${err.name}`));
    child.on("error", (err) => {
      if (writer !== child) return;
      writer = null;
      app.error(err);
      fatal = `the writer process could not be started: ${err.message}`;
      app.setPluginError(fatal);
    });
    child.on("exit", (code, signal) => {
      if (writer !== child) return;
      writer = null;
      if (code === EXIT_LOCKED) {
        // Usually transient rather than real. Signal K restarts a plugin on
        // every config save, and until this branch waited for the outgoing
        // writer, the incoming one could find it still listening. Latching
        // that as fatal stopped recording for a condition that resolves itself
        // in milliseconds, and the operator's only remedy -- toggling the
        // plugin -- re-ran the race.
        if (lockedRetries < MAX_LOCKED_RETRIES && !stopping) {
          lockedRetries++;
          const delay = LOCKED_RETRY_MS * lockedRetries;
          app.debug(
            `the hot store is still held; retry ${lockedRetries} in ${delay}ms`,
          );
          const timer = setTimeout(() => {
            if (!stopping && writer === null) {
              writer = spawnWriter(dataDir, rollIntervalMinutes);
            }
          }, delay);
          timer.unref();
          return;
        }
        fatal =
          "another writer already holds the hot store; " +
          "recording is stopped until it exits";
        app.setPluginError(fatal);
        return;
      }
      const how = code === null ? `signal ${signal}` : `code ${code}`;
      app.error(`writer exited (${how})`);
      if (stopping) return;
      // Without this the Admin UI keeps showing whatever the status line last
      // said, which is "Recording" -- the exact shape of failure this design
      // is meant to make impossible. Nothing is recorded once the writer is
      // gone, and the buffer fills until it starts dropping.
      fatal = `the writer process exited (${how}); nothing is being recorded`;
      app.setPluginError(fatal);
    });
    return child;
  }

  function status(): void {
    if (fatal !== null) return;
    const stats = recorder?.stats;
    const wire = client?.stats;
    if (stats === undefined || wire === undefined) return;

    const parts = [
      wire.connected ? "Recording" : "Buffering, writer unreachable",
      `${stats.paths} paths across ${stats.contexts} contexts`,
      `${wire.stored} samples stored`,
    ];
    // Every drop is named. A count nobody sees is the same as no count.
    if (wire.dropped > 0) parts.push(`${wire.dropped} dropped, buffer full`);
    if (stats.pathsOverCap > 0) {
      parts.push(`${stats.pathsOverCap} values over the path cap`);
    }
    if (stats.contextsOverCap > 0) {
      parts.push(`${stats.contextsOverCap} values over the context cap`);
    }
    app.setPluginStatus(`${parts.join(". ")}.`);
  }

  /** SIGTERM, then SIGKILL, then give up — never block the server's shutdown. */
  async function stopWriter(): Promise<void> {
    const departing = writer;
    writer = null;
    if (departing === null || departing.exitCode !== null) return;
    const exited = new Promise<void>((resolve) =>
      departing.once("exit", () => resolve()),
    );
    departing.kill("SIGTERM");
    const killer = setTimeout(() => {
      app.error("the writer did not exit on SIGTERM; killing it");
      departing.kill("SIGKILL");
    }, WRITER_EXIT_TIMEOUT_MS);
    killer.unref();
    await exited;
    clearTimeout(killer);
  }

  const plugin = {
    id: PLUGIN_ID,
    name: "Parquet History",

    schema: ConfigSchema,

    start(rawConfig: StoredConfig) {
      try {
        const config: Config = normalizeConfig(rawConfig);
        dataDir = resolveDataDir(config.dataDir, app.getDataDirPath());
        mkdirSync(dataDir, { recursive: true, mode: DATA_DIR_MODE });
        chmodSync(dataDir, DATA_DIR_MODE);
        for (const sub of Object.values(DATA_LAYOUT)) {
          const path = join(dataDir, sub);
          mkdirSync(path, { recursive: true, mode: DATA_DIR_MODE });
          // mkdir's mode is masked by umask and does nothing at all for a
          // directory that already exists, so the chmod is what enforces this.
          chmodSync(path, DATA_DIR_MODE);
        }
        app.debug(`data directory: ${dataDir}`);

        fatal = null;
        stopping = false;
        lockedRetries = 0;
        writer = spawnWriter(dataDir, config.rollIntervalMinutes);

        const buffer = new FlushBuffer({
          flushIntervalMs: config.flushIntervalMs,
          batchSize: config.flushBatchSize,
          maxBytes: Math.round(config.maxBufferMB * 1024 * 1024),
        });
        client = new WriterClient({
          socketPath: writerPaths(dataDir).socket,
          // Fresh per run, so the writer can tell this plugin's sequence
          // numbers from a previous run's and never discards ours as
          // duplicates of theirs.
          session: randomUUID(),
          buffer,
          log: (line) => app.debug(line),
          onUnhealthy: (message) => app.setPluginError(message),
          onHealthy: () => status(),
          onConnected: () => status(),
        });
        client.start();

        recorder = new Recorder({
          config,
          selfContext: app.selfContext,
          emit: (sample) => client?.add(sample),
          log: (line) => app.error(line),
        });
        unsubscribe = app.streambundle
          .getBus()
          .onValue((value) => recorder?.handle(value));

        statusTimer = setInterval(status, STATUS_INTERVAL_MS);
        statusTimer.unref();
        status();
      } catch (err) {
        // Both surfaces, deliberately. setPluginError writes to a field nobody
        // sees unless they open the Admin UI; the server log is what survives
        // a reboot and what ships in a support bundle, and it is the only one
        // that gets the stack.
        app.error(err);
        app.setPluginError(
          `Startup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },

    async stop() {
      stopping = true;
      unsubscribe?.();
      unsubscribe = null;
      if (statusTimer !== null) {
        clearInterval(statusTimer);
        statusTimer = null;
      }
      recorder = null;

      // Send what is buffered before tearing anything down. Discarding it lost
      // several hundred samples on every config save, while the configuration
      // describes the flush interval as the window a power cut loses.
      const departing = client;
      client = null;
      if (departing !== null) {
        try {
          await departing.drain(DRAIN_TIMEOUT_MS);
        } catch (err) {
          app.error(err);
        }
        await departing.stop();
      }

      // SIGTERM rather than SIGKILL: the writer removes its pid file and closes
      // the store on the way out. Awaited, because Signal K calls start()
      // straight after a config save and the next writer's probe would
      // otherwise find this one still listening.
      await stopWriter();
    },
  };

  return plugin;
};
