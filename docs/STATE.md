# Project state

Working notes for picking this up cold. Complements `SPEC.md` (what to build),
`docs/signal-cli-rpc.md` (what the daemon actually does), and `docs/ROADMAP.md` (what is next).
This file is the present tense; the roadmap is the future one.

Last updated: 2026-11-14.

---

## Status in one line

Phases 1–5 are written, tested and green, the app runs against the live account, and group
conversations work. Relinking from the app's own QR code was exercised live on 2026-11-14,
after this computer had been removed from the phone's Linked Devices.

`npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`, `npm test`
(130 tests) all pass, `npm run package` produces `release/AIMgnal-0.1.0-arm64.dmg` (117 MB), and
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
| Repo | `~/Library/Mobile Documents/com~apple~CloudDocs/Projects/aim-but-its-signal` — iCloud Drive, kept downloaded locally. The old path had an apostrophe that broke node-gyp; this one does not |
| GitHub | `jessegill/aim-but-its-signal`, public, `main` |
| Product name | **AIMgnal** (`dev.aimgnal.app`) |
| Target | macOS **arm64 only**, minimum macOS 15 |
| signal-cli | **0.14.6** (Homebrew, a GraalVM native image) |
| Electron | **42** — pinned, see below |
| Node | 26.5.1 |
| Linked account | The user's own Signal account, as a linked device. The number and ACI are deliberately not written down here — this repository is public |

Signal allows five linked devices per account. Remove stale entries from the phone before
relinking if it refuses.

**Never write the account's phone number or ACI into a tracked file.** Both were once
committed here and had to be scrubbed from history. `scripts/hooks/check-secrets.sh` now
refuses real-looking phone numbers, and refuses exact strings listed in the untracked
`.git/info/check-secrets-denylist` (put the number and ACI there in any fresh clone). Run
`scripts/hooks/install-hooks.sh` once per clone, or the pre-commit guard never runs.

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

**Main refuses any attachment path it did not vend.** The picker records every path it hands a
renderer; `im:send` rejects anything else. Without that ledger the attachments argument is an
arbitrary-file-*read* primitive — a compromised renderer could name any file on the disk and
have main mail it to a contact, and it would look like an ordinary send from every angle.

**A file the user sends is copied into the cache; their original is never touched.**
`AttachmentCache.adopt` is deliberately separate from `ingest` for this: `ingest` shreds its
source because that source is the daemon's scratch copy, and doing the same to a document in the
user's own folder would be unrecoverable. The copy is what the sender's own history points at,
which is also what puts a sent file inside the expiry sweep — Signal never syncs a message back
to the device that sent it, so without the copy there would be no record here at all.

**Opening an attachment on an expiring message warns, then allows.** Refusing would make a
legitimate file unreachable on the machine it was sent to and push the user to screenshot it.
Allowing silently would weaken the disappearing-message promise without the person relying on it
being told. So the warning names the actual leak — Preview's recents, Quick Look's thumbnail
cache — and its "don't warn again" is session-scoped and never persisted.

**The formatting toolbar is AIM's icon strip, not a set of dropdowns.** Colour, size, style,
inserts — four groups, in AIM's order, no font/size menus and no palette of colour chips. The
controls the protocol cannot carry (colour, size, underline) are marked by hover text rather
than greyed out: they were greyed while clicking one changed a state object nothing read, and an
inert button is better greyed than live. They now restyle the composer, so they are honest.

**The smiley button inserts Unicode emoji, not `:-)`.** AIM's own menu inserted text and each
end drew its own graphic — era-correct, and not what ships, because it is not what the other end
sees: a Signal recipient's phone renders 🙂, so the picker offers 🙂. A period-accurate control
whose output nobody else's client understands is a costume, not a feature. The chrome around the
grid is still 2003; it is the glyphs that are modern, because the glyphs are what travels.

