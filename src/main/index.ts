/**
 * Main process entry — scaffold only.
 *
 * The main process is the single owner of the protocol connection and all application state
 * (SPEC.md §3). This file currently does the minimum to prove the build pipeline: app
 * lifecycle, frameless window creation for the three renderer entry points, window-chrome IPC,
 * and baseline renderer hardening.
 *
 * Everything else — daemon supervision, JSON-RPC, the SQLite store, the window manager, and
 * the domain IPC handlers from src/shared/types.ts — is owned by other modules and plugs in at
 * the TODO(main) markers below. Do not implement them here.
 *
 * macOS / Apple Silicon only, minimum macOS 15.
 */

import { join } from 'node:path'

import { app, BrowserWindow, ipcMain, shell } from 'electron'
import type { BrowserWindowConstructorOptions } from 'electron'

import { WINDOW_CONTROL_CHANNELS } from '../preload/channels'

// ---------------------------------------------------------------------------
// Renderer entry points
// ---------------------------------------------------------------------------

/** Keep in sync with `rendererEntries` in electron.vite.config.ts. */
export const RENDERER_ENTRIES = ['buddylist', 'im', 'signon'] as const
export type RendererEntry = (typeof RENDERER_ENTRIES)[number]

const PRELOAD_PATH = join(__dirname, '../preload/index.js')

/** SPEC.md §9 — XP chrome gray. Set on the window so there is no white flash before paint. */
const CHROME_BACKGROUND = '#ECE9D8'

/**
 * Every window is frameless. On macOS a native title bar (or even hidden-style traffic lights)
 * would sit on top of the XP-style title bar the UI draws itself, which reads as broken.
 * The custom title-bar buttons drive the window through WINDOW_CONTROL_CHANNELS, and the
 * `.titlebar-drag` / `.no-drag` classes in src/renderer/base.css provide the drag region.
 */
const FRAMELESS: BrowserWindowConstructorOptions = {
  frame: false,
  backgroundColor: CHROME_BACKGROUND,
  show: false,
}

const WEB_PREFERENCES = {
  preload: PRELOAD_PATH,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webviewTag: false,
  spellcheck: false,
} as const

function isDev(): boolean {
  return !app.isPackaged
}

function rendererDevServerUrl(): string | undefined {
  // Set by electron-vite in `dev` mode only.
  return process.env.ELECTRON_RENDERER_URL
}

/**
 * Loads one of the three renderer bundles into a window.
 *
 * dev:  <devServer>/<entry>/index.html
 * prod: out/renderer/<entry>/index.html   (relative to out/main)
 */
function loadRenderer(
  window: BrowserWindow,
  entry: RendererEntry,
  params?: Readonly<Record<string, string>>,
): void {
  const search = params ? new URLSearchParams(params).toString() : ''
  const devServer = rendererDevServerUrl()

  if (isDev() && devServer !== undefined) {
    const suffix = search === '' ? '' : `?${search}`
    void window.loadURL(`${devServer}/${entry}/index.html${suffix}`)
    return
  }

  const file = join(__dirname, `../renderer/${entry}/index.html`)
  void window.loadFile(file, search === '' ? {} : { search })
}

function createWindow(
  entry: RendererEntry,
  options: BrowserWindowConstructorOptions,
  params?: Readonly<Record<string, string>>,
): BrowserWindow {
  const window = new BrowserWindow({
    ...FRAMELESS,
    ...options,
    webPreferences: { ...WEB_PREFERENCES },
  })

  window.on('ready-to-show', () => {
    window.show()
  })

  // Keep the custom title bar's maximize button in sync with reality.
  const pushMaximized = (isMaximized: boolean) => (): void => {
    if (!window.isDestroyed()) {
      window.webContents.send(WINDOW_CONTROL_CHANNELS.maximizedChanged, isMaximized)
    }
  }
  window.on('maximize', pushMaximized(true))
  window.on('unmaximize', pushMaximized(false))

  loadRenderer(window, entry, params)
  return window
}

