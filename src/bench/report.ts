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
  const seen = new Set<string>();
  for (const run of runs) {
    for (const subject of run.subjects) {
      for (const name of orderMetrics(Object.keys(subject.metrics))) {
        const key = `${subject.name}\u0000${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({
          subject: subject.name,
          metric: name,
          unit: subject.metrics[name].unit,
        });
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
      "† marks a window whose two halves disagreed by more than the " +
      "tolerance, i.e. the measurement covered a transition rather than a " +
      "steady state.",
  ];

  const peaks = rows
    .filter((row) => row.metric === "memoryMb")
    .flatMap((row) =>
      runs
        .map((run) => {
          const found = find(run, row.subject, row.metric);
          return found?.peak === undefined
            ? null
            : `${row.subject} in ${run.label}: mean ${found.dispersion.mean.toFixed(1)} MB, peak ${found.peak.toFixed(1)} MB`;
        })
        .filter((v): v is string => v !== null),
    );
  if (peaks.length > 0) {
    lines.push(
      "",
      "Memory peaks, reported apart from the means because a transient peak " +
        "and a continuous cost are different quantities and adding them " +
        "produces a number that describes nothing:",
      ...peaks.map((p) => `- ${p}`),
    );
  }

  const notes = runs.filter((run) => run.notes.length > 0);
  if (notes.length > 0) {
    lines.push("", "Conditions:");
    for (const run of notes) {
      lines.push(`- **${run.label}** — ${run.notes.join("; ")}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

function methodBlock(runs: RunResult[]): string[] {
  const first = runs[0];
  const mismatched = runs.filter(
    (r) =>
      r.windowSeconds !== first.windowSeconds ||
      r.windows !== first.windows ||
      r.settleSeconds !== first.settleSeconds,
  );
  const lines = [
    `${first.windows} × ${first.windowSeconds}s windows after a ` +
      `${first.settleSeconds}s settle, on ${[...new Set(runs.map((r) => r.host))].join(", ")}.`,
  ];
  if (mismatched.length > 0) {
    lines.push(
      "",
      "**These runs do not share a method and are not comparable:** " +
        mismatched
          .map(
            (r) =>
              `${r.label} used ${r.windows} × ${r.windowSeconds}s after ${r.settleSeconds}s`,
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
  return `${formatDispersion(result.dispersion)}${result.steady ? "" : " †"}`;
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

function markdownTable(header: string[], body: string[][]): string[] {
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
