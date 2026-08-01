/**
 * signal-cli daemon lifecycle and supervision.
 *
 * The daemon is a separate GPLv3 process we talk to over JSON-RPC (SPEC.md §10) — its source is
 * never vendored here and no cryptography is reimplemented. This module owns spawning it,
 * restarting it when it dies, and reporting connection state honestly rather than hanging.
 *
 * Pinned to signal-cli 0.14.6 (SPEC.md §11.2 / README).
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { ConnectionState } from '@shared/types';

/**
 * The socket lives in a private 0700 directory rather than directly in a world-readable temp
 * dir: anything that can connect to this socket can send as the user and read their roster.
 *
 * macOS caps UNIX socket paths at ~104 bytes and fails at bind time if exceeded
 * (docs/signal-cli-rpc.md §1), so this deliberately stays short instead of living under
 * Application Support.
 */
export function defaultSocketPath(): string {
  const dir = join(
    tmpdir().startsWith('/var/folders') ? '/tmp' : tmpdir(),
    `aim-${String(process.getuid?.() ?? 0)}`
  );
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  return join(dir, 'signal.sock');
}

export interface DaemonOptions {
  /** Path to the signal-cli executable. */
  binary?: string;
  socketPath: string;
  /** Restart backoff bounds. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

/**
 * Events:
 *   'started'  ()
 *   'exited'   (code: number | null, signal: string | null)
 *   'state'    (state: ConnectionState)
 *   'log'      (line: string)
 */
export class SignalDaemon extends EventEmitter {
  private child: ChildProcess | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private backoffMs: number;
  private stopped = false;
  private state: ConnectionState = 'daemon-down';

  private readonly binary: string;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;
  readonly socketPath: string;

  constructor(options: DaemonOptions) {
    super();
    this.binary = options.binary ?? 'signal-cli';
    this.socketPath = options.socketPath;
    this.minBackoffMs = options.minBackoffMs ?? 500;
    this.maxBackoffMs = options.maxBackoffMs ?? 15_000;
    this.backoffMs = this.minBackoffMs;
  }

  get currentState(): ConnectionState {
    return this.state;
  }

  setState(next: ConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.emit('state', next);
  }

  /**
   * Starts the daemon in **multi-account mode** (no `-a`).
   *
   * This is required, not incidental: `startLink` / `finishLink` return -32601 when the daemon
   * is bound to a single account (docs/signal-cli-rpc.md §3.3), and SPEC.md §12 requires the
   * app to link by QR code itself. Running multi-account throughout avoids maintaining two
   * daemon configurations, at the cost of passing `account` on every account-scoped request.
   *
   * `--receive-mode on-connection` is also required rather than preferred: under the default
   * `on-start` the daemon pulls, decrypts and acknowledges messages with no client attached and
   * never replays them, so anything arriving while we are disconnected is lost permanently.
   */
  start(): void {
    this.stopped = false;
    if (this.child !== null) return;

    // A socket file left behind by a crashed daemon prevents the new one from binding.
    rmSync(this.socketPath, { force: true });

    this.setState('linking');

    const child = spawn(
      this.binary,
      [
        'daemon',
        '--socket',
        this.socketPath,
        '--receive-mode',
        'on-connection',
        '--no-receive-stdout',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    this.child = child;

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    const onLog = (chunk: string): void => {
      for (const line of chunk.split('\n')) {
        if (line.trim() !== '') this.emit('log', line);
      }
    };
    child.stdout?.on('data', onLog);
    child.stderr?.on('data', onLog);

    child.on('spawn', () => {
      this.backoffMs = this.minBackoffMs;
      this.emit('started');
    });

    child.on('error', (error) => {
      // Most commonly ENOENT: signal-cli is not installed or not on PATH.
      this.emit('log', `daemon spawn error: ${error.message}`);
      this.setState('daemon-down');
    });

    child.on('exit', (code, signal) => {
      this.child = null;
      this.setState('daemon-down');
      this.emit('exited', code, signal);
      if (this.stopped) return;

      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.start();
      }, this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    });
  }

  /** Stops supervising and terminates the daemon. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    const child = this.child;
    if (child === null) {
      this.setState('daemon-down');
      return;
    }

    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(force);
        resolve();
      };
      const force = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 5_000);
      child.once('exit', done);
      child.kill('SIGTERM');
    });

    this.child = null;
    rmSync(this.socketPath, { force: true });
    this.setState('daemon-down');
  }
}
