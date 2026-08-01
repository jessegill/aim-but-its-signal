/**
 * BrowserWindow creation and the per-conversation window manager.
 *
 * SPEC.md §1 is emphatic that each conversation gets its own real OS window — not tabs, not
 * panes. This module is the thing that makes that true: it owns `Map<ConversationId,
 * BrowserWindow>`, focuses an existing window rather than opening a second one, and restores
 * each window's persisted geometry on reopen.
 *
 * Renderers are pure views (SPEC.md §3). Nothing here hands them state; they ask for it over
 * IPC and receive pushes.
 *
 * macOS / Apple Silicon only, minimum macOS 15.
 */

import { join } from 'node:path';

import { app, BrowserWindow, screen } from 'electron';
import type { BrowserWindowConstructorOptions } from 'electron';

import { WINDOW_CONTROL_CHANNELS } from '../preload/channels';
import type { ConversationId } from '@shared/types';
import type { WindowBounds, WindowStore } from './store/windows.ts';
import { BUDDY_LIST_WINDOW_KEY } from './store/windows.ts';

export const RENDERER_ENTRIES = ['buddylist', 'im', 'signon'] as const;
export type RendererEntry = (typeof RENDERER_ENTRIES)[number];

const PRELOAD_PATH = join(__dirname, '../preload/index.js');

/** SPEC.md §9 — XP chrome gray, set on the window so there is no white flash before paint. */
const CHROME_BACKGROUND = '#ECE9D8';

/**
 * Each renderer is a process (SPEC.md §9). Cap concurrent IM windows so a busy day cannot spawn
 * a hundred of them; the least-recently-focused idle window is closed to make room. Its
 * conversation is untouched — closing a window closes only the view.
 */
const MAX_IM_WINDOWS = 20;

/** Geometry writes are debounced: a drag emits a resize event per frame. */
const GEOMETRY_SAVE_DEBOUNCE_MS = 400;

const FRAMELESS: BrowserWindowConstructorOptions = {
  frame: false,
  backgroundColor: CHROME_BACKGROUND,
  show: false,
};

const WEB_PREFERENCES = {
  preload: PRELOAD_PATH,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webviewTag: false,
  spellcheck: false,
} as const;

function isDev(): boolean {
  return !app.isPackaged;
}

function rendererDevServerUrl(): string | undefined {
  return process.env.ELECTRON_RENDERER_URL;
}

function loadRenderer(
  window: BrowserWindow,
  entry: RendererEntry,
  params?: Readonly<Record<string, string>>
): void {
  const search = params ? new URLSearchParams(params).toString() : '';
  const devServer = rendererDevServerUrl();

  if (isDev() && devServer !== undefined) {
    const suffix = search === '' ? '' : `?${search}`;
    void window.loadURL(`${devServer}/${entry}/index.html${suffix}`);
    return;
  }

  const file = join(__dirname, `../renderer/${entry}/index.html`);
  void window.loadFile(file, search === '' ? {} : { search });
}

function createWindow(
  entry: RendererEntry,
  options: BrowserWindowConstructorOptions,
  params?: Readonly<Record<string, string>>
): BrowserWindow {
  const window = new BrowserWindow({
    ...FRAMELESS,
    ...options,
    webPreferences: { ...WEB_PREFERENCES },
  });

  window.on('ready-to-show', () => {
    window.show();
  });

  const pushMaximized = (isMaximized: boolean) => (): void => {
    if (!window.isDestroyed()) {
      window.webContents.send(WINDOW_CONTROL_CHANNELS.maximizedChanged, isMaximized);
    }
  };
  window.on('maximize', pushMaximized(true));
  window.on('unmaximize', pushMaximized(false));

  loadRenderer(window, entry, params);
  return window;
}

/**
 * Persisted geometry is only honoured if it still lands on a display that exists. Unplugging
 * the monitor a window was last on would otherwise restore it off-screen, where it is visible
 * in the taskbar but impossible to reach.
 */
