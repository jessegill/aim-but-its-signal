/**
 * Preload — the only bridge between renderer and main.
 *
 * Runs with contextIsolation ON, nodeIntegration OFF and sandbox ON. Nothing here hands a
 * renderer a raw `ipcRenderer`, a Node builtin, or anything that can reach the network or the
 * filesystem: renderers are pure views (SPEC.md §3). The exposed surface is exactly the
 * channels declared in src/shared/types.ts, plus frameless-window chrome control.
 */

import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { IpcRendererEvent } from 'electron';

import { MAX_ATTACHMENT_BYTES } from '@shared/types';
import type {
  IpcEventChannel,
  IpcEvents,
  IpcRequestChannel,
  IpcRequests,
  StagedFileResult,
} from '@shared/types';

import type { FilesApi, RetroIpcApi, Unsubscribe, WindowControlsApi } from './api';
import {
  EVENT_CHANNELS,
  PRELOAD_CHANNELS,
  REQUEST_CHANNELS,
  WINDOW_CONTROL_CHANNELS,
} from './channels';

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

const files: FilesApi = {
  stage: async (file: File): Promise<StagedFileResult> => {
    if (!(file instanceof File)) {
      return { rejected: { name: 'file', reason: 'not a file' } };
    }
    // A real file on disk (dragged from Finder, or copied there and pasted): referenced in
    // place, exactly as the picker does. The path comes from the browser, not the renderer.
    const path = webUtils.getPathForFile(file);
    if (path !== '') {
      return (await ipcRenderer.invoke(PRELOAD_CHANNELS.vendDropped, path)) as StagedFileResult;
    }
    // No file behind it — a screenshot or image copied from another app. Main writes it out.
    if (file.size > MAX_ATTACHMENT_BYTES) {
      return {
        rejected: { name: file.name || 'image', reason: 'larger than the 100 MB Signal allows' },
      };
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    return (await ipcRenderer.invoke(PRELOAD_CHANNELS.stageBytes, {
      name: file.name,
      type: file.type,
      bytes,
    })) as StagedFileResult;
  },
};

contextBridge.exposeInMainWorld('api', api);
contextBridge.exposeInMainWorld('files', files);
contextBridge.exposeInMainWorld('windowControls', windowControls);
