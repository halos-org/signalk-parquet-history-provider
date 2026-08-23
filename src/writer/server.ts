import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { createServer } from "node:net";
import type { Server, Socket } from "node:net";
import { dirname } from "node:path";
import { FrameDecoder, ProtocolError, encodeFrame } from "./protocol.js";
import type { Message } from "./protocol.js";
import type { HotStore } from "./hot-store.js";

/**
 * The writer's side of the socket.
 *
 * Two things here exist to stop something rather than to do something: the
 * store is held under an explicit lock so a second writer cannot interleave
 * rows into it, and the socket sits in a directory only its owner can enter so
 * no other account on the device can send it frames.
 */

/** Raised when another writer already owns the hot store. */
export class StoreLockedError extends Error {
  constructor(readonly holderPid: number) {
    super(
      `the hot store is already held by writer process ${holderPid}; refusing to open a second writer`,
    );
    this.name = "StoreLockedError";
  }
}

/**
 * Takes an exclusive claim on the hot store.
 *
 * SQLite will not do this for us. Two processes can both open the same file
 * and both write to it — it takes per-transaction file locks, not per-handle
 * ones — so a second writer would silently interleave its rows and its
 * sequence numbers with the first's. `PRAGMA locking_mode = EXCLUSIVE` would
 * stop that and is not available here: it also blocks readers, and the roll
 * reading the store while the writer holds it is the reason the store is
 * SQLite in the first place.
 *
 * So the claim is a separate lock file. A lock left behind by a writer that
 * died is reclaimed; a lock whose process is still alive is refused, loudly,
 * because a writer that appears to start and then records nothing is the
 * failure this exists to prevent.
 */
export function acquireStoreLock(lockPath: string): () => void {
  // Two passes at most: the first may find a lock left by a dead writer, which
  // this removes; a second EEXIST after that means someone else won the race,
  // and racing them again would loop.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeSync(fd, `${process.pid}\n`);
      } finally {
        closeSync(fd);
      }
      return () => rmSync(lockPath, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const holder = readHolderPid(lockPath);
      if (holder !== null && isProcessAlive(holder)) {
        throw new StoreLockedError(holder);
      }
      rmSync(lockPath, { force: true });
    }
  }
  throw new Error(`could not take the hot store lock at ${lockPath}`);
}

function readHolderPid(lockPath: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(lockPath, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    // Unreadable or already gone: treat it as reclaimable rather than as a
    // live holder, since refusing on an unreadable lock would wedge the writer
    // permanently on a truncated file.
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists and belongs to another user, which is
    // still a live holder. Only ESRCH means nobody is there.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface WriterServerOptions {
  socketPath: string;
  store: HotStore;
  /** Counts, path names and error classes only — never a recorded value. */
  log?: (message: string) => void;
}

export class WriterServer {
  private readonly server: Server;
  private readonly store: HotStore;
  private readonly log: (message: string) => void;
  private readonly sockets = new Set<Socket>();

  private constructor(server: Server, options: WriterServerOptions) {
    this.server = server;
    this.store = options.store;
    this.log = options.log ?? (() => {});
  }

  static listen(options: WriterServerOptions): Promise<WriterServer> {
    const { socketPath } = options;

    // A Unix domain socket, never a TCP port — not even on loopback, which is
    // shared with every local process and every container in the namespace.
    // The directory is the real gate: on Linux, reaching a socket requires
    // execute permission on the directory holding it, and that check happens
    // before the socket's own mode. Node exposes no way to read peer
    // credentials (SO_PEERCRED) without a native addon, which this package
    // exists to avoid, so filesystem permission is the enforcement.
    mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
    chmodSync(dirname(socketPath), 0o700);
    // Safe because the caller holds the store lock: any socket file still here
    // was left by a writer that is gone.
    rmSync(socketPath, { force: true });

    const server = createServer();
    const instance = new WriterServer(server, options);
    server.on("connection", (socket) => instance.handle(socket));

    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.removeListener("error", reject);
        chmodSync(socketPath, 0o600);
        resolve(instance);
      });
    });
  }

  get connectionCount(): number {
    return this.sockets.size;
  }

  private handle(socket: Socket): void {
    // One decoder per connection: it holds the tail of a partial frame, so
    // sharing one would splice two streams together.
    const decoder = new FrameDecoder();
    let session: string | null = null;
    this.sockets.add(socket);

    socket.on("data", (chunk: Buffer) => {
      let messages: Message[];
      try {
        messages = decoder.push(chunk);
      } catch (err) {
        // There is no resynchronisation point in a length-prefixed stream once
        // the length is in doubt, so the connection ends here.
        this.log(
          `dropping the connection: ${err instanceof ProtocolError ? err.message : String(err)}`,
        );
        socket.destroy();
        return;
      }
      for (const message of messages) {
        session = this.dispatch(socket, message, session);
      }
    });

    socket.on("error", (err) => {
      this.log(`connection error: ${err.name}`);
      socket.destroy();
    });
    socket.on("close", () => this.sockets.delete(socket));
  }

  private dispatch(
    socket: Socket,
    message: Message,
    session: string | null,
  ): string | null {
    switch (message.type) {
      case "hello": {
        const lastSeq = this.store.beginSession(message.session);
        this.send(socket, {
          type: "welcome",
          session: message.session,
          lastSeq,
        });
        this.log(`session ${message.session} resumed at seq ${lastSeq}`);
        return message.session;
      }
      case "batch": {
        if (session === null) {
          this.send(socket, {
            type: "error",
            seq: message.seq,
            message: "batch before hello",
          });
          return session;
        }
        try {
          const result = this.store.insertBatch(message.seq, message.samples);
          this.send(socket, {
            type: "ack",
            seq: message.seq,
            stored: result.stored,
          });
        } catch (err) {
          // The error class and the batch's size, never a sample's value: this
          // line goes to the Signal K log, which ships in support bundles.
          const name = err instanceof Error ? err.name : "Error";
          this.log(
            `batch ${message.seq} of ${message.samples.length} samples failed: ${name}`,
          );
          this.send(socket, {
            type: "error",
            seq: message.seq,
            message: `writing the batch failed: ${name}`,
          });
        }
        return session;
      }
      default:
        // welcome, ack and error travel the other way. Receiving one means the
        // peer is not a plugin.
        this.log(`unexpected ${message.type} from the client`);
        socket.destroy();
        return session;
    }
  }

  private send(socket: Socket, message: Message): void {
    if (socket.destroyed) return;
    socket.write(encodeFrame(message));
  }

  close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
