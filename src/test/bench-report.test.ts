import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { renderComparison } from "../bench/report.js";
import { MetricResult, RunResult } from "../bench/run.js";
import { summarize } from "../bench/statistics.js";

function metric(
  unit: string,
  values: number[],
  extra: Partial<MetricResult> = {},
): MetricResult {
  return {
    unit,
    perWindow: values,
    dispersion: summarize(values),
    halfWindowDrift: values.map(() => 0),
    steady: true,
    ...extra,
  };
}

function run(
  label: string,
  cpu: number[],
  extra: Partial<RunResult> = {},
): RunResult {
  return {
    label,
    startedAt: "2026-08-23T00:00:00.000Z",
    host: "halpi",
    windows: 3,
    windowSeconds: 300,
    settleSeconds: 180,
    tolerance: 0.1,
    devices: ["mmcblk0"],
    notes: [],
    subjects: [
      {
        name: "signalk",
        kind: "pid",
        target: "pid 1",
        metrics: {
          cpuPercentOfCore: metric("% of one core", cpu),
          memoryMb: metric("MB", [87, 88, 87], { peak: 218 }),
        },
      },
    ],
    ...extra,
  };
}

describe("renderComparison", () => {
  it("puts the conditions side by side with their spread", () => {
    const table = renderComparison([
      run("control", [23.1, 23.2, 23.3]),
      run("sqhp", [25.3, 25.5, 25.6]),
    ]);
    assert.match(table, /\| control\s+\| sqhp\s+\|/);
    assert.match(table, /signalk CPU \(% of one core\)/);
    assert.match(table, /23\.20 \(23\.10–23\.30\)/);
  });

  it("marks a metric whose window halves disagreed", () => {
    const drifting = run("parquet", [10, 20, 30]);
    drifting.subjects[0].metrics.cpuPercentOfCore.steady = false;
    const table = renderComparison([drifting]);
    assert.match(table, /†/);
    assert.match(table, /covered a transition/);
  });

  it("reports memory peaks apart from the means", () => {
    const table = renderComparison([run("parquet", [1, 1, 1])]);
    assert.match(table, /peak 218\.0 MB/);
    assert.match(table, /different quantities/);
  });

  it("says so when the runs do not share a method", () => {
    // Comparing a 300-second window against a 30-second one is the sort of
    // thing that reads fine in a table and means nothing.
    const table = renderComparison([
      run("control", [1, 1, 1]),
      run("parquet", [2, 2, 2], { windowSeconds: 30 }),
    ]);
    assert.match(table, /do not share a method and are not comparable/);
  });

  it("fills a cell a condition does not have", () => {
    const other = run("parquet", [1, 1, 1]);
    other.subjects[0].name = "writer";
    const table = renderComparison([run("control", [1, 1, 1]), other]);
    assert.match(table, /—/);
  });

  it("carries the conditions' notes", () => {
    const annotated = run("parquet", [1, 1, 1], {
      notes: ["1000 ms cap, self only"],
    });
    assert.match(renderComparison([annotated]), /1000 ms cap, self only/);
  });

  it("refuses to compare nothing", () => {
    assert.throws(() => renderComparison([]));
  });
});
