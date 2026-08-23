import { Socket } from "node:net";
import { FrameDecoder, ProtocolError, encodeFrame } from "./protocol.js";
import type { Message, Sample } from "./protocol.js";
import type { FlushBuffer } from "../flush-buffer.js";

/**
 * The plugin's side of the socket.
 *
 * Follows `signalk-questdb-history-provider/src/ilp-writer.ts`, which learned
 * these rules against a real QuestDB on a real boat. The one that matters most
 * is that `close` is the single source of truth for a connection ending: Node
 * emits it after a failed connect and after a live socket drops, so all
 * backoff, flap accounting and rescheduling live there. A connect-failure path
 * that also reschedules double-counts flaps and runs two timers.
 */

const DEFAULTS = {
  initialReconnectDelayMs: 1000,
  maxReconnectDelayMs: 30_000,
  /**
   * A connection that closes sooner than this never carried useful data. It is
   * counted as a failed attempt so the backoff grows, rather than resetting the
   * delay and reconnecting roughly once a second forever.
   */
  stableConnectionMs: 5000,
  /** After this many instant drops the plugin says so instead of staying green. */
  unhealthyAfterFlaps: 5,
  /**
   * How often the time-based flush is checked. Only the interval trigger needs
   * it: reaching the batch size flushes from `add` directly, so this timer
   * carries a partial batch that has 5000 ms of slack.
   */
  pumpIntervalMs: 1000,
};

export interface WriterClientOptions {
  socketPath: string;
  /** Identifies this run of the plugin to the writer. */
  session: string;
  buffer: FlushBuffer;
  log?: (message: string) => void;
  onUnhealthy?: (message: string) => void;
  onHealthy?: () => void;
  /** Fired once the writer has welcomed this session. */
  onConnected?: () => void;
  now?: () => number;
  timing?: Partial<typeof DEFAULTS>;
}

export interface WriterClientStats {
  connected: boolean;
  /** Batches the writer confirmed. */
  acked: number;
  /** Samples the writer confirmed. */
  stored: number;
  /** Samples the buffer discarded to stay under its ceiling. */
  dropped: number;
  consecutiveFlaps: number;
}

export class WriterClient {
  private readonly options: Required<Omit<WriterClientOptions, "timing">> & {
    timing: typeof DEFAULTS;
  };
  private socket: Socket | null = null;
  private decoder = new FrameDecoder();
  private connected = false;
  private welcomed = false;
  private stopped = true;
  private connectedAt = 0;
  private stableTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pumpTimer: NodeJS.Timeout | null = null;
  private reconnectDelay: number;
  private consecutiveFlaps = 0;
  private unhealthy = false;
  private seq = 0;
  /** The batch on the wire, kept until the writer confirms it. */
  private inFlight: { seq: number; samples: Sample[] } | null = null;
  private acked = 0;
  private stored = 0;

  constructor(options: WriterClientOptions) {
    this.options = {
      socketPath: options.socketPath,
      session: options.session,
      buffer: options.buffer,
      log: options.log ?? (() => {}),
      onUnhealthy: options.onUnhealthy ?? (() => {}),
      onHealthy: options.onHealthy ?? (() => {}),
      onConnected: options.onConnected ?? (() => {}),
      now: options.now ?? (() => Date.now()),
      timing: { ...DEFAULTS, ...options.timing },
    };
    this.reconnectDelay = this.options.timing.initialReconnectDelayMs;
  }

