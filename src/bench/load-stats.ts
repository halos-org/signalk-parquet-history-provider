/**
 * What the selftest's load generator measured about itself.
 *
 * Its own file because `load.ts` starts generating load the moment it is
 * imported — the selftest needs to know the file's name and shape without
 * running a busy loop to find out.
 */
export interface LoadStats {
  elapsedMs: number;
  cpuUsec: number;
  bytesWritten: number;
  writes: number;
}

export const STATS_FILE = "load-stats.json";

/** The generator's own account, in the harness's units, so the two can be
 * read side by side. */
export function loadStatsSummary(stats: LoadStats): {
  cpuPercentOfCore: number;
  writeKbPerSec: number;
} {
  const seconds = stats.elapsedMs / 1000;
  return {
    cpuPercentOfCore: seconds > 0 ? (stats.cpuUsec / seconds / 1e6) * 100 : 0,
    writeKbPerSec: seconds > 0 ? stats.bytesWritten / 1024 / seconds : 0,
  };
}
