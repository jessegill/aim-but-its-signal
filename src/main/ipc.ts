/**
 * IPC handler registration.
 *
 * Deliberately thin: every handler validates its arguments, delegates to {@link AppService},
 * and returns. All state and all network access live behind the service (SPEC.md §3), and no
 * renderer is trusted to send well-formed input — the preload's allowlist stops unknown
 * channels, but says nothing about the shape of the arguments on a known one.
 */

import { BrowserWindow, dialog, ipcMain } from 'electron';
import { basename } from 'node:path';
import { statSync } from 'node:fs';

import { MAX_ATTACHMENT_BYTES } from '@shared/types';
import type { PickedFile, RejectedFile, StagedFileResult } from '@shared/types';

import { PRELOAD_CHANNELS } from '../preload/channels';

import { guessContentType } from './store/index.ts';
import type { AppService } from './service.ts';

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
  return value;
}

function optionalStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
    throw new TypeError(`${name} must be an array of strings`);
  }
  return value as string[];
}

/**
 * Refuses a conversation-scoped request unless it came from that conversation's own window.
 *
 * The preload allowlist limits *which* channels a renderer can reach, not *what* it can do on
 * them. Without this, any window could read or send in every conversation by naming its id.
 */
function requireImSender(
  service: AppService,
  event: Electron.IpcMainInvokeEvent,
  conversationId: string
): void {
  const owner = service.windows.ownerOf(event.sender);
  if (owner?.kind !== 'im' || owner.conversationId !== conversationId) {
    throw new Error('this window may not act on that conversation');
  }
}

/** Refuses a request from anything but the listed kinds of window. */
function requireSenderKind(
  service: AppService,
  event: Electron.IpcMainInvokeEvent,
  ...kinds: ('im' | 'buddylist' | 'signon')[]
): void {
  const owner = service.windows.ownerOf(event.sender);
  if (owner === null || !kinds.includes(owner.kind)) {
    throw new Error('this window may not make that request');
  }
}

/**
 * The checks every attachment gets, however it was chosen: a regular file, readable, within
 * Signal's size limit. Passing them makes the path sendable (see vendAttachmentPath).
 */
function inspectAndVend(service: AppService, path: string): StagedFileResult {
  const name = basename(path);
  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return { rejected: { name, reason: 'not a file' } };
    size = stat.size;
  } catch {
    return { rejected: { name, reason: 'could not be read' } };
  }
  if (size > MAX_ATTACHMENT_BYTES) {
    // Refused here rather than at send time: signal-cli's failure for an oversized file is a
    // daemon error the user cannot act on.
    return { rejected: { name, reason: 'larger than the 100 MB Signal allows' } };
  }
  service.vendAttachmentPath(path);
  return { file: { path, name, size, contentType: guessContentType(name) } };
}