// ---------------------------------------------------------------------------
// Window factories
// ---------------------------------------------------------------------------

/** Buddy list — narrow and tall (SPEC.md §9). */
function createBuddyListWindow(): BrowserWindow {
  return createWindow('buddylist', {
    width: 250,
    height: 620,
    minWidth: 200,
    minHeight: 320,
    title: 'Buddy List',
  })
}

/**
 * IM window — one real OS window per conversation (SPEC.md §1).
 *
 * TODO(main): owned by integration — the window manager keeps
 * Map<ConversationId, BrowserWindow>, focuses an existing window instead of opening a second
 * one, and restores persisted geometry from the store. This factory is only the constructor.
 */
export function createImWindow(conversationId: string): BrowserWindow {
  return createWindow(
    'im',
    { width: 520, height: 400, minWidth: 320, minHeight: 240, title: 'Instant Message' },
    { conversationId },
  )
}

/** Sign-on / QR linking window (SPEC.md §9). */
export function createSignOnWindow(): BrowserWindow {
  return createWindow('signon', {
    width: 380,
    height: 460,
    resizable: false,
    title: 'Sign On',
  })
}

// ---------------------------------------------------------------------------
// Window chrome IPC (frameless title bar)
// ---------------------------------------------------------------------------

function senderWindow(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

function registerWindowControls(): void {
  ipcMain.on(WINDOW_CONTROL_CHANNELS.minimize, (event) => {
    senderWindow(event)?.minimize()
  })

  ipcMain.on(WINDOW_CONTROL_CHANNELS.maximize, (event) => {
    const window = senderWindow(event)
    if (window === null) return
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
  })

  ipcMain.on(WINDOW_CONTROL_CHANNELS.close, (event) => {
    // Closing an IM window closes only that conversation (SPEC.md §9).
    senderWindow(event)?.close()
  })

  ipcMain.handle(WINDOW_CONTROL_CHANNELS.isMaximized, (event) => {
    return senderWindow(event)?.isMaximized() ?? false
  })
}

// ---------------------------------------------------------------------------
// Renderer hardening
// ---------------------------------------------------------------------------

/**
 * Renderers are pure views and never navigate anywhere or open anything themselves
 * (SPEC.md §3). Any link that would leave the app goes to the system browser instead.
 */
function hardenWebContents(): void {
  app.on('web-contents-created', (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://')) void shell.openExternal(url)
      return { action: 'deny' }
    })

    contents.on('will-navigate', (event, url) => {
      const devServer = rendererDevServerUrl()
      const isAppUrl =
        url.startsWith('file://') || (devServer !== undefined && url.startsWith(devServer))
      if (!isAppUrl) {
        event.preventDefault()
        if (url.startsWith('https://')) void shell.openExternal(url)
      }
    })

    contents.on('will-attach-webview', (event) => {
      event.preventDefault()
    })
  })
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

// Exactly one signal-cli connection for the whole application (SPEC.md §3) — which means
// exactly one instance of the app.
if (!app.requestSingleInstanceLock()) {
  app.quit()
}

hardenWebContents()

void app.whenReady().then(() => {
  registerWindowControls()

  // TODO(main): owned by integration — start and supervise the signal-cli daemon, open the
  // JSON-RPC connection, and register the domain IPC handlers declared in
  // src/shared/types.ts (im:*, roster:*, group:*, window:openIm, connection:get) before any
  // window loads. Open the sign-on window instead of the buddy list when the connection state
  // is 'unlinked' — createSignOnWindow() is ready for that.

  createBuddyListWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createBuddyListWindow()
    }
  })
})

app.on('window-all-closed', () => {
  // macOS-only app: closing the last window must not hard-quit, and must not orphan IM
  // windows (SPEC.md §9).
  // TODO(main): owned by integration — decide tray vs. dock-only behaviour and quit
  // deliberately. Deliberately NOT calling app.quit() here.
})

// TODO(main): owned by integration — flush the store and shut the daemon down cleanly on
// 'before-quit'.
