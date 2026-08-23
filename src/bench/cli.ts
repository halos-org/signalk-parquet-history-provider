/**
 * The measurement harness's command line.
 *
 *   node dist/bench/cli.js run --label sqhp --subject signalk:pid=1234 -o sqhp.json
 *   node dist/bench/cli.js compare control.json sqhp.json parquet.json
 *   node dist/bench/cli.js selftest
 *   node dist/bench/cli.js roll --data-dir /path/to/a/copy --max-rowid 1267241
 *
 * `run` measures one condition. `compare` puts several side by side, which is
 * the only form in which these numbers mean anything. `selftest` runs the
 * whole path against a load generator with a known duty cycle, so a machine
 * can show that the harness reports what it should before anyone trusts it
 * about a real workload. `roll` measures one roll, which `run` cannot: a roll
 * has no steady state and is gone before a window closes.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { LoadStats, STATS_FILE, loadStatsSummary } from "./load-stats.js";
import { renderComparison } from "./report.js";
import {
  DEFAULTS,
  RESULT_FORMAT_VERSION,
  RunResult,
  runBenchmark,
} from "./run.js";

/** The selftest generator's write cadence, named once so the argument and the
 * note that describes it cannot disagree. */
const SELFTEST_WRITE_INTERVAL_MS = 250;
import { createProcSampler, parseSubjectSpec } from "./subjects.js";
import { measureOneShot } from "./one-shot.js";
import { writerPaths } from "../writer/contract.js";
import { probeLiveWriter } from "../writer/server.js";

const HERE = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const command = process.argv[2];
  const rest = process.argv.slice(3);
  if (command === "run") return doRun(rest);
  if (command === "compare") return doCompare(rest);
  if (command === "selftest") return doSelftest(rest);
  if (command === "roll") return doRoll(rest);
  console.error(
    "usage: cli.js run|compare|selftest|roll ... (see the file header)",
  );
  process.exitCode = 2;
}

async function doRun(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      label: { type: "string" },
      subject: { type: "string", multiple: true, default: [] },
      device: { type: "string", multiple: true },
      note: { type: "string", multiple: true, default: [] },
      windows: { type: "string" },
      "window-seconds": { type: "string" },
      "settle-seconds": { type: "string" },
      "gauge-interval-seconds": { type: "string" },
      out: { type: "string", short: "o" },
    },
  });
  if (!values.label)
    throw new Error("--label names the condition; it is required");

  requireLinux();
  const result = await runBenchmark({
    label: values.label,
    subjects: values.subject.map(parseSubjectSpec),
    sampler: createProcSampler(),
    devices: values.device,
    notes: values.note,
    windows: numberOr(values.windows, DEFAULTS.windows),
    windowSeconds: numberOr(values["window-seconds"], DEFAULTS.windowSeconds),
    settleSeconds: numberOr(values["settle-seconds"], DEFAULTS.settleSeconds),
    gaugeIntervalSeconds: numberOr(
      values["gauge-interval-seconds"],
      DEFAULTS.gaugeIntervalSeconds,
    ),
    log: (message) => console.error(message),
  });

  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (values.out) {
    writeFileSync(values.out, json);
    console.error(`wrote ${values.out}`);
  } else {
    process.stdout.write(json);
  }
}

async function doCompare(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { out: { type: "string", short: "o" } },
  });
  if (positionals.length === 0) {
    throw new Error("compare takes one or more result files");
  }
  const runs = positionals.map((path) => readRunResult(path));
  const table = renderComparison(runs);
  if (values.out) {
    writeFileSync(values.out, table);
    console.error(`wrote ${values.out}`);
  } else {
    process.stdout.write(table);
  }
}

/**
 * One roll, measured.
 *
 * **Point this at a copy of a data directory, never at a live one.** A roll
 * writes into the tree and does not truncate the hot store, so a roll run
 * beside a live writer puts those rows in the tree twice — once here, once
 * when the writer rolls them itself under a different name. The live-writer
 * probe is what enforces that: if anything answers on the socket, this
 * refuses.
 */
