# Roadmap

What is next, and what each item actually requires. `docs/STATE.md` records where the project
*is*; this records where it is going.

Ordering within a section is rough priority. An item is done when it works against the live
account, not when it compiles.

Last updated: 2026-08-01.

---

## Now — the three main-process capabilities

All three are blocked on the same thing: a renderer cannot touch the disk or the system UI
(SPEC.md §3), so each needs a channel in `src/shared/types.ts`, a validated handler in
`src/main/ipc.ts`, and an entry in the preload allowlist. The buttons already exist and
currently explain what is missing instead of doing nothing.

### 1. Attach a file

- [ ] `dialog:pickAttachments` → `dialog.showOpenDialog` in main, returning absolute paths.
- [ ] Wire the 📎 toolbar button and *File → Send File…* to it. Both currently raise the
      `ATTACH_NOTICE` in `src/renderer/im/App.tsx`.
- [ ] Pass the chosen paths through the existing `im:send(conversationId, body, attachments)`
      argument, which is already plumbed to signal-cli's `attachment` param and already
      validated by `optionalStringArray`.

The send path needs no protocol work — `service.send` already forwards attachments. This is
almost entirely a picker and a button.

Worth deciding: whether to copy the file into the attachment cache before sending. signal-cli
reads the path at send time, so a file the user moves or deletes in between fails the send.

### 2. Open a received attachment

- [ ] `attachment:open(messageId, attachmentId)` → resolve the cached path in main, then
      `shell.openPath`.
- [ ] Wire `onOpenAttachment`, which currently raises `OPEN_ATTACHMENT_NOTICE`.
- [ ] Resolve the path in **main from the message id**, never from a path supplied by the
      renderer — a renderer-supplied path is an arbitrary-file-open primitive.

**This one has a security decision in it, not just plumbing.** Attachments in a
disappearing-message conversation are shredded when the timer expires (SPEC.md §8), and the
store goes to real trouble to make that stick. Handing the file to another application copies
it somewhere the sweep cannot reach — Preview's recents, QuickLook's thumbnail cache. Decide
explicitly:

- refuse to open attachments on expiring messages, or
- warn once, or
- allow it and accept that the guarantee ends at the app boundary.

Whatever is chosen, say so in the UI. Silently weakening the disappearing-message promise is
the one outcome that is not acceptable.

### 3. Emoji picker on the smiley button

- [ ] `app.showEmojiPanel()` — Electron exposes the macOS system picker directly, and it is
      main-process only, so it needs a channel.
- [ ] Wire the `:-)` toolbar button (`onInsertEmoticon`, currently unwired).

The system panel inserts into the focused text field itself, so there is likely nothing to
plumb back — but confirm that it reaches a `<textarea>` inside a `sandbox: true` renderer
rather than assuming it.

Open question: the panel inserts Unicode emoji, while AIM's own smiley menu inserted `:-)` and
rendered it as a graphic. Decide whether this button is "insert emoji" or "insert AIM emoticon".
They are different features and the era-correct one is the second.

---

## Next — gaps with a decision behind them

Recorded in `docs/STATE.md` under Known gaps; repeated here only as work items.

- [ ] **Scrollback.** `getInitial` hardcodes `limit: 200` and there is no way to reach older
      messages. The store already supports it — `getMessages` takes a `beforeSentAt` cursor and
      a limit up to 5,000 — so this is an IPC channel plus a "load earlier" affordance. Do this
      *before* the Desktop import below, or most of what is imported will be invisible.
- [ ] **Import history from Signal Desktop.** `~/Library/Application Support/Signal/sql/db.sqlite`
      is SQLCipher, which this project can already read. Message identity is `(sender_id, sent_at)`
      and Desktop stores both, so re-running the import is idempotent by construction. Must
      filter expired and view-once content on the way in. Signal's linked-device protocol will
      not backfill and signal-cli keeps no store, so this is the only route to old history.
- [ ] **Safety-number verification UI.** `onVerifySafetyNumber` raises a notice; the identity
      store already records safety numbers and change events.
- [ ] **A window opened by an incoming message can render empty.** Observed once in the packaged
      build: the log read "No messages yet" in a chat room that an arriving message had just
      opened. Title and member list were correct, so this is the read path, not groups. Not
      diagnosed.
- [ ] **Formatting toolbar is decorative.** `im:send` takes a plain body; Signal supports ranged
      text styling. The toolbar renders and toggles but nothing reaches the wire.
- [ ] **Group membership changes are not events.** Joins and leaves are only noticed at the next
      `listGroups` sync. No "X has entered the room" line, which the chat-room idiom wants.
- [ ] **Group admin actions.** No create, rename, add/remove member, or leave. `isAdmin` is
      stored and nothing acts on it.
- [ ] **Admin-delete** of another member's message is a separate signal-cli method, unhandled.
- [ ] **`group:reorder` semantics are undefined** in the contract — the renderer sends a desired
      0-based index and expects main to re-index siblings.

---

## Before anyone else can run it

- [ ] **Code signing and notarization.** The build is unsigned; Gatekeeper blocks it on any Mac
      that is not this one. The exact configuration block is already written as a comment in
      `electron-builder.yml`, including the two entitlements the hardened runtime needs — V8
      wants `allow-unsigned-executable-memory`, and spawning signal-cli wants
      `disable-library-validation`.
- [ ] **Say so when signal-cli is missing.** `resolveSignalCli()` falls back to the bare name and
      the app reports `daemon-down`, which is honest but indistinguishable from a crashed daemon.
      A first-run check that names the actual problem — and links to the install — is the
      difference between "broken" and "one brew install away".
- [ ] **Read receipts as a preference.** Deliberately never sent (they leak read state for every
      message). The decision was "off until it is a preference, not a default", so the remaining
      work is the preference, not the sending.

---

## Not planned

- **Presence of any kind.** Signal transmits none (SPEC.md §7). Typing indicators and receipts
  are per-message protocol events and are built; online/idle/away are not coming, and any slot
  that looks like it wants them stays empty rather than being filled with a guess.
- **Voice and video calls.** Out of scope (SPEC.md §8). Call envelopes render a "answer on phone"
  notice so the app is never silent about one.
- **Reimplementing any cryptography.** signal-cli is a separate GPLv3 process for a reason
  (SPEC.md §10). No key material is handled in this codebase.
