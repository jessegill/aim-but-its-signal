import { builtinModules } from 'node:module'
import { resolve } from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'

const root = __dirname
const sharedDir = resolve(root, 'src/shared')
const rendererRoot = resolve(root, 'src/renderer')

/**
 * The three renderer entry points (SPEC.md §9). Each is a separate HTML document and a
 * separate renderer process at runtime:
 *
 *   buddylist  the buddy list window (one instance)
 *   im         the IM window (many instances, one per conversation)
 *   signon     the QR linking / sign-on window (one instance)
 *
 * Keep this list in sync with RENDERER_ENTRIES in src/main/index.ts.
 */
const rendererEntries = ['buddylist', 'im', 'signon'] as const

/**
 * Hard guard for SPEC.md §3: "Renderers communicate only via IPC. No renderer opens a socket
 * or spawns a process."
 *
 * Fails the build if anything in the renderer graph reaches for Node builtins, Electron, or a
 * native module (notably better-sqlite3 — bundling it into a renderer is both an architecture
 * violation and an instant NODE_MODULE_VERSION crash).
 */
function forbidNodeInRenderer(): Plugin {
  const forbidden = new Set<string>([
    'electron',
    'better-sqlite3',
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
  ])

  return {
    name: 'aimgnal:forbid-node-in-renderer',
    enforce: 'pre',
    resolveId(source, importer) {
      if (forbidden.has(source) || source.startsWith('node:')) {
        throw new Error(
          `Renderer bundle may not import "${source}"` +
            (importer ? ` (imported by ${importer})` : '') +
            '. Renderers are pure views — route it through IPC to the main process ' +
            '(SPEC.md §3).',
        )
      }
      return null
    },
  }
}

// Apple Silicon, macOS 15+, Electron 43 — a very modern Chromium/V8 is guaranteed, so no
// legacy transpilation, polyfills, or browserslist compatibility target.
const RENDERER_TARGET = 'chrome130'

export default defineConfig({
  main: {
    resolve: {
      alias: { '@shared': sharedDir },
    },
    // Keeps `dependencies` (better-sqlite3) out of the bundle so Node resolves the real,
    // Electron-ABI-rebuilt .node binary from node_modules at runtime.
    plugins: [externalizeDepsPlugin()],
    build: {
      target: 'node22',
      rollupOptions: {
        input: { index: resolve(root, 'src/main/index.ts') },
      },
    },
  },

  preload: {
    resolve: {
      alias: { '@shared': sharedDir },
    },
    plugins: [externalizeDepsPlugin()],
    build: {
      target: 'node22',
      rollupOptions: {
        input: { index: resolve(root, 'src/preload/index.ts') },
      },
    },
  },

  renderer: {
    root: rendererRoot,
    resolve: {
      alias: { '@shared': sharedDir },
    },
    plugins: [forbidNodeInRenderer(), react()],
    esbuild: { target: RENDERER_TARGET },
    build: {
      target: RENDERER_TARGET,
      // Output lands at out/renderer/<entry>/index.html — see loadRenderer() in src/main.
      rollupOptions: {
        input: Object.fromEntries(
          rendererEntries.map((entry) => [entry, resolve(rendererRoot, entry, 'index.html')]),
        ),
      },
    },
  },
})