async function doRoll(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      "data-dir": { type: "string" },
      "max-rowid": { type: "string" },
      "memory-limit": { type: "string" },
      out: { type: "string", short: "o" },
    },
  });
  const dataDir = values["data-dir"];
  if (!dataDir) throw new Error("--data-dir is required");
  requireLinux();

  if (await probeLiveWriter(writerPaths(dataDir).socket)) {
    throw new Error(
      `a writer is live on ${dataDir}. Measuring a roll there would write ` +
        `its rows into the tree twice — copy the data directory first.`,
    );
  }

  const result = await measureOneShot({
    command: process.execPath,
    args: [
      join(HERE, "..", "roll", "main.js"),
      "--data-dir",
      dataDir,
      "--max-rowid",
      values["max-rowid"] ?? "0",
      "--roll-id",
      String(Date.now()),
      ...(values["memory-limit"]
        ? ["--memory-limit", values["memory-limit"]]
        : []),
    ],
    selfReportedPeak: (stdout) => {
      try {
        const summary = JSON.parse(stdout.trim().split("\n").pop() ?? "") as {
          peakRssBytes?: number | null;
        };
        return summary.peakRssBytes ?? null;
      } catch {
        return null;
      }
    },
  });

  if (result.exitCode !== 0) {
    throw new Error(
      `the roll exited ${result.exitCode}: ${result.stderr.trim()}`,
    );
  }
  const json = `${JSON.stringify(
    {
      peakMb: +(result.peakBytes / 1048576).toFixed(1),
      peakSource: result.peakSource,
      sampledPeakMb: +(result.sampledPeakBytes / 1048576).toFixed(1),
      samples: result.samples,
      wallMs: Math.round(result.wallMs),
      roll: JSON.parse(result.stdout.trim().split("\n").pop() ?? "null"),
    },
    null,
    2,
  )}\n`;
  if (values.out) {
    writeFileSync(values.out, json);
    console.error(`wrote ${values.out}`);
  } else {
    process.stdout.write(json);
  }
}

/**
 * Three conditions against a load generator whose CPU and write rates are set
 * in advance, so the table can be read against what it should say.
 */
