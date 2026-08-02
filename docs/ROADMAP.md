# Roadmap

What is next, and what each item actually requires. `docs/STATE.md` records where the project
*is*; this records where it is going.

Ordering within a section is rough priority. An item is done when it works against the live
account, not when it compiles.

Last updated: 2026-08-01.

---

## Now — awaiting a live check

All four items below are written and green: `npm run typecheck`, `npm run lint`,
`npm run format:check`, `npm run build`, `npm test` (123 tests). Item 3 has been exercised
against the running app; the rest still need clicking — see "Confirming these by hand".

### 1. Attach a file — done, unverified live

- [x] `dialog:pickAttachments` → `dialog.showOpenDialog` in main, returning absolute paths plus
      name, size and content type, sheet-attached to the conversation's own window.
- [x] Wire the 📎 toolbar button, the *Attach…* button and *File → Send File…*.
- [x] Pass the chosen paths through `im:send(conversationId, body, attachments)`.
- [x] Refuse files over 100 MB at pick time, with the reason, rather than at send time with a
      daemon error.
- [x] Allow an empty body when there are attachments — a file with no caption is ordinary.

**Decided: the file is copied into the attachment cache, but *after* the send, not before.**
The roadmap raised this as a pick-time question; it turned out to matter for a second reason
that outranks it. `markOutboundSent` was writing `kind: 'text'` and no attachment rows, so a
sent file left **no trace in the sender's own log at all** — and Signal never syncs a message
back to the device that sent it, so nothing would ever have filled that in. The cached copy is
now what the sender's own history points at, which also puts it inside the expiry sweep: a file
sent into a disappearing-message conversation is shredded here on the timer like any other.

The user's own original is never touched. `AttachmentCache.adopt` exists precisely so this
cannot be confused with `ingest`, which shreds its source on purpose because that source is the
daemon's scratch copy.

Also closed a hole the picker opened: **main refuses any attachment path it did not itself
vend.** `im:send` taking a renderer-supplied path is an arbitrary-file-*read* primitive — a
compromised renderer could name `~/.ssh/id_ed25519` and have main mail it to a contact, and
every part of that would look like an ordinary send.

### 2. Open a received attachment — done, unverified live

- [x] `attachment:open(messageId, attachmentId)` → resolve in main, then `shell.openPath`.
- [x] Wire `onOpenAttachment`.
- [x] The path is resolved in main **from the message id**, and is additionally required to sit
      inside our own cache root, so a row holding a foreign path could not open one either.

**Decided: warn, then allow.** Of the three options, refusing would make a legitimate file
unreachable on the machine it was sent to and push the user to screenshot it instead — worse by
every measure. Allowing silently would weaken a promise the rest of the codebase keeps
carefully, without the person relying on it ever being told.

So: a native warning on the first attachment of an expiring message, naming the actual leak
(Preview's recents, Quick Look's thumbnail cache), with a "don't warn me again" that lasts the
session and is not persisted. Attachment chips on expiring messages carry a ⧗ and say the same
thing on hover. The guarantee ends at the app boundary and the UI says so — which was the one
condition this item set.

### 3. Smiley button — done

- [x] Wire the smiley toolbar button to an in-window emoji picker.
- [x] Insertion at the caret, not appended — appending is wrong the moment the user goes back to
      fix a word mid-sentence.

**Decided: Unicode emoji, not AIM emoticons.** The open question asked which of the two this
button is; the answer is the modern one, and the reason is the recipient. AIM's menu inserted
`:-)` as text because both ends drew their own graphic from it — but a Signal recipient's phone
renders 🙂, so that is what the picker offers. A period-accurate control whose output nobody
else's client understands is a costume. The chrome stays 2003; the glyphs are what travels.

**`app.showEmojiPanel()` was tried first and does not work.** The macOS system panel is never
presented when the focused field is a `<textarea>` inside a `sandbox: true` renderer — the
concern SPEC.md §11.1 exists for, confirmed the only way it could be. The channel was removed
rather than left as a button that silently does nothing, and the picker is an in-window grid
instead: seven categories, a few hundred curated emoji, no dependence on the OS.

### 4. A colour per member in a chat room — done, unverified live

- [x] Stable per-sender colour in group conversations, in the message log and the member list.

Derived from the sender's ACI by hash, not from their position in the member list: assigning by
position would re-tint everyone below a member who left, changing the colours in a scrollback
the user had already learned to read. Hashing costs collisions in rooms larger than the twelve
colours — a legible failure, since the names are still spelled out on every line.

Own lines stay `--ink-me` red. 1:1 windows are untouched: two people do not need more than
AIM's two colours. Every palette entry clears 4.5:1 on the log's white, asserted in the test
rather than eyeballed.

### Confirming these by hand

In order of likelihood of being wrong:

1. **Sending a file**, then confirming it appears in your *own* log with a thumbnail or a chip.
   That path had no coverage at all before and is new code end to end.
2. **Inline thumbnails under `npm run dev`.** They were broken before the custom scheme and the
   breakage was invisible in a packaged build — so this needs checking in *both*, not one.
   Registering the scheme happens before app-ready, so a hot reload will not pick it up; the app
   has to be restarted.
3. **Opening a received attachment on a disappearing message** — that the warning appears once,
   that "don't warn again" holds for the session, and that Cancel opens nothing.
4. **A chat room with more than two active speakers**, for whether the colours actually help.

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
      store already records safety numbers and change events. Now the last remaining notice of
      its kind in the IM window — the other two are wired.
- [ ] **A window opened by an incoming message can render empty.** Observed once in the packaged
      build: the log read "No messages yet" in a chat room that an arriving message had just
      opened. Title and member list were correct, so this is the read path, not groups. Not
      diagnosed.
- [ ] **Formatting reaches the composer but not the wire.** The toolbar now restyles the input
      pane, so its buttons do something visible — but `im:send` still takes a plain body, and
      Signal's ranged text styling (bold, italic, strikethrough, monospace, spoiler) is
      untouched. Bold and italic are the two that could travel today; colour, size and underline
      never can, and the toolbar says so on hover.
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
