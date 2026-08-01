# Project state

Working notes for picking this up cold. Complements `SPEC.md` (what to build) and
`docs/signal-cli-rpc.md` (what the daemon actually does).

Last updated: 2026-07-31.

---

## Status in one line

Phases 1–5 are written, tested and green, the app runs against the live account, and group
conversations work.

`npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`, `npm test`
(98 tests) all pass, `npm run package` produces `release/AIMgnal-0.1.0-arm64.dmg` (117 MB), and
that packaged build has been launched from Finder: buddy list, live group chat rooms with named
members, and the daemon resolved from Homebrew. The first launch found four bugs no test could
have, and the first *packaged* launch found three more (both lists below).

**The build is unsigned and unnotarized.** It runs here; on any other Mac Gatekeeper will refuse
it ("damaged / cannot be opened"). The exact block to enable signing is written as a comment in
`electron-builder.yml`. It also needs signal-cli installed — the app spawns it, never bundles it
(SPEC §10).

---

## Environment

| Thing | Value |
|---|---|
| Repo | `~/Projects/aim-but-its-signal` (moved out of iCloud — an apostrophe in the old path broke node-gyp and electron-builder) |
| GitHub | `jessegill/aim-but-its-signal`, public, `main` |
| Product name | **AIMgnal** (`dev.aimgnal.app`) |
| Target | macOS **arm64 only**, minimum macOS 15 |
| signal-cli | **0.14.6** (Homebrew, a GraalVM native image) |
| Electron | **42** — pinned, see below |
| Node | 26.5.1 |
| Linked account | The user's **primary personal** Signal account, `+15550000000`, device 4 |
| Self ACI | `11111111-2222-4333-8444-555555555555` |

The account is at the 5-linked-device cap. Three stale `macOS` entries (devices 3, 5, 6) can be
removed from the phone to free a slot if a relink is needed.

---

## Decisions and why

Nothing here is arbitrary; each one has a failure mode behind it.

**Daemon runs multi-account (no `-a`).** `startLink`/`finishLink` return `-32601` when bound to
a single account, and SPEC §12 requires in-app QR linking. Cost: `account` must be passed on
every account-scoped request.

**`--receive-mode on-connection`, never `on-start`.** Under `on-start` the daemon pulls,
decrypts and *acknowledges* messages with no client attached, and never replays them.
signal-cli has no message store, so anything arriving while we are detached is lost permanently.
This was observed live, not inferred.

**UNIX socket, never TCP.** The daemon holds full account access. A localhost port is reachable
by every process on the machine; a socket file is permission-gated. It lives in a private `0700`
directory, and short — macOS caps socket paths at ~104 bytes.

**`better-sqlite3-multiple-ciphers`, not `better-sqlite3`.** Plain better-sqlite3 *silently
accepts* `PRAGMA cipher`/`hexkey` and writes cleartext. The store reads the file header after
keying and refuses to run on an unencrypted database.

**Electron pinned to 42.** The SQLCipher driver publishes Electron prebuilds only through ABI
146 (= Electron 42). Bumping forces a from-source build.

**`"type": "module"` deliberately NOT set.** It makes electron-vite emit the preload as ESM,
which Electron cannot load under `sandbox: true`. Silenced with a Node warning flag instead.

**Message identity is `(sender_id, sent_at)`**, enforced by a schema `CHECK`. There is no stable
server GUID in any envelope. Every reaction, quote, edit, delete and receipt resolves by that
tuple.

**Read receipts are not sent.** They leak read state for every message. Off until it is a
preference, not a default.

**Buddy group counts show unread/total, not online/total.** Presence does not exist in Signal
(SPEC §7). The iconic `Buddies (3/8)` form is kept with a message-derived number and a tooltip
saying so.

**Sender names are resolved on read, never stored on the message row.** A renamed contact — or
one given a local nickname — is renamed through their whole history at once. The alternative
leaves old names on old messages, which is a lie the user cannot correct.

**The buddy list is conversation-driven, not roster-driven.** A departure from SPEC §6, taken
deliberately: on a real account the roster is everyone who has ever had your number, and the few
conversations that matter drown in it. A buddy or room earns a row by carrying a message, or by
being pinned or archived. The whole roster is one toggle away — *Edit → Show All Contacts &
Rooms* — because a list of only people who have already written to you is a list you can never
start a conversation from.

