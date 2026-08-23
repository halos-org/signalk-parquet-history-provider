import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HotStore } from "../writer/hot-store.js";
import {
  StoreLockedError,
  WriterServer,
  acquireStoreLock,
} from "../writer/server.js";
import { FrameDecoder, encodeFrame } from "../writer/protocol.js";
import type { Message, Sample } from "../writer/protocol.js";

function sample(over: Partial<Sample> = {}): Sample {
  return {
    ts: 1_700_000_000_000,
    context: "self",
    path: "environment.depth.belowKeel",
    source: "n2k.0",
    kind: "number",
    value: 4.2,
    ...over,
  } as Sample;
}

let dir: string;
let store: HotStore;
let server: WriterServer | null;
let socketPath: string;
const openSockets: Socket[] = [];

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "writer-server-"));
  socketPath = join(dir, "run", "writer.sock");
  store = HotStore.open(join(dir, "hot.sqlite"));
  server = await WriterServer.listen({ socketPath, store });
});

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.destroy();
  await server?.close();
  server = null;
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A client that collects decoded messages as they arrive. */
function client(): { socket: Socket; messages: Message[] } {
  const decoder = new FrameDecoder();
  const messages: Message[] = [];
  const socket = connect(socketPath);
  socket.on("data", (chunk: Buffer) => messages.push(...decoder.push(chunk)));
  openSockets.push(socket);
  return { socket, messages };
}

/** Resolves once `messages` holds at least `count`, or rejects on timeout. */
function until(messages: Message[], count: number): Promise<Message[]> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const poll = setInterval(() => {
      if (messages.length >= count) {
        clearInterval(poll);
        resolve(messages);
      } else if (Date.now() > deadline) {
        clearInterval(poll);
        reject(new Error(`only ${messages.length} of ${count} messages`));
      }
    }, 5);
  });
}

describe("the socket is reachable only by its owner", () => {
  it("puts the socket in a directory nobody else may enter", () => {
    // The directory is what actually gates access: reaching a socket needs
    // execute permission on the directory holding it, checked before the
    // socket's own mode. Both are set because either alone is one mistake from
    // being world-reachable.
    assert.strictEqual(statSync(join(dir, "run")).mode & 0o777, 0o700);
    assert.strictEqual(statSync(socketPath).mode & 0o777, 0o600);
  });

  it("is a socket, not a TCP port", () => {
    assert.ok(statSync(socketPath).isSocket());
  });
});

describe("the store is held against a second writer", () => {
  it("refuses to start when a live process holds the lock", () => {
    const lockPath = join(dir, "writer.lock");
    const release = acquireStoreLock(lockPath);
    try {
      assert.throws(() => acquireStoreLock(lockPath), StoreLockedError);
      assert.throws(
        () => acquireStoreLock(lockPath),
        /already held by writer process \d+/,
      );
    } finally {
      release();
    }
  });

  it("reclaims a lock left behind by a writer that died", () => {
    // A pid that has certainly exited: spawned, waited for, and reaped.
    const gone = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    assert.notStrictEqual(gone.pid, undefined);
    const lockPath = join(dir, "writer.lock");
    writeFileSync(lockPath, `${gone.pid}\n`);

    const release = acquireStoreLock(lockPath);
    release();
  });

  it("reclaims a lock whose contents make no sense", () => {
    // Refusing on an unreadable lock would wedge the writer permanently on a
    // file truncated by a power cut.
    const lockPath = join(dir, "writer.lock");
    writeFileSync(lockPath, "");
    acquireStoreLock(lockPath)();

    writeFileSync(lockPath, "not-a-pid\n");
    acquireStoreLock(lockPath)();
  });

  it("releases the lock so the next writer can take it", () => {
    const lockPath = join(dir, "writer.lock");
    acquireStoreLock(lockPath)();
    acquireStoreLock(lockPath)();
  });
});

