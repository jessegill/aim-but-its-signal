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
import type { PickedFile, RejectedFile } from '@shared/types';

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
      const name = basename(path);
      let size: number;
      try {
        const stat = statSync(path);
        if (!stat.isFile()) {
          rejected.push({ name, reason: 'not a file' });
          continue;
        }
        size = stat.size;
      } catch {
        rejected.push({ name, reason: 'could not be read' });
        continue;
      }
      if (size > MAX_ATTACHMENT_BYTES) {
        // Refused here rather than at send time: signal-cli's failure for an oversized file is
        // a daemon error the user cannot act on.
        rejected.push({ name, reason: 'larger than the 100 MB Signal allows' });
        continue;
      }
      service.vendAttachmentPath(path);
      files.push({ path, name, size, contentType: guessContentType(name) });
    }

    return { files, rejected };
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

  ipcMain.handle('roster:move', (_event, buddyId: unknown, groupId: unknown) => {
    service.roster.moveBuddy(requireString(buddyId, 'buddyId'), requireNumber(groupId, 'groupId'));
  });

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

  ipcMain.handle('group:reorder', (_event, groupId: unknown, sortOrder: unknown) => {
    service.roster.reorderGroup(
      requireNumber(groupId, 'groupId'),
      requireNumber(sortOrder, 'sortOrder')
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