**Sections are fixed in order: Pinned, the user's groups, Chat Rooms, Archived.** Pinned renders
even when empty, since it is the only place the pin gesture is discoverable. Archived appears
only when it holds something, and starts collapsed.

**A shelf belongs to the conversation, not to the buddy or the group.** `conversation_shelf` is
keyed by conversation id with no foreign key to either table — the same three states apply to a
person and to a room, and neither owner can hold a concept that spans both. Only departures from
`normal` are stored, so un-pinning is a delete rather than a written default.

**The banner shows the Signal username; the title bar shows the product.** AIM titled the buddy
list with the screen name, but that name is already the loudest thing on the page directly below
it. A username is opt-in on Signal, so the banner falls back to "My Account".

**A Signal group is a conversation, not a roster entry.** `signal_groups` is a separate table
from `buddy_groups` and the two are never joined; the roster is people (SPEC §6), a group is a
place. Rooms get their own fixed section in the buddy list, below the user's own groups, so a
room can never be dragged into one.

---

## Bugs real traffic found that source-reading did not

All four fail **silently**. This is why SPEC §11.1 says the spec's own signatures are not
authoritative.

1. **Phone-side edits were dropped.** A *received* edit is at `envelope.editMessage`; an edit
   made on another device is at `syncMessage.sentMessage.editMessage`. Stale text would have
   stayed on screen forever. Note the asymmetry — `sentMessage` is `@JsonUnwrapped`, but
   `editMessage.dataMessage` inside it is genuinely nested.
2. **View-once media vanished.** Its envelope has *no* `attachments` key and a null `message` —
   indistinguishable from protocol plumbing. It was discarded entirely.
3. **Attachment paths never resolved.** The envelope has no path field at all; the daemon writes
   the bytes to `~/.local/share/signal-cli/attachments/<id>` before we see the message. With a
   null path the store could not shred the daemon's copy, so a disappearing-message attachment
   would outlive its timer on disk. Security-relevant.
4. **The voice-note heuristic was backwards.** A voice note carries a generated filename
   (`signal-<date>.m4a`); a photo has `filename: null`. Content type is the only dependable
   signal.

Verified correct with no change needed: delete-for-everyone, reactions add/remove, quotes,
group routing, disappearing timers, `envelope.timestamp === sentMessage.timestamp`.

## Bugs the first *packaged* build found

None of these could happen in `npm run dev`, and all three were invisible: the app appeared in
the Dock, alive, with no window and no explanation.

1. **The database location guard rejected the correct location.** It refused any path inside
   `process.cwd()`, meaning "not in the source tree". An app launched from Finder has a working
   directory of `/`, so every absolute path qualified and the guard took the app down at
   start-up. It now looks for `.git` / `package.json` in the ancestors of the database path,
   stopping at `$HOME`, which is what it always meant.
2. **signal-cli was not found.** A Finder-launched app inherits `/usr/bin:/bin:/usr/sbin:/sbin`,
   which has no Homebrew in it, so `spawn('signal-cli')` failed with ENOENT. `resolveSignalCli()`
   now checks absolute locations, honours `AIMGNAL_SIGNAL_CLI`, and keeps the bare name as a
   fallback.
3. **Nothing listened to the daemon's output.** `SignalDaemon` emitted every line of signal-cli's
   stdout and stderr as a `log` event with no listener anywhere, so the one thing that could
   explain a failure was computed and discarded. The service now logs it, and a throw during
   start-up raises a dialog instead of leaving a windowless process.

## Bugs the first launch found

Four more, all at boundaries the tests stub out. Fixed in `d574a62`; the detail is in that
commit message. In short: `listAccounts` does not return the ACI (it has to come from
`listContacts`), sends were validated *after* the message had gone out, an unlistened `error`
emission killed startup, and window geometry was written to a closed database on quit.

---

## Ownership map