describe("the handshake", () => {
  it("welcomes a new session at sequence zero", async () => {
    const { socket, messages } = client();
    socket.write(encodeFrame({ type: "hello", session: "s1" }));

    assert.deepStrictEqual((await until(messages, 1))[0], {
      type: "welcome",
      session: "s1",
      lastSeq: 0,
    });
  });

  it("welcomes a returning session at what it committed", async () => {
    const first = client();
    first.socket.write(encodeFrame({ type: "hello", session: "s1" }));
    await until(first.messages, 1);
    first.socket.write(
      encodeFrame({ type: "batch", seq: 9, samples: [sample()] }),
    );
    await until(first.messages, 2);
    first.socket.destroy();

    const second = client();
    second.socket.write(encodeFrame({ type: "hello", session: "s1" }));
    assert.deepStrictEqual((await until(second.messages, 1))[0], {
      type: "welcome",
      session: "s1",
      lastSeq: 9,
    });
  });

  it("refuses a batch that arrives before a hello", async () => {
    // Otherwise the batch is written against whatever session the store last
    // saw, which after a plugin restart is the previous run's.
    const { socket, messages } = client();
    socket.write(encodeFrame({ type: "batch", seq: 1, samples: [sample()] }));

    const [reply] = await until(messages, 1);
    assert.strictEqual(reply.type, "error");
    assert.strictEqual(store.rowCount(), 0);
  });
});

describe("batches", () => {
  async function greeted() {
    const c = client();
    c.socket.write(encodeFrame({ type: "hello", session: "s1" }));
    await until(c.messages, 1);
    return c;
  }

  it("acknowledges what it stored", async () => {
    const { socket, messages } = await greeted();
    socket.write(
      encodeFrame({
        type: "batch",
        seq: 1,
        samples: [sample(), sample(), sample()],
      }),
    );

    assert.deepStrictEqual((await until(messages, 2))[1], {
      type: "ack",
      seq: 1,
      stored: 3,
    });
    assert.strictEqual(store.rowCount(), 3);
  });

  it("acknowledges a resend without storing it twice", async () => {
    const { socket, messages } = await greeted();
    const batch: Message = { type: "batch", seq: 1, samples: [sample()] };

    socket.write(encodeFrame(batch));
    await until(messages, 2);
    socket.write(encodeFrame(batch));

    assert.deepStrictEqual((await until(messages, 3))[2], {
      type: "ack",
      seq: 1,
      stored: 0,
    });
    assert.strictEqual(store.rowCount(), 1);
  });
});

describe("a frame it cannot trust ends the connection", () => {
  it("drops the connection on a malformed frame and stays up for the next one", async () => {
    const lines: string[] = [];
    await server?.close();
    server = await WriterServer.listen({
      socketPath,
      store,
      log: (line) => lines.push(line),
    });

    const bad = client();
    const body = Buffer.from("{not json", "utf8");
    const header = Buffer.alloc(4);
    header.writeUInt32BE(body.length, 0);
    bad.socket.write(Buffer.concat([header, body]));

    await new Promise<void>((resolve) =>
      bad.socket.on("close", () => resolve()),
    );
    assert.ok(
      lines.some((line) => line.includes("dropping the connection")),
      `expected a log line about the drop, got ${JSON.stringify(lines)}`,
    );

    // The writer itself survives: a new client is served normally.
    const good = client();
    good.socket.write(encodeFrame({ type: "hello", session: "s2" }));
    assert.strictEqual((await until(good.messages, 1))[0].type, "welcome");
  });

  it("never writes a recorded value into the log", async () => {
    // These lines reach the Signal K log and ship in support bundles. A
    // position or a tank level is the boat's, not the log's.
    const lines: string[] = [];
    await server?.close();
    server = await WriterServer.listen({
      socketPath,
      store,
      log: (line) => lines.push(line),
    });

    const c = client();
    c.socket.write(encodeFrame({ type: "hello", session: "s1" }));
    await until(c.messages, 1);

    // Closing the store makes the insert throw with the batch in hand, which
    // is the moment the server has both a failure to report and a sample to
    // leak. A malformed frame would not do: the decoder rejects it before the
    // server ever sees a value.
    store.close();
    const marker = "60.1667,24.9433";
    c.socket.write(
      encodeFrame({
        type: "batch",
        seq: 1,
        samples: [sample({ kind: "string", value: marker })],
      }),
    );

    // The failure path really ran -- without this the assertion below passes
    // on an empty log.
    const [, reply] = await until(c.messages, 2);
    assert.strictEqual(reply.type, "error");
    assert.ok(
      lines.some((line) => line.includes("batch 1 of 1 samples failed")),
      `expected the failure to be logged, got ${JSON.stringify(lines)}`,
    );
    for (const line of lines) {
      assert.ok(
        !line.includes(marker),
        `a recorded value reached the log: ${line}`,
      );
    }
    assert.ok(
      !JSON.stringify(reply).includes(marker),
      "a recorded value reached the error reply",
    );

    // Reopened so afterEach's close has something to close.
    store = HotStore.open(join(dir, "hot.sqlite"));
  });
});
