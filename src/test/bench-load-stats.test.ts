import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadStatsSummary } from "../bench/load-stats.js";

describe("loadStatsSummary", () => {
  it("converts the generator's own counters into the harness's units", () => {
    // 6 seconds of wall clock, 1.2 s of CPU, 384 KB fsynced.
    const summary = loadStatsSummary({
      elapsedMs: 6000,
      cpuUsec: 1_200_000,
      bytesWritten: 384 * 1024,
      writes: 24,
    });
    assert.ok(Math.abs(summary.cpuPercentOfCore - 20) < 1e-9);
    assert.ok(Math.abs(summary.writeKbPerSec - 64) < 1e-9);
  });

  it("reports zero rather than dividing by an elapsed time of zero", () => {
    const summary = loadStatsSummary({
      elapsedMs: 0,
      cpuUsec: 0,
      bytesWritten: 0,
      writes: 0,
    });
    assert.equal(summary.cpuPercentOfCore, 0);
    assert.equal(summary.writeKbPerSec, 0);
  });
});
