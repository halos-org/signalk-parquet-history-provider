/**
 * The measurement harness's command line.
 *
 *   node dist/bench/cli.js run --label sqhp --subject signalk:pid=1234 -o sqhp.json
 *   node dist/bench/cli.js compare control.json sqhp.json parquet.json
 *   node dist/bench/cli.js selftest
 *
 * `run` measures one condition. `compare` puts several side by side, which is
 * the only form in which these numbers mean anything. `selftest` runs the
 * whole path against a load generator with a known duty cycle, so a machine
 * can show that the harness reports what it should before anyone trusts it
 * about a real workload.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { LoadStats, STATS_FILE, loadStatsSummary } from "./load-stats.js";
import { renderComparison } from "./report.js";
import { DEFAULTS, RunResult, runBenchmark } from "./run.js";
import { createProcSampler, parseSubjectSpec } from "./subjects.js";

const HERE = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  const command = process.argv[2];
  const rest = process.argv.slice(3);
  if (command === "run") return doRun(rest);
  if (command === "compare") return doCompare(rest);
  if (command === "selftest") return doSelftest(rest);
  console.error("usage: cli.js run|compare|selftest ... (see the file header)");
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
  const runs = positionals.map(
    (path) => JSON.parse(readFileSync(path, "utf8")) as RunResult,
  );
  const table = renderComparison(runs);
  if (values.out) {
    writeFileSync(values.out, table);
    console.error(`wrote ${values.out}`);
  } else {
    process.stdout.write(table);
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
          "250",
          "--dir",
          dir,
        ],
        { stdio: "ignore" },
      );
      const exited = new Promise<void>((resolve) =>
        child.once("exit", () => resolve()),
      );
      let result: RunResult;
      try {
        result = await runBenchmark({
          label: condition.label,
          subjects: [{ name: "load", kind: "pid", pid: child.pid as number }],
          sampler: createProcSampler(),
          windows: Number(values.windows),
          windowSeconds: Number(values["window-seconds"]),
          settleSeconds: Number(values["settle-seconds"]),
          gaugeIntervalSeconds: 1,
          notes: [
            `load generator at ${(condition.duty * 100).toFixed(0)}% duty`,
            condition.writeKb > 0
              ? `${condition.writeKb} KB fsynced every ~250 ms`
              : "no writes",
          ],
          log: (message) => console.error(`[${condition.label}] ${message}`),
        });
      } finally {
        child.kill("SIGTERM");
      }

      // The generator's own account of what it did. It is not a second
      // estimate — it counted the bytes it fsynced and asked the kernel for
      // its own CPU time — so the harness agreeing with it to within a few
      // percent is the thing that makes the harness trustworthy. Timer
      // scheduling means the requested duty and interval are targets, not
      // facts, which is why the note carries this rather than the request.
      await exited;
      result.notes.push(byItsOwnAccount(dir));
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
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function byItsOwnAccount(dir: string): string {
  try {
    const stats = JSON.parse(
      readFileSync(join(dir, STATS_FILE), "utf8"),
    ) as LoadStats;
    const own = loadStatsSummary(stats);
    return (
      `by its own accounting over ${(stats.elapsedMs / 1000).toFixed(0)}s ` +
      `(settle included): ${own.cpuPercentOfCore.toFixed(2)}% of one core, ` +
      `${own.writeKbPerSec.toFixed(2)} KB/s fsynced in ${stats.writes} writes`
    );
  } catch {
    return "the load generator wrote no stats file";
  }
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
