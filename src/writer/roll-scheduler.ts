import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { delayToNextRoll, nextRollAt } from "../roll/schedule.js";
import { writerPaths } from "./contract.js";
import type { HotStore } from "./hot-store.js";

/**
 * Rolls, scheduled and truncated by the process that owns the store.
 *
 * The writer runs this, not the plugin, for one reason: **only the writer may
 * write to the hot store.** The roll opens it read-only, so the delete that
 * follows a successful roll has to happen here — and putting the schedule
 * anywhere else would mean a protocol message whose only job is to ask the
 * owner to do what the owner already knows how to do.
 *
 * The roll itself is a separate process. DuckDB's allocator does not return
 * its memory, so the exit is what keeps a two-second transient from becoming
 * a standing cost inside a process that runs for weeks. Nothing in this file's
 * import graph reaches the engine; `src/test/plugin-import-graph.test.ts`
 * checks that against the compiled writer.
 */

const ROLL_ENTRY = fileURLToPath(new URL("../roll/main.js", import.meta.url));

/**
 * How long a roll gets before it is killed.
 *
 * Generous on purpose. An hourly roll is a second or two, but a device that
 * was off for a week wakes up with a week in the store, and a roll killed for
 * being slow never truncates — so a timeout that is too short does not fail
 * safe, it fails permanently and the store grows without bound.
 */
const ROLL_TIMEOUT_MS = 15 * 60_000;

/** How long a killed roll gets to die before SIGKILL. */
const ROLL_KILL_GRACE_MS = 5000;

export interface RollSchedulerOptions {
  store: HotStore;
  dataDir: string;
  intervalMinutes: number;
  log: (line: string) => void;
  /** Injected in tests. Production reads the clock. */
  now?: () => number;
  /** Injected in tests, so a roll need not be a real DuckDB process. */
  spawnRoll?: (args: string[]) => ChildProcess;
  /** Injected in tests. Production waits ROLL_TIMEOUT_MS. */
  timeoutMs?: number;
}

export class RollScheduler {
  private readonly options: RollSchedulerOptions;
  private readonly now: () => number;
  private timer: NodeJS.Timeout | null = null;
  private running: ChildProcess | null = null;
  private stopped = false;
  /**
   * The id of a roll that has been started and not yet truncated.
   *
   * Kept across a failure so the retry writes the same filenames and replaces
   * the failed attempt's files. Without it, a roll that wrote its Parquet and
   * then died would leave those rows in the tree AND in the store, and the
   * next roll would write them again under a new name — the same rows twice,
   * silently and for good.
   *
   * It outlives the writer as well, in a file, because the writer is not the
   * only thing that can die: a SIGKILL or an OOM kill leaves the roll process
   * running, and an orphan that finishes has written a file this scheduler
   * would otherwise know nothing about. The successor reads the id and its
   * next roll overwrites that file.
   *
   * The two cannot collide over one filename. The successor rolls at the next
   * slot, minutes or an hour away, and an orphan roll is seconds long.
   */
  private pendingRollId: number | null;

  constructor(options: RollSchedulerOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.pendingRollId = readPendingRoll(options.dataDir);
    if (this.pendingRollId !== null) {
      options.log(
        `roll ${this.pendingRollId} was left unfinished; the next roll reuses its name`,
      );
    }
  }

  /** Arm the timer for the next slot. Nothing rolls at start. */
  start(): void {
    this.stopped = false;
    this.arm();
  }

