# Retro IM — Build Spec

A desktop instant messenger with a **2003-era AIM 5.1 look and feel** that runs on the **real
Signal network** as a linked secondary device. Every conversation opens in **its own OS
window**.

This document is the complete specification. Build from it.

---

## 1. Product definition

**What it is:** an Electron desktop client that links to the user's existing Signal account
(phone stays primary, exactly like official Signal Desktop), presents a classic AIM buddy list
with user-defined collapsible groups, and opens each conversation in a separate operating
system window.

**Defining requirement — do not compromise this:** *each conversation gets its own real OS
window.* Not tabs, not panes, not in-frame floating divs. Real `BrowserWindow`s that appear in
the taskbar, can be moved between monitors, and remember their position. This is the core
product, and the architecture in §3 exists to serve it.

**Feature surface is deliberately small** — 1:1 text messaging, a grouped buddy list,
profiles, and attachments. This is not a Signal client competing on features; it is an AIM
experience riding Signal's network.

---

## 2. Fixed decisions

These are settled. Do not redesign them.

| Decision | Value |
|---|---|
| Network | Real Signal network |
| Device role | Linked secondary device; user's phone remains primary |
| Protocol backend | `signal-cli` running as a daemon, JSON-RPC over localhost |
| Shell | Electron + TypeScript |
| UI | React, built fresh (no forking of any existing Signal client) |
| Windows | One real OS window per conversation, from day one |
| Presence | **None.** See §7. |
| Buddy groups | Local-only, user-assigned, exclusive membership |
| Nicknames | Local per-buddy screen-name overrides |
| Message history | Starts empty and accumulates going forward. Acceptable. Do not build history import. |

---

## 3. Architecture

The Electron **main process is the single owner** of the protocol connection and all
application state. Renderer windows are **pure views** that hold no authoritative state and
never touch the network.

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

**Rules that make this work — violate none of them:**
- Exactly **one** signal-cli connection for the entire application. Never one per window.
- Renderers communicate only via IPC. No renderer opens a socket or spawns a process.
- A renderer may be closed or crash at any time without affecting message delivery.
- All persistence happens in the main process.

### IPC surface (initial)
```ts
// renderer → main
'im:getInitial'   (conversationId) → { messages, contact }
'im:subscribe'    (conversationId)
'im:send'         (conversationId, body, attachments?)
'im:markRead'     (conversationId)
'roster:get'      () → { groups, buddies }
'roster:move'     (buddyId, groupId)
'roster:setNick'  (buddyId, nickname)
'group:create' | 'group:rename' | 'group:delete' | 'group:reorder' | 'group:setCollapsed'
'window:openIm'   (buddyId)

// main → renderer (pushed)
'im:message'      (conversationId, message)
'im:typing'       (conversationId, isTyping)
'im:receipt'      (conversationId, messageId, state)
'roster:updated'  ()
'connection:state'(state)   // linked | linking | unlinked | daemon-down
```

---

## 4. Repository setup

Create a new GitHub repository. Suggested scaffold:

```
/src
  /main
    index.ts            entry, app lifecycle
    daemon.ts           signal-cli spawn/supervise/health
    rpc.ts              JSON-RPC client, reconnect logic
    events.ts           JSON-RPC payloads → typed domain events
    store/
      db.ts             SQLite connection, migrations
      messages.ts       message read/write + expiry enforcement
      roster.ts         buddies, groups, nicknames
      windows.ts        persisted window geometry
    windows.ts          BrowserWindow manager
    ipc.ts              IPC handler registration
  /renderer
    /buddylist          buddy list window app
    /im                 IM window app
    /ui                 shared AIM component library + theme
  /shared
    types.ts            types shared across main/renderer
/resources
  /sounds               message send/receive/typing
  /icons
```

**Stack:** `electron` + `electron-vite` + `typescript` + `react` + `better-sqlite3`.
State in renderers is local and ephemeral; no Redux needed — IPC push plus React state is
sufficient given main owns truth.

**Repo hygiene:** MIT or GPL-compatible license file (see §10), `.gitignore` covering
`node_modules`, build output, and **any local signal-cli data directory**. Never commit
account state, keys, or database files.

---

## 5. Build phases

Ship each phase working before starting the next.

### Phase 1 — Vertical slice (prove the architecture)
Ugly on purpose. No styling whatsoever.

1. Link signal-cli manually from a terminal first; confirm send/receive works before writing
   any application code. Do not debug two unfamiliar systems simultaneously.
2. Main process spawns and supervises the daemon, holds the JSON-RPC connection.
3. Buddy list window: unstyled list of contacts from `listContacts`.
4. Double-clicking a contact opens a **new `BrowserWindow`** for that conversation; focuses it
   if already open.
