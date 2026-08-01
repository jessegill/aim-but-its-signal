/**
 * IPC handler registration.
 *
 * Deliberately thin: every handler validates its arguments, delegates to {@link AppService},
 * and returns. All state and all network access live behind the service (SPEC.md §3), and no
 * renderer is trusted to send well-formed input — the preload's allowlist stops unknown
 * channels, but says nothing about the shape of the arguments on a known one.
 */

import { ipcMain } from 'electron'

import type { AppService } from './service.ts'

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${name} must be a non-empty string`)
  }
  return value
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`)
  }
  return value
}

function optionalStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new TypeError(`${name} must be an array of strings`)
  }
  return value as string[]
}

export function registerIpc(service: AppService): void {
  // -- conversations --------------------------------------------------------

  ipcMain.handle('im:getInitial', (_event, conversationId: unknown) => {
    return service.getInitial(requireString(conversationId, 'conversationId'))
  })

  // Subscription is implicit: the window manager already routes pushes by conversation, so
  // this exists to satisfy the declared surface and to let a renderer signal readiness.
  ipcMain.handle('im:subscribe', (_event, conversationId: unknown) => {
    requireString(conversationId, 'conversationId')
  })

  ipcMain.handle('im:send', async (_event, conversationId: unknown, body: unknown, attachments: unknown) => {
    const id = requireString(conversationId, 'conversationId')
    const text = requireString(body, 'body')
    const messageId = await service.send(id, text, optionalStringArray(attachments, 'attachments'))
    return { messageId }
  })

  ipcMain.handle('im:markRead', (_event, conversationId: unknown) => {
    requireString(conversationId, 'conversationId')
    // TODO(read receipts): sending read receipts is user-visible and leaks read state, so it
    // stays off until it is a preference rather than a default (see the note on
    // --send-read-receipts in docs/signal-cli-rpc.md).
  })

  ipcMain.handle('im:setTyping', async (_event, conversationId: unknown, isTyping: unknown) => {
    const id = requireString(conversationId, 'conversationId')
    await service.setTyping(id, isTyping === true)
  })

  // -- roster ---------------------------------------------------------------

  ipcMain.handle('roster:get', () => service.getRoster())

  ipcMain.handle('roster:move', (_event, buddyId: unknown, groupId: unknown) => {
    service.roster.moveBuddy(requireString(buddyId, 'buddyId'), requireNumber(groupId, 'groupId'))
  })

  ipcMain.handle('roster:setNick', (_event, buddyId: unknown, nickname: unknown) => {
    const id = requireString(buddyId, 'buddyId')
    if (nickname !== null && typeof nickname !== 'string') {
      throw new TypeError('nickname must be a string or null')
    }
    service.roster.setNickname(id, nickname === '' ? null : nickname)
  })

  // -- groups ---------------------------------------------------------------

  ipcMain.handle('group:create', (_event, name: unknown) => {
    return service.roster.createGroup(requireString(name, 'name'))
  })

  ipcMain.handle('group:rename', (_event, groupId: unknown, name: unknown) => {
    service.roster.renameGroup(requireNumber(groupId, 'groupId'), requireString(name, 'name'))
  })

  ipcMain.handle('group:delete', (_event, groupId: unknown) => {
    service.roster.deleteGroup(requireNumber(groupId, 'groupId'))
  })

  ipcMain.handle('group:reorder', (_event, groupId: unknown, sortOrder: unknown) => {
    service.roster.reorderGroup(requireNumber(groupId, 'groupId'), requireNumber(sortOrder, 'sortOrder'))
  })

  ipcMain.handle('group:setCollapsed', (_event, groupId: unknown, collapsed: unknown) => {
    service.roster.setGroupCollapsed(requireNumber(groupId, 'groupId'), collapsed === true)
  })

  // -- windows / connection -------------------------------------------------

  ipcMain.handle('window:openIm', (_event, buddyId: unknown) => {
    // A roster entry with zero messages is valid; the conversation is created on demand
    // (SPEC.md §6).
    service.windows.openIm(requireString(buddyId, 'buddyId'))
  })

  ipcMain.handle('connection:get', () => service.connectionState)

  ipcMain.handle('connection:startLink', async () => {
    // Also the relink path (SPEC.md §8). The device name is what appears in the user's Linked
    // Devices list on their phone.
    return await service.startLink('AIMgnal')
  })

  ipcMain.handle('self:get', () => service.selfAccount())
}