  private arm(): void {
    if (this.stopped) return;
    const now = this.now();
    // The slot is decided here and carried into the roll, never re-derived
    // from the clock when the timer fires. setTimeout may fire a millisecond
    // early, and a clock read on the wrong side of the boundary names the
    // PREVIOUS slot — whose file already exists and would be overwritten with
    // a fraction of its rows. That destroyed 2.5M rows on a device before this
    // was a parameter.
    const slot = nextRollAt(now, this.options.intervalMinutes);
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.rollOnce(slot).finally(() => this.arm());
      },
      delayToNextRoll(now, this.options.intervalMinutes),
    );
    // The writer must not be held open by a pending roll: the plugin stops it
    // with SIGTERM and waits, and an armed timer would not delay that anyway.
    this.timer.unref();
  }

  /**
   * One roll: choose the set, write it, and delete exactly that set.
   *
   * `slot` names the roll, and the caller supplies it — the schedule knows
   * which instant it armed for, and nothing here should have to guess it back
   * out of a clock reading.
   */
  async rollOnce(slot: number): Promise<void> {
    if (this.stopped || this.running !== null) return;
    const bound = this.options.store.rollBound();
    if (bound === null) {
      // Nothing recorded since the last roll. No file, no empty directory.
      this.pendingRollId = null;
      clearPendingRoll(this.options.dataDir);
      return;
    }

    // A retry keeps the failed attempt's name, and only a retry may replace a
    // file that is already there.
    const retry = this.pendingRollId !== null;
    const rollId = this.pendingRollId ?? slot;
    this.pendingRollId = rollId;
    // Before the spawn, so a writer that dies during the roll still leaves the
    // name behind for its successor.
    writePendingRoll(this.options.dataDir, rollId);

    const outcome = await this.runRoll(rollId, bound.maxRowid, retry);
    if (!outcome.ok) {
      this.options.log(
        `roll ${rollId} did not finish (${outcome.why}); ${bound.rows} rows stay in the hot store`,
      );
      return;
    }

    // Only now, and only through the bound the roll was given: the store has
    // kept ingesting throughout, and those rows were never written.
    const removed = this.options.store.deleteThrough(bound.maxRowid);
    this.pendingRollId = null;
    clearPendingRoll(this.options.dataDir);
    this.options.log(
      `roll ${rollId} wrote ${outcome.summary}; ${removed} rows truncated`,
    );
  }

  private runRoll(
    rollId: number,
    maxRowid: number,
    retry: boolean,
  ): Promise<{ ok: true; summary: string } | { ok: false; why: string }> {
    const args = [
      ROLL_ENTRY,
      "--data-dir",
      this.options.dataDir,
      "--max-rowid",
      String(maxRowid),
      "--roll-id",
      String(rollId),
      // Only a retry is allowed to replace a file. Otherwise a roll that
      // arrives at a name already taken fails loudly instead of overwriting
      // history with a fraction of it.
      ...(retry ? ["--replace"] : []),
    ];
    const child = (this.options.spawnRoll ?? defaultSpawn)(args);
    this.running = child;

    return new Promise((resolve) => {
      let out = "";
      let err = "";
      let settled = false;
      const settle = (
        result: { ok: true; summary: string } | { ok: false; why: string },
      ) => {
        if (settled) return;
        settled = true;
        clearTimeout(killer);
        this.running = null;
        resolve(result);
      };

      child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString()));
      child.stderr?.on("data", (chunk: Buffer) => (err += chunk.toString()));
      // A ChildProcess with no error listener rethrows the event, and the
      // writer would exit for a failure that should cost one roll.
      child.stdout?.on("error", () => {});
      child.stderr?.on("error", () => {});
      child.on("error", (error) => settle({ ok: false, why: error.message }));

      const killer = setTimeout(() => {
        this.options.log(`roll ${rollId} exceeded its timeout; killing it`);
        child.kill("SIGTERM");
        const hard = setTimeout(
          () => child.kill("SIGKILL"),
          ROLL_KILL_GRACE_MS,
        );
        hard.unref();
      }, this.options.timeoutMs ?? ROLL_TIMEOUT_MS);
      killer.unref();

      child.on("exit", (code, signal) => {
        if (code === 0) {
          settle({ ok: true, summary: summarize(out) });
          return;
        }
        const how = code === null ? `signal ${signal}` : `code ${code}`;
        settle({
          ok: false,
          why: `${how}: ${err.trim().split("\n").pop() ?? ""}`,
        });
      });
    });
  }

  /** Disarm, and stop a roll in flight without truncating anything. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const running = this.running;
    if (running === null || running.exitCode !== null) return;
    const exited = new Promise<void>((resolve) =>
      running.once("exit", () => resolve()),
    );
    running.kill("SIGTERM");
    const hard = setTimeout(() => running.kill("SIGKILL"), ROLL_KILL_GRACE_MS);
    hard.unref();
    await exited;
    clearTimeout(hard);
  }
}

function readPendingRoll(dataDir: string): number | null {
  try {
    const raw = JSON.parse(
      readFileSync(writerPaths(dataDir).pendingRoll, "utf8"),
    ) as { rollId?: unknown };
    return Number.isSafeInteger(raw.rollId) && (raw.rollId as number) >= 0
      ? (raw.rollId as number)
      : null;
  } catch {
    // Absent is the normal case. Unreadable is treated the same way on
    // purpose: a corrupt file must not be able to stop a device rolling.
    return null;
  }
}

function writePendingRoll(dataDir: string, rollId: number): void {
  try {
    writeFileSync(
      writerPaths(dataDir).pendingRoll,
      `${JSON.stringify({ rollId })}\n`,
      { mode: 0o600 },
    );
  } catch {
    // Recording the name is a safeguard against one narrow failure. Refusing
    // to roll because the safeguard could not be written would be worse than
    // the failure it guards.
  }
}

function clearPendingRoll(dataDir: string): void {
  rmSync(writerPaths(dataDir).pendingRoll, { force: true });
}

function defaultSpawn(args: string[]): ChildProcess {
  // An argument array, never a shell: the data directory is a string an
  // operator typed into the Admin UI.
  return spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
}

/** The roll's own JSON summary, reduced to a log line. */
function summarize(stdout: string): string {
  const line = stdout.trim().split("\n").pop() ?? "";
  try {
    const result = JSON.parse(line) as {
      rows: number;
      files: { date: string }[];
      sidecarRows: number;
      peakRssBytes: number | null;
    };
    const dates = result.files.map((file) => file.date).join(", ") || "nothing";
    const peak =
      result.peakRssBytes === null
        ? ""
        : `, peaking at ${Math.round(result.peakRssBytes / 1048576)} MB`;
    return `${result.rows} rows to ${dates} and ${result.sidecarRows} sidecar rows${peak}`;
  } catch {
    return "an unreadable summary";
  }
}
