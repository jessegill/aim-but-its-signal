import type {
  IpcEventChannel,
  IpcEvents,
  IpcRequestChannel,
  IpcRequests,
} from '@shared/types'

/** Detach a pushed-event listener. Always call this on unmount. */
export type Unsubscribe = () => void

/**
 * renderer → main. Channel and argument types are both derived from IpcRequests, so a typo or
 * a wrong argument is a compile error, not a silent no-op.
 */
export type IpcInvoke = <K extends IpcRequestChannel>(
  channel: K,
  ...args: Parameters<IpcRequests[K]>
) => Promise<Awaited<ReturnType<IpcRequests[K]>>>

/** main → renderer, pushed. Returns an unsubscribe function. */
export type IpcSubscribe = <K extends IpcEventChannel>(
  channel: K,
  listener: (...args: Parameters<IpcEvents[K]>) => void,
) => Unsubscribe

/** The whole domain IPC surface exposed to renderers. Nothing else crosses the bridge. */
export interface RetroIpcApi {
  readonly invoke: IpcInvoke
  readonly on: IpcSubscribe
}

/**
 * Window chrome control for the custom XP-style title bar (SPEC.md §9). Every window is
 * frameless, so these replace the native macOS traffic lights.
 */
export interface WindowControlsApi {
  readonly minimize: () => void
  /** Toggles between maximized and restored. */
  readonly maximize: () => void
  readonly close: () => void
  readonly isMaximized: () => Promise<boolean>
  readonly onMaximizedChanged: (listener: (isMaximized: boolean) => void) => Unsubscribe
}

declare global {
  interface Window {
    readonly api: RetroIpcApi
    readonly windowControls: WindowControlsApi
  }
}
