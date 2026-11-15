/**
 * JSON-RPC 2.0 client for the signal-cli daemon.
 *
 * Transport is a UNIX socket carrying newline-delimited JSON, one object per line in both
 * directions (docs/signal-cli-rpc.md §1). A UNIX socket rather than TCP is deliberate: the
 * daemon holds full account access, and a localhost port is reachable by every process on the
 * machine while a socket file is gated by filesystem permissions.
 *
 * There is exactly one of these for the whole application (SPEC.md §3). Renderers never see it.
 */

import { Socket } from 'node:net';
import { EventEmitter } from 'node:events';

/** A JSON-RPC error returned by the daemon, preserved with its code. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data: unknown,
    readonly method: string
  ) {
    super(`${method}: ${message} (${String(code)})`);
    this.name = 'RpcError';
  }
}

export class RpcTimeoutError extends Error {
  constructor(method: string, ms: number) {
    super(`${method}: no response after ${String(ms)}ms`);
    this.name = 'RpcTimeoutError';
  }
}

export class RpcNotConnectedError extends Error {
  constructor(method: string) {
    super(`${method}: not connected to the signal-cli daemon`);
    this.name = 'RpcNotConnectedError';
  }
}

interface PendingCall {
  method: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export interface RpcClientOptions {
  socketPath: string;
  /** Per-request timeout. Sends can be slow on a cold connection; 30s is generous but finite. */
  requestTimeoutMs?: number;
  /** Reconnect backoff bounds. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * Events:
 *   'notification' (method: string, params: unknown)  — an inbound JSON-RPC notification
 *   'connected'    ()
 *   'disconnected' (reason: Error | null)
 *   'error'        (error: Error)   — transport/protocol level, never a per-call rejection
 */
export class RpcClient extends EventEmitter {
  private socket: Socket | null = null;
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<string, PendingCall>();
  private backoffMs: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;

  private readonly socketPath: string;
  private readonly requestTimeoutMs: number;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;

  constructor(options: RpcClientOptions) {
    super();
    this.socketPath = options.socketPath;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.minBackoffMs = options.minBackoffMs ?? 250;
    this.maxBackoffMs = options.maxBackoffMs ?? 10_000;
    this.backoffMs = this.minBackoffMs;
  }

  get connected(): boolean {
    return this.socket !== null && !this.socket.destroyed && this.socket.readyState === 'open';
  }

