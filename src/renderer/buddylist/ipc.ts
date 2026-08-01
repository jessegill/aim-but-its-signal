/**
 * The renderer's only door to the outside world (SPEC.md §3).
 *
 * Everything here goes through the `window.api` / `window.windowControls` bridge the preload
 * installs. No fetch, no sockets, no Node, no Electron import — those are all blocked by the
 * build-time guard in electron.vite.config.ts, and rightly so.
 *
 * Two failure modes are handled deliberately rather than left to crash the window:
 *
 *   1. The bridge is missing entirely (preload failed to load, or the HTML was opened
 *      directly). `window.api` is typed as always-present, so it is read defensively here.
 *   2. The main process has not registered a handler for a channel yet. `ipcRenderer.invoke`
 *      rejects in that case rather than hanging, so every call is wrapped and the failure is
 *      surfaced in the UI instead of vanishing into an unhandled rejection.
 */

import * as React from 'react';

import type { IpcEventChannel, IpcEvents, IpcRequestChannel, IpcRequests } from '@shared/types';

type Bridge = Window['api'] | undefined;
type Controls = Window['windowControls'] | undefined;

const bridge = (): Bridge => (window as { api?: Window['api'] }).api;
const controls = (): Controls =>
  (window as { windowControls?: Window['windowControls'] }).windowControls;

export const BRIDGE_MISSING =
  'The IPC bridge is not available in this window, so nothing can load. This window cannot ' +
  'reach the network by design — everything comes from the main process.';

/** True when the preload bridge is present. */
export function hasBridge(): boolean {
  return bridge() !== undefined;
}

/** renderer → main. Rejects if the bridge or the handler is missing; callers must catch. */
export async function invoke<K extends IpcRequestChannel>(
  channel: K,
  ...args: Parameters<IpcRequests[K]>
): Promise<Awaited<ReturnType<IpcRequests[K]>>> {
  const api = bridge();
  if (api === undefined) throw new Error(BRIDGE_MISSING);
  return await api.invoke(channel, ...args);
}

/**
 * Human-readable failure text for the UI. Electron's "No handler registered for 'x'" is the
 * expected message while the main-process side of a channel is still being written, so it is
 * translated rather than shown raw.
 */
export function describeFailure(channel: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.includes('No handler registered')) {
    return `“${channel}” is not handled by the main process yet.`;
  }
  return `${channel} failed: ${raw.replace(/^Error invoking remote method '.*?':\s*/, '')}`;
}

/**
 * main → renderer, pushed. Subscribes for the lifetime of the component and always
 * unsubscribes — an IM window can be closed at any moment (SPEC.md §3).
 *
 * The listener is held in a ref so a caller can pass an inline closure without resubscribing
 * on every render.
 */
export function useIpcEvent<K extends IpcEventChannel>(
  channel: K,
  listener: (...args: Parameters<IpcEvents[K]>) => void
): void {
  const ref = React.useRef(listener);
  ref.current = listener;

  React.useEffect(() => {
    const api = bridge();
    if (api === undefined) return undefined;
    return api.on(channel, (...args: Parameters<IpcEvents[K]>) => {
      ref.current(...args);
    });
  }, [channel]);
}

/**
 * Frameless-window chrome. Every window is `frame: false`, so the UI library's TitleBar
 * buttons are the only minimize / maximize / close controls that exist (SPEC.md §9).
 */
export const windowChrome = {
  minimize: (): void => controls()?.minimize(),
  maximize: (): void => controls()?.maximize(),
  close: (): void => controls()?.close(),
};
