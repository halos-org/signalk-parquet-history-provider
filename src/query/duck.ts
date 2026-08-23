import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * Queries, from the side that must never hold an engine.
 *
 * This file runs inside the Signal K process, so it spawns `query/main.js` and
 * reads what it prints. Nothing here imports `@duckdb/node-api`, and
 * `src/test/plugin-import-graph.test.ts` is what keeps it that way — a lazily
 * loaded engine inside a request handler is exactly the shape this design
 * exists to prevent.
 *
 * **One request, one process.** The sibling provider issues one query per
 * pathSpec and a second for non-numeric paths, which is free against a running
 * server and is not free here: every spawn pays process start, extension load
 * and Parquet footer reads, measured at 70–110 ms before any work. A ten-series
 * panel would pay it twenty times. So a request naming ten paths compiles to
 * one statement in one process.
 */

const QUERY_ENTRY = fileURLToPath(new URL("./main.js", import.meta.url));

/** The columns a `range` row carries, in the order the tree writes them. */
export const RANGE_COLUMNS = [
  "ts",
  "context",
  "path",
  "source",
  "value_kind",
  "value_num",
  "value_str",
  "value_lat",
  "value_lon",
] as const;

/**
 * What a query asks for. `from` is inclusive and `to` exclusive, both in
 * milliseconds, which is what the store and the tree hold.
 */
export type QueryRequest =
  | {
      kind: "range";
      from: number;
      to: number;
      context: string;
      /** Empty or absent means every path in the context. */
      paths?: string[];
      /** Rows to return before the answer is reported as truncated. */
      limit?: number;
    }
  | { kind: "paths"; from: number; to: number; context: string }
  | { kind: "contexts"; from: number; to: number };

export interface QueryResult {
  /** Column order for `range` is `RANGE_COLUMNS`; the other two are one column. */
  rows: unknown[][];
  /** The range held more rows than the limit, and these are the first of them. */
  truncated: boolean;
  /**
   * Spawn to last line, measured here rather than in the engine.
   *
   * The engine's own timing omits process start, extension load and Parquet
   * metadata reads, which together outweigh a well-shaped query over a day of
   * data. Only this side can see all of it.
   */
  wallMs: number;
  /** Tree files the reader opened. Zero means the range was inside the hot store. */
  treeFiles: number;
  /** The query process's own peak resident size, or null off Linux. */
  peakRssBytes: number | null;
}

/**
 * How many query processes may run at once.
 *
 * Two, because each is around 120 MB and a roll is another 160 MB against a
 * device with 4 GB that is also running the marine stack. It is a cap on
 * concurrent transients, not a throughput target: the queue below is what
 * absorbs a burst.
 */
export const MAX_CONCURRENT_QUERIES = 2;

/**
 * How many may wait for a slot before the answer is "no".
 *
 * A Grafana dashboard opens with one request per panel, so a queue is the
 * right response to a burst and a refusal is the right response to a backlog:
 * past this many, the requests already waiting will not be served inside their
 * own deadline either, and accepting more only spends memory on answers nobody
 * is waiting for any more.
 */
export const MAX_QUEUED_QUERIES = 8;

/** The deadline for one request, queue wait included. */
export const QUERY_TIMEOUT_MS = 30_000;

/** How long a killed query gets to die before it is killed harder. */
const KILL_GRACE_MS = 1000;

/** The queue was full. The API surface turns this into a 503. */
export class QueryOverloadedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryOverloadedError";
  }
}

/** The deadline passed, in the queue or in the engine. */
export class QueryTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryTimeoutError";
  }
}

/** The query process failed, and this is what it said. */
export class QueryFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryFailedError";
  }
}

export interface QueryRunnerOptions {
  dataDir: string;
  maxConcurrent?: number;
  maxQueued?: number;
  timeoutMs?: number;
  /** Passed to the engine. The default lives in the reader. */
  memoryLimit?: string;
  /** Injected in tests, so a query need not be a real DuckDB process. */
  spawnQuery?: (args: string[]) => ChildProcess;
}

interface Waiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | null;
}

export class QueryRunner {
  private readonly options: QueryRunnerOptions;
  private readonly maxConcurrent: number;
  private readonly maxQueued: number;
  private readonly timeoutMs: number;
  private active = 0;
  private readonly waiting: Waiter[] = [];
  private readonly running = new Set<ChildProcess>();
  private stopped = false;

  constructor(options: QueryRunnerOptions) {
    this.options = options;
    this.maxConcurrent = options.maxConcurrent ?? MAX_CONCURRENT_QUERIES;
    this.maxQueued = options.maxQueued ?? MAX_QUEUED_QUERIES;
    this.timeoutMs = options.timeoutMs ?? QUERY_TIMEOUT_MS;
  }

  /** Queries in flight and queued, for a status line. */
  get pending(): { active: number; queued: number } {
    return { active: this.active, queued: this.waiting.length };
  }

  /**
   * One request, one process.
   *
   * The deadline starts here and covers the wait for a slot as well as the
   * query itself. A request that spent its whole deadline queued is one whose
   * client has stopped waiting, and running it then would spend a slot the
   * requests behind it could use.
   */
  async run(request: QueryRequest): Promise<QueryResult> {
    const deadline = Date.now() + this.timeoutMs;
    await this.acquire(deadline);
    try {
      // Both of these are the state at the moment the slot became this
      // request's, which is not the state when it asked for one. Even an
      // uncontended slot is handed over a microtask later, and `stop()`
      // landing in that gap would otherwise spawn a process nothing is left
      // to kill — the plugin has already stopped waiting for it.
      if (this.stopped) throw new QueryFailedError("the plugin is stopping");
      if (Date.now() >= deadline) {
        throw new QueryTimeoutError(
          `no query slot came free within ${this.timeoutMs} ms`,
        );
      }
      return await this.execute(request, deadline);
    } finally {
      this.release();
    }
  }