5. IM window: message log plus text input, wired through IPC.
6. Inbound messages route to the correct window; if none is open, open one.
7. In-memory state only — no database yet.

**Done when:** two IM windows are open simultaneously, both receiving live messages, both able
to send, no crosstalk, and exactly one daemon connection exists.

### Phase 2 — Persistence
SQLite via `better-sqlite3`, **encrypted at rest**. Schema in §6.
Message expiry (§8) must be enforced from the first commit that writes messages to disk — not
retrofitted later.

### Phase 3 — Roster and groups
Buddy groups, exclusive membership, ordering, collapse state, nicknames. Context menus for
assignment and group management. See §6.

### Phase 4 — AIM skin
Apply the visual system in §9 across both window types.

### Phase 5 — Message type coverage
Implement the handling matrix in §8.

### Phase 6 — Polish
Sounds, preferences window, window geometry persistence, packaging.

---

## 6. Data model

### Roster is contact-based, not conversation-based
This distinction matters. A buddy list contains **everyone the user knows**, including people
they have never messaged. A conversation list contains only people they have exchanged
messages with. Build the former.

- Roster entries are keyed by **Signal contact identity (ACI/UUID)**, never by conversation id.
- A roster entry with zero messages is valid and must render normally.
- Opening an IM window for a buddy with no prior conversation must create the conversation on
  demand.
- Buddies not explicitly assigned to a group fall into a default group named `Buddies`.

### Tables
```sql
buddies         (id TEXT PRIMARY KEY,      -- Signal ACI/UUID
                 display_name TEXT,
                 nickname TEXT,            -- local override, nullable
                 profile_key BLOB)

buddy_groups    (id INTEGER PRIMARY KEY,
                 name TEXT NOT NULL,
                 sort_order INTEGER NOT NULL,
                 collapsed INTEGER NOT NULL DEFAULT 0)

buddy_group_members
                (buddy_id TEXT NOT NULL REFERENCES buddies(id),
                 group_id INTEGER NOT NULL REFERENCES buddy_groups(id),
                 sort_order INTEGER NOT NULL,
                 PRIMARY KEY (buddy_id))     -- exclusive membership

messages        (id TEXT PRIMARY KEY,
                 conversation_id TEXT NOT NULL,
                 sender_id TEXT NOT NULL,
                 body TEXT,
                 sent_at INTEGER NOT NULL,
                 received_at INTEGER,
                 expires_at INTEGER,         -- NULL = never; see §8
                 edited_at INTEGER,
                 quote_id TEXT,
                 kind TEXT NOT NULL)         -- text | attachment | sticker | tombstone | ...

window_geometry (conversation_id TEXT PRIMARY KEY,
                 x INTEGER, y INTEGER, w INTEGER, h INTEGER)
```

`PRIMARY KEY (buddy_id)` on the membership table enforces exclusive group membership at the
schema level. Keep it that way.

---

## 7. No presence — this is a hard constraint

Signal transmits no online/offline/idle/away state. It does not exist in the protocol and
cannot be obtained.

**Therefore, do not build:**
- Online/offline indicators or icons
- Idle timers or "away" status
- Away messages
- Buddy sign-on / sign-off sounds
- Warning ("evil") levels
- Any grouping or sorting derived from availability

Buddy groups are purely user-defined organization. If a task seems to require presence, it is
out of scope — flag it rather than approximating it.

**Typing indicators and read receipts are NOT presence** — they are per-message events, they
do exist in the protocol, and they should be wired through.

---

## 8. Message handling

Modern Signal contacts will send message types AIM never had. Silently dropping them produces
a client that is quietly lossy and misleading. Every row below needs defined behavior.

### Security-critical — must be correct before any release
| Requirement | Behavior |
|---|---|
| **Disappearing messages** | Honor the timer. Enforce `expires_at` deletion in the store layer, not the UI. A message the sender believed was ephemeral must not persist in local SQLite. Test this explicitly. |
| **View-once media** | Honor view-once semantics or refuse to display. Never persist. |
| **Safety numbers / identity changes** | Surface these. Render an AIM-styled equivalent — never omit a security signal because the retro idiom lacks a place for it. |
| **Encryption at rest** | The local database is encrypted. Deletions and expiries actually remove data. |
| **Deleted for everyone** | Replace with a tombstone and purge the original from the store. |

> **When retro authenticity conflicts with a security signal, security wins.** Style the
> security element to fit the era; do not drop it.

