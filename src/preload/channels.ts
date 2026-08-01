import type { IpcEventChannel, IpcRequestChannel } from '@shared/types'

/**
 * Runtime allowlists for the contextBridge.
 *
 * src/shared/types.ts declares the IPC surface as *types*, which vanish at runtime. These
 * arrays are the runtime half: the preload refuses any channel not listed here, so a
 * compromised renderer cannot reach arbitrary ipcMain handlers.
 *
 * The `satisfies` clauses below catch typos and stale entries; the AssertNever aliases at the
 * bottom fail the build if src/shared/types.ts gains a channel nobody added here.
 */

export const REQUEST_CHANNELS = [
  'im:getInitial',
  'im:subscribe',
  'im:send',
  'im:markRead',
  'im:setTyping',

  'roster:get',
  'roster:move',
  'roster:setNick',

  'group:create',
  'group:rename',
  'group:delete',
  'group:reorder',
  'group:setCollapsed',

  'window:openIm',

  'connection:get',
] as const satisfies readonly IpcRequestChannel[]

export const EVENT_CHANNELS = [
  'im:message',
  'im:typing',
  'im:receipt',
  'im:removed',
  'roster:updated',
  'connection:state',
] as const satisfies readonly IpcEventChannel[]

/**
 * Window chrome control. Every window is frameless (`frame: false`) so the UI can draw the
 * XP-style title bar from SPEC.md §9, which means the minimize / maximize / close buttons in
 * that title bar have to drive the BrowserWindow over IPC.
 *
 * These are deliberately NOT in src/shared/types.ts — that file is the domain IPC surface and
 * is owned elsewhere. See the note in the scaffold report; they can be folded in later.
 */
export const WINDOW_CONTROL_CHANNELS = {
  minimize: 'window:minimize',
  maximize: 'window:maximize',
  close: 'window:close',
  isMaximized: 'window:isMaximized',
  maximizedChanged: 'window:maximizedChanged',
} as const

// --- exhaustiveness guards ---------------------------------------------------------------
// If these ever error, a channel was added to src/shared/types.ts without being allowlisted
// above, and the renderer would be blocked at runtime.

type AssertNever<T extends never> = T

export type _NoUnlistedRequestChannels = AssertNever<
  Exclude<IpcRequestChannel, (typeof REQUEST_CHANNELS)[number]>
>
export type _NoUnlistedEventChannels = AssertNever<
  Exclude<IpcEventChannel, (typeof EVENT_CHANNELS)[number]>
>
