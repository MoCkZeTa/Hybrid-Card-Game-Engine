/**
 * The message bus every backend instance talks over.
 *
 * Two shapes of traffic ride on it:
 *
 *  - **Fan-out** (`publish` / `subscribe`) — "here is the new state of match X",
 *    sent to every node so each can push it down its own sockets.
 *  - **Request/reply** (`request` / `handleRequests`) — "you own match X, please
 *    apply this move and tell me whether it worked". Correlation IDs ride in the
 *    payload and replies come back on a channel private to the asking node.
 *
 * `LocalEventBus` is a faithful in-process implementation used when Redis is
 * not configured and in tests — two `LocalEventBus` instances sharing one
 * `LocalBusBackplane` exercise the exact same routing code paths that Redis
 * would, which is how the cluster logic is tested without a server.
 */

import { randomUUID } from 'node:crypto';
import type { RedisBundle } from '../redis/redis-client.js';

export type BusHandler = (payload: unknown, channel: string) => void;

export interface EventBus {
  /** Fire-and-forget broadcast to every subscriber of `channel`, on every node. */
  publish(channel: string, payload: unknown): Promise<void>;
  /** Registers `handler` for `channel`. Returns an unsubscribe function. */
  subscribe(channel: string, handler: BusHandler): Promise<() => void>;
  /**
   * Sends `payload` to exactly one node — the one that registered
   * `handleRequests` for `targetChannel` — and resolves with its reply.
   * Rejects on timeout, and rejects with the remote error if the handler threw.
   */
  request<T>(targetChannel: string, payload: unknown, timeoutMs: number): Promise<T>;
  /** Serves `request` calls aimed at `channel`. Returns an unsubscribe function. */
  handleRequests(channel: string, handler: (payload: unknown) => Promise<unknown>): Promise<() => void>;
  close(): Promise<void>;
}

export class RequestTimeoutError extends Error {
  constructor(channel: string, timeoutMs: number) {
    super(`No reply from "${channel}" within ${timeoutMs}ms`);
    this.name = 'RequestTimeoutError';
  }
}

/** Errors thrown by a remote handler are rebuilt on this side so `instanceof Error` still holds. */
export class RemoteError extends Error {
  constructor(
    message: string,
    /** The remote error's `name`, so callers can branch on the original class. */
    public readonly remoteName: string,
  ) {
    super(message);
    this.name = 'RemoteError';
  }
}

interface Envelope {
  readonly id: string;
  readonly replyTo: string;
  readonly payload: unknown;
}

interface Reply {
  readonly id: string;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { readonly name: string; readonly message: string };
}

function isEnvelope(v: unknown): v is Envelope {
  return typeof v === 'object' && v !== null && 'id' in v && 'replyTo' in v;
}

function isReply(v: unknown): v is Reply {
  return typeof v === 'object' && v !== null && 'id' in v && 'ok' in v;
}

/**
 * Shared request/reply plumbing. Both implementations only have to provide raw
 * publish/subscribe; the correlation-ID dance is identical either way.
 */
abstract class BaseEventBus implements EventBus {
  private readonly pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private replyUnsubscribe: (() => void) | null = null;
  private replyReady: Promise<void> | null = null;

  /** Unique per bus instance — the private inbox replies come back on. */
  protected readonly replyChannel = `reply:${randomUUID()}`;

  abstract publish(channel: string, payload: unknown): Promise<void>;
  abstract subscribe(channel: string, handler: BusHandler): Promise<() => void>;

  private ensureReplyInbox(): Promise<void> {
    this.replyReady ??= this.subscribe(this.replyChannel, (payload) => {
      if (!isReply(payload)) return;
      const waiter = this.pending.get(payload.id);
      if (!waiter) return; // already timed out — drop the late reply
      this.pending.delete(payload.id);
      clearTimeout(waiter.timer);
      if (payload.ok) waiter.resolve(payload.value);
      else waiter.reject(new RemoteError(payload.error?.message ?? 'Remote handler failed', payload.error?.name ?? 'Error'));
    }).then((unsub) => {
      this.replyUnsubscribe = unsub;
    });
    return this.replyReady;
  }