function boundsAreVisible(bounds: WindowBounds): boolean {
  return screen.getAllDisplays().some((display) => {
    const area = display.workArea;
    const overlapsX = bounds.x < area.x + area.width && bounds.x + bounds.width > area.x;
    const overlapsY = bounds.y < area.y + area.height && bounds.y + bounds.height > area.y;
    return overlapsX && overlapsY;
  });
}

interface ManagedWindow {
  window: BrowserWindow;
  lastFocusedAt: number;
  saveTimer: NodeJS.Timeout | null;
}

export class WindowManager {
  private readonly imWindows = new Map<ConversationId, ManagedWindow>();
  private buddyList: BrowserWindow | null = null;
  private signOn: BrowserWindow | null = null;

  constructor(private readonly geometry: WindowStore) {}

  // -------------------------------------------------------------------------
  // Buddy list
  // -------------------------------------------------------------------------

  openBuddyList(): BrowserWindow {
    if (this.buddyList !== null && !this.buddyList.isDestroyed()) {
      this.buddyList.focus();
      return this.buddyList;
    }

    const saved = this.restoreBounds(BUDDY_LIST_WINDOW_KEY);
    const window = createWindow('buddylist', {
      width: saved?.width ?? 250,
      height: saved?.height ?? 620,
      ...(saved ? { x: saved.x, y: saved.y } : {}),
      minWidth: 200,
      minHeight: 320,
      title: 'Buddy List',
    });

    this.buddyList = window;
    this.trackGeometry(window, BUDDY_LIST_WINDOW_KEY);
    window.on('closed', () => {
      this.buddyList = null;
    });
    return window;
  }

  get buddyListWindow(): BrowserWindow | null {
    return this.buddyList !== null && !this.buddyList.isDestroyed() ? this.buddyList : null;
  }

  // -------------------------------------------------------------------------
  // Sign-on
  // -------------------------------------------------------------------------

  openSignOn(): BrowserWindow {
    if (this.signOn !== null && !this.signOn.isDestroyed()) {
      this.signOn.focus();
      return this.signOn;
    }
    const window = createWindow('signon', {
      width: 380,
      // The QR, its instructions, the connection badge and the relink button need ~530px.
      // At 460 the button fell below the fold.
      height: 560,
      resizable: false,
      title: 'Sign On',
    });
    this.signOn = window;
    window.on('closed', () => {
      this.signOn = null;
    });
    return window;
  }

  closeSignOn(): void {
    if (this.signOn !== null && !this.signOn.isDestroyed()) this.signOn.close();
    this.signOn = null;
  }

  // -------------------------------------------------------------------------
  // IM windows — one real OS window per conversation
  // -------------------------------------------------------------------------

  /** Opens the window for a conversation, or focuses it if it is already open. */
  openIm(conversationId: ConversationId): BrowserWindow {
    const existing = this.imWindows.get(conversationId);
    if (existing !== undefined && !existing.window.isDestroyed()) {
      existing.lastFocusedAt = Date.now();
      if (existing.window.isMinimized()) existing.window.restore();
      existing.window.focus();
      return existing.window;
    }

    this.evictIfAtCapacity();

    const saved = this.restoreBounds(conversationId);
    const window = createWindow(
      'im',
      {
        width: saved?.width ?? 520,
        height: saved?.height ?? 400,
        ...(saved ? { x: saved.x, y: saved.y } : {}),
        minWidth: 320,
        minHeight: 240,
        title: 'Instant Message',
      },
      { conversationId }
    );

    const managed: ManagedWindow = { window, lastFocusedAt: Date.now(), saveTimer: null };
    this.imWindows.set(conversationId, managed);

    window.on('focus', () => {
      managed.lastFocusedAt = Date.now();
    });
    window.on('closed', () => {
      const current = this.imWindows.get(conversationId);
      if (current?.window === window) {
        if (current.saveTimer !== null) clearTimeout(current.saveTimer);
        this.imWindows.delete(conversationId);
      }
    });

    this.trackGeometry(window, conversationId);
    return window;
  }