**`app.showEmojiPanel()` does not work here and was removed.** The macOS system panel is never
presented when the focused field is a `<textarea>` inside a `sandbox: true` renderer. The channel
is gone rather than left as a button that silently does nothing — which is how it was found.

**Inline attachment images are served on a custom scheme, not `file://`.** A `file://` subresource
loads from a packaged renderer (itself a `file://` document) and is blocked in dev, where the
renderer comes from `http://localhost:5173` — so thumbnails rendered when packaged and silently
vanished under `npm run dev`. `aimgnal-attachment://` behaves identically in both, and follows the
same rule as `attachment:open`: the URL carries **ids, not a path**, main resolves the path from
the message row, and nothing outside the cache can be served.

**Chat-room colours are hashed from the ACI, not assigned by list position.** Position-based
assignment would re-tint everyone below a member who left, changing colours throughout a
scrollback the user had already learned to read. The cost is collisions past twelve members,
which is a legible failure — the names are still spelled out on every line.

**Receives that arrive before the account's ACI is known are buffered, not dropped.** Under
`on-connection` the backlog that queued while the app was shut arrives the instant the socket
connects, a couple of round trips before bring-up knows who "self" is. Dropping it lost every
message received while the app was closed, permanently — the daemon had already acknowledged
it. The buffer is flushed synchronously, so arrival order is kept.

**An unregistered account is detected, not suffered.** A daemon started after the phone removed
this device drops the account (`listAccounts` → `[]`, every account call → `-32602 Specified
account does not exist`); one already running gets authorization failures. Either sends the app
to the sign-on window, and the daemon is restarted so it forgets the stale account.

**The sign-on window always has a code.** Main generates one the moment it finds no linked
account, brings the window to the front, and replaces the code if it expires unscanned.
`finishLink` gets a 10-minute timeout; on the 30 s default every scan slower than that failed.
After a link, the RPC connection is renewed, because the daemon subscribes a connection only to
accounts that existed when it opened.

**A partial send failure is written into the conversation.** signal-cli fails `send` only when
*no* recipient got it. In a group, members who did not (changed safety number, unregistered)
are listed in a `system` notice — "Not delivered to Dave (their safety number changed)" — instead
of the message simply reading "sent".

**A first-ever message does not open a window.** A conversation with no history and no pin is a
stranger, in effect a message request: it notifies and appears in the buddy list, but does not
put a window on screen uninvited. Messages from blocked contacts and blocked rooms are discarded
and their media shredded.

**Notifications carry no text for a disappearing message.** Notification Center keeps its own
copy, which would outlive the timer. The Dock badge counts unread messages and clears when a
conversation is read here or on the phone (`sync-read` → `im:read`).

**IPC checks which window is asking.** Conversation-scoped requests are refused unless they come
from that conversation's own IM window, so one compromised renderer cannot read or send in every
conversation.

**Ordering is by neighbour, never by index.** `roster:move(buddy, group, beforeBuddyId)` and
`group:reorder(group, beforeGroupId)` insert before a named sibling (null: the end) and renumber
the whole group 0…n-1. An index fails here because the tree hides members — contacts never
messaged, empty groups — so a position counted in what the user sees is not the stored one. The
old `group:reorder` wrote the index straight into `sort_order`, tied with a neighbour, and Move
Up/Down often did nothing.

**Drag and drop moves only what a context menu could already move.** Buddies into or within
the user's groups, buddies and rooms onto Pinned or Archived, rooms back to Chat Rooms, group
headers before or after each other. A room can never enter a buddy group, and the synthetic
section headers never move. The dragged item lives in a ref, not the drag payload, so nothing
dropped from outside the window can act.

