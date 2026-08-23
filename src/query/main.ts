import { writeSync } from "node:fs";
import { once } from "node:events";
import { ownPeakBytes } from "../bench/one-shot.js";
import { read } from "./reader.js";
import type { QueryRequest } from "./duck.js";

/**
 * The query process.
 *
 * Spawned per request, and it exits when the answer is out. The exit is the
 * mechanism rather than tidiness: DuckDB's allocator does not return this
 * memory in-process, so an engine held open inside the Signal K server would
 * turn a ~120 MB transient into a standing cost — which is the one thing this
 * plugin exists to avoid.
 *
 *   node dist/query/main.js --data-dir <path> [--memory-limit 256MB]
 *
 * The request is one JSON object on stdin. The answer is newline-delimited
 * JSON on stdout: one array per row, then one object summarising the run —
 * including this process's own peak resident size, which nothing outside the
 * process can read exactly. Rows are arrays and the summary is an object, so
 * the two need no marker to be told apart.
 *
 * Exit codes:
 *   0  the answer is complete, or complete to the row limit the summary states
 *   1  anything else; the reason is the first line of stderr
 */

/**
 * Write to stderr and be sure it arrives.
 *
 * `process.stderr.write` is asynchronous when stderr is a pipe — which it
 * always is here — and `process.exit` right after it truncates whatever is
 * still queued. The message this loses is the one the caller reports.
 */
function writeStderr(line: string): void {
  writeSync(2, line);
}

/** Rows per write. Large enough that the syscalls do not dominate a big
 * answer, small enough that the text of one batch is not worth measuring. */
const OUTPUT_BATCH_ROWS = 1000;

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function readRequest(): Promise<QueryRequest> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString().trim();
  if (text === "") throw new Error("no request arrived on stdin");
  return JSON.parse(text) as QueryRequest;
}

async function main(): Promise<void> {
  const dataDir = argValue("--data-dir");
  if (dataDir === undefined || dataDir === "") {
    writeStderr("usage: query/main.js --data-dir <path> < request.json\n");
    process.exit(1);
  }

  const started = performance.now();
  const result = await read(await readRequest(), {
    dataDir,
    memoryLimit: argValue("--memory-limit"),
  });

  // Rows first, summary last: the caller treats a missing summary as a failed
  // query, so it can only ever be written once everything before it is.
  //
  // In batches rather than one string. A range query's answer can be tens of
  // megabytes, and this process's peak is the figure the design is judged on —
  // joining every line first would add the whole answer to it a second time.
  const batch: string[] = [];
  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const full = !process.stdout.write(`${batch.join("\n")}\n`);
    batch.length = 0;
    // Waiting for the pipe rather than serialising ahead of it. Without this
    // an answer the caller reads slowly accumulates inside this process
    // instead — on top of the rows it already holds, and on the one figure
    // this design is judged on.
    if (full) await once(process.stdout, "drain");
  };
  for (const row of result.rows) {
    batch.push(JSON.stringify(row));
    if (batch.length >= OUTPUT_BATCH_ROWS) await flush();
  }
  batch.push(
    JSON.stringify({
      rows: result.rows.length,
      truncated: result.truncated,
      treeFiles: result.treeFiles,
      // In-engine time, which is not what a request costs — the caller
      // measures spawn to answer, and process start plus extension load is
      // most of the difference. Reported so the two can be compared.
      queryMs: Math.round(performance.now() - started),
      peakRssBytes: ownPeakBytes(),
    }),
  );
  await flush();
}

main().catch((err: unknown) => {
  // The message first, then the stack. The caller reports the first line, and
  // a stack frame tells an operator nothing about why the query failed.
  writeStderr(
    `${err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err)}\n`,
  );
  process.exit(1);
});