export function registerIpc(service: AppService): void {
  // -- conversations --------------------------------------------------------

  ipcMain.handle('im:getInitial', (event, conversationId: unknown) => {
    const id = requireString(conversationId, 'conversationId');
    requireImSender(service, event, id);
    return service.getInitial(id);
  });

  // Subscription is implicit: the window manager already routes pushes by conversation, so
  // this exists to satisfy the declared surface and to let a renderer signal readiness.
  ipcMain.handle('im:subscribe', (_event, conversationId: unknown) => {
    requireString(conversationId, 'conversationId');
  });

  ipcMain.handle(
    'im:send',
    async (event, conversationId: unknown, body: unknown, attachments: unknown) => {
      const id = requireString(conversationId, 'conversationId');
      requireImSender(service, event, id);
      const files = optionalStringArray(attachments, 'attachments');
      // A caption is optional when there is a file; a message with neither is not a message.
      if (typeof body !== 'string') throw new TypeError('body must be a string');
      if (body === '' && (files === undefined || files.length === 0)) {
        throw new TypeError('body must be a non-empty string when there are no attachments');
      }
      const messageId = await service.send(id, body, files);
      return { messageId };
    }
  );

  // -- attachments ----------------------------------------------------------

  ipcMain.handle('dialog:pickAttachments', async (event, kind: unknown) => {
    requireSenderKind(service, event, 'im');
    const parent = BrowserWindow.fromWebContents(event.sender);
    // "All Files" stays available in both cases — the filter picks the default, it does not
    // restrict what can be attached, and main runs the same checks on whatever comes back.
    const filters =
      kind === 'image'
        ? [
            { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'heic', 'webp', 'tiff'] },
            { name: 'All Files', extensions: ['*'] },
          ]
        : [{ name: 'All Files', extensions: ['*'] }];
    const options = {
      // Sheet-attached to the conversation it will be sent to, so two open IM windows cannot
      // leave the user guessing which one they are picking for.
      properties: ['openFile', 'multiSelections'] as const,
      buttonLabel: 'Attach',
      title: kind === 'image' ? 'Send Picture' : 'Send File',
      filters,
    };
    const result = await (parent === null
      ? dialog.showOpenDialog({ ...options, properties: [...options.properties] })
      : dialog.showOpenDialog(parent, { ...options, properties: [...options.properties] }));
    if (result.canceled) return { files: [], rejected: [] };

    const files: PickedFile[] = [];
    const rejected: RejectedFile[] = [];

    for (const path of result.filePaths) {
      const outcome = inspectAndVend(service, path);
      if ('file' in outcome) files.push(outcome.file);
      else rejected.push(outcome.rejected);
    }

    return { files, rejected };
  });

  // Preload-only (see PRELOAD_CHANNELS): a file dropped or pasted into an IM window.
  ipcMain.handle(PRELOAD_CHANNELS.vendDropped, (event, path: unknown) => {
    requireSenderKind(service, event, 'im');
    return inspectAndVend(service, requireString(path, 'path'));
  });

  ipcMain.handle(PRELOAD_CHANNELS.stageBytes, (event, payload: unknown) => {
    requireSenderKind(service, event, 'im');
    const record =
      typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
    const bytes = record.bytes;
    if (!(bytes instanceof Uint8Array)) throw new TypeError('bytes must be a Uint8Array');
    if (bytes.byteLength === 0) {
      return { rejected: { name: 'image', reason: 'empty' } } satisfies StagedFileResult;
    }
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      return {
        rejected: { name: 'image', reason: 'larger than the 100 MB Signal allows' },
      } satisfies StagedFileResult;
    }
    const path = service.stageBytes(
      typeof record.name === 'string' ? record.name : '',
      typeof record.type === 'string' ? record.type : '',
      bytes
    );
    return inspectAndVend(service, path);
  });

  ipcMain.handle('attachment:open', async (event, messageId: unknown, attachmentId: unknown) => {
    const id = requireString(messageId, 'messageId');
    const conversationId = service.conversationOfMessage(id);
    if (conversationId !== null) requireImSender(service, event, conversationId);
    return await service.openAttachment(id, requireString(attachmentId, 'attachmentId'));
  });

  ipcMain.handle('im:markRead', (event, conversationId: unknown) => {
    const id = requireString(conversationId, 'conversationId');
    requireImSender(service, event, id);
    service.markRead(id);
    // TODO(read receipts): sending read receipts is user-visible and leaks read state, so it
    // stays off until it is a preference rather than a default (see the note on
    // --send-read-receipts in docs/signal-cli-rpc.md).
  });

  ipcMain.handle('im:setTyping', async (event, conversationId: unknown, isTyping: unknown) => {
    const id = requireString(conversationId, 'conversationId');
    requireImSender(service, event, id);
    await service.setTyping(id, isTyping === true);
  });

  // -- roster ---------------------------------------------------------------

  ipcMain.handle('roster:get', () => service.getRoster());

  ipcMain.handle('chats:get', () => service.getChats());

  ipcMain.handle('conversations:get', () => service.getConversations());

  ipcMain.handle('conversation:setShelf', (_event, conversationId: unknown, shelf: unknown) => {
    const id = requireString(conversationId, 'conversationId');
    if (shelf !== 'pinned' && shelf !== 'normal' && shelf !== 'archived') {
      throw new TypeError("shelf must be 'pinned', 'normal' or 'archived'");
    }
    service.setShelf(id, shelf);
  });

  ipcMain.handle(
    'roster:move',
    (_event, buddyId: unknown, groupId: unknown, beforeBuddyId: unknown) => {
      service.roster.moveBuddy(
        requireString(buddyId, 'buddyId'),
        requireNumber(groupId, 'groupId'),
        beforeBuddyId == null ? null : requireString(beforeBuddyId, 'beforeBuddyId')
      );
    }
  );

  ipcMain.handle('roster:setNick', (_event, buddyId: unknown, nickname: unknown) => {
    const id = requireString(buddyId, 'buddyId');
    if (nickname !== null && typeof nickname !== 'string') {
      throw new TypeError('nickname must be a string or null');
    }
    service.roster.setNickname(id, nickname === '' ? null : nickname);
  });

  // -- groups ---------------------------------------------------------------

  ipcMain.handle('group:create', (_event, name: unknown) => {
    return service.roster.createGroup(requireString(name, 'name'));
  });

  ipcMain.handle('group:rename', (_event, groupId: unknown, name: unknown) => {
    service.roster.renameGroup(requireNumber(groupId, 'groupId'), requireString(name, 'name'));
  });

  ipcMain.handle('group:delete', (_event, groupId: unknown) => {
    service.roster.deleteGroup(requireNumber(groupId, 'groupId'));
  });

  ipcMain.handle('group:reorder', (_event, groupId: unknown, beforeGroupId: unknown) => {
    service.roster.reorderGroup(
      requireNumber(groupId, 'groupId'),
      beforeGroupId === null ? null : requireNumber(beforeGroupId, 'beforeGroupId')
    );
  });

  ipcMain.handle('group:setCollapsed', (_event, groupId: unknown, collapsed: unknown) => {
    service.roster.setGroupCollapsed(requireNumber(groupId, 'groupId'), collapsed === true);
  });

  // -- windows / connection -------------------------------------------------

  ipcMain.handle('window:openIm', (_event, buddyId: unknown) => {
    // A roster entry with zero messages is valid; the conversation is created on demand
    // (SPEC.md §6).
    service.windows.openIm(requireString(buddyId, 'buddyId'));
  });

  ipcMain.handle('connection:get', () => service.connectionState);

  ipcMain.handle('connection:startLink', async (event, deviceName: unknown) => {
    // Also the relink path (SPEC.md §8). The name is what the phone's Linked Devices list shows.
    requireSenderKind(service, event, 'signon', 'buddylist');
    const name = typeof deviceName === 'string' ? deviceName.trim().slice(0, 50) : '';
    return await service.startLink(name === '' ? undefined : name);
  });

  ipcMain.handle('connection:getLinkUri', (event) => {
    requireSenderKind(service, event, 'signon');
    return service.linkUri;
  });

  ipcMain.handle('connection:restartService', async (event) => {
    requireSenderKind(service, event, 'signon', 'buddylist');
    await service.restartService();
  });

  ipcMain.handle('connection:signOff', async (event) => {
    requireSenderKind(service, event, 'buddylist');
    return await service.signOff();
  });

  ipcMain.handle('self:get', () => service.selfAccount());
}