| Path | Contents |
|---|---|
| `src/main/rpc.ts` | JSON-RPC over the socket: framing, id correlation, timeouts, reconnect |
| `src/main/daemon.ts` | Spawn/supervise signal-cli; `signalCliAttachmentsDir()` |
| `src/main/events.ts` | Envelopes → typed domain events. Total, non-throwing |
| `src/main/service.ts` | The single owner: store + daemon + rpc + windows |
| `src/main/windows.ts` | `Map<ConversationId, BrowserWindow>`, geometry, flash |
| `src/main/ipc.ts` | Thin handlers, every argument validated |
| `src/main/store/signal-groups.ts` | Signal group conversations and their membership |
| `src/main/store/shelves.ts` | Pinned / archived state, keyed by conversation |
| `src/main/store/**` | Encrypted SQLite, expiry, outbound queue, 78 tests |
| `src/renderer/ui/**` | AIM 5.1 components + `showcase.html` (open directly in a browser) |
| `src/renderer/{buddylist,im,signon}/**` | The three window apps |
| `src/shared/types.ts` | IPC surface and domain types |

---

## Known gaps

Decisions, not typing:

- **No file picker, no attachment-open, no safety-number-verify UI.** The affordances render and
  name what is missing.
- **Group membership changes are not events.** Someone joining or leaving is only noticed at the
  next `listGroups` sync (bring-up, or the first message from an unknown group). There is no
  "X has entered the room" line.
- **Group admin actions are absent** — no create, rename, add/remove member, or leave. The store
  records `isAdmin`; nothing acts on it.
- **A window opened by an incoming message can render empty.** Seen once in the packaged build:
  `openOnIncoming` opened a chat room whose log then read "No messages yet", even though an
  arriving message is what opened it. The member list and title were correct, so this is the
  message read path, not the group. Not diagnosed.
- **Formatting toolbar is decorative** — `im:send` takes a plain body.
- **`group:reorder` semantics** — the renderer sends a desired 0-based index and expects main to
  re-index siblings. Undefined in the contract.
- **Code signing / notarization is off**, with the exact block written as a comment in
  `electron-builder.yml`. An unsigned build will be Gatekeeper-blocked.
- **Admin-delete** of another member's message is a separate method, not handled.

---

## Running it

**The capture session and the app cannot run at the same time** — signal-cli locks the account
data directory, and whichever starts second fails to acquire it. Kill any stray daemon first:

```sh
pkill -f 'signal-cli.*daemon'
pkill -f capture-envelopes
```

Then:

```sh
cd ~/Projects/aim-but-its-signal
npm run dev
```

The app spawns its own daemon on its own socket (`/tmp/aim-<uid>/signal.sock`). Expect the
daemon's first startup to be slow — it is a JVM native image doing account setup.

Confirmed working against the live account: bring-up, `listAccounts` → `listContacts` self
resolution, roster load (73 contacts), group sync (43 groups), and the buddy list rendering
both sections.

Still unexercised live, in order of likelihood of being wrong:

1. **Opening a group window.** Double-click a room under **Chat Rooms**. The group id is base64,
   so it travels through the window's query string percent-encoded — worth confirming the title
   bar shows the group name and the member list is populated rather than empty.
2. **Sign-on window.** Least real-world exercise of anything in the codebase. The service opens
   the buddy list first and swaps to sign-on only if no account turns out to be linked.
3. **Opening a 1:1 IM window** and whether geometry persists across a reopen.
4. **A live inbound message** routing to the right window, and the buddy list receiving it too
   for unread counts.
5. **A message from a group member who is not a contact.** Should show a truncated ACI, trigger
   one `listContacts` refresh, and then resolve to a real name in place without reopening.

Note there is no way to synthesize a click from a shell without assistive access, so anything
needing a double-click has to be checked by hand.

---

## Verification commands

```sh
npm run typecheck && npm run lint && npm run format:check && npm run build && npm test
./scripts/hooks/check-secrets.sh --tracked    # must pass before any commit
open src/renderer/ui/showcase.html            # the AIM component library, no build needed
```

`npm test` runs under `ELECTRON_RUN_AS_NODE=1 electron` because the SQLCipher driver is built
against Electron's ABI — plain `node` cannot `dlopen` it. This briefly bounces an Electron icon
in the Dock; that is expected and opens no window.
