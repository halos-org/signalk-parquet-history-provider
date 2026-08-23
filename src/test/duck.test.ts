import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  QueryFailedError,
  QueryOverloadedError,
  QueryRunner,
  QueryTimeoutError,
} from "../query/duck.js";
import type { QueryRequest } from "../query/duck.js";
import { eventually } from "./fixtures.js";

/**
 * The spawn side, without an engine.
 *
 * What matters here is the process contract — one request, one process; a cap
 * on how many run; a deadline that covers the wait as well as the work — and
 * none of it needs DuckDB. `reader.test.ts` covers what the query answers.
 */

let dir: string;
let runner: QueryRunner | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "query-"));
});

afterEach(() => {
  runner?.stop();
  runner = null;
  rmSync(dir, { recursive: true, force: true });
});

const RANGE: QueryRequest = {
  kind: "range",
  from: 0,
  to: 1,
  context: "self",
  paths: ["a.b", "c.d", "e.f"],
};

const child = (script: string): ChildProcess =>
  spawn(process.execPath, ["-e", script], {
    stdio: ["pipe", "pipe", "pipe"],
  });

/** A stand-in query that answers with `rows` rows and a valid summary. */
function answers(rows: unknown[][] = [[1, "self", "a.b"]]): () => ChildProcess {
  const lines = [
    ...rows.map((row) => JSON.stringify(row)),
    JSON.stringify({ rows: rows.length, truncated: false, treeFiles: 2 }),
  ];
  return () =>
    child(
      `process.stdin.resume();` +
        `console.log(${JSON.stringify(lines.join("\n"))});` +
        `process.stdin.on("end", () => process.exit(0));`,
    );
}

const HANGS = (): ChildProcess => child("setTimeout(() => {}, 60000)");

function make(
  over: Partial<ConstructorParameters<typeof QueryRunner>[0]> = {},
): QueryRunner {
  runner = new QueryRunner({ dataDir: dir, spawnQuery: answers(), ...over });
  return runner;
}

describe("a query", () => {
  it("compiles every path in one request into one process", async () => {
    let spawned = 0;
    const result = await make({
      spawnQuery: (args) => {
        spawned += 1;
        assert.deepEqual(args.slice(1), ["--data-dir", dir]);
        return answers()();
      },
    }).run(RANGE);

    assert.equal(spawned, 1, "three paths must not cost three processes");
    assert.deepEqual(result.rows, [[1, "self", "a.b"]]);
    assert.equal(result.treeFiles, 2);
    assert.equal(result.truncated, false);
  });

  it("hands the request to the process on stdin", async () => {
    // Echoed back as a row, which is the only way this side can see what the
    // query was given.
    const echo = (): ChildProcess =>
      child(
        `let text = "";` +
          `process.stdin.on("data", (c) => (text += c));` +
          `process.stdin.on("end", () => {` +
          `  console.log(JSON.stringify([JSON.parse(text).paths.length]));` +
          `  console.log(JSON.stringify({rows:1,truncated:false,treeFiles:0}));` +
          `});`,
      );
    const result = await make({ spawnQuery: echo }).run(RANGE);
    assert.deepEqual(result.rows, [[3]]);
  });

  it("reassembles a row whose text is split across two chunks", async () => {
    // A vessel name or a notification message can put a multi-byte character
    // on a 64 kB boundary. Decoding each chunk on its own replaces the split
    // bytes with U+FFFD in both halves, so the row comes back mangled — or
    // stops being JSON and takes the whole query with it. Here the split is
    // deliberate and mid-character.
    const written = JSON.stringify([1, "self", "n.name", "Kärppä ⛵"]);
    const bytes = Buffer.from(`${written}\n`, "utf8");
    const cut = bytes.indexOf(Buffer.from("ä", "utf8")) + 1;
    const splitWriter = (): ChildProcess =>
      child(
        `const b = Buffer.from(${JSON.stringify(bytes.toString("base64"))}, "base64");` +
          `process.stdout.write(b.subarray(0, ${cut}));` +
          `setTimeout(() => {` +
          `  process.stdout.write(b.subarray(${cut}));` +
          `  console.log(JSON.stringify({rows:1,truncated:false,treeFiles:0}));` +
          `}, 10);`,
      );

    const result = await make({ spawnQuery: splitWriter }).run(RANGE);

    assert.deepEqual(result.rows, [[1, "self", "n.name", "Kärppä ⛵"]]);
  });

  it("reports a failing query with what it said, not with a stack", async () => {
    const fails = (): ChildProcess =>
      child(
        `console.error("the tree could not be read\\n    at some.frame");` +
          `process.exit(1)`,
      );
    await assert.rejects(
      make({ spawnQuery: fails }).run(RANGE),
      (err: Error) =>
        err instanceof QueryFailedError &&
        /code 1: the tree could not be read$/.test(err.message),
    );
  });

  it("refuses an answer with no summary", async () => {
    // A query killed mid-answer exits 0 in some shells and leaves rows without
    // the line that says whether they are all of them. Half an answer must not
    // be reported as a whole one.
    const truncatedOutput = (): ChildProcess =>
      child(`console.log(JSON.stringify([1, "self", "a.b"]))`);
    await assert.rejects(
      make({ spawnQuery: truncatedOutput }).run(RANGE),
      (err: Error) =>
        err instanceof QueryFailedError && /no summary/.test(err.message),
    );
  });

  it("passes the row limit's verdict through", async () => {
    const result = await make({
      spawnQuery: () =>
        child(
          `console.log(JSON.stringify([1]));` +
            `console.log(JSON.stringify({rows:1,truncated:true,treeFiles:9}))`,
        ),
    }).run(RANGE);
    assert.equal(result.truncated, true);
  });
});