  get stats(): WriterClientStats {
    return {
      connected: this.connected && this.welcomed,
      acked: this.acked,
      stored: this.stored,
      dropped: this.options.buffer.dropped,
      consecutiveFlaps: this.consecutiveFlaps,
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.pumpTimer = setInterval(
      () => this.pump(),
      this.options.timing.pumpIntervalMs,
    );
    this.pumpTimer.unref();
    this.openSocket();
  }

  /** Buffers a sample. Flushes at once if that completed a batch. */
  add(sample: Sample): void {
    const now = this.options.now();
    this.options.buffer.add(sample, now);
    if (this.options.buffer.isDue(now)) this.pump();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimer("pumpTimer");
    this.clearTimer("reconnectTimer");
    this.clearTimer("stableTimer");
    const socket = this.socket;
    this.socket = null;
    if (socket === null) return;
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.destroy();
    });
  }

  private openSocket(): void {
    if (this.stopped || this.socket !== null) return;

    const socket = new Socket();
    this.socket = socket;
    this.decoder = new FrameDecoder();
    this.welcomed = false;

    socket.on("connect", () => {
      this.connected = true;
      this.connectedAt = this.options.now();
      // Deliberately no backoff reset here. Accepting a connection is not
      // proof the connection is usable; only surviving stableConnectionMs is.
      this.startStabilityTimer();
      this.send({ type: "hello", session: this.options.session });
    });

    socket.on("data", (chunk: Buffer) => {
      let messages: Message[];
      try {
        messages = this.decoder.push(chunk);
      } catch (err) {
        this.options.log(
          `dropping the writer connection: ${err instanceof ProtocolError ? err.message : String(err)}`,
        );
        socket.destroy();
        return;
      }
      for (const message of messages) this.receive(message);
    });

    // Logged but not acted on: `close` always follows, and handling both would
    // double-count the flap and schedule two reconnects.
    socket.on("error", (err) => this.options.log(`writer socket: ${err.name}`));

    socket.on("close", () => {
      const wasStable = this.connected && this.stableTimer === null;
      const upForMs = this.connectedAt
        ? this.options.now() - this.connectedAt
        : 0;
      this.connected = false;
      this.welcomed = false;
      this.connectedAt = 0;
      this.clearTimer("stableTimer");
      this.socket = null;
      if (this.stopped) return;

      if (!wasStable) {
        this.consecutiveFlaps++;
        this.reconnectDelay = Math.min(
          this.reconnectDelay * 2,
          this.options.timing.maxReconnectDelayMs,
        );
        this.options.log(
          `writer connection dropped after ${upForMs}ms (flap ${this.consecutiveFlaps}), retrying in ${this.reconnectDelay}ms`,
        );
        if (this.consecutiveFlaps >= this.options.timing.unhealthyAfterFlaps) {
          this.markUnhealthy();
        }
      }
      this.scheduleReconnect();
    });

    socket.connect(this.options.socketPath);
  }

  private receive(message: Message): void {
    switch (message.type) {
      case "welcome": {
        // The writer's counter is authoritative on reconnect: it may have
        // committed a batch whose acknowledgement never arrived.
        this.seq = Math.max(this.seq, message.lastSeq);
        this.settleInFlight(message.lastSeq);
        this.welcomed = true;
        // Reported rather than left for the next status tick: a plugin that
        // says "writer unreachable" for ten seconds after every enable is
        // reporting a problem that lasted milliseconds.
        this.options.onConnected();
        this.pump();
        return;
      }
      case "ack": {
        if (this.inFlight?.seq === message.seq) {
          this.acked++;
          this.stored += message.stored;
          this.inFlight = null;
        }
        this.pump();
        return;
      }
      case "error": {
        this.options.log(`writer refused a batch: ${message.message}`);
        if (this.inFlight !== null && this.inFlight.seq === message.seq) {
          // Back to the buffer rather than discarded: the writer said it did
          // not store this, so losing it here would be loss the plugin chose.
          this.options.buffer.requeue(this.inFlight.samples);
          this.inFlight = null;
        }
        this.markUnhealthy(message.message);
        return;
      }
      default:
        this.options.log(`unexpected ${message.type} from the writer`);
        this.socket?.destroy();
    }
  }

  /**
   * Decides the fate of a batch that was on the wire when the connection ended.
   *
   * The writer's last committed sequence number is what separates the two
   * cases: at or below it, the batch landed and its acknowledgement was simply
   * lost, so resending it would duplicate rows. Above it, the writer never had
   * it, so dropping it would lose them.
   */
  private settleInFlight(writerLastSeq: number): void {
    const pending = this.inFlight;
    if (pending === null) return;
    this.inFlight = null;
    if (pending.seq <= writerLastSeq) {
      this.acked++;
      this.stored += pending.samples.length;
      this.options.log(`batch ${pending.seq} had landed before the drop`);
      return;
    }
    this.options.buffer.requeue(pending.samples);
  }

  private pump(): void {
    if (!this.connected || !this.welcomed || this.inFlight !== null) return;
    const now = this.options.now();
    if (!this.options.buffer.isDue(now)) return;

    const samples = this.options.buffer.take(now);
    if (samples.length === 0) return;
    this.seq++;
    this.inFlight = { seq: this.seq, samples };
    this.send({ type: "batch", seq: this.seq, samples });
  }

  private send(message: Message): void {
    const socket = this.socket;
    if (socket === null || socket.destroyed) return;
    try {
      socket.write(encodeFrame(message));
    } catch (err) {
      // Encoding refuses an oversized frame. Dropping the connection would not
      // help, since the same batch would be retried; the batch goes back to
      // the buffer and the plugin is told.
      this.options.log(
        `could not send to the writer: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (message.type === "batch" && this.inFlight?.seq === message.seq) {
        this.inFlight = null;
      }
    }
  }

  private startStabilityTimer(): void {
    this.clearTimer("stableTimer");
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      this.reconnectDelay = this.options.timing.initialReconnectDelayMs;
      this.consecutiveFlaps = 0;
      if (this.unhealthy) {
        this.unhealthy = false;
        this.options.onHealthy();
      }
    }, this.options.timing.stableConnectionMs);
    this.stableTimer.unref();
  }

  private scheduleReconnect(): void {
    this.clearTimer("reconnectTimer");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, this.reconnectDelay);
    this.reconnectTimer.unref();
  }

  private markUnhealthy(reason?: string): void {
    if (this.unhealthy) return;
    this.unhealthy = true;
    const dropped = this.options.buffer.dropped;
    this.options.onUnhealthy(
      reason ??
        `the writer connection has dropped ${this.consecutiveFlaps} times in a row` +
          (dropped > 0 ? `; ${dropped} samples dropped so far` : ""),
    );
  }

  private clearTimer(
    which: "stableTimer" | "reconnectTimer" | "pumpTimer",
  ): void {
    const timer = this[which];
    if (timer === null) return;
    clearTimeout(timer);
    clearInterval(timer);
    this[which] = null;
  }
}