### Graceful degradation — may ship incrementally
| Type | Behavior |
|---|---|
| Reactions | Render inline, e.g. `[♥ from Bob]`. Never drop silently. |
| Quote / reply | Render a quoted stub above the message. |
| Edited message | Show current text plus an edit marker. Never present stale text as current. |
| Attachments | Render inline where practical; otherwise a clear labeled affordance. |
| Voice notes | Play, or show "unsupported — open on phone". |
| Stickers | Render, or a labeled placeholder. |
| Group messages | Open in an AIM chat-room-styled window; sender attribution required. |
| Calls | Out of scope. Show a "call — answer on phone" notice; never stay silent. |

### Linked-device behaviors that are easy to get wrong
- **Messages the user sends from their phone arrive as sync messages and must render.** If
  this is missed, the app feels broken in a confusing way — the user types on their phone and
  the desktop stays silent. Handle sync messages as first-class inbound events.
- **Echo protection:** track sent timestamps so the user's own outbound messages do not
  double-render when they return via sync.
- **Connection states** must be visible to the user: `linked`, `linking`, `unlinked`,
  `daemon-down`. Provide a path to re-scan a QR code and relink.

---

## 9. Visual specification (AIM 5.1)

### Windows
**Sign-on / linking window** — first run shows a QR code for the user to scan from their
phone. Style it as the classic AIM sign-on window.

**Buddy list window** — narrow and tall. Title bar, menu bar, collapsible group tree, buddy
count per group (e.g. `Buddies (3/8)`). Groups show a triangle/plus expander. Double-click a
buddy to open an IM window.

**IM window** — one per conversation. Message history pane on top, input pane below, a
formatting toolbar between them, and a Send button bottom-right.

### Style tokens
| Property | Value |
|---|---|
| Chrome background | `#ECE9D8` (XP gray) |
| Title bar | `#0054E3` gradient to lighter blue, white bold text |
| Accent | AIM yellow `#FFCC00` |
| Font | Tahoma, fallback MS Sans Serif / Verdana, ~11px |
| Corners | **Square everywhere.** `border-radius: 0` globally. |
| Panels/buttons | `border: 2px outset` |
| Text inputs | `border: 2px inset`, white background |
| Messages | **No chat bubbles.** Plain text, bold colored sender name, inline timestamps. |
| Density | Tight. Small rows, minimal padding. |

The single highest-impact rule is square corners — rounded geometry reads as modern
immediately.

### Window behavior
- Persist each IM window's position and size **per conversation**; restore on reopen.
- Incoming message with a window open: flash the window and play the receive sound.
- Incoming message with no window open: open one. Make this a user preference — it was one in
  AIM.
- Closing an IM window closes only that conversation.
- Closing the buddy list must not orphan IM windows or hard-quit. Choose tray or minimize
  behavior deliberately.
- Each window is a renderer process. Cap open windows or tear down idle ones.

### Sounds
Message send, message receive, typing. Message-driven only — there are no presence events to
sound.

### Assets
Do **not** ship extracted AIM or AOL artwork. The running man and AIM marks are not ours to
distribute. Create original look-alike assets.

---

## 10. Constraints

- **Naming and branding:** do not use "Signal" or "AIM"/"AOL" names, logos, or marks in the
  product name, UI, icons, or repository name. Pick an original name.
- **Licensing:** `signal-cli` is GPLv3 and runs as a **separate process communicated with over
  JSON-RPC** — keep that boundary clean and do not vendor its source into this codebase.
  License this repository compatibly and publish the source.
- **Account safety:** during development, link to a **secondary test Signal account**, not the
  developer's primary account. A linked device has full account access; a bug can send garbage
  to real contacts.
- **Never modify or reimplement cryptography.** Use the daemon as-is. No key handling in this
  codebase.
- **Five linked devices per account maximum.** This client uses one slot.

---

## 11. Working rules

1. **Verify, do not assume.** Confirm signal-cli's actual JSON-RPC method names, parameters,
   and event payload shapes against the installed version before writing code against them.
   Command signatures in this document are indicative, not authoritative.
2. Pin the signal-cli version. Record it in the README.
3. One connection, always. Renderers are network-silent.
4. Enforce message expiry in the store layer, never only in the UI.
5. Security requirements in §8 outrank visual authenticity.
6. Each phase ends with a green build and its stated done-criteria met.

---

## 12. Definition of done (v1)

- Links to a Signal account by QR code from the app.
- Buddy list shows all contacts, organized into user-created collapsible groups with
  exclusive membership, ordering, and nicknames.
- Double-clicking a buddy opens a real OS window for that conversation; multiple conversation
  windows operate simultaneously and independently.
- Window positions persist per conversation.
- Messages send and receive in real time, including messages sent from the user's phone.
- Every row in §8 has defined behavior; all security-critical rows are verified by explicit
  test.
- The application looks like AIM 5.1.
- Source published; no Signal or AOL branding; no extracted assets.
