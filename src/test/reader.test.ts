import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA_LAYOUT } from "../data-dir.js";
import { QueryRunner } from "../query/duck.js";
import type { QueryRequest, QueryResult } from "../query/duck.js";
import { treeFilesInRange } from "../query/reader.js";
import { roll } from "../roll/roll.js";
import { dateDirectory, rollFile } from "../roll/tree-path.js";
import { writerPaths } from "../writer/contract.js";
import { HotStore } from "../writer/hot-store.js";
import { NO_BUNDLED_EXTENSION, sample } from "./fixtures.js";
import type { Sample } from "../writer/protocol.js";

/**
 * The reader, through a real spawned process and a real engine.
 *
 * The seam is what these are about: the tree and the hot store hold the same
 * rows for as long as it takes the writer to truncate, and an answer that
 * counts them twice is as wrong as one that misses them.
 */

const DAY = 86_400_000;
const AUG_23 = Date.UTC(2026, 7, 23);
const AUG_24 = AUG_23 + DAY;

let dir: string;
let store: HotStore;
let runner: QueryRunner;
let seq = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reader-"));
  mkdirSync(join(dir, DATA_LAYOUT.hotStore), { recursive: true });
  store = HotStore.open(writerPaths(dir).store);
  store.beginSession("test");
  runner = new QueryRunner({ dataDir: dir });
  seq = 0;
});

afterEach(() => {
  runner.stop();
  try {
    store.close();
  } catch {
    // Already closed by the test.
  }
  rmSync(dir, { recursive: true, force: true });
});

function record(...samples: Sample[]): void {
  seq += 1;
  store.insertBatch(seq, samples);
}

/** Records `count` numeric samples a second apart from `start`. */
function series(start: number, count: number, path = "a.b"): void {
  for (let i = 0; i < count; i += 1) {
    record(sample({ ts: start + i * 1000, path, value: i }));
  }
}

/** Rolls everything in the store under `rollId` and returns the bound used. */
async function rollAll(rollId: number): Promise<number> {
  const bound = store.rollBound();
  assert.ok(bound !== null, "nothing to roll");
  await roll({ dataDir: dir, maxRowid: bound.maxRowid, rollId });
  return bound.maxRowid;
}

/** The record the writer leaves between a roll and the truncate that follows. */
function writePendingRoll(
  rollId: number,
  maxRowid: number,
  phase: "rolling" | "written",
): void {
  writeFileSync(
    writerPaths(dir).pendingRoll,
    `${JSON.stringify({ rollId, maxRowid, phase })}\n`,
  );
}

function timestamps(result: QueryResult): number[] {
  return result.rows.map((row) => row[0] as number);
}

const range = (from: number, to: number, over: Partial<QueryRequest> = {}) =>
  ({ kind: "range", from, to, context: "self", ...over }) as QueryRequest;

describe("a query across the seam", { skip: NO_BUNDLED_EXTENSION }, () => {
  it("returns the tree's rows and the store's rows once each, in order", async () => {
    series(AUG_23 + 1000, 5);
    const maxRowid = await rollAll(1);
    store.deleteThrough(maxRowid);
    series(AUG_23 + 60_000, 3);

    const result = await runner.run(range(AUG_23, AUG_23 + DAY));

    assert.deepEqual(timestamps(result), [
      AUG_23 + 1000,
      AUG_23 + 2000,
      AUG_23 + 3000,
      AUG_23 + 4000,
      AUG_23 + 5000,
      AUG_23 + 60_000,
      AUG_23 + 61_000,
      AUG_23 + 62_000,
    ]);
    assert.equal(result.treeFiles, 1);
  });

  it("counts a rolled row once while it is still in both", async () => {
    // The window between a roll writing its Parquet and the writer deleting
    // those rows. It is milliseconds in the ordinary case and survives a
    // restart when the delete failed, which is why the reader subtracts rather
    // than hoping.
    series(AUG_23 + 1000, 5);
    const maxRowid = await rollAll(1);
    writePendingRoll(1, maxRowid, "written");
    series(AUG_23 + 60_000, 2);

    const result = await runner.run(range(AUG_23, AUG_23 + DAY));

    assert.deepEqual(timestamps(result), [
      AUG_23 + 1000,
      AUG_23 + 2000,
      AUG_23 + 3000,
      AUG_23 + 4000,
      AUG_23 + 5000,
      AUG_23 + 60_000,
      AUG_23 + 61_000,
    ]);
  });

  it("keeps the store's copy of a date the roll never wrote", async () => {
    // A roll killed between two date directories. Subtracting its whole bound
    // would drop the day it never got to, which is a gap — worse than the
    // duplicate the subtraction exists to prevent.
    series(AUG_23 + 1000, 2);
    series(AUG_24 + 1000, 2);
    const maxRowid = await rollAll(7);
    rmSync(rollFile(dir, AUG_24, 7));
    writePendingRoll(7, maxRowid, "rolling");

    const result = await runner.run(range(AUG_23, AUG_24 + DAY));

    assert.deepEqual(timestamps(result), [
      AUG_23 + 1000,
      AUG_23 + 2000,
      AUG_24 + 1000,
      AUG_24 + 2000,
    ]);
  });

  it("ignores a pending record whose file has not appeared", async () => {
    // The record is written before the roll is spawned, so this is the state
    // every roll passes through. Nothing is in the tree yet, so nothing may be
    // subtracted from the store.
    series(AUG_23 + 1000, 3);
    const bound = store.rollBound();
    assert.ok(bound !== null);
    writePendingRoll(1, bound.maxRowid, "rolling");

    const result = await runner.run(range(AUG_23, AUG_23 + DAY));

    assert.equal(result.rows.length, 3);
    assert.equal(result.treeFiles, 0);
  });
});

