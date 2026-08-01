# Project state

Working notes for picking this up cold. Complements `SPEC.md` (what to build) and
`docs/signal-cli-rpc.md` (what the daemon actually does).

Last updated: 2026-07-31.

---

## Status in one line

Phases 1–5 are written, tested and green — **and the app has never been run end to end.**

`npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build`, `npm test`
(84 tests) all pass. Every module is verified in isolation and the protocol layer is verified
against real captured traffic. The daemon has never talked to the live service.

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
| Linked account | The user's **primary personal** Signal account (number omitted — see local signal-cli config), device 4 |
| Self ACI | (omitted — run `signal-cli listAccounts` locally) |

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
| `src/main/store/**` | Encrypted SQLite, expiry, outbound queue, 65 tests |
| `src/renderer/ui/**` | AIM 5.1 components + `showcase.html` (open directly in a browser) |
| `src/renderer/{buddylist,im,signon}/**` | The three window apps |
| `src/shared/types.ts` | IPC surface and domain types |

---

## Known gaps

Decisions, not typing:

- **Group messages attribute to the wrong name.** No channel supplies per-sender names for
  group conversations, so `MessageLog.resolveName` cannot be provided. SPEC §8 requires sender
  attribution — group chat is effectively broken until this exists.
- **No file picker, no attachment-open, no safety-number-verify UI.** The affordances render and
  name what is missing.
- **Formatting toolbar is decorative** — `im:send` takes a plain body.
- **`group:reorder` semantics** — the renderer sends a desired 0-based index and expects main to
  re-index siblings. Undefined in the contract.
- **Code signing / notarization is off**, with the exact block written as a comment in
  `electron-builder.yml`. An unsigned build will be Gatekeeper-blocked.
- **Admin-delete** of another member's message is a separate method, not handled.

---

## Next: the first launch

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

The app spawns its own daemon on its own socket (`/tmp/aim-<uid>/signal.sock`).

What to watch, in order of likelihood of being wrong:

1. **Sign-on window.** Least real-world exercise of anything in the codebase. The service opens
   the buddy list first and swaps to sign-on only if no account turns out to be linked.
2. **`listAccounts` shape in multi-account mode.** `onRpcConnected` reads `number` and `uuid`
   off the first entry; if that shape differs, the app decides it is unlinked.
3. **Roster load** — 99 contacts, and display-name resolution has a fallback chain.
4. **Opening an IM window** and whether geometry persists across a reopen.
5. **A live inbound message** routing to the right window, and the buddy list receiving it too
   for unread counts.

Expect the daemon's first startup to be slow — it is a JVM native image doing account setup.

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
