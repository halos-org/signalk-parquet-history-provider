import { formatDispersion } from "./statistics.js";
import { MetricResult, RunResult } from "./run.js";

/**
 * One markdown table across several conditions — control, the incumbent, the
 * candidate — because a number from this harness is only ever interesting
 * next to the number it is meant to beat.
 *
 * Cells carry the spread, not just the mean. A window whose halves disagreed
 * is marked rather than dropped: a reader deciding whether to trust the
 * figure needs to see that it measured a transition.
 */

const METRIC_ORDER = [
  "cpuPercentOfCore",
  "memoryMb",
  "writeKbPerSec",
  "readKbPerSec",
  "writeIops",
  "readIops",
];

const METRIC_LABELS: Record<string, string> = {
  cpuPercentOfCore: "CPU",
  memoryMb: "memory",
  writeKbPerSec: "writes",
  readKbPerSec: "reads",
  writeIops: "write IOPS",
  readIops: "read IOPS",
};

export function renderComparison(runs: RunResult[]): string {
  if (runs.length === 0) throw new Error("Nothing to compare");

  const rows: { subject: string; metric: string; unit: string }[] = [];
  // Keyed with a colon pair, which no subject name can contain: parseSubjectSpec
  // splits its argument on the first colon, so a name carrying one never
  // reaches here.
  const unitByRow = new Map<string, string>();
  for (const run of runs) {
    for (const subject of run.subjects) {
      for (const name of orderMetrics(Object.keys(subject.metrics))) {
        const key = `${subject.name}::${name}`;
        const unit = subject.metrics[name].unit;
        const already = unitByRow.get(key);
        if (already !== undefined) {
          // The row header carries whichever unit was seen first, and every
          // later run's cell is printed beneath it. Two runs reporting one
          // measurement in KB/s and in MB/s would render a table that looks
          // right and is out by a factor of 1000, so this refuses instead.
          if (already !== unit) {
            throw new Error(
              `${subject.name} ${name} is reported in both "${already}" and ` +
                `"${unit}"; these runs cannot share a row`,
            );
          }
          continue;
        }
        unitByRow.set(key, unit);
        rows.push({ subject: subject.name, metric: name, unit });
      }
    }
  }

  const header = ["measurement", ...runs.map((r) => r.label)];
  const body = rows.map((row) => [
    `${row.subject} ${METRIC_LABELS[row.metric] ?? row.metric} (${row.unit})`,
    ...runs.map((run) => cell(find(run, row.subject, row.metric))),
  ]);

  const lines = [
    ...methodBlock(runs),
    "",
    ...markdownTable(header, body),
    "",
    "Cells are the mean across windows with the min–max range. " +
      "† marks a measurement in which at least one window's two halves " +
      "disagreed by more than the tolerance — that window covered a " +
      "transition rather than a steady state, and `halfWindowDrift` in the " +
      "result file says which. An unmarked cell is either steady or, for a " +
      "gauge and for the system rows, never split to check.",
  ];

  const peaks = rows.flatMap((row) =>
    runs
      .map((run) => {
        const found = find(run, row.subject, row.metric);
        const label = METRIC_LABELS[row.metric] ?? row.metric;
        return found?.peak === undefined
          ? null
          : `${escapeInline(row.subject)} ${label} in ` +
              `${escapeInline(run.label)}: mean ` +
              `${found.dispersion.mean.toFixed(1)} ${escapeInline(row.unit)}, peak ` +
              `${found.peak.toFixed(1)} ${escapeInline(row.unit)}`;
      })
      .filter((v): v is string => v !== null),
  );
  if (peaks.length > 0) {
    lines.push(
      "",
      "Gauge peaks, reported apart from the means because a transient peak " +
        "and a continuous cost are different quantities and adding them " +
        "produces a number that describes nothing:",
      ...peaks.map((p) => `- ${p}`),
    );
  }

  const notes = runs.filter((run) => run.notes.length > 0);
  if (notes.length > 0) {
    lines.push("", "Conditions:");
    for (const run of notes) {
      lines.push(
        `- **${escapeInline(run.label)}** — ` +
          `${run.notes.map(escapeInline).join("; ")}`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function methodBlock(runs: RunResult[]): string[] {
  const first = runs[0];
  // Tolerance belongs here with the three window parameters: it decides what
  // the † marker means, so a run at 0.9 and a run at 0.1 carry markers that
  // are not the same claim.
  const mismatched = runs.filter(
    (r) =>
      r.windowSeconds !== first.windowSeconds ||
      r.windows !== first.windows ||
      r.settleSeconds !== first.settleSeconds ||
      r.tolerance !== first.tolerance,
  );
  // The device set belongs in the header: a mistyped --device sums to zero,
  // which renders as a legitimate 0.00 in every system row, and nothing else
  // in the table says which disks were counted.
  const devices = [...new Set(runs.flatMap((r) => r.devices))].sort();
  const lines = [
    `${first.windows} × ${first.windowSeconds}s windows after a ` +
      `${first.settleSeconds}s settle, on ` +
      `${[...new Set(runs.map((r) => escapeInline(r.host)))].join(", ")}. ` +
      `System rows count ${devices.map(escapeInline).join(", ") || "no disks"}.`,
  ];
  if (mismatched.length > 0) {
    lines.push(
      "",
      "**These runs do not share a method and are not comparable:** " +
        mismatched
          .map(
            (r) =>
              `${escapeInline(r.label)} used ${r.windows} × ` +
              `${r.windowSeconds}s after ${r.settleSeconds}s`,
          )
          .join(", ") +
        ".",
    );
  }
  return lines;
}

function find(
  run: RunResult,
  subject: string,
  metric: string,
): MetricResult | undefined {
  return run.subjects.find((s) => s.name === subject)?.metrics[metric];
}

function cell(result: MetricResult | undefined): string {
  if (!result) return "—";
  // `steady === null` means the metric has no half-window split, which is not
  // the same as passing the check. Rendering it unmarked, identically to a
  // metric that was checked and agreed, is the claim the null exists to avoid.
  const marker = result.steady === false ? " †" : "";
  return `${formatDispersion(result.dispersion)}${marker}`;
}

function orderMetrics(names: string[]): string[] {
  return [...names].sort((a, b) => {
    const ai = METRIC_ORDER.indexOf(a);
    const bi = METRIC_ORDER.indexOf(b);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return a.localeCompare(b);
  });
}

/**
 * Labels, subject names, notes, hosts and device names are all free text —
 * `--label` and `--note` come straight off the command line, and a result file
 * can come from anywhere. Rendered raw, a newline in any of them starts a new
 * Markdown block and a `*` or a backtick closes the construct it sits inside,
 * so the report ends up describing something other than the run.
 */
function escapeInline(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replace(/[*_`[\]<>]/g, (c) => `\\${c}`)
    .replace(/\s*\r?\n\s*/g, " ")
    .trim();
}

/** A table cell needs the same treatment plus the pipe, which would otherwise
 * add a column and shift every later cell under the wrong condition. */
function escapeCell(value: string): string {
  return escapeInline(value).replaceAll("|", "\\|");
}

function markdownTable(rawHeader: string[], rawBody: string[][]): string[] {
  const header = rawHeader.map(escapeCell);
  const body = rawBody.map((row) => row.map(escapeCell));
  const widths = header.map((cell, i) =>
    Math.max(cell.length, ...body.map((row) => row[i].length)),
  );
  const line = (cells: string[]) =>
    `| ${cells.map((c, i) => c.padEnd(widths[i])).join(" | ")} |`;
  return [
    line(header),
    `| ${widths.map((w) => "-".repeat(w)).join(" | ")} |`,
    ...body.map(line),
  ];
}