async function doSelftest(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      windows: { type: "string", default: "3" },
      "window-seconds": { type: "string", default: "6" },
      "settle-seconds": { type: "string", default: "2" },
      out: { type: "string", short: "o" },
    },
  });
  requireLinux();

  const work = mkdtempSync(join(tmpdir(), "sk-parquet-bench-"));
  const conditions = [
    { label: "idle", duty: 0, writeKb: 0 },
    { label: "light", duty: 0.1, writeKb: 16 },
    { label: "heavy", duty: 0.4, writeKb: 64 },
  ];

  try {
    const runs: RunResult[] = [];
    const disagreements: string[] = [];
    for (const condition of conditions) {
      const dir = join(work, condition.label);
      const child = spawn(
        process.execPath,
        [
          join(HERE, "load.js"),
          "--duty",
          String(condition.duty),
          "--write-kb",
          String(condition.writeKb),
          "--interval-ms",
          String(SELFTEST_WRITE_INTERVAL_MS),
          "--dir",
          dir,
        ],
        { stdio: "ignore" },
      );
      // Without an error listener a failed spawn (EMFILE, ENOMEM, a missing
      // load.js) becomes an uncaught exception outside this promise chain, so
      // the outer finally never runs and the temp directory is left behind.
      const spawnFailure: { error?: Error } = {};
      child.once("error", (err: Error) => {
        spawnFailure.error = err;
      });
      const exited = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.once("error", () => resolve());
      });
      if (child.pid === undefined) {
        throw new Error(
          `Could not start the load generator: ${spawnFailure.error?.message ?? "spawn returned no pid"}`,
        );
      }
      let result: RunResult;
      try {
        result = await runBenchmark({
          label: condition.label,
          subjects: [{ name: "load", kind: "pid", pid: child.pid }],
          sampler: createProcSampler(),
          windows: numberOr(values.windows, 3),
          windowSeconds: numberOr(values["window-seconds"], 6),
          settleSeconds: numberOr(values["settle-seconds"], 2),
          gaugeIntervalSeconds: 1,
          notes: [
            `load generator at ${(condition.duty * 100).toFixed(0)}% duty`,
            condition.writeKb > 0
              ? `${condition.writeKb} KB fsynced every ~${SELFTEST_WRITE_INTERVAL_MS} ms`
              : "no writes",
          ],
          log: (message) => console.error(`[${condition.label}] ${message}`),
        });
      } finally {
        // Both in the finally: if runBenchmark throws, control leaves here and
        // a generator still parked in fsync would outlive the outer cleanup
        // that deletes its working directory. settleChild escalates to SIGKILL
        // and then gives up, so it cannot hang the run either.
        child.kill("SIGTERM");
        await settleChild(child, exited);
      }

      // The generator's own account of what it did. It is not a second
      // estimate — it counted the bytes it fsynced and asked the kernel for
      // its own CPU time — so the harness agreeing with it to within a few
      // percent is the thing that makes the harness trustworthy. Timer
      // scheduling means the requested duty and interval are targets, not
      // facts, which is why the note carries this rather than the request.
      const own = ownAccount(dir);
      result.notes.push(describeOwnAccount(own));
      if (own) disagreements.push(...compare(condition.label, result, own));
      runs.push(result);
    }

    const table =
      `${renderComparison(runs)}\n` +
      `Read each row against the condition's own accounting below: the ` +
      `generator counted the bytes it fsynced and asked the kernel for its ` +
      `own CPU time, so those are ground truth and the table should match ` +
      `them within a few percent. The remaining gap is the settle period, ` +
      `which the generator's figure covers and the windows do not.\n\n` +
      `Drift markers are expected here and do not carry over to a real run: ` +
      `these windows are ${values["window-seconds"]}s against the method's ` +
      `${DEFAULTS.windowSeconds}s, short enough that a handful of 64 KB ` +
      `writes lands unevenly across the two halves.\n`;
    if (values.out) {
      writeFileSync(values.out, table);
      console.error(`wrote ${values.out}`);
    } else {
      process.stdout.write(table);
    }

    // Printing a table and exiting 0 regardless is not a self-test. The
    // generator counted the bytes it fsynced and asked the kernel for its own
    // CPU time, so a disagreement means the harness is wrong about a workload
    // whose answer is known — which is the only reason to run this.
    if (disagreements.length > 0) {
      console.error(
        `\nThe harness disagrees with the load generator's own accounting:`,
      );
      for (const line of disagreements) console.error(`- ${line}`);
      process.exitCode = 1;
    } else {
      console.error(
        "\nThe harness agrees with the generator's own accounting.",
      );
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * How far the harness may sit from the generator's own accounting before the
 * selftest fails.
 *
 * Wide, because the generator's figure spans its whole lifetime — settle
 * included — while the harness's spans only the windows, and because a shared
 * CI runner is noisy. Still far narrower than the errors it exists to catch: a
 * rate divided by the nominal rather than the measured window was out by 20%
 * in the case that prompted this.
 */
const SELFTEST_BAND = 0.15;

function compare(
  label: string,
  result: RunResult,
  own: { cpuPercentOfCore: number; writeKbPerSec: number },
): string[] {
  const load = result.subjects.find((s) => s.name === "load");
  if (!load) return [`${label}: the run has no load subject`];
  const out: string[] = [];
  const check = (metric: string, truth: number, floor: number) => {
    const measured = load.metrics[metric]?.dispersion.mean;
    if (measured === undefined) {
      out.push(`${label}: the run reports no ${metric}`);
      return;
    }
    // Below the floor both numbers are noise and their ratio says nothing.
    if (truth < floor && measured < floor) return;
    const drift = Math.abs(measured - truth) / Math.max(truth, floor);
    if (drift > SELFTEST_BAND) {
      out.push(
        `${label} ${metric}: harness ${measured.toFixed(2)} against the ` +
          `generator's ${truth.toFixed(2)} (${(drift * 100).toFixed(0)}% apart)`,
      );
    }
  };
  check("cpuPercentOfCore", own.cpuPercentOfCore, 1);
  check("writeKbPerSec", own.writeKbPerSec, 1);
  return out;
}

/** How long to wait for a SIGTERMed generator before escalating, and again
 * before giving up on it. */
const CHILD_EXIT_GRACE_MS = 5000;

async function settleChild(
  child: { kill: (signal: NodeJS.Signals) => boolean },
  exited: Promise<void>,
): Promise<void> {
  if (await finishesWithin(exited, CHILD_EXIT_GRACE_MS)) return;
  child.kill("SIGKILL");
  if (await finishesWithin(exited, CHILD_EXIT_GRACE_MS)) return;
  console.error(
    "the load generator did not exit; continuing without its own accounting",
  );
}

function finishesWithin(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    timer.unref();
    void promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Read a result file, refusing one this build does not understand rather than
 * rendering it. An older shape would otherwise surface as a TypeError from
 * inside the renderer, naming neither the file nor the field.
 */
function readRunResult(path: string): RunResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${path} is not readable JSON`, { cause: err });
  }
  const run = parsed as Partial<RunResult>;
  if (run.formatVersion !== RESULT_FORMAT_VERSION) {
    throw new Error(
      `${path} is result format ${run.formatVersion ?? "unversioned"}; ` +
        `this build reads ${RESULT_FORMAT_VERSION}`,
    );
  }
  if (!Array.isArray(run.subjects) || !Array.isArray(run.notes)) {
    throw new Error(`${path} is missing its subjects or notes`);
  }
  return run as RunResult;
}

function ownAccount(
  dir: string,
): (LoadStats & { cpuPercentOfCore: number; writeKbPerSec: number }) | null {
  try {
    const stats = JSON.parse(
      readFileSync(join(dir, STATS_FILE), "utf8"),
    ) as LoadStats;
    return { ...stats, ...loadStatsSummary(stats) };
  } catch {
    return null;
  }
}

function describeOwnAccount(own: ReturnType<typeof ownAccount>): string {
  if (!own) {
    // Said plainly, because a condition with no ground truth is not one the
    // reader should compare against a condition that has it.
    return "the load generator wrote no stats file, so this condition has no ground truth";
  }
  return (
    `by its own accounting over ${(own.elapsedMs / 1000).toFixed(0)}s ` +
    `(settle included): ${own.cpuPercentOfCore.toFixed(2)}% of one core, ` +
    `${own.writeKbPerSec.toFixed(2)} KB/s fsynced in ${own.writes} writes`
  );
}

function requireLinux(): void {
  if (process.platform !== "linux") {
    throw new Error(
      `The harness reads /proc and cgroup counters, which ${process.platform} ` +
        `does not have. Run it on the device.`,
    );
  }
}

function numberOr(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`"${value}" is not a number`);
  return parsed;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
