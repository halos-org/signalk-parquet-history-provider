import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HotStore } from "../writer/hot-store.js";
import type { Sample } from "../writer/protocol.js";

function sample(over: Partial<Sample> = {}): Sample {
  return {
    ts: 1_700_000_000_000,
    context: "vessels.self",
    path: "environment.depth.belowKeel",
    source: "n2k.0",
    kind: "number",
    value: 4.2,
    ...over,
  } as Sample;
}

let dir: string;
let store: HotStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hot-store-"));
  store = HotStore.open(join(dir, "hot.sqlite"));
});

afterEach(() => {
  try {
    store.close();
  } catch {
    // Already closed by the test.
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Reads rows back through a second handle, the way the roll will. */
function rows(path = join(dir, "hot.sqlite")): Record<string, unknown>[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare("SELECT * FROM sample ORDER BY rowid").all() as Record<
      string,
      unknown
    >[];
  } finally {
    db.close();
  }
}

describe("the store is configured for cheap, durable-enough writes", () => {
  it("runs in WAL with synchronous NORMAL", () => {
    // WAL is what lets the roll read while the writer holds the store, and
    // NORMAL is the difference between 435 bytes written per row and
    // signalk-parquet's measured 35 KB from per-record FULL commits.
    assert.strictEqual(store.pragma("journal_mode"), "wal");
    assert.strictEqual(store.pragma("synchronous"), 1);
  });

  it("carries no index on the sample table", () => {
    // Deliberate. Every index is paid on each insert, and nothing reads this
    // table by key: the roll scans a time range and truncates, and DuckDB's
    // sqlite_scanner scans regardless. An index here would buy nothing and
    // cost the write budget the whole design is judged on.
    store.beginSession("s1");
    const db = new DatabaseSync(join(dir, "hot.sqlite"), { readOnly: true });
    try {
      const indexes = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sample' AND sql IS NOT NULL",
        )
        .all();
      assert.deepStrictEqual(indexes, []);
    } finally {
      db.close();
    }
  });
});

describe("value fidelity", () => {
  beforeEach(() => store.beginSession("s1"));

  it("round-trips every kind with its value in its own column", () => {
    store.insertBatch(1, [
      sample({ kind: "number", value: -4.25 }),
      sample({ kind: "string", value: "moored", path: "navigation.state" }),
      sample({
        kind: "position",
        path: "navigation.position",
        value: { latitude: -60.166_666_7, longitude: 24.943_333_3 },
      }),
      sample({ kind: "identity", path: "name", value: "Øresund ⛵" }),
    ]);

    const stored = rows();
    assert.strictEqual(stored[0].value_kind, "number");
    assert.strictEqual(stored[0].value_num, -4.25);
    assert.strictEqual(stored[0].value_str, null);

    assert.strictEqual(stored[1].value_kind, "string");
    assert.strictEqual(stored[1].value_str, "moored");
    assert.strictEqual(stored[1].value_num, null);

    assert.strictEqual(stored[2].value_kind, "position");
    assert.strictEqual(stored[2].value_lat, -60.166_666_7);
    assert.strictEqual(stored[2].value_lon, 24.943_333_3);

    assert.strictEqual(stored[3].value_kind, "identity");
    assert.strictEqual(stored[3].path, "name");
    assert.strictEqual(stored[3].value_str, "Øresund ⛵");
  });

  it("tells a recorded boolean from a string that says true", () => {
    // The reason value_kind exists. Without it both are the text "true" and
    // Unit 4c cannot replay one as a boolean and the other as a string, while
    // a round-trip test that only checks the value still passes.
    store.insertBatch(1, [
      sample({ kind: "boolean", value: "true", path: "electrical.switch.1" }),
      sample({ kind: "string", value: "true", path: "navigation.state" }),
    ]);

    const stored = rows();
    assert.strictEqual(stored[0].value_str, stored[1].value_str);
    assert.notStrictEqual(stored[0].value_kind, stored[1].value_kind);
    assert.strictEqual(stored[0].value_kind, "boolean");
    assert.strictEqual(stored[1].value_kind, "string");
  });

  it("keeps a null source null rather than turning it into a string", () => {
    store.insertBatch(1, [sample({ source: null })]);
    assert.strictEqual(rows()[0].source, null);
  });

  it("refuses a value kind the schema does not know", () => {
    // The store is written by a process reading a socket, so the schema states
    // the closed set rather than trusting the reader to have checked.
    assert.throws(() =>
      store.insertBatch(1, [
        { ...sample(), kind: "elephant", value: 1 } as unknown as Sample,
      ]),
    );
  });
});

describe("a batch is one transaction", () => {
  beforeEach(() => store.beginSession("s1"));

  it("stores none of a batch when one row is rejected", () => {
    store.insertBatch(1, [sample({ ts: 1 })]);
    assert.strictEqual(store.rowCount(), 1);

    assert.throws(() =>
      store.insertBatch(2, [
        sample({ ts: 2 }),
        { ...sample({ ts: 3 }), kind: "elephant" } as unknown as Sample,
        sample({ ts: 4 }),
      ]),
    );

    assert.strictEqual(store.rowCount(), 1, "the good rows rolled back too");
  });

  it("leaves the sequence counter untouched when a batch rolls back", () => {
    // Otherwise the failed batch is remembered as applied and its retry is
    // discarded as a duplicate — silent loss on the path that already failed.
    store.insertBatch(1, [sample()]);
    assert.throws(() =>
      store.insertBatch(2, [
        { ...sample(), kind: "elephant" } as unknown as Sample,
      ]),
    );

    assert.deepStrictEqual(store.insertBatch(2, [sample()]), {
      stored: 1,
      skipped: false,
    });
  });
});

describe("a resend after a lost acknowledgement is not stored twice", () => {
  it("skips a sequence number it has already committed", () => {
    store.beginSession("s1");
    assert.deepStrictEqual(store.insertBatch(1, [sample(), sample()]), {
      stored: 2,
      skipped: false,
    });

    assert.deepStrictEqual(store.insertBatch(1, [sample(), sample()]), {
      stored: 0,
      skipped: true,
    });
    assert.strictEqual(store.rowCount(), 2);
  });

  it("resumes the counter when the same session reopens the store", () => {
    // The writer restarting under a live plugin. Its sequence numbers keep
    // climbing, so the counter has to survive in the file, not just in memory.
    store.beginSession("s1");
    store.insertBatch(7, [sample()]);
    store.close();

    store = HotStore.open(join(dir, "hot.sqlite"));
    assert.strictEqual(store.beginSession("s1"), 7);
    assert.deepStrictEqual(store.insertBatch(7, [sample()]), {
      stored: 0,
      skipped: true,
    });
  });

  it("resets the counter for a different session", () => {
    // The plugin restarting. Its counter goes back to 1, and treating those as
    // duplicates of the previous run would acknowledge every batch and store
    // none of them, with the plugin reporting healthy throughout.
    store.beginSession("s1");
    store.insertBatch(40_000, [sample()]);

    assert.strictEqual(store.beginSession("s2"), 0);
    assert.deepStrictEqual(store.insertBatch(1, [sample()]), {
      stored: 1,
      skipped: false,
    });
    assert.strictEqual(store.rowCount(), 2, "the earlier run's rows stay");
  });

  it("refuses a batch before a session is bound", () => {
    assert.throws(() => store.insertBatch(1, [sample()]));
  });
});

describe("an abruptly killed writer", () => {
  it("loses nothing it committed, and the store reopens", () => {
    // The issue's error path: SIGKILL mid-flush, loss bounded to the flush
    // window. A normal close would exercise SQLite's shutdown rather than its
    // recovery, so this kills a real process holding a real WAL.
    const dbPath = join(dir, "kill.sqlite");
    // Driven through the compiled module in a child so the kill lands on a
    // process that really holds the store open.
    const script = `
      import { HotStore } from ${JSON.stringify(
        new URL("../writer/hot-store.js", import.meta.url).href,
      )};
      const store = HotStore.open(${JSON.stringify(dbPath)});
      store.beginSession("s1");
      for (let seq = 1; seq <= 5; seq++) {
        store.insertBatch(seq, [
          { ts: seq, context: "vessels.self", path: "a.b", source: null, kind: "number", value: seq },
        ]);
      }
      process.stdout.write("committed\\n");
      setInterval(() => {}, 1000);
    `;
    const victim = spawn(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        "--input-type=module",
        "-e",
        script,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );

    return new Promise<void>((resolve, reject) => {
      let seen = "";
      victim.stdout.on("data", (chunk: Buffer) => {
        seen += chunk.toString();
        if (!seen.includes("committed")) return;
        victim.kill("SIGKILL");
        victim.on("exit", () => {
          try {
            const reopened = HotStore.open(dbPath);
            try {
              assert.strictEqual(reopened.rowCount(), 5);
              assert.strictEqual(reopened.beginSession("s1"), 5);
            } finally {
              reopened.close();
            }
            resolve();
          } catch (err) {
            reject(err);
          }
        });
      });
      victim.on("error", reject);
    });
  });
});

describe("integrity", () => {
  it("passes SQLite's own integrity check after a batch", () => {
    store.beginSession("s1");
    store.insertBatch(1, [sample(), sample({ kind: "string", value: "x" })]);
    assert.strictEqual(store.integrityCheck(), "ok");
  });
});