**Dropping or pasting a file opens "Send Picture" — without loosening the picker ledger.** Main
still sends only paths it vended. A dropped file's path is derived in the *preload* with
`webUtils.getPathForFile` from a browser-created File, and sent on a preload-only channel
absent from the renderer's allowlist; a renderer cannot forge a File with a path, so it still
cannot name an arbitrary file. A pasted image has no file behind it, so main writes the bytes
to `userData/staging/` (0700), vends that, deletes it once the send has been copied into the
attachment cache, and empties the folder at start and stop. The description is sent as the
message body — Signal's caption. Navigation is now limited to the app's own pages: an unclaimed
file drop used to navigate a window to the dropped file.

**A second copy refuses to start.** `npm run dev` and the packaged app have different
user-data directories and therefore different single-instance locks, but the same daemon socket
— and `start()` deletes a leftover socket file, which cut the running copy off. Start-up now
probes the socket and says "already running" instead.

**Sign Off erases this computer's copy.** A linked device cannot remove itself from the account,
so *File → Sign Off and Relink…* deletes signal-cli's local credentials for the account and this
app's database, key and attachments, relaunches into the QR code, and tells the user to remove
the device on the phone.

---

## Bugs a code review found (2026-11-14)

1. **Every message received while the app was closed was lost.** See the buffering decision
   above. Source-reading found it; nothing in the tests could, because the tests never model
   the order in which bring-up and the backlog race.
2. **The QR code never appeared.** The sign-on window was written against a channel that did
   not exist yet and was never revisited once it did: nothing called `startLink`, the code was
   read from a query string nobody set, and Relink / Restart Service showed "not wired yet".
3. **Two daemon connections.** `rpc.connect()` opened a second socket while the reconnect loop
   was already opening one, so every receive arrived twice (deduplicated by the store) and
   bring-up ran twice in parallel. Found from the log of the relink.

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

## The bug using it found

**Outgoing messages were stuck on "sending…" forever.** Reported for group chats; it affected
every conversation. Two bugs, the second being why the first never healed. Fixed in `3efeeaf`.

1. **The optimistic row overwrote the authoritative one.** `im:send` resolves only *after* main
   has persisted and pushed the message, and Electron delivers that push before the invoke
   reply — so the renderer's "sending" placeholder landed on top of a row already marked `sent`
   and dragged it backwards. The placeholder now yields to a row that has already arrived.
2. **Receipts resolved against the wrong party.** A delivery receipt is sent *to* us *by* the
   recipient, but the message it acknowledges is one *we* wrote: the key is `(selfId, sentAt)`.
   The code used the ACI of whoever sent the receipt, which matches no row this app has ever
   written, so the UPDATE hit nothing and the pushed id referred to no message. Nothing outgoing
   could ever advance.

Receipts are now monotonic as well. In a group every member acknowledges separately and in
arbitrary order, so a late `delivered` would otherwise drag an already-`read` message back down
and the state would flap for as long as receipts kept arriving.

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

## The bug that was visible only in *dev*

The mirror image of the section above, and worth its own heading because the lesson is the pair,
not either half.

**Inline attachment thumbnails never rendered under `npm run dev`.** `MessageLog` built
`<img src="file://…">`. A packaged renderer is itself a `file://` document and loads that fine; a
dev renderer is served from `http://localhost:5173`, and Chromium refuses a `file://` subresource
from an `http://` origin. So the feature worked in the build nobody develops against and was
broken in the one everybody does — silently, with no console error the app surfaces.

Fixed with the `aimgnal-attachment://` scheme, which behaves the same in both and is strictly
tighter than `file://`: the URL carries ids, main resolves the path from the message row, and
nothing outside the attachment cache can be served.