  async request<T>(targetChannel: string, payload: unknown, timeoutMs: number): Promise<T> {
    await this.ensureReplyInbox();
    const id = randomUUID();

    const result = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RequestTimeoutError(targetChannel, timeoutMs));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    });

    const envelope: Envelope = { id, replyTo: this.replyChannel, payload };
    await this.publish(targetChannel, envelope);
    return result;
  }

  async handleRequests(channel: string, handler: (payload: unknown) => Promise<unknown>): Promise<() => void> {
    return this.subscribe(channel, (raw) => {
      if (!isEnvelope(raw)) return;
      const { id, replyTo, payload } = raw;
      void handler(payload)
        .then((value) => this.publish(replyTo, { id, ok: true, value } satisfies Reply))
        .catch((err: unknown) => {
          const e = err instanceof Error ? err : new Error(String(err));
          return this.publish(replyTo, {
            id,
            ok: false,
            error: { name: e.name, message: e.message },
          } satisfies Reply);
        })
        // A failed reply publish means the asker will hit its own timeout,
        // which is the correct outcome — just don't lose the reason.
        .catch((err: unknown) => console.error(`[bus] failed to deliver reply on "${replyTo}":`, err));
    });
  }

  async close(): Promise<void> {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Event bus closed'));
    }
    this.pending.clear();
    this.replyUnsubscribe?.();
    this.replyUnsubscribe = null;
    this.replyReady = null;
  }
}

// ---- In-process ------------------------------------------------------------

/**
 * The wiring two `LocalEventBus` instances share to behave like two nodes on
 * one Redis. A single-node server just gets its own private backplane.
 */
export class LocalBusBackplane {
  private readonly handlers = new Map<string, Set<BusHandler>>();

  add(channel: string, handler: BusHandler): () => void {
    let set = this.handlers.get(channel);
    if (!set) {
      set = new Set();
      this.handlers.set(channel, set);
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
      if (set!.size === 0) this.handlers.delete(channel);
    };
  }

  emit(channel: string, payload: unknown): void {
    const set = this.handlers.get(channel);
    if (!set) return;
    // Round-trip through JSON so a local bus cannot accidentally hand out a
    // live object reference that Redis would have copied — otherwise a bug
    // that only bites in the clustered build passes locally.
    const copy = JSON.parse(JSON.stringify(payload)) as unknown;
    // Snapshot: a handler may unsubscribe itself while we iterate.
    for (const handler of [...set]) {
      try {
        handler(copy, channel);
      } catch (err) {
        console.error(`[bus] handler for "${channel}" threw:`, err);
      }
    }
  }
}

export class LocalEventBus extends BaseEventBus {
  constructor(private readonly backplane: LocalBusBackplane = new LocalBusBackplane()) {
    super();
  }

  async publish(channel: string, payload: unknown): Promise<void> {
    // Defer so publish is asynchronous like the Redis one — a handler that
    // publishes back must not re-enter synchronously.
    queueMicrotask(() => this.backplane.emit(channel, payload));
  }

  async subscribe(channel: string, handler: BusHandler): Promise<() => void> {
    return this.backplane.add(channel, handler);
  }
}

// ---- Redis -----------------------------------------------------------------

export class RedisEventBus extends BaseEventBus {
  private readonly handlers = new Map<string, Set<BusHandler>>();
  private readonly prefix: string;
  private wired = false;

  constructor(private readonly redis: RedisBundle) {
    super();
    this.prefix = `${redis.keyPrefix}:bus:`;

    this.redis.subscriber.on('message', (channel: string, raw: string) => {
      const set = this.handlers.get(channel);
      if (!set) return;
      let payload: unknown;
      try {
        payload = JSON.parse(raw);
      } catch {
        console.error(`[bus] dropped unparseable message on "${channel}"`);
        return;
      }
      const local = channel.slice(this.prefix.length);
      for (const handler of [...set]) {
        try {
          handler(payload, local);
        } catch (err) {
          console.error(`[bus] handler for "${local}" threw:`, err);
        }
      }
    });

    // After a reconnect ioredis replays subscriptions itself, but only for
    // channels it still knows about — re-asserting is cheap insurance.
    this.redis.subscriber.on('ready', () => {
      if (!this.wired || this.handlers.size === 0) return;
      void this.redis.subscriber.subscribe(...this.handlers.keys()).catch((err: unknown) => {
        console.error('[bus] failed to restore subscriptions after reconnect:', err);
      });
    });
    this.wired = true;
  }

  async publish(channel: string, payload: unknown): Promise<void> {
    await this.redis.publisher.publish(this.prefix + channel, JSON.stringify(payload));
  }

  async subscribe(channel: string, handler: BusHandler): Promise<() => void> {
    const full = this.prefix + channel;
    let set = this.handlers.get(full);
    if (!set) {
      set = new Set();
      this.handlers.set(full, set);
      await this.redis.subscriber.subscribe(full);
    }
    set.add(handler);

    return () => {
      set!.delete(handler);
      if (set!.size === 0) {
        this.handlers.delete(full);
        void this.redis.subscriber.unsubscribe(full).catch(() => {
          /* unsubscribing a dead socket is not worth reporting */
        });
      }
    };
  }

  override async close(): Promise<void> {
    await super.close();
    this.handlers.clear();
  }
}