  private acquire(deadline: number): Promise<void> {
    if (this.stopped) {
      return Promise.reject(new QueryFailedError("the plugin is stopping"));
    }
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    if (this.waiting.length >= this.maxQueued) {
      return Promise.reject(
        new QueryOverloadedError(
          `${this.maxConcurrent} queries are running and ${this.waiting.length} ` +
            `are already waiting; this one is refused rather than queued behind them`,
        ),
      );
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(
        () => {
          this.drop(waiter);
          reject(
            new QueryTimeoutError(
              `no query slot came free within ${this.timeoutMs} ms`,
            ),
          );
        },
        Math.max(0, deadline - Date.now()),
      );
      waiter.timer.unref();
      this.waiting.push(waiter);
    });
  }

  /**
   * Hand the slot to whoever is next, or give it back.
   *
   * The slot moves without passing through `active`, because decrementing and
   * letting the next waiter re-acquire would let a request that arrived in
   * between overtake the queue.
   */
  private release(): void {
    const next = this.waiting.shift();
    if (next === undefined) {
      this.active -= 1;
      return;
    }
    if (next.timer !== null) clearTimeout(next.timer);
    next.resolve();
  }

  private drop(waiter: Waiter): void {
    const index = this.waiting.indexOf(waiter);
    if (index >= 0) this.waiting.splice(index, 1);
  }

  private execute(
    request: QueryRequest,
    deadline: number,
  ): Promise<QueryResult> {
    const started = performance.now();
    const args = [QUERY_ENTRY, "--data-dir", this.options.dataDir];
    if (this.options.memoryLimit !== undefined) {
      args.push("--memory-limit", this.options.memoryLimit);
    }
    const child = (this.options.spawnQuery ?? defaultSpawn)(args);
    this.running.add(child);

    return new Promise<QueryResult>((resolve, reject) => {
      const rows: unknown[][] = [];
      let summary: Summary | null = null;
      let pendingLine = "";
      let stderr = "";
      let settled = false;
      let parseFailure: string | null = null;

      const settle = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(killer);
        this.running.delete(child);
        outcome();
      };

      const killer = setTimeout(
        () => {
          child.kill("SIGTERM");
          const hard = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
          hard.unref();
          settle(() =>
            reject(
              new QueryTimeoutError(
                `the query did not finish within ${this.timeoutMs} ms`,
              ),
            ),
          );
        },
        Math.max(0, deadline - Date.now()),
      );
      killer.unref();

      // Line by line as it arrives, rather than one split over a collected
      // string: a range query's answer can be tens of megabytes, and holding
      // it once as text and once as rows doubles that inside the Signal K
      // process.
      child.stdout?.on("data", (chunk: Buffer) => {
        pendingLine += chunk.toString();
        let cut = pendingLine.indexOf("\n");
        while (cut >= 0) {
          const line = pendingLine.slice(0, cut);
          pendingLine = pendingLine.slice(cut + 1);
          if (line !== "") {
            try {
              // Rows are arrays and the summary is an object, so the last line
              // needs no marker to be told from the rows before it.
              const parsed: unknown = JSON.parse(line);
              if (Array.isArray(parsed)) rows.push(parsed as unknown[]);
              else summary = parsed as Summary;
            } catch {
              parseFailure ??= "the query printed something that is not JSON";
            }
          }
          cut = pendingLine.indexOf("\n");
        }
      });
      child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
      // An EventEmitter with no error listener rethrows the event, which would
      // take the Signal K process down for a failed query.
      child.stdout?.on("error", () => {});
      child.stderr?.on("error", () => {});
      // EPIPE, when the query exits before reading its request.
      child.stdin?.on("error", () => {});
      child.on("error", (err) =>
        settle(() => reject(new QueryFailedError(err.message))),
      );

      child.stdin?.end(`${JSON.stringify(request)}\n`);

      // `close`, not `exit`: exit can fire while the summary is still in the
      // pipe, and the summary is what says whether the answer is complete.
      child.on("close", (code, signal) => {
        settle(() => {
          if (code !== 0) {
            const how = code === null ? `signal ${signal}` : `code ${code}`;
            reject(
              new QueryFailedError(
                `the query exited with ${how}: ${firstLine(stderr)}`,
              ),
            );
            return;
          }
          if (parseFailure !== null || summary === null) {
            reject(
              new QueryFailedError(
                parseFailure ?? "the query printed no summary",
              ),
            );
            return;
          }
          const complete: Summary = summary;
          resolve({
            rows,
            truncated: complete.truncated === true,
            wallMs: performance.now() - started,
            treeFiles: complete.treeFiles ?? 0,
            peakRssBytes: complete.peakRssBytes ?? null,
          });
        });
      });
    });
  }

  /**
   * Refuse new work, drop the queue and kill what is running.
   *
   * A query outliving the plugin holds a read on the hot store the writer is
   * being asked to close.
   */
  stop(): void {
    this.stopped = true;
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift() as Waiter;
      if (waiter.timer !== null) clearTimeout(waiter.timer);
      waiter.reject(new QueryFailedError("the plugin is stopping"));
    }
    for (const child of this.running) {
      child.kill("SIGTERM");
      const hard = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
      hard.unref();
    }
  }
}

/** The fields of the query's last line this side depends on. */
interface Summary {
  truncated?: boolean;
  treeFiles?: number;
  peakRssBytes?: number | null;
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}

function defaultSpawn(args: string[]): ChildProcess {
  // An argument array, never a shell: the data directory is a string an
  // operator typed into the Admin UI.
  return spawn(process.execPath, args, {
    stdio: ["pipe", "pipe", "pipe"],
  });
}