Three bugs hid until the first packaged launch; this one hid until the first dev launch *after*
a packaged one. **Neither build is the real one.** A change to how a renderer loads anything off
disk has to be tried in both.

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
| `src/main/signal-results.ts` | `send` result failures; "is this device unlinked?" detection |
| `src/main/service.ts` | The single owner: store + daemon + rpc + windows |
| `src/main/windows.ts` | `Map<ConversationId, BrowserWindow>`, geometry, flash |
| `src/main/ipc.ts` | Thin handlers, every argument validated |
| `src/main/store/signal-groups.ts` | Signal group conversations and their membership |
| `src/main/store/shelves.ts` | Pinned / archived state, keyed by conversation |
| `src/main/store/**` | Encrypted SQLite, expiry, outbound queue, attachment cache |
| `src/renderer/ui/**` | AIM 5.1 components + `showcase.html` (open directly in a browser) |
| `src/renderer/ui/senderColors.ts` | Per-member colour in chat rooms, hashed from the ACI |
| `src/renderer/ui/emoji.ts` | The emoji the smiley button offers. Unicode, not `:-)` |
| `src/renderer/{buddylist,im,signon}/**` | The three window apps |
| `src/shared/types.ts` | IPC surface, domain types, and the `aimgnal-attachment://` URL |

---

## Known gaps

Decisions, not typing:

- **No safety-number-verify UI.** The affordance renders and names what is missing. The file
  picker and attachment-open are wired now, so this is the last of the three — and the last
  "not wired yet" notice left in the IM window.
- **Group membership changes are not events.** Someone joining or leaving is only noticed at the
  next `listGroups` sync (bring-up, or the first message from an unknown group). There is no
  "X has entered the room" line.
- **Group admin actions are absent** — no create, rename, add/remove member, or leave. The store
  records `isAdmin`; nothing acts on it.
- **A window opened by an incoming message can render empty.** Seen once in the packaged build:
  `openOnIncoming` opened a chat room whose log then read "No messages yet", even though an
  arriving message is what opened it. The member list and title were correct, so this is the
  message read path, not the group. Not diagnosed.
- **Formatting stops at the composer** — the toolbar restyles the input pane, but `im:send` takes
  a plain body and Signal's ranged styling is unused.
- **Code signing / notarization is off**, with the exact block written as a comment in
  `electron-builder.yml`. An unsigned build will be Gatekeeper-blocked.
- **Admin-delete** of another member's message is a separate method, not handled.
- **No preferences window.** Sounds, notifications and open-on-incoming are always on (the last
  except for first contact). They are fields in `service.ts`, not settings.
- **"First contact" is a heuristic** — no history and no pin. Signal's own message-request
  acceptance state is not read, and there is no Accept / Block action.
- **The duplicate-connection bug may explain the empty-window report above**: bring-up ran
  twice in parallel. Unconfirmed; worth re-checking before digging further.

---

## Running it

**Only one thing can hold the account at a time** — signal-cli locks the account data
directory, and whichever starts second fails to acquire it. That covers the capture session, a
`npm run dev` run, *and* a packaged AIMgnal still open from earlier: the packaged app spawns its
own daemon on the same socket. Check before launching, and kill any stray:

```sh
pgrep -fl 'signal-cli|AIMgnal'
pkill -f 'signal-cli.*daemon'
pkill -f capture-envelopes
```

`npm run dev` and `npm run preview` clear `ELECTRON_RUN_AS_NODE` themselves. VS Code's
integrated terminal exports it, and with it set Electron starts as plain Node and crashes on
`app.requestSingleInstanceLock`. Anything else that launches Electron from that terminal needs
`env -u ELECTRON_RUN_AS_NODE` too.

**A main-process change needs a real restart, not a reload.** electron-vite hot-reloads renderers
only; the main bundle is built once at start. Anything that runs before `app.whenReady()` — the
`aimgnal-attachment://` scheme registration, in particular — will not exist in a running process
no matter how many times its file is saved.

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

**Sending and opening files and chat-room colours are written and green but have not been
clicked.** See the top of `docs/ROADMAP.md` for what each one decided and "Confirming these by
hand" for what to try first. Inline thumbnails need checking in the packaged build as well as in
dev: they were broken in exactly one of the two before the custom scheme, which is the failure
mode that hid three bugs until the first packaged launch.

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