  imWindow(conversationId: ConversationId): BrowserWindow | null {
    const managed = this.imWindows.get(conversationId);
    return managed !== undefined && !managed.window.isDestroyed() ? managed.window : null;
  }

  hasIm(conversationId: ConversationId): boolean {
    return this.imWindow(conversationId) !== null;
  }

  /**
   * Signals a newly arrived message. SPEC.md §9: flash the window if it is open. The receive
   * sound and the open-if-closed preference are the caller's business — this only handles the
   * window-level attention cue.
   */
  flash(conversationId: ConversationId): void {
    const window = this.imWindow(conversationId);
    if (window === null) return;
    if (!window.isFocused()) window.flashFrame(true);
  }

  /** Closes only that conversation's window (SPEC.md §9). */
  closeIm(conversationId: ConversationId): void {
    this.imWindow(conversationId)?.close();
  }

  get openConversationIds(): ConversationId[] {
    return [...this.imWindows.keys()];
  }

  /** Broadcasts a pushed event to every live renderer. */
  broadcast(channel: string, ...args: unknown[]): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, ...args);
    }
  }

  /** Sends a pushed event to one conversation's window, if it is open. */
  sendToIm(conversationId: ConversationId, channel: string, ...args: unknown[]): void {
    const window = this.imWindow(conversationId);
    if (window !== null) window.webContents.send(channel, ...args);
  }

  // -------------------------------------------------------------------------
  // Geometry
  // -------------------------------------------------------------------------

  private restoreBounds(key: string): WindowBounds | null {
    const saved = this.geometry.get(key);
    if (saved === null) return null;
    const { x, y, w, h } = saved;
    if (x === null || y === null || w === null || h === null) return null;

    const bounds: WindowBounds = { x, y, width: w, height: h };
    return boundsAreVisible(bounds) ? bounds : null;
  }

  private trackGeometry(window: BrowserWindow, key: string): void {
    const persist = (): void => {
      if (window.isDestroyed() || window.isMinimized() || window.isMaximized()) return;
      const bounds = window.getBounds();
      this.geometry.save(key, bounds);
    };

    const schedule = (): void => {
      const managed = this.imWindows.get(key);
      if (managed !== undefined) {
        if (managed.saveTimer !== null) clearTimeout(managed.saveTimer);
        managed.saveTimer = setTimeout(persist, GEOMETRY_SAVE_DEBOUNCE_MS);
        return;
      }
      // Buddy list and other singletons: debounce on a local timer.
      if (singletonTimers.has(key)) clearTimeout(singletonTimers.get(key));
      singletonTimers.set(key, setTimeout(persist, GEOMETRY_SAVE_DEBOUNCE_MS));
    };

    window.on('resize', schedule);
    window.on('move', schedule);
    // A window closed mid-drag would otherwise lose the last position.
    window.on('close', persist);
  }

  private evictIfAtCapacity(): void {
    if (this.imWindows.size < MAX_IM_WINDOWS) return;

    let oldest: { id: ConversationId; at: number } | null = null;
    for (const [id, managed] of this.imWindows) {
      if (managed.window.isDestroyed() || managed.window.isFocused()) continue;
      if (oldest === null || managed.lastFocusedAt < oldest.at) {
        oldest = { id, at: managed.lastFocusedAt };
      }
    }
    if (oldest !== null) this.closeIm(oldest.id);
  }

  /** Closes everything. Used on quit. */
  closeAll(): void {
    for (const timer of singletonTimers.values()) clearTimeout(timer);
    singletonTimers.clear();
    for (const managed of this.imWindows.values()) {
      if (managed.saveTimer !== null) clearTimeout(managed.saveTimer);
      if (!managed.window.isDestroyed()) managed.window.destroy();
    }
    this.imWindows.clear();
  }
}

const singletonTimers = new Map<string, NodeJS.Timeout>();
