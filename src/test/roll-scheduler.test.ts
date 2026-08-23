import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA_LAYOUT } from "../data-dir.js";
import { dateDirectory } from "../roll/tree-path.js";
import { writerPaths } from "../writer/contract.js";
import { HotStore } from "../writer/hot-store.js";
import { RollScheduler } from "../writer/roll-scheduler.js";
import { sample } from "./fixtures.js";
import type { Sample } from "../writer/protocol.js";

const AUG_23 = Date.UTC(2026, 7, 23);
/** 14:37 on the 23rd: mid-slot for every interval under test. */
const NOW = Date.UTC(2026, 7, 23, 14, 37, 12);

let dir: string;
let store: HotStore;
let seq = 0;
let logged: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "roll-scheduler-"));
  mkdirSync(join(dir, DATA_LAYOUT.hotStore), { recursive: true });
  store = HotStore.open(writerPaths(dir).store);
  store.beginSession("test");
  seq = 0;
  logged = [];
});

afterEach(() => {
  try {
    store.close();
  } catch {
    // Already closed.
  }
  rmSync(dir, { recursive: true, force: true });
});

function record(...samples: Sample[]): void {
  seq += 1;
  store.insertBatch(seq, samples);
}

/** A stand-in roll that does what the argument says and nothing else. */
function fakeRoll(script: string): (args: string[]) => ChildProcess {
  return () =>
    spawn(process.execPath, ["-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
}

const SUCCEEDS = fakeRoll(
  `console.log(JSON.stringify({rows:2,files:[{date:"2026-08-23"}],sidecarRows:2}))`,
);
const FAILS = fakeRoll(`console.error("boom"); process.exit(3)`);
const HANGS = fakeRoll(`setTimeout(() => {}, 60000)`);

function scheduler(
  over: Partial<ConstructorParameters<typeof RollScheduler>[0]> = {},
): RollScheduler {
  return new RollScheduler({
    store,
    dataDir: dir,
    intervalMinutes: 60,
    log: (line) => logged.push(line),
    now: () => NOW,
    spawnRoll: SUCCEEDS,
    ...over,
  });
}

describe("a scheduled roll", () => {
  it("truncates exactly what the roll was given", async () => {
    record(sample({ ts: AUG_23 }), sample({ ts: AUG_23 + 1 }));
    let seenRowid = "";
    const rolls = scheduler({
      spawnRoll: (args) => {
        seenRowid = args[args.indexOf("--max-rowid") + 1];
        // The writer keeps ingesting while the roll runs, and this row was
        // never handed to it.
        record(sample({ ts: AUG_23 + 2 }));
        return SUCCEEDS([]);
      },
    });

    await rolls.rollOnce();

    assert.equal(seenRowid, "2");
    assert.equal(store.rowCount(), 1);
    assert.match(logged.join("\n"), /2 rows truncated/);
  });

  it("names the roll after the slot it belongs to, not the clock", async () => {
    record(sample({ ts: AUG_23 }));
    let rollId = "";
    const rolls = scheduler({
      spawnRoll: (args) => {
        rollId = args[args.indexOf("--roll-id") + 1];
        return SUCCEEDS([]);
      },
    });
    await rolls.rollOnce();
    assert.equal(
      new Date(Number(rollId)).toISOString(),
      "2026-08-23T14:00:00.000Z",
    );
  });

  it("spawns nothing when there is nothing to roll", async () => {
    let spawned = 0;
    const rolls = scheduler({
      spawnRoll: () => {
        spawned += 1;
        return SUCCEEDS([]);
      },
    });
    await rolls.rollOnce();
    assert.equal(spawned, 0);
    // Not even a directory: an empty roll leaves no trace in the tree.
    assert.ok(!existsSync(join(dir, DATA_LAYOUT.tree)));
  });
});

describe("a roll that does not finish", () => {
  it("leaves the hot store intact when the roll fails", async () => {
    record(sample({ ts: AUG_23 }), sample({ ts: AUG_23 + 1 }));
    await scheduler({ spawnRoll: FAILS }).rollOnce();

    assert.equal(store.rowCount(), 2);
    assert.match(logged.join("\n"), /did not finish .*code 3.*2 rows stay/s);
  });

  it("kills a roll that overruns and still does not truncate", async () => {
    record(sample({ ts: AUG_23 }));
    await scheduler({ spawnRoll: HANGS, timeoutMs: 50 }).rollOnce();

    assert.equal(store.rowCount(), 1);
    assert.match(logged.join("\n"), /exceeded its timeout/);
  });

  it("reuses the roll id after a failure, so the retry replaces the files", async () => {
    // A roll that wrote its Parquet and then died leaves those rows in the
    // tree and in the store. Reusing the id makes the retry overwrite what
    // the first attempt wrote instead of adding a second copy beside it.
    record(sample({ ts: AUG_23 }));
    const ids: string[] = [];
    let clock = NOW;
    const failing = scheduler({
      now: () => clock,
      spawnRoll: (args) => {
        ids.push(args[args.indexOf("--roll-id") + 1]);
        return FAILS([]);
      },
    });
    await failing.rollOnce();
    // An hour later, which is a different slot and would be a different name.
    clock = NOW + 3_600_000;
    await failing.rollOnce();

    assert.equal(ids.length, 2);
    assert.equal(ids[0], ids[1]);
  });

  it("takes a fresh id once a roll has been truncated", async () => {
    record(sample({ ts: AUG_23 }));
    const ids: string[] = [];
    let clock = NOW;
    const rolls = scheduler({
      now: () => clock,
      spawnRoll: (args) => {
        ids.push(args[args.indexOf("--roll-id") + 1]);
        return SUCCEEDS([]);
      },
    });
    await rolls.rollOnce();
    record(sample({ ts: AUG_23 + 5 }));
    clock = NOW + 3_600_000;
    await rolls.rollOnce();

    assert.equal(ids.length, 2);
    assert.notEqual(ids[0], ids[1]);
  });
});

describe("a roll left unfinished by a writer that died", () => {
  it("is picked up by the next writer, which reuses its name", async () => {
    // A SIGKILL or an OOM kill leaves the roll process running. If it
    // finishes, it has written a file the successor knows nothing about, and
    // a fresh id would put those rows in the tree twice.
    record(sample({ ts: AUG_23 }));
    const first = scheduler({ spawnRoll: FAILS });
    const ids: string[] = [];
    await first.rollOnce();

    // A new scheduler over the same data directory: a new writer process.
    const successor = scheduler({
      spawnRoll: (args) => {
        ids.push(args[args.indexOf("--roll-id") + 1]);
        return SUCCEEDS([]);
      },
      now: () => NOW + 3_600_000,
    });
    await successor.rollOnce();

    assert.equal(ids.length, 1);
    assert.equal(Number(ids[0]), Date.UTC(2026, 7, 23, 14, 0, 0));
    assert.match(logged.join("\n"), /left unfinished/);
  });

  it("forgets the name once a roll has been truncated", async () => {
    record(sample({ ts: AUG_23 }));
    await scheduler().rollOnce();
    assert.ok(!existsSync(writerPaths(dir).pendingRoll));

    record(sample({ ts: AUG_23 + 1 }));
    const ids: string[] = [];
    const later = scheduler({
      spawnRoll: (args) => {
        ids.push(args[args.indexOf("--roll-id") + 1]);
        return SUCCEEDS([]);
      },
      now: () => NOW + 3_600_000,
    });
    await later.rollOnce();
    assert.equal(Number(ids[0]), Date.UTC(2026, 7, 23, 15, 0, 0));
  });

  it("ignores a pending file it cannot read", async () => {
    // A corrupt safeguard must not be able to stop a device rolling.
    writeFileSync(writerPaths(dir).pendingRoll, "not json");
    record(sample({ ts: AUG_23 }));
    await scheduler().rollOnce();
    assert.equal(store.rowCount(), 0);
  });
});

describe("stopping", () => {
  it("does not start a roll after stop", async () => {
    record(sample({ ts: AUG_23 }));
    let spawned = 0;
    const rolls = scheduler({
      spawnRoll: () => {
        spawned += 1;
        return SUCCEEDS([]);
      },
    });
    await rolls.stop();
    await rolls.rollOnce();
    assert.equal(spawned, 0);
    assert.equal(store.rowCount(), 1);
  });

  it("kills a roll in flight and truncates nothing", async () => {
    record(sample({ ts: AUG_23 }));
    const rolls = scheduler({ spawnRoll: HANGS });
    const inFlight = rolls.rollOnce();
    // Let the child reach the event loop before stopping it.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await rolls.stop();
    await inFlight;

    assert.equal(store.rowCount(), 1);
  });
});

describe("the real roll process, driven by the scheduler", () => {
  it("writes the tree and truncates the store", async () => {
    record(
      sample({ ts: AUG_23 + 1000, path: "a.b" }),
      sample({ ts: AUG_23 + 2000, path: "c.d" }),
    );
    // No spawnRoll: this is the production path, DuckDB and all.
    const rolls = new RollScheduler({
      store,
      dataDir: dir,
      intervalMinutes: 60,
      log: (line) => logged.push(line),
      now: () => NOW,
    });
    await rolls.rollOnce();

    assert.equal(store.rowCount(), 0);
    assert.deepEqual(readdirSync(dateDirectory(dir, AUG_23)), [
      `${Date.UTC(2026, 7, 23, 14, 0, 0)}.parquet`,
    ]);
    assert.match(logged.join("\n"), /2 rows to 2026-08-23 and 2 sidecar rows/);
  });
});
