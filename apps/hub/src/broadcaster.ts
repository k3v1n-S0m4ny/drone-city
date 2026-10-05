import type { ServerMsg, Session, SessionEvent } from "@drone-city/model";
import type { Changes } from "./store.ts";

/** The slice of a `ws` WebSocket the broadcaster needs (lets tests use a fake). */
export interface Socket {
  readyState: number;
  readonly bufferedAmount: number;
  send(data: string): void;
  terminate(): void;
}

const OPEN = 1;
/** Max events per `events` frame. */
const MAX_EVENTS_PER_FRAME = 500;
/** A client this far behind in the socket buffer is dropped outright. */
const HARD_LIMIT_FACTOR = 16;

export interface BroadcasterOptions {
  coalesceMs: number;
  maxQueued: number;
  highWaterBytes: number;
  /** Builds a fresh snapshot frame (used on connect and on resync). */
  snapshot: () => ServerMsg;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

interface ClientState {
  socket: Socket;
  events: SessionEvent[];
  upserts: Map<string, Session>;
  removes: Set<string>;
  needsSnapshot: boolean;
  timer: unknown;
}

export interface BroadcasterStats {
  clients: number;
  resyncs: number;
  terminated: number;
  framesSent: number;
}

/**
 * Per-client coalescing fan-out. Changes queue up per client and flush at most every
 * `coalesceMs`. A client whose queue exceeds `maxQueued`, or whose socket buffer is above
 * `highWaterBytes`, has its queue dropped and receives a fresh snapshot once it drains.
 */
export class Broadcaster {
  private readonly clients = new Set<ClientState>();
  readonly stats: BroadcasterStats = { clients: 0, resyncs: 0, terminated: 0, framesSent: 0 };
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;

  private readonly opts: BroadcasterOptions;

  constructor(opts: BroadcasterOptions) {
    this.opts = opts;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  }

  get size(): number {
    return this.clients.size;
  }

  /** Register a socket and send the snapshot immediately. Returns a detach function. */
  add(socket: Socket): () => void {
    const c: ClientState = {
      socket,
      events: [],
      upserts: new Map(),
      removes: new Set(),
      needsSnapshot: false,
      timer: null,
    };
    this.clients.add(c);
    this.stats.clients = this.clients.size;
    this.send(c, this.opts.snapshot());
    return () => this.remove(c);
  }

  /** Re-send a fresh snapshot to a client (e.g. when it says hello). */
  resync(socket: Socket): void {
    for (const c of this.clients) {
      if (c.socket === socket) {
        this.dropQueue(c);
        c.needsSnapshot = true;
        this.schedule(c);
      }
    }
  }

  publish(changes: Pick<Changes, "events" | "upserts" | "removes">): void {
    if (changes.events.length + changes.upserts.length + changes.removes.length === 0) return;
    for (const c of this.clients) {
      if (!c.needsSnapshot) {
        c.events.push(...changes.events);
        for (const s of changes.upserts) {
          c.removes.delete(s.id);
          c.upserts.set(s.id, s);
        }
        for (const id of changes.removes) {
          c.upserts.delete(id);
          c.removes.add(id);
        }
        if (c.events.length + c.upserts.size + c.removes.size > this.opts.maxQueued) {
          this.dropQueue(c);
          c.needsSnapshot = true;
          this.stats.resyncs++;
        }
      }
      this.schedule(c);
    }
  }

  close(): void {
    for (const c of this.clients) this.clearTimerOf(c);
    this.clients.clear();
    this.stats.clients = 0;
  }

  private remove(c: ClientState): void {
    this.clearTimerOf(c);
    this.clients.delete(c);
    this.stats.clients = this.clients.size;
  }

  private dropQueue(c: ClientState): void {
    c.events = [];
    c.upserts.clear();
    c.removes.clear();
  }

  private clearTimerOf(c: ClientState): void {
    if (c.timer !== null) this.clearTimer(c.timer);
    c.timer = null;
  }

  private schedule(c: ClientState): void {
    if (c.timer !== null) return;
    c.timer = this.setTimer(() => {
      c.timer = null;
      this.flush(c);
    }, this.opts.coalesceMs);
  }

  private send(c: ClientState, msg: ServerMsg): void {
    if (c.socket.readyState !== OPEN) return;
    c.socket.send(JSON.stringify(msg));
    this.stats.framesSent++;
  }

  private flush(c: ClientState): void {
    if (c.socket.readyState !== OPEN) {
      this.remove(c);
      return;
    }
    const buffered = c.socket.bufferedAmount;
    if (buffered > this.opts.highWaterBytes * HARD_LIMIT_FACTOR) {
      this.stats.terminated++;
      this.remove(c);
      c.socket.terminate();
      return;
    }
    if (buffered > this.opts.highWaterBytes) {
      // Slow client: do not pile more onto its socket. Drop what is queued, resync when drained.
      if (!c.needsSnapshot) this.stats.resyncs++;
      this.dropQueue(c);
      c.needsSnapshot = true;
      this.schedule(c);
      return;
    }
    if (c.needsSnapshot) {
      c.needsSnapshot = false;
      this.dropQueue(c);
      this.send(c, this.opts.snapshot());
      return;
    }
    for (let i = 0; i < c.events.length; i += MAX_EVENTS_PER_FRAME) {
      this.send(c, { v: 1, type: "events", events: c.events.slice(i, i + MAX_EVENTS_PER_FRAME) });
    }
    for (const session of c.upserts.values()) this.send(c, { v: 1, type: "session", session });
    for (const sessionId of c.removes) this.send(c, { v: 1, type: "remove", sessionId });
    this.dropQueue(c);
  }
}