  /**
   * Opens the connection and keeps it open, reconnecting with exponential backoff until
   * `close()` is called. Resolves on the first successful connect.
   */
  connect(): Promise<void> {
    this.closed = false;
    // Already connected, or the reconnect loop already has a socket opening. A second socket
    // here meant a second connection to the daemon: it subscribes each connection to receives
    // separately, so every message arrived twice, and bring-up ran twice in parallel (two QR
    // codes generated, the first immediately superseded).
    if (this.socket !== null && !this.socket.destroyed) {
      if (this.connected) return Promise.resolve();
      const pending = this.socket;
      return new Promise((resolve, reject) => {
        pending.once('connect', () => resolve());
        pending.once('error', reject);
      });
    }
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const onReady = (): void => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const onFail = (error: Error): void => {
        if (!settled) {
          settled = true;
          reject(error);
        }
      };
      this.open(onReady, onFail);
    });
  }

  private open(onReady?: () => void, onFirstFailure?: (error: Error) => void): void {
    if (this.closed) return;

    const socket = new Socket();
    this.socket = socket;
    this.buffer = '';

    socket.setNoDelay(true);
    socket.setEncoding('utf8');

    socket.on('connect', () => {
      this.backoffMs = this.minBackoffMs;
      this.emit('connected');
      onReady?.();
    });

    socket.on('data', (chunk: string) => {
      this.onData(chunk);
    });

    socket.on('error', (error: Error) => {
      // A connection-refused during reconnect is expected while the daemon restarts; surface it
      // but do not treat it as fatal.
      //
      // The listener check is load-bearing: EventEmitter rethrows an 'error' emission that has
      // no listener as an uncaught exception. Emitting unguarded here turns the ordinary ENOENT
      // from the ~1s gap between spawning the daemon and it binding the socket into a crash
      // that takes the app down before any window opens.
      if (this.listenerCount('error') > 0) this.emit('error', error);
      onFirstFailure?.(error);
    });

    socket.on('close', () => {
      this.onDisconnected();
    });

    socket.connect(this.socketPath);
  }

  private onDisconnected(): void {
    const wasConnected = this.socket !== null;
    this.socket = null;

    // Every in-flight call is unanswerable now. Reject rather than leaving callers hanging.
    const error = new Error('signal-cli daemon connection closed');
    for (const [id, call] of this.pending) {
      clearTimeout(call.timer);
      this.pending.delete(id);
      call.reject(error);
    }

    if (wasConnected) this.emit('disconnected', null);
    if (this.closed) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;

    // Newline-delimited framing. A partial trailing line stays in the buffer.
    let newline = this.buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line !== '') this.onLine(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  private onLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit('error', new Error(`unparseable line from daemon: ${line.slice(0, 200)}`));
      return;
    }

    if (Array.isArray(message)) {
      for (const item of message) this.dispatch(item);
      return;
    }
    this.dispatch(message);
  }

  private dispatch(message: unknown): void {
    if (typeof message !== 'object' || message === null) return;
    const record = message as Record<string, unknown>;

    // A notification has a method and no id.
    if (typeof record.method === 'string' && record.id === undefined) {
      this.emit('notification', record.method, record.params);
      return;
    }

    const id = record.id;
    // JSON-RPC allows string or number ids; we only ever send strings. Anything else is not a
    // response to a call of ours.
    if (typeof id !== 'string' && typeof id !== 'number') return;
    const key = String(id);

    const call = this.pending.get(key);
    if (call === undefined) return; // response to a call we already timed out
    clearTimeout(call.timer);
    this.pending.delete(key);

    const error = record.error;
    if (error !== undefined && error !== null) {
      const errorRecord = error as Record<string, unknown>;
      call.reject(
        new RpcError(
          typeof errorRecord.code === 'number' ? errorRecord.code : 0,
          typeof errorRecord.message === 'string' ? errorRecord.message : 'unknown error',
          errorRecord.data,
          call.method
        )
      );
      return;
    }

    call.resolve(record.result);
  }

  /**
   * Invokes a method and resolves with its raw result.
   *
   * `params` must be an object — the daemon rejects arrays with -32600 before dispatch. Note
   * that unknown param names are silently ignored by signal-cli, so a typo is a no-op rather
   * than an error (docs/signal-cli-rpc.md §2); callers should treat param names as exact.
   */
  call(
    method: string,
    params: Record<string, unknown> = {},
    options: { timeoutMs?: number } = {}
  ): Promise<unknown> {
    const socket = this.socket;
    // Most calls answer in milliseconds. A few — `finishLink` above all, which blocks until a
    // human scans a QR code — legitimately take minutes, and the default would fail them.
    const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
    if (socket === null || !this.connected) {
      return Promise.reject(new RpcNotConnectedError(method));
    }

    const id = String(this.nextId++);
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcTimeoutError(method, timeoutMs));
      }, timeoutMs);

      this.pending.set(id, { method, resolve, reject, timer });

      socket.write(`${payload}\n`, (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  /**
   * Drops the current connection and lets the reconnect loop open a fresh one, which re-runs
   * everything listening for 'connected'. Used after linking: the daemon only auto-subscribes
   * a connection to the accounts that existed when it was opened, so a freshly linked account
   * receives nothing until the connection is renewed.
   */
  reconnect(): void {
    if (this.closed) return;
    this.socket?.destroy();
  }

  /** Stops reconnecting and tears the connection down. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.destroy();
    this.socket = null;
  }
}
