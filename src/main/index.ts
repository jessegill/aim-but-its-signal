/**
 * Main process entry — app lifecycle and wiring.
 *
 * The main process is the single owner of the protocol connection and all application state
 * (SPEC.md §3). That ownership lives in `service.ts`; this file starts it, registers the IPC
 * surface, hardens renderers, and shuts everything down cleanly.
 *
 * macOS / Apple Silicon only, minimum macOS 15.
 */

import { app, BrowserWindow, ipcMain, shell } from 'electron'

import { WINDOW_CONTROL_CHANNELS } from '../preload/channels'
import { AppService } from './service.ts'
import { registerIpc } from './ipc.ts'

let service: AppService | null = null
let quitting = false

// ---------------------------------------------------------------------------
// Window chrome IPC (frameless title bar)
// ---------------------------------------------------------------------------

function senderWindow(
  event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent,
): BrowserWindow | null {
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
      const devServer = process.env.ELECTRON_RENDERER_URL
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

app.on('second-instance', () => {
  service?.windows.openBuddyList()
})

void app.whenReady().then(() => {
  registerWindowControls()

  // The store's encryption key comes from the macOS Keychain via safeStorage, which is not
  // reliably available before the app is ready — hence construction here rather than at import.
  service = new AppService()
  registerIpc(service)
  service.start()

  // The buddy list opens immediately; the service swaps in the sign-on window if it turns out
  // no account is linked. Showing the buddy list first avoids a flash of sign-on UI on every
  // launch for the common case.
  service.windows.openBuddyList()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      service?.windows.openBuddyList()
    }
  })
})

app.on('window-all-closed', () => {
  // macOS-only app. Closing the last window must not hard-quit and must not orphan IM windows
  // (SPEC.md §9): the app stays alive in the Dock, and clicking it reopens the buddy list via
  // 'activate'. Quitting is explicit, through the Dock or Cmd-Q.
})

app.on('before-quit', (event) => {
  if (quitting || service === null) return

  // Shut the daemon down cleanly and close the database rather than leaving a WAL behind.
  quitting = true
  event.preventDefault()
  void service.stop().finally(() => {
    service = null
    app.quit()
  })
})
