# Contributing

## Read this first — account safety

This client links to a Signal account as a **real secondary device**. A linked device has
**full account access**: it can read your conversations and send messages to your real
contacts, and a bug in an outbound path can do that without you noticing.

**Develop against a secondary Signal account, not your personal one.** A spare number, a
cheap eSIM, a Google Voice number — anything that is not the account your friends and family
message. This costs one of the account's **five linked-device slots** either way, so use one
you are willing to spend.

Related hard rules from [SPEC.md](../SPEC.md) §10:

- **Never commit account state, key material, or databases.** Not signal-cli's `data/`
  directory, not `*.db` / `*.sqlite`, not `.env`, not a device-linking URI pasted into a
  scratch file. This repository is public.
- **Never modify or reimplement cryptography.** signal-cli is used as-is over JSON-RPC; no
  key handling lives in this codebase.
- **Never vendor signal-cli's source.** It is GPLv3 and stays a separate process behind the
  JSON-RPC boundary.

### Enable the pre-commit guard

Once per clone:

```sh
./scripts/hooks/install-hooks.sh
```

This points `core.hooksPath` at `scripts/hooks/`, so `pre-commit` runs
`scripts/hooks/check-secrets.sh --staged` on every commit. It blocks account-state files, key
material, local databases and device-linking URIs. It takes well under a second — no
typecheck, no lint — precisely so nobody is tempted to reach for `--no-verify`.

CI runs the same script against the full tree and against every diff. Bypassing the hook
locally only defers the failure.

If the guard is wrong, fix the guard in its own commit with a note explaining why. Do not
work around it.

## Setup

Requires macOS 15 (Sequoia) or later on **Apple Silicon**. Intel is not supported.

```sh
brew install node signal-cli   # signal-cli pinned to 0.14.6 — see README
node --version                 # expect v26.x
npm install
```

**Link signal-cli manually from a terminal before running the app** (SPEC.md §5, Phase 1).
Confirm you can send and receive from the CLI first. Debugging the app and an unfamiliar
daemon at the same time wastes a day.

## Running

```sh
npm run dev        # electron-vite dev server, main + renderers, HMR
npm run build      # production build into out/
npm start          # run the production build
```

## Checks

Run before pushing. CI runs exactly these.

```sh
npm run typecheck     # tsc --noEmit
npm run lint          # eslint .
npm run format        # prettier --write .
npm run format:check  # prettier --check .   (what CI runs)
npm test              # vitest run
```

### The native module has two builds

`better-sqlite3` is a native addon, and Electron's `NODE_MODULE_VERSION` differs from stock
Node's. The same `node_modules` cannot serve both:

- **Tests** (Vitest, plain Node) need the **Node-ABI** build — what `npm install` produces.
- **The app** (Electron) needs the **Electron-ABI** build.

So:

```sh
npm test                                        # Node ABI
npx electron-rebuild --force --arch arm64       # switch to the Electron ABI
npm run dev                                     # now the app can load it
npm install                                     # back to the Node ABI for tests
```

If you see `ERR_DLOPEN_FAILED` or "compiled against a different Node.js version", you are on
the wrong side of that switch. CI runs the checks in that order deliberately and then loads
the module from inside the Electron runtime
(`.github/scripts/verify-electron-abi.cjs`) so a Node-ABI build can never pass silently.

## Module ownership

Change code in your own area. If you need something from another, ask for the interface
rather than editing across the boundary — several people work this repo concurrently.

| Area | Owns |
|---|---|
| `src/main/daemon.ts`, `rpc.ts`, `events.ts` | signal-cli lifecycle, JSON-RPC transport, payload → typed domain events |
| `src/main/store/**` | SQLite schema, migrations, message/roster persistence, **expiry enforcement** |
| `src/main/windows.ts`, `ipc.ts` | BrowserWindow manager, geometry persistence, IPC registration |
| `src/renderer/buddylist/**` | Buddy list window |
| `src/renderer/im/**` | IM window |
| `src/renderer/ui/**` | Shared AIM component library and theme tokens |
| `src/shared/types.ts` | Types crossing the process boundary — **changes here affect everyone** |
| `resources/**` | Original look-alike icons and sounds |
| `.github/**`, `eslint.config.mjs`, `.prettierrc.json`, `scripts/hooks/**` | CI, linting, guards |
| `package.json`, `tsconfig*.json`, `electron.vite.config.ts` | Build scaffold — coordinate before editing |

### Architectural boundaries that are not negotiable

From SPEC.md §3. ESLint enforces the import rules mechanically; the rest is on you.

- **One signal-cli connection for the whole app.** Never one per window.
- **Renderers are pure views.** No sockets, no `child_process`, no `better-sqlite3`, no
  `electron` import — only the preload IPC bridge. A renderer may crash at any moment without
  affecting message delivery.
- **All persistence happens in the main process.**
- **Message expiry is enforced in the store layer, never only in the UI** (SPEC.md §8). A
  message the sender believed was ephemeral must not survive in local SQLite. This has an
  explicit test; keep it green.
- **Security signals are never dropped for the sake of the retro look** (SPEC.md §8). Safety
  number changes, identity changes, view-once semantics — style them to fit 2003, do not omit
  them.
- **No presence, ever** (SPEC.md §7). Signal transmits no online/offline/idle/away state. No
  availability indicators, idle timers, away messages, or sign-on sounds. Typing indicators
  and read receipts are *not* presence and are wired through.

## Pull requests

- One phase or one concern per PR. SPEC.md §5 phases ship in order, each green before the
  next starts.
- CI must pass: account-state guard, typecheck, lint, format, tests, Electron-ABI check,
  build.
- Verify signal-cli's actual JSON-RPC method names and payload shapes against the installed
  daemon before writing code against them (SPEC.md §11). The shapes in SPEC.md are indicative,
  not authoritative.
- Anything touching a security-critical row in SPEC.md §8 needs an explicit test in the same
  PR.
- No Signal or AOL branding, names, marks, or extracted artwork (SPEC.md §10).