describe("what a query reads", { skip: NO_BUNDLED_EXTENSION }, () => {
  it("opens no tree file for a range the hot store covers alone", async () => {
    series(AUG_23 + 1000, 2);
    store.deleteThrough(await rollAll(1));
    series(AUG_24 + 1000, 2);

    const result = await runner.run(range(AUG_24, AUG_24 + DAY));

    assert.equal(result.treeFiles, 0, "a dated directory outside the range");
    assert.equal(result.rows.length, 2);
  });

  it("answers a range before anything was recorded with no rows", async () => {
    series(AUG_23 + 1000, 2);
    store.deleteThrough(await rollAll(1));

    const result = await runner.run(
      range(AUG_23 - 30 * DAY, AUG_23 - 29 * DAY),
    );

    assert.deepEqual(result.rows, []);
    assert.equal(result.truncated, false);
  });

  it("answers on a data directory with neither a tree nor a store", async () => {
    const empty = mkdtempSync(join(tmpdir(), "reader-empty-"));
    const fresh = new QueryRunner({ dataDir: empty });
    try {
      const result = await fresh.run(range(AUG_23, AUG_23 + DAY));
      assert.deepEqual(result.rows, []);
    } finally {
      fresh.stop();
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("refuses a request whose shape reached it from JSON", async () => {
    // The type the request is cast to on arrival is a claim, not a check. An
    // unrecognised `kind` used to compile to the contexts query and answer it,
    // and a `limit` that is not a number used to compile to `LIMIT NaN`.
    series(AUG_23 + 1000, 2);
    const refuses = async (request: unknown, why: RegExp) => {
      await assert.rejects(
        runner.run(request as QueryRequest),
        (err: Error) => why.test(err.message),
        `${JSON.stringify(request)} was not refused`,
      );
    };

    await refuses(
      { kind: "everything", from: AUG_23, to: AUG_23 + DAY, context: "self" },
      /is not a query kind/,
    );
    await refuses(
      range(AUG_23, AUG_23 + DAY, { limit: "x" as unknown as number }),
      /limit must be a number/,
    );
    await refuses(
      { kind: "range", from: AUG_23, to: undefined, context: "self" },
      /to must be a timestamp/,
    );
  });

  it("skips a partition a killed roll left half-written", async () => {
    series(AUG_23 + 1000, 2);
    const maxRowid = await rollAll(1);
    store.deleteThrough(maxRowid);
    // What a roll killed mid-`COPY` leaves. It is not Parquet at all, so a
    // reader that picked it up would fail rather than return a subset — which
    // is the assertion: the query succeeds.
    writeFileSync(join(dateDirectory(dir, AUG_23), "9999.parquet.tmp"), "no");

    const result = await runner.run(range(AUG_23, AUG_23 + DAY));

    assert.equal(result.rows.length, 2);
    assert.equal(result.treeFiles, 1);
  });

  it("returns only the paths the request named", async () => {
    series(AUG_23 + 1000, 2, "a.b");
    series(AUG_23 + 1000, 2, "c.d");
    series(AUG_23 + 1000, 2, "e.f");
    store.deleteThrough(await rollAll(1));

    const result = await runner.run(
      range(AUG_23, AUG_23 + DAY, { paths: ["a.b", "e.f"] }),
    );

    assert.deepEqual([...new Set(result.rows.map((row) => row[2]))].sort(), [
      "a.b",
      "e.f",
    ]);
  });

  it("reports a truncated answer rather than returning everything", async () => {
    series(AUG_23 + 1000, 6);

    const result = await runner.run(range(AUG_23, AUG_23 + DAY, { limit: 4 }));

    assert.equal(result.rows.length, 4);
    assert.equal(result.truncated, true);
    assert.deepEqual(timestamps(result), [
      AUG_23 + 1000,
      AUG_23 + 2000,
      AUG_23 + 3000,
      AUG_23 + 4000,
    ]);
  });

  it("lists the paths and contexts in a range from both sources", async () => {
    series(AUG_23 + 1000, 1, "a.b");
    record(sample({ ts: AUG_23 + 2000, path: "c.d", context: "other" }));
    store.deleteThrough(await rollAll(1));
    series(AUG_23 + 60_000, 1, "e.f");

    const paths = await runner.run({
      kind: "paths",
      from: AUG_23,
      to: AUG_23 + DAY,
      context: "self",
    });
    const contexts = await runner.run({
      kind: "contexts",
      from: AUG_23,
      to: AUG_23 + DAY,
    });

    assert.deepEqual(paths.rows, [["a.b"], ["e.f"]]);
    assert.deepEqual(contexts.rows, [["other"], ["self"]]);
  });

  it("carries every column of a row through unchanged", async () => {
    record(
      sample({ ts: AUG_23 + 1000, path: "n.p", kind: "position" }),
      sample({
        ts: AUG_23 + 2000,
        path: "s.t",
        kind: "string",
        value: "moored",
      }),
    );
    store.deleteThrough(await rollAll(1));

    const result = await runner.run(range(AUG_23, AUG_23 + DAY));

    assert.deepEqual(result.rows[0], [
      AUG_23 + 1000,
      "self",
      "n.p",
      "n2k.0",
      "position",
      null,
      null,
      60.16,
      24.94,
    ]);
    assert.deepEqual(result.rows[1], [
      AUG_23 + 2000,
      "self",
      "s.t",
      "n2k.0",
      "string",
      null,
      "moored",
      null,
      null,
    ]);
  });
});

describe("the tree's file selection", () => {
  it("keeps the dates that intersect the range and no others", async () => {
    for (const date of ["2026-08-22", "2026-08-23", "2026-08-24"]) {
      const directory = join(dir, DATA_LAYOUT.tree, `date=${date}`);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "1.parquet"), "");
    }

    const files = treeFilesInRange(dir, AUG_23 + 1000, AUG_23 + 2000);

    assert.deepEqual(
      files.map((file) => file.name),
      ["1.parquet"],
    );
    assert.match(files[0].path, /date=2026-08-23/);
  });

  it("takes the day either side when the range crosses midnight", () => {
    for (const date of ["2026-08-23", "2026-08-24", "2026-08-25"]) {
      const directory = join(dir, DATA_LAYOUT.tree, `date=${date}`);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "1.parquet"), "");
    }

    const files = treeFilesInRange(dir, AUG_23 + DAY - 1000, AUG_24 + 1000);

    assert.deepEqual(
      files.map((file) => file.day),
      [AUG_23, AUG_24],
    );
  });

  it("ignores a directory that does not name a date", () => {
    for (const name of ["date=not-a-date", "date=2026-08-32", "notes", ""]) {
      if (name === "") continue;
      const directory = join(dir, DATA_LAYOUT.tree, name);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "1.parquet"), "");
    }

    assert.deepEqual(treeFilesInRange(dir, 0, Date.UTC(2100, 0, 1)), []);
  });

  it("returns nothing rather than failing when there is no tree", () => {
    assert.deepEqual(treeFilesInRange(dir, 0, Date.UTC(2100, 0, 1)), []);
  });
});