describe("the concurrency cap", () => {
  it("runs no more processes than the cap and queues the rest", async () => {
    let live = 0;
    let peak = 0;
    const slow = (): ChildProcess => {
      live += 1;
      peak = Math.max(peak, live);
      const c = child(
        `setTimeout(() => {` +
          `  console.log(JSON.stringify([1]));` +
          `  console.log(JSON.stringify({rows:1,truncated:false,treeFiles:0}));` +
          `}, 60)`,
      );
      c.on("close", () => (live -= 1));
      return c;
    };
    const runner = make({ spawnQuery: slow, maxConcurrent: 2 });

    const all = await Promise.all(
      Array.from({ length: 6 }, () => runner.run(RANGE)),
    );

    assert.equal(all.length, 6, "every queued query is still answered");
    assert.equal(peak, 2, `${peak} processes ran at once against a cap of 2`);
  });

  it("refuses rather than queueing without limit", async () => {
    const runner = make({ spawnQuery: HANGS, maxConcurrent: 1, maxQueued: 2 });
    const accepted = [runner.run(RANGE), runner.run(RANGE), runner.run(RANGE)];
    // Attached before the rejection can arrive: an unhandled rejection ends
    // the test process under Node's default.
    for (const promise of accepted) promise.catch(() => {});

    await assert.rejects(
      runner.run(RANGE),
      (err: Error) =>
        err instanceof QueryOverloadedError &&
        /1 queries are running and 2 are already waiting/.test(err.message),
    );
    assert.deepEqual(runner.pending, { active: 1, queued: 2 });
  });

  it("kills a query that outlives its deadline", async () => {
    const runner = make({ spawnQuery: HANGS, timeoutMs: 100 });
    const started = Date.now();
    await assert.rejects(
      runner.run(RANGE),
      (err: Error) =>
        err instanceof QueryTimeoutError && /within 100 ms/.test(err.message),
    );
    assert.ok(Date.now() - started < 5000, "the deadline did not end the wait");
    // The slot has to come back, or one hung query costs the plugin a
    // permanent halving of its capacity.
    assert.equal(runner.pending.active, 0);
  });

  it("spends the deadline on the queue as well as on the query", async () => {
    // A request that spent its whole deadline waiting has a client that has
    // stopped waiting too. Spawning for it then costs a slot the requests
    // behind it could use, and answers into a socket nobody is reading.
    let spawned = 0;
    const runner = make({
      spawnQuery: () => {
        spawned += 1;
        return HANGS();
      },
      maxConcurrent: 1,
      timeoutMs: 80,
    });
    const first = runner.run(RANGE);
    first.catch(() => {});

    await assert.rejects(runner.run(RANGE), QueryTimeoutError);

    assert.equal(spawned, 1, "the queued query must not have been spawned");
  });

  it("drops the queue and kills what is running when the plugin stops", async () => {
    const runner = make({ spawnQuery: HANGS, maxConcurrent: 1 });
    const running = runner.run(RANGE);
    const queued = runner.run(RANGE);
    const outcomes: string[] = [];
    running.catch((err: Error) => outcomes.push(err.name));
    queued.catch((err: Error) => outcomes.push(err.name));

    runner.stop();

    await eventually(() => outcomes.length === 2, "both queries to end");
    assert.deepEqual(outcomes.sort(), ["QueryFailedError", "QueryFailedError"]);
    await assert.rejects(runner.run(RANGE), /stopping/);
  });
});
