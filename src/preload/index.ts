/**
 * Preload — the only bridge between renderer and main.
 *
 * Runs with contextIsolation ON, nodeIntegration OFF and sandbox ON. Nothing here hands a
 * renderer a raw `ipcRenderer`, a Node builtin, or anything that can reach the network or the
 * filesystem: renderers are pure views (SPEC.md §3). The exposed surface is exactly the
 * channels declared in src/shared/types.ts, plus frameless-window chrome control.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { IpcRendererEvent } from 'electron';

import type { IpcEventChannel, IpcEvents, IpcRequestChannel, IpcRequests } from '@shared/types';

import type { RetroIpcApi, Unsubscribe, WindowControlsApi } from './api';
import { EVENT_CHANNELS, REQUEST_CHANNELS, WINDOW_CONTROL_CHANNELS } from './channels';

const requestChannels: ReadonlySet<string> = new Set<string>(REQUEST_CHANNELS);
const eventChannels: ReadonlySet<string> = new Set<string>(EVENT_CHANNELS);

type AnyListener = (...args: readonly unknown[]) => void;

function invoke<K extends IpcRequestChannel>(
  channel: K,
  ...args: Parameters<IpcRequests[K]>
): Promise<Awaited<ReturnType<IpcRequests[K]>>> {
  if (!requestChannels.has(channel)) {
    return Promise.reject(new Error(`Blocked IPC request on undeclared channel "${channel}"`));
  }
  return ipcRenderer.invoke(channel, ...args) as Promise<Awaited<ReturnType<IpcRequests[K]>>>;
}

function on<K extends IpcEventChannel>(
  channel: K,
  listener: (...args: Parameters<IpcEvents[K]>) => void
): Unsubscribe {
  if (!eventChannels.has(channel)) {
    throw new Error(`Blocked IPC subscription on undeclared channel "${channel}"`);
  }
  // The IpcRendererEvent carries a `sender` — never forward it into the renderer.
  const forward = (_event: IpcRendererEvent, ...args: unknown[]): void => {
    (listener as AnyListener)(...args);
  };
  ipcRenderer.on(channel, forward);
  return () => {
    ipcRenderer.removeListener(channel, forward);
  };
}

const api: RetroIpcApi = { invoke, on };

const windowControls: WindowControlsApi = {
  minimize: () => {
    ipcRenderer.send(WINDOW_CONTROL_CHANNELS.minimize);
  },
  maximize: () => {
    ipcRenderer.send(WINDOW_CONTROL_CHANNELS.maximize);
  },
  close: () => {
    ipcRenderer.send(WINDOW_CONTROL_CHANNELS.close);
  },
  isMaximized: () => ipcRenderer.invoke(WINDOW_CONTROL_CHANNELS.isMaximized) as Promise<boolean>,
  onMaximizedChanged: (listener) => {
    const forward = (_event: IpcRendererEvent, isMaximized: boolean): void => {
      listener(isMaximized);
    };
    ipcRenderer.on(WINDOW_CONTROL_CHANNELS.maximizedChanged, forward);
    return () => {
      ipcRenderer.removeListener(WINDOW_CONTROL_CHANNELS.maximizedChanged, forward);
    };
  },
};

contextBridge.exposeInMainWorld('api', api);
contextBridge.exposeInMainWorld('windowControls', windowControls);
