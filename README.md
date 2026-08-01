# AIMgnal

*AIM but it's Signal.*

A desktop instant messenger with a 2003-era AIM 5.1 look and feel that runs on the real Signal
network as a linked secondary device. Every conversation opens in its own OS window.

> **Not affiliated with, endorsed by, or connected to** Signal Messenger LLC, the Signal
> Technology Foundation, AOL, Yahoo, or any successor rights holder. The name is a portmanteau
> used descriptively to say what this project is. All trademarks belong to their respective
> owners. No AOL or AIM artwork is used or distributed — all retro assets are original
> look-alikes.

## What it is

An Electron client that links to an existing Signal account (your phone stays primary, exactly
like official Signal Desktop), presents a classic AIM buddy list with user-defined collapsible
groups, and opens each conversation in a **separate operating system window** — real windows in
the taskbar, movable between monitors, remembering their position. Not tabs. Not panes.

The feature surface is deliberately small: 1:1 text messaging, a grouped buddy list, profiles,
and attachments. This is not a Signal client competing on features; it is an AIM experience
riding Signal's network.

## Architecture

The Electron **main process is the single owner** of the protocol connection and all
application state. Renderer windows are pure views — they hold no authoritative state and never
touch the network.

```
┌──────────────────────────────────────────────────┐
│ MAIN PROCESS  (single source of truth)           │
│   • signal-cli daemon lifecycle & supervision    │
│   • JSON-RPC client → typed internal event bus   │
│   • SQLite store (messages, roster, groups)      │
│   • Window manager: Map<conversationId, Window>  │
│   • ALL outbound sends route through here        │
└──────────────────────────────────────────────────┘
         │ typed IPC (per-conversation channels)
   ┌─────┴──────┐   ┌───────────┐   ┌───────────┐
   │ Buddy List │   │ IM Window │   │ IM Window │
   │  (view)    │   │  (view)   │   │  (view)   │
   └────────────┘   └───────────┘   └───────────┘
```

Invariants:

- Exactly **one** signal-cli connection for the entire application. Never one per window.
- Renderers communicate only via IPC. No renderer opens a socket or spawns a process.
- A renderer may be closed or crash at any time without affecting message delivery.
- All persistence happens in the main process.
- Message expiry is enforced in the **store layer**, never only in the UI.

## Stack

| Component | Choice |
|---|---|
| Shell | Electron + TypeScript |
| Build | electron-vite |
| UI | React (built fresh — no fork of any existing Signal client) |
| Storage | better-sqlite3, encrypted at rest |
| Protocol backend | `signal-cli` daemon, JSON-RPC over localhost |

### Pinned versions

| Tool | Version |
|---|---|
| **signal-cli** | **0.14.6** |
| Node | 26.5.1 |

signal-cli is **GPLv3** and runs as a **separate process** communicated with over JSON-RPC.
That boundary is deliberate and must stay clean — its source is never vendored into this
codebase.

## Development

```sh
brew install node signal-cli   # signal-cli 0.14.6
npm install
npm run dev
```

### Account safety

A linked device has **full account access** — a bug can send real messages to real contacts.
Linking to a secondary test account is strongly recommended. This client occupies one of
Signal's **five linked device slots** per account.

Cryptography is never modified or reimplemented here. The daemon is used as-is; no key handling
lives in this codebase.

## Non-goals

- **Presence.** Signal transmits no online/offline/idle/away state — it does not exist in the
  protocol. No availability indicators, idle timers, away messages, sign-on sounds, or warning
  levels. (Typing indicators and read receipts are *not* presence; they are per-message events
  and are wired through.)
- **History import.** Message history starts empty and accumulates going forward.
- **Calls.** Out of scope — surfaced as an "answer on phone" notice, never silently dropped.

## License

MIT. See [LICENSE](LICENSE).
