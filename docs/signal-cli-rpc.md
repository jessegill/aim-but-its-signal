# signal-cli 0.14.6 — JSON-RPC reference

Authoritative reference for the JSON-RPC surface this project builds against.
Supersedes the indicative command signatures in `SPEC.md` (see SPEC.md §11.1).

| | |
|---|---|
| Version verified | `signal-cli 0.14.6` (Homebrew, GraalVM native image, arm64) |
| Verified on | 2026-07-31 |
| How | Live daemon on a UNIX socket + the tagged upstream source for `v0.14.6` |
| Live account | linked secondary device, single-account mode |

Everything in the "Methods" and "Envelope catalog" sections below was checked
against `signal-cli-0.14.6/src/main/java/org/asamk/signal/{commands,json,jsonrpc}/`
and, where marked **[live]**, against real traffic on a running daemon.
Anything not confirmed is in [Unverified](#unverified--needs-live-traffic).

---

## 1. Transport

### Start the daemon

```sh
signal-cli -a +1XXXXXXXXXX daemon \
  --socket /tmp/signal-cli.sock \
  --receive-mode on-connection \
  --no-receive-stdout
```

- **Use `--socket`, never `--tcp`.** A localhost TCP port is reachable by every
  local process and the daemon holds full account access (send as the user, read
  the roster, remove devices). A UNIX socket is filesystem-permission gated.
- **macOS caps UNIX socket paths at ~104 bytes.** Longer paths fail at bind time
  with `Failed to bind socket …: Unix domain path too long`. Keep the socket in a
  short directory. **[live]**
- Default socket path if you pass a bare `--socket` is
  `$XDG_RUNTIME_DIR/signal-cli/socket`. `$XDG_RUNTIME_DIR` is normally unset on
  macOS, so pass an explicit path.
- `--no-receive-stdout` only suppresses the daemon's own stdout printing. It does
  not affect RPC notifications.

### Framing

Newline-delimited JSON. One JSON object per line, both directions. Standard
JSON-RPC 2.0 (`jsonrpc`, `method`, `params`, `id`, `result`, `error`). Batch
arrays are supported. `params` **must be an object** — passing an array yields
`-32600` before method dispatch even for a valid method name. **[live]**

Multiple clients may connect to one socket concurrently; each connection gets its
own dispatcher.

### `--receive-mode` — this decides whether you lose messages

| Mode | Receive thread runs | Consequence |
|---|---|---|
| `on-start` (default) | from daemon start, always | The daemon pulls, decrypts and **acks** messages even when no RPC client is connected. Those messages are **never replayed**. signal-cli has no message store — anything that arrives while your client is disconnected is silently lost to your app. |
| `on-connection` | while ≥1 client is subscribed | Nothing is pulled from the server until a client attaches, so nothing is lost across client restarts. |
| `manual` | only after `subscribeReceive` | As above, but you control the start explicitly. |

Mechanism: `on-start` registers a *strong* receive handler, which starts the
receive thread; the other modes register a *weak* handler, which does not
(`ManagerImpl.addReceiveHandler`, `DaemonCommand.addDefaultReceiveHandler`).

**This was observed, not just read.** During verification the daemon ran with
`--receive-mode on-start` and a client attached a few minutes later. Read and
delivery receipts then arrived **[live]** for four messages the user had sent
from their phone in that gap — but the sync transcripts for those same four
messages were never delivered to the client. They had been consumed and acked
while nothing was listening. An app built on `on-start` would show receipts for
messages it has no record of.

**Recommendation for this project:** `--receive-mode on-connection`, and treat
the daemon + RPC connection as a single unit — if the socket drops, the app must
reconnect promptly. Do not use `on-start` unless a client is guaranteed to be
attached for the daemon's whole lifetime.

### Receive notification wrapping

- In `on-start` / `on-connection` the daemon auto-subscribes each new connection
  as an *internal* subscription. Notifications arrive **bare**:
  `{"jsonrpc":"2.0","method":"receive","params":{"envelope":{…},"account":"+1…"}}` **[live]**
- If you additionally call `subscribeReceive`, that subscription is *external*
  and its notifications are **wrapped**:
  `{"jsonrpc":"2.0","method":"receive","params":{"subscription":0,"result":{"envelope":{…},"account":"+1…"}}}`
- **Therefore: do not call `subscribeReceive` in `on-start`/`on-connection` mode.**
  You will receive every event twice, in two different shapes. Only call it in
  `manual` mode.

Consumers should normalise with `const payload = params.result ?? params;`.

`account` is a **sibling of `envelope` inside `params`**, not a field of the
envelope. **[live]**

### `receive` is not usable in daemon mode

Calling the `receive` method while the daemon's own receive thread is running
returns:

```json
{"jsonrpc":"2.0","error":{"code":-1,"message":"Receive command cannot be used if messages are already being received.","data":null},"id":"18"}
```
**[live]** Use notifications, not polling.

---

## 2. Parameter naming rules

Verified in `JsonRpcNamespace.java` and `Util.dashSeparatedToCamelCaseString`:

1. **RPC param name = camelCase of the CLI long flag.** `--group-id` → `groupId`,
   `--target-timestamp` → `targetTimestamp`, `--note-to-self` → `noteToSelf`,
   `--end-session` → `endSession`. **[live]**
2. **Positional CLI args keep their name.** `recipient`, `pin`, `path`.
3. **List params accept three forms**: the singular key with a scalar
   (`"recipient": "+1…"`), the singular key with an array
   (`"recipient": ["+1…"]`), or the **plural** key with an array
   (`"recipients": [...]`). `getList(dest)` falls back to `dest + "s"`.
4. **Unknown params are silently ignored** — no error. A typo'd param name is a
   silent no-op, so there is no runtime safety net for misspellings. **[live]**
5. `account` is stripped by the dispatcher before the command sees it. In
   single-account mode it is ignored entirely. **[live]**
6. Boolean flags are `true`/`false` JSON booleans (`"viewOnce": true`), except the
   handful of CLI args declared as `{true,false}` *choice* arguments, which are
   strings: `--blocked`, `--read-receipts`, `--typing-indicators`,
   `--link-previews`, `--unidentified-delivery-indicators`,
   `--unrestricted-unidentified-sender`, `--discoverable-by-number`,
   `--number-sharing`.

---

## 3. Method catalog

There is **no introspection method**. `listMethods`, `rpc.discover`,
`system.listMethods` and `help` all return `-32601`. **[live]** The list below is
the whole surface.

Availability depends on mode. In **single-account mode** (`-a` given, which is
what this project uses) only commands implementing `JsonRpcSingleCommand` are
dispatched; everything else returns `-32601 "Method not implemented"` **without
executing**. That is a safety property worth knowing: calling `register` or
`deleteLocalAccountData` over a single-account socket is a no-op. **[live]**

### 3.1 Read-only / safe

| Method | Params | Result |
|---|---|---|
| `version` | — | `{"version":"0.14.6"}` **[live]** |
| `listContacts` | `recipient`, `allRecipients` (bool), `blocked` (`"true"`/`"false"`), `name`, `detailed` (bool), `internal` (bool) | `Contact[]` — see §5.1 **[live]** |
| `listGroups` | `groupId`, `detailed` (bool) | `Group[]` — see §5.2 **[live]** |
| `listIdentities` | `number` | `Identity[]` — see §5.3 **[live]** |
| `listDevices` | — | `{id,name,createdTimestamp,lastSeenTimestamp}[]` **[live]** |
| `listCalls` | — | active call info array (empty when idle) **[live]** |
| `listStickerPacks` | — | `{packId,url,installed,title,author,cover,stickers[]}[]` **[live]** |
| `getAttachment` | `id`, `recipient`, `groupId` | `{"data":"<base64>"}` **[live]** |
| `getAvatar` | `contact` \| `profile` \| `groupId` | `{"data":"<base64>"}` **[live]** |
| `getSticker` | `packId` (hex), `stickerId` (int) | `{"data":"<base64>"}` **[live]** |
| `getUserStatus` | `recipient`, `username` | registration status per number. Hits the server's CDSI; rate-limited. Not exercised. |
| `receive` | `timeout` (double, default 3.0), `maxMessages` (int) | array of receive payloads. **Errors in daemon mode** — see §1. **[live]** |
| `subscribeReceive` | — | `<int subscriptionId>` **[live]** |
| `unsubscribeReceive` | `subscription` (int); omit in single-account mode to drop this connection's subscription | `{}` |
| `subscribeCallEvents` | — | `<int subscriptionId>` **[live]** — **undocumented in the man page** |
| `unsubscribeCallEvents` | `subscription` (int) | `{}` **[live]** |

`subscribeCallEvents` enables a separate `callEvent` notification stream — see §4.9.

### 3.2 Mutating — exist, deliberately NOT invoked

These are all `JsonRpcSingleCommand` and therefore dispatchable in
single-account mode. Param names are the camelCase mapping of the flags in
`signal-cli <cmd> --help`, verified against each command's `ns.get*("…")` calls
in the source. **None of these were executed** — the verification account is the
user's primary with real contacts.

| Method | Params |
|---|---|
| `send` | `recipient`, `groupId`, `username`, `noteToSelf` (bool), `notifySelf` (bool), `message`, `messageFromStdin` (bool), `attachment` (path or RFC-2397 data URI), `viewOnce` (bool), `endSession` (bool), `mention` (`start:length:number`), `textStyle` (`start:length:STYLE`), `quoteTimestamp`, `quoteAuthor`, `quoteMessage`, `quoteMention`, `quoteAttachment`, `quoteTextStyle`, `sticker` (`packId:stickerId`), `previewUrl`, `previewTitle`, `previewDescription`, `previewImage`, `storyTimestamp`, `storyAuthor`, `editTimestamp`, `noUrgent` (bool), `voiceNote` (bool) |
| `sendReaction` | `recipient`, `groupId`, `username`, `noteToSelf`, `notifySelf`, `emoji`, `targetAuthor`, `targetTimestamp`, `remove` (bool), `story` (bool) |
| `sendReceipt` | `recipient`, `targetTimestamp` (scalar or array), `type` (`"read"` \| `"viewed"`) |
| `sendTyping` | `recipient`, `groupId`, `stop` (bool) |
| `remoteDelete` | `recipient`, `groupId`, `username`, `noteToSelf`, `targetTimestamp` |
| `sendAdminDelete` | `groupId`, `notifySelf`, `targetAuthor`, `targetTimestamp`, `story` |
| `sendPinMessage` / `sendUnpinMessage` | `recipient`, `groupId`, `username`, `noteToSelf`, `notifySelf`, `targetAuthor`, `targetTimestamp`, `pinDuration` (pin only, `-1` = forever), `story` |
| `sendPollCreate` | `recipient`, `groupId`, `username`, `noteToSelf`, `notifySelf`, `question`, `option` (array), `noMulti` (bool) |
| `sendPollVote` | …, `pollAuthor`, `pollTimestamp`, `option` (indexes), `voteCount` |
| `sendPollTerminate` | …, `pollTimestamp` |
| `sendStory` | `attachment`, `noReplies` (bool), `groupId` |
| `sendPaymentNotification` | `recipient`, `receipt` (base64), `note` |
| `sendMessageRequestResponse` | `recipient`, `groupId`, `username`, `type` (`"accept"`\|`"delete"`) |
| `sendContacts` | — (pushes local contacts to all linked devices) |
| `sendSyncRequest` | — (asks the primary for contacts/groups sync) |
| `updateContact` | `recipient`, `name`, `givenName`, `familyName`, `nickGivenName`, `nickFamilyName`, `note`, `expiration` (seconds) |
| `removeContact` | `recipient`, `hide` (bool), `forget` (bool) |
| `block` / `unblock` | `recipient`, `groupId` |
| `updateGroup` | `groupId`, `name`, `description`, `avatar`, `member`, `removeMember`, `admin`, `removeAdmin`, `ban`, `unban`, `resetLink` (bool), `link` (`enabled`\|`enabled-with-approval`\|`disabled`), `setPermissionAddMember`, `setPermissionEditDetails`, `setPermissionSendMessages` (each `every-member`\|`only-admins`), `expiration`, `memberLabelEmoji`, `memberLabel` |
| `joinGroup` | `uri` |
| `quitGroup` | `groupId`, `delete` (bool), `admin` |
| `updateProfile` | `givenName`, `familyName`, `about`, `aboutEmoji`, `mobileCoinAddress`, `avatar`, `removeAvatar` (bool) |
| `updateAccount` | `deviceName`, `unrestrictedUnidentifiedSender`, `discoverableByNumber`, `numberSharing`, `username`, `deleteUsername` (bool) |
| `updateConfiguration` | `readReceipts`, `unidentifiedDeliveryIndicators`, `typingIndicators`, `linkPreviews` (all `"true"`/`"false"` strings) |
| `updateDevice` | `deviceId`, `deviceName` |
| `removeDevice` | `deviceId` |
| `addDevice` | `uri` |
| `trust` | `recipient`, `trustAllKnownKeys` (bool), `verifiedSafetyNumber` |
| `addStickerPack` | `uri` |
| `uploadStickerPack` | `path` |
| `acceptCall` / `rejectCall` / `hangupCall` | `callId` |
| `startCall` | `recipient` |
| `setPin` | `pin` |
| `removePin` | — |
| `unregister` | `deleteAccount` (bool) — **destructive** |
| `startChangeNumber` / `finishChangeNumber` | see `--help` — **destructive** |
| `submitRateLimitChallenge` | `challenge`, `captcha` |

### 3.3 Multi-account mode only

Return `-32601` in single-account mode, verified live: `listAccounts`,
`startLink`, `finishLink`, `register`, `verify`, `deleteLocalAccountData`.
`link`, `daemon` and `jsonRpc` are not RPC methods at all (also `-32601`). **[live]**

> **Implication for SPEC.md §12 ("Links to a Signal account by QR code from the
> app")**: `startLink` / `finishLink` require the daemon to run in
> **multi-account mode** (no `-a` flag). The app therefore needs *two* daemon
> configurations, or must always run multi-account and pass `"account"` in every
> request. Decide this before Phase 1.
>
> `startLink` → `{"deviceLinkUri":"sgnl://linkdevice?uuid=…&pub_key=…"}`; render
> that string as the QR code. `finishLink` takes `{"deviceLinkUri":…,
> "deviceName":…}` and blocks until the primary device responds.

### 3.4 Errors

| Code | Meaning |
|---|---|
| `-32700` | Parse error (malformed JSON line) |
| `-32600` | Invalid request — also returned for a `params` deserialization failure |
| `-32601` | `"Method not implemented"` — unknown method, or a method not available in this mode |
| `-32602` | Invalid params (e.g. missing/unloadable `account` in multi-account mode) |
| `-32603` | Internal error; message is `<exception message> (<SimpleName>)` |
| `-1` | **User error** — bad argument value, unknown group id, unknown attachment id, etc. |
| `-3` | IO error |
| `-4` | Untrusted key (send blocked by a safety-number change) |
| `-5` | Rate limit — `data.response` carries the proof token |
| `-6` | Captcha rejected |

`error.data` is `null` unless the command produced partial output, in which case
it is `{"response": <partial result>}`. Note `-1`/`-3`/`-4`/`-5`/`-6` are
signal-cli extensions outside the JSON-RPC reserved range.

---

## 4. Inbound event envelope catalog

All examples below are **real captured traffic**, redacted: phone numbers →
`+15550001`…, UUIDs → `UUID-1`…, display names → `Alice`, group ids and message
bodies replaced. Where an example is reconstructed from the record definitions
rather than captured, it is marked **[from source]** and repeated in
[Unverified](#unverified--needs-live-traffic).

### 4.0 The envelope, and how to dispatch on it

`org.asamk.signal.json.JsonMessageEnvelope`:

```
source                     string   deprecated; legacy identifier (number if known, else UUID)
sourceNumber               string|null
sourceUuid                 string|null   ACI — use this as the identity key
sourceName                 string|null   contact or profile name, resolved locally
sourceDevice               int|null      1 = the sender's primary phone
timestamp                  long     ** the stable message identity **
serverReceivedTimestamp    long
serverDeliveredTimestamp   long
dataMessage      ?  object  omitted when absent
editMessage      ?  object
storyMessage     ?  object
syncMessage      ?  object
callMessage      ?  object
receiptMessage   ?  object
typingMessage    ?  object
```

The seven payload fields use `@JsonInclude(NON_NULL)`, so **an absent payload key
means "not this kind"**. The first five envelope fields do **not**, so
`sourceNumber`/`sourceUuid`/`sourceName`/`sourceDevice` are emitted as explicit
`null` when unknown (e.g. a sealed-sender envelope that failed to decrypt).

**All seven payload fields can be absent simultaneously.** Captured live:

```json
{"jsonrpc":"2.0","method":"receive","params":{
  "envelope":{
    "source":"+15550001","sourceNumber":"+15550001","sourceUuid":"UUID-1",
    "sourceName":"Alice","sourceDevice":1,
    "timestamp":1785550685419,
    "serverReceivedTimestamp":1785550685455,
    "serverDeliveredTimestamp":1785550685465
  },
  "account":"+15550000"}}
```
**[live]** These are protocol-plumbing envelopes (sender-key distribution,
profile-key updates, null messages). **Ignore them silently** — do not render an
empty message row.

#### Message identity

**`envelope.timestamp` is the stable message id**, and it equals
`dataMessage.timestamp` for a normal data message. **[live]** Every cross-message
reference in the protocol uses that same value:

| Reference | Field |
|---|---|
| Reaction target | `dataMessage.reaction.targetSentTimestamp` |
| Quote target | `dataMessage.quote.id` |
| Remote delete target | `dataMessage.remoteDelete.timestamp` |
| Edit target | `editMessage.targetSentTimestamp` |
| Receipt targets | `receiptMessage.timestamps[]` |
| Sync-read targets | `syncMessage.readMessages[].timestamp` |
| Pin/unpin/admin-delete | `…targetSentTimestamp` |

So the `messages.id` column in SPEC.md §6 should be
`(conversationId, sentTimestamp)` or the raw `sentTimestamp` — **not** a
locally-generated uuid, or none of the above can be resolved.

`serverReceivedTimestamp` / `serverDeliveredTimestamp` are server clocks; use
them for ordering-on-arrival only, never for identity.

---

### 4.1 Incoming 1:1 text message

**[from source — only the group variant was captured live]** The 1:1 shape is the
group shape minus `groupInfo`:

```json
{"jsonrpc":"2.0","method":"receive","params":{
  "envelope":{
    "source":"+15550001","sourceNumber":"+15550001","sourceUuid":"UUID-1",
    "sourceName":"Alice","sourceDevice":1,
    "timestamp":1785550689033,
    "serverReceivedTimestamp":1785550689106,
    "serverDeliveredTimestamp":1785550689117,
    "dataMessage":{
      "timestamp":1785550689033,
      "message":"hello",
      "expiresInSeconds":0,
      "isExpirationUpdate":false,
      "viewOnce":false
    }
  },
  "account":"+15550000"}}
```

**Conversation routing:** if `dataMessage.groupInfo` is absent the conversation is
the 1:1 with `sourceUuid`. If present, the conversation is
`groupInfo.groupId`.

`message` is `null` for an attachment-only or sticker-only message. Long
messages (>2000 chars) are transparently reassembled by signal-cli from the
`text/x-signal-plain` attachment, so `message` always carries the full body.

### 4.2 Group text message **[live]**

```json
{"jsonrpc":"2.0","method":"receive","params":{
  "envelope":{
    "source":"+15550001","sourceNumber":"+15550001","sourceUuid":"UUID-1",
    "sourceName":"Alice","sourceDevice":1,
    "timestamp":1785550689033,
    "serverReceivedTimestamp":1785550689106,
    "serverDeliveredTimestamp":1785550689117,
    "dataMessage":{
      "timestamp":1785550689033,
      "message":"Need to buy 3",
      "expiresInSeconds":0,
      "isExpirationUpdate":false,
      "viewOnce":false,
      "groupInfo":{
        "groupId":"BASE64GROUPID=",
        "groupName":"Some Group",
        "revision":30,
        "type":"DELIVER"
      }
    }
  },
  "account":"+15550000"}}
```

`groupInfo.type` is `"DELIVER"` for a normal message and `"UPDATE"` for a group
metadata change (rename, member add/remove). An `"UPDATE"` envelope typically has
no `message` — render it as a system line, not a chat message.

`groupInfo.groupId` is base64 and is the same string `send`/`sendTyping` expect
as `groupId`.

### 4.3 `dataMessage` full field list

`org.asamk.signal.json.JsonDataMessage`. Only `timestamp`, `message`,
`expiresInSeconds`, `isExpirationUpdate` and `viewOnce` are always present; every
other field is `NON_NULL` and therefore omitted when absent. **[live: the five
always-present fields]**

```
timestamp            long          == envelope.timestamp for a non-sync message
message              string|null   body text, null for media-only
expiresInSeconds     int           per-message disappearing timer, 0 = never
isExpirationUpdate   bool          true => this message ONLY changes the timer
viewOnce             bool
reaction           ? Reaction
quote              ? Quote
payment            ? Payment
mentions           ? Mention[]
previews           ? Preview[]
attachments        ? Attachment[]
sticker            ? Sticker
remoteDelete       ? {timestamp}
contacts           ? SharedContact[]
pollCreate         ? PollCreate
pollVote           ? PollVote
pollTerminate      ? PollTerminate
textStyles         ? TextStyle[]     {style,start,length}, UTF-16 code units
groupInfo          ? GroupInfo
storyContext       ? {authorNumber,authorUuid,sentTimestamp}
pinMessage         ? PinMessage
unpinMessage       ? UnpinMessage
adminDelete        ? AdminDelete
```

Sub-records:

```
Attachment      { contentType, filename, id, size, width, height, caption, uploadTimestamp }
Quote           { id, author(dep), authorNumber, authorUuid, text, mentions?, attachments[], textStyles? }
QuotedAttachment{ contentType, filename, thumbnail? }
Reaction        { emoji, targetAuthor(dep), targetAuthorNumber, targetAuthorUuid,
                  targetSentTimestamp, isRemove }
Sticker         { packId (hex string), stickerId (int) }
Mention         { name(dep), number, uuid, start, length }   // UTF-16 code units
Preview         { url, title, description, image (Attachment|null) }
GroupInfo       { groupId, groupName, revision, type }
```

`Attachment.id` is the opaque handle you pass to `getAttachment`. The bytes are
also already on disk at `$XDG_DATA_HOME/signal-cli/attachments/<id>` — see §6.

### 4.4 Sync message — a message the user sent from their phone

**This is the one SPEC.md §8 warns about, and the JSON shape is a trap.**

`JsonSyncMessage`, all fields `NON_NULL`:

```
sentMessage       ? SyncDataMessage
sentStoryMessage  ? SyncStoryMessage
blockedNumbers    ? string[]
blockedGroupIds   ? string[]
readMessages      ? SyncReadMessage[]      // the user read something elsewhere
type              ? "CONTACTS_SYNC" | "GROUPS_SYNC" | "REQUEST_SYNC"
```

`SyncDataMessage` is:

```
destination        string|null   deprecated legacy id of the 1:1 peer
destinationNumber  string|null
destinationUuid    string|null   null for a group send
<all DataMessage fields, FLATTENED>   ← @JsonUnwrapped
```

**The `dataMessage` payload is `@JsonUnwrapped` into `sentMessage`.** There is no
`sentMessage.dataMessage` key. `message`, `timestamp`, `expiresInSeconds`,
`attachments`, `groupInfo` … all sit directly on `sentMessage`. Any consumer that
looks for `syncMessage.sentMessage.dataMessage.message` gets `undefined`.
Confirmed in `JsonSyncDataMessage.java` and in the upstream man page example.

**[from source — see Unverified]** Expected shape for a 1:1 message the user sent
from their phone:

```json
{"jsonrpc":"2.0","method":"receive","params":{
  "envelope":{
    "source":"+15550000","sourceNumber":"+15550000","sourceUuid":"UUID-0",
    "sourceName":"Alice","sourceDevice":1,
    "timestamp":1693064367769,
    "serverReceivedTimestamp":1693064367800,
    "serverDeliveredTimestamp":1693064367810,
    "syncMessage":{
      "sentMessage":{
        "destination":"+15550001",
        "destinationNumber":"+15550001",
        "destinationUuid":"UUID-1",
        "timestamp":1693064367769,
        "message":"sent from my phone",
        "expiresInSeconds":0,
        "isExpirationUpdate":false,
        "viewOnce":false
      }
    }
  },
  "account":"+15550000"}}
```

#### Rules for handling sync messages

1. **The discriminator is `envelope.syncMessage`.** Not `source == account`.
   Sync envelopes always have `source`/`sourceUuid` equal to *the account's own*
   identity, but so does a Note-to-Self data message; only `syncMessage`
   distinguishes them reliably.
2. **The sender is the local user**, always. `sourceDevice` tells you which
   device sent it — `1` is the phone. **[live: `sourceDevice:1` observed]**
3. **The conversation is `sentMessage.destinationUuid`**, *not* `sourceUuid`.
   For a group send `destination*` are all `null` and the conversation is
   `sentMessage.groupInfo.groupId`. Getting this backwards routes every
   phone-sent message into a conversation with yourself.
4. **Echo protection** (SPEC.md §8) is probably unnecessary — see the box below.
   If it turns out to be needed, key the dedupe on `sentMessage.timestamp`
   against the `timestamp` returned by the `send` call; they are the same number.
5. `syncMessage` can be an **empty object** `{}`. Captured live:

   ```json
   {"jsonrpc":"2.0","method":"receive","params":{
     "envelope":{
       "source":"+15550000","sourceNumber":"+15550000","sourceUuid":"UUID-0",
       "sourceName":"Alice","sourceDevice":1,
       "timestamp":1785550265832,
       "serverReceivedTimestamp":1785550265911,
       "serverDeliveredTimestamp":1785550265920,
       "syncMessage":{}
     },
     "account":"+15550000"}}
   ```
   **[live]** This is a sync type signal-cli's JSON layer does not model (keys,
   configuration, call-event, view-once-open, viewed-receipt, message-request
   response). Ignore it — but do not crash on it, and do not assume
   `syncMessage.sentMessage` exists.

> **A device does not receive sync transcripts for its own sends.**
> `SendHelper.sendSelfMessage` builds a `SentTranscriptMessage` and hands it to
> `messageSender.sendSyncMessage`, which addresses the account's own service id.
> The Signal server fans that out to the account's *other* devices and excludes
> the originating one. So when **this app** sends a message, it will not see that
> message come back as a sync — only the phone and any other linked devices will.
>
> Consequence: **SPEC.md §8's "echo protection" requirement is likely moot.** The
> render-your-own-sent-message path is a plain local insert at `send` time, and
> the only sync `sentMessage` values you will ever see are from *other* devices.
> This is reasoning from source, not observation — it is item #18 in
> [Unverified](#unverified--needs-live-traffic) and must be tested before the
> dedupe logic is either written or dropped.
>
> It also means **you cannot capture a sync `sentMessage` by sending from
> signal-cli.** Only the user sending from their phone (or Signal Desktop)
> produces one. That is why item #2 below needs a physical action.

#### Sync read receipts

`syncMessage.readMessages` — the user read a message on another device. Use it to
clear unread state locally.

```
readMessages: [ { sender (dep), senderNumber, senderUuid, timestamp } ]
```
`timestamp` is the **target message's** sent timestamp.

### 4.5 Delivery / read / viewed receipt **[live]**

```json
{"jsonrpc":"2.0","method":"receive","params":{
  "envelope":{
    "source":"+15550001","sourceNumber":"+15550001","sourceUuid":"UUID-1",
    "sourceName":"Alice","sourceDevice":1,
    "timestamp":1785550459795,
    "serverReceivedTimestamp":1785550460250,
    "serverDeliveredTimestamp":1785550460281,
    "receiptMessage":{
      "when":1785550459795,
      "isDelivery":true,
      "isRead":false,
      "isViewed":false,
      "timestamps":[1785550052262]
    }
  },
  "account":"+15550000"}}
```

Read receipt — same shape with `"isDelivery":false,"isRead":true`, and observed
carrying **several targets at once**: **[live]**

```json
"receiptMessage":{
  "when":1785550387122,
  "isDelivery":false,"isRead":true,"isViewed":false,
  "timestamps":[1785549936806,1785549906211,1785549918085]
}
```

Notes:
- `timestamps` is an **array**. One receipt updates N messages. **[live]**
- Three booleans, not an enum. A fourth protocol type (`UNKNOWN`) serialises as
  all three `false` — treat that as "ignore".
- `when` is the receipt's own timestamp, equal to `envelope.timestamp`. The
  message being acknowledged is in `timestamps`, never in `when`.
- **A linked device receives receipts for messages it never sent** — including
  ones sent from the phone. **[live, repeatedly]** Do not drop a receipt just
  because you have no local record of the target; you may simply not have been
  connected when the original was sent.
- signal-cli sends **delivery** receipts automatically on receive. Read receipts
  are only sent if you pass `--send-read-receipts` (daemon-wide) or call
  `sendReceipt` (per message). For an AIM-style client, per-message `sendReceipt`
  on window focus is the right call; leave the daemon flag off.

### 4.6 Typing indicator **[live]**

```json
{"jsonrpc":"2.0","method":"receive","params":{
  "envelope":{
    "source":"+15550001","sourceNumber":"+15550001","sourceUuid":"UUID-1",
    "sourceName":"Alice","sourceDevice":1,
    "timestamp":1785550685390,
    "serverReceivedTimestamp":1785550685486,
    "serverDeliveredTimestamp":1785550685542,
    "typingMessage":{
      "action":"STARTED",
      "timestamp":1785550685390,
      "groupId":"BASE64GROUPID="
    }
  },
  "account":"+15550000"}}
```

- `action` is `"STARTED"` or `"STOPPED"` (the enum name, uppercase).
- `groupId` is `NON_NULL` — **absent** for a 1:1 typing indicator. **[live: group
  variant captured]**
- Signal clients show typing for **15 s** unless a `STOPPED` arrives first. A
  `STOPPED` is not guaranteed; always run a local 15 s timeout.

### 4.7 Reaction, quote, edit, remote delete

All **[from source]** — see [Unverified](#unverified--needs-live-traffic).

**Reaction** — arrives as a `dataMessage` with a `reaction` and (usually) no
`message`:

```json
"dataMessage":{
  "timestamp":1785550700000,
  "message":null,
  "expiresInSeconds":0,"isExpirationUpdate":false,"viewOnce":false,
  "reaction":{
    "emoji":"❤️",
    "targetAuthor":"+15550000","targetAuthorNumber":"+15550000","targetAuthorUuid":"UUID-0",
    "targetSentTimestamp":1785550689033,
    "isRemove":false
  }
}
```
Removing a reaction is the same object with `"isRemove":true` (and the same
`emoji`). Reactions on group messages also carry `groupInfo`.

**Quote / reply** — a normal `dataMessage` with an extra `quote`:

```json
"dataMessage":{
  "timestamp":1785550710000,
  "message":"agreed",
  "expiresInSeconds":0,"isExpirationUpdate":false,"viewOnce":false,
  "quote":{
    "id":1785550689033,
    "author":"+15550000","authorNumber":"+15550000","authorUuid":"UUID-0",
    "text":"the original text",
    "attachments":[]
  }
}
```
`quote.id` is the quoted message's sent timestamp. `quote.attachments` is always
present (possibly `[]`); `quote.mentions` and `quote.textStyles` are `NON_NULL`.

**Edited message** — a **top-level `editMessage`**, *not* a `dataMessage`:

```json
"editMessage":{
  "targetSentTimestamp":1785550689033,
  "dataMessage":{
    "timestamp":1785550720000,
    "message":"corrected text",
    "expiresInSeconds":0,"isExpirationUpdate":false,"viewOnce":false
  }
}
```
Note the asymmetry with sync: here `dataMessage` **is** a nested object (no
`@JsonUnwrapped`). Replace the body of the message whose sent timestamp is
`targetSentTimestamp`; the edit itself has a new `timestamp` and `envelope.timestamp`.
Per SPEC.md §8, never show the stale text.

An edit sent from the user's phone arrives as
`syncMessage.sentMessage.editMessage` (a real nested key on `SyncDataMessage`).

**Remote delete ("delete for everyone")**:

```json
"dataMessage":{
  "timestamp":1785550730000,
  "message":null,
  "expiresInSeconds":0,"isExpirationUpdate":false,"viewOnce":false,
  "remoteDelete":{"timestamp":1785550689033}
}
```
`remoteDelete.timestamp` identifies the message to purge. SPEC.md §8 requires
replacing it with a tombstone and deleting the original row and any downloaded
attachment files.

### 4.8 Attachments, voice notes, stickers

All **[from source]**.

```json
"dataMessage":{
  "timestamp":1785550740000,
  "message":null,
  "expiresInSeconds":0,"isExpirationUpdate":false,"viewOnce":false,
  "attachments":[{
    "contentType":"image/jpeg",
    "filename":"IMG_0001.JPG",
    "id":"OPAQUE_ATTACHMENT_ID",
    "size":183245,
    "width":1024,"height":768,
    "caption":null,
    "uploadTimestamp":1785550739000
  }]
}
```

- **Voice note**: there is **no `voiceNote` boolean on the inbound attachment.**
  The outbound `send` API has `--voice-note`, but `JsonAttachment` does not carry
  the flag. Detect heuristically: `contentType` starting `audio/` (typically
  `audio/aac`) with `filename == null`. Treat that as "unsupported — open on
  phone" per SPEC.md §8, or play it.
- **Sticker**: `"sticker":{"packId":"<32-hex>","stickerId":3}` with `message:null`.
  Resolve the image with `getSticker {packId, stickerId}` → base64. Pack metadata
  comes from `listStickerPacks`.
- Attachments are downloaded eagerly to
  `$XDG_DATA_HOME/signal-cli/attachments/<id>` unless the daemon runs with
  `--ignore-attachments`. See §6 — this matters for view-once and disappearing
  media.

### 4.9 Calls

Two independent surfaces.

**(a) `callMessage` inside a receive envelope** — raw WebRTC signalling
(`offerMessage`, `answerMessage`, `busyMessage`, `hangupMessage`,
`iceUpdateMessages`). `offerMessage` is what marks an incoming call:

```json
"callMessage":{
  "offerMessage":{"id":12345678901234,"type":"AUDIO_CALL","opaque":"BASE64"}
}
```
`id` is serialised as an **unsigned BigInteger** and routinely exceeds
`Number.MAX_SAFE_INTEGER`. In JavaScript, `JSON.parse` will corrupt it. If you
ever need the call id, extract it from the raw line as a string.

**(b) `callEvent` notification** — higher level, requires
`subscribeCallEvents` **[live: subscription established]**:

```json
{"jsonrpc":"2.0","method":"callEvent","params":{
  "subscription":6,
  "result":{
    "callId":12345678901234,
    "state":"RINGING",
    "number":"+15550001",
    "uuid":"UUID-1",
    "isOutgoing":false,
    "reason":null
  }}}
```
`state` is a `CallInfo.state` enum name. SPEC.md §8 only requires a
"call — answer on phone" notice, so `offerMessage` alone is sufficient; the
`callEvent` stream is optional.

**Group calls are invisible.** The internal model has
`MessageEnvelope.Data.groupCallUpdate`, but `JsonDataMessage` does **not**
serialise it. A group call start produces a `dataMessage` with `message:null`,
`groupInfo`, and nothing else — indistinguishable from noise. See §7.

### 4.10 Identity / safety-number change **[from source]**

This does **not** come through as a message type. It comes through as the
`exception` sibling of `envelope` in the receive payload:

```json
{"jsonrpc":"2.0","method":"receive","params":{
  "envelope":{
    "source":"+15550001","sourceNumber":"+15550001","sourceUuid":"UUID-1",
    "sourceName":"Alice","sourceDevice":1,
    "timestamp":1785550750000,
    "serverReceivedTimestamp":1785550750100,
    "serverDeliveredTimestamp":1785550750110
  },
  "exception":{
    "message":"Untrusted identity: +15550001",
    "type":"UntrustedIdentityException"
  },
  "account":"+15550000"}}
```

- `exception` sits **beside** `envelope`, at the same level as `account`
  (`JsonReceiveMessageHandler.handleMessage`).
- `envelope` is still populated — `JsonMessageEnvelope.from` pulls the sender
  address out of the exception when the envelope itself has no source. The
  message body is **not** decrypted and is not present.
- `exception.type` is the Java class simple name. Any decryption failure surfaces
  the same way with a different `type`, so branch on
  `type === "UntrustedIdentityException"` specifically.
- Per SPEC.md §8, surface this. Resolve details with
  `listIdentities {number}` → `{fingerprint, safetyNumber, scannableSafetyNumber,
  trustLevel, addedTimestamp}`. `trustLevel` is `TRUSTED_UNVERIFIED`,
  `TRUSTED_VERIFIED` or `UNTRUSTED`. **[live: shape confirmed]**
- Outbound sends to an untrusted identity fail with RPC error code `-4`.
- The daemon-level `--trust-new-identities` flag (`always` / `on-first-use` /
  `never`) controls whether this happens at all. **Do not set `always`** — it
  silently accepts key changes and destroys the security signal SPEC.md §8
  requires.

### 4.11 Stories

`envelope.storyMessage` (and `syncMessage.sentStoryMessage`). Run the daemon with
`--ignore-stories` unless the product wants them; the AIM idiom has no place for
stories and SPEC.md keeps the feature surface small.

---

## 5. Result shapes for the roster

### 5.1 `listContacts` **[live]**

```json
{"number":"+15550001","uuid":"UUID-1","username":"alice.01",
 "name":"","givenName":"","familyName":null,
 "nickName":null,"nickGivenName":null,"nickFamilyName":null,
 "note":null,"color":null,
 "isArchived":false,"isBlocked":false,"isHidden":false,
 "messageExpirationTime":0,
 "profileSharing":false,"unregistered":false,
 "profile":{"lastUpdateTimestamp":1785549832300,
            "givenName":"Alice","familyName":null,
            "about":"…","aboutEmoji":"🙃",
            "hasAvatar":true,"mobileCoinAddress":"…"}}
```

For SPEC.md §6 ("roster is contact-based, not conversation-based"):
- `uuid` is the ACI and is the roster primary key. Use it, not `number`.
- Display name precedence: `nickName` → `name` → `profile.givenName` +
  `profile.familyName` → `username` → `number`. SPEC's local nickname override
  layers on top of all of these.
- `messageExpirationTime` is the **per-conversation disappearing-message timer**
  in seconds. See §6.
- `isHidden` / `unregistered` contacts should be filtered out of the buddy list.
- `--all-recipients` / `"allRecipients":true` widens the result to every known
  recipient, not just contacts. The plain `listContacts` result is the right
  buddy-list source.
- Avatar bytes: `getAvatar {"profile":"+1…"}` or `{"contact":"+1…"}` →
  `{"data":"<base64 jpeg>"}`. **[live]**

### 5.2 `listGroups` **[live]**

```json
{"id":"BASE64GROUPID=","name":"Some Group","description":"",
 "isMember":true,"isBlocked":false,"messageExpirationTime":0,
 "members":[{"number":"+15550001","uuid":"UUID-1","isAdmin":false}],
 "pendingMembers":[],"requestingMembers":[],
 "admins":[{"number":"+15550002","uuid":"UUID-2"}],
 "banned":[],
 "permissionAddMember":"EVERY_MEMBER",
 "permissionEditDetails":"EVERY_MEMBER",
 "permissionSendMessage":"EVERY_MEMBER",
 "groupInviteLink":"https://signal.group/#…"}
```

`id` here is the same base64 string as `dataMessage.groupInfo.groupId` and the
`groupId` param of `send`/`sendTyping`. Members can also carry `labelEmoji` /
`label` (`NON_NULL`).

### 5.3 `listIdentities` **[live]**

```json
{"number":"+15550001","uuid":"UUID-1",
 "fingerprint":"05 2a da 67 …",
 "safetyNumber":"77801 84357 …",
 "scannableSafetyNumber":"CAISIgog…",
 "trustLevel":"TRUSTED_VERIFIED",
 "addedTimestamp":1785549381502}
```

### 5.4 `send` result **[from source]**

```json
{"timestamp":1785550689033,
 "results":[{"recipientAddress":{"uuid":"UUID-1","number":"+15550001"},
             "type":"SUCCESS"}]}
```
`type` ∈ `SUCCESS`, `NETWORK_FAILURE`, `UNREGISTERED_FAILURE`,
`IDENTITY_FAILURE`, `RATE_LIMIT_FAILURE`, `INVALID_PRE_KEY_FAILURE`. Optional
`groupId`, `token`, `retryAfterSeconds`. **If no recipient succeeded the whole
call returns an error**, with the partial result under `error.data.response`.

`timestamp` is the message's identity — store it as the message id and use it for
sync echo suppression (§4.4).

---

## 6. Disappearing messages and view-once — the security-critical answers

### Disappearing messages: **both**, and neither is sufficient alone

| Surface | Where | Meaning |
|---|---|---|
| **Per-message** | `dataMessage.expiresInSeconds` (int, seconds, `0` = never) | The timer **as the sender had it at send time**. Present on every data message. **[live: `0` observed]** |
| **Per-conversation** | `listContacts[].messageExpirationTime`, `listGroups[].messageExpirationTime` | The current timer signal-cli has recorded for that conversation. |
| **Timer change event** | `dataMessage.isExpirationUpdate == true` | This message exists *only* to change the timer. Its `expiresInSeconds` is the new value; `message` is `null`. Render as a system line, never as a chat message. **[live: field present and `false` on normal messages]** |

**Use the per-message value.** A message must expire on the terms its sender
believed, and the conversation timer may have changed since. The conversation
value is for showing the current setting in the UI and for defaulting outbound
sends.

**The critical gap:** Signal's expiry clock starts when the **recipient reads**
the message, not when it is sent. signal-cli's JSON gives you the duration and
nothing else:

- There is no `expirationStartTimestamp` in any JSON envelope. It exists in the
  internal model (`MessageEnvelope.Sync.Sent.expirationStartTimestamp`) but
  `JsonSyncDataMessage` does not serialise it.
- `syncMessage.viewOnceOpen` and `syncMessage.viewed` exist internally but are
  **not serialised either** (`JsonSyncMessage` only emits `sentMessage`,
  `sentStoryMessage`, `blockedNumbers`, `blockedGroupIds`, `readMessages`,
  `type`).

So the app must own the expiry clock:

```
expires_at = (local read/display time) + expiresInSeconds * 1000
```
and for messages the user sent (sync `sentMessage`),
`expires_at = sentMessage.timestamp + expiresInSeconds * 1000` is the safe
approximation — it expires early rather than late, which is the correct
direction.

Per SPEC.md §8 and §11.4 this must be enforced by a store-layer sweep, and it
must also **delete the downloaded attachment file** at
`$XDG_DATA_HOME/signal-cli/attachments/<id>` — signal-cli will not.

### View-once: `dataMessage.viewOnce == true`

- Always present on `dataMessage` (boolean, defaults `false`). **[live]**
- It is the **only** signal. `JsonAttachment` carries no view-once flag; the flag
  is on the message.
- **The daemon has already written the media to disk before you see the
  envelope.** Attachments are downloaded eagerly into
  `$XDG_DATA_HOME/signal-cli/attachments/`. SPEC.md §8 says view-once media must
  never persist — so the app must delete that file after display (or refuse to
  display and delete immediately). Running the daemon with
  `--ignore-attachments` is the strongest option if the product can accept
  fetching on demand instead.
- There is **no way to know the user opened it on another device** — the
  `viewOnceOpen` sync is not serialised (above). Treat the local copy as
  authoritative and destroy it on first view here.
- Nothing stops you re-reading the file. Enforcement is entirely this app's
  responsibility.

---

## 7. Things the JSON layer silently drops

Present in `MessageEnvelope` but **not** in the JSON output. If the product needs
any of these, it cannot get them from signal-cli 0.14.6's JSON-RPC.

| Dropped | Where it lives internally |
|---|---|
| `groupCallUpdate` — group call started | `MessageEnvelope.Data.groupCallUpdate` |
| `isEndSession` | `MessageEnvelope.Data.isEndSession` |
| `isProfileKeyUpdate`, `hasProfileKey` | `MessageEnvelope.Data` |
| `isUnidentifiedSender` (sealed sender) | `MessageEnvelope.isUnidentifiedSender` |
| sync `viewed` receipts | `MessageEnvelope.Sync.viewed` |
| sync `viewOnceOpen` | `MessageEnvelope.Sync.viewOnceOpen` |
| sync `messageRequestResponse` | `MessageEnvelope.Sync.messageRequestResponse` |
| `expirationStartTimestamp` on sync sends | `MessageEnvelope.Sync.Sent` |
| inbound voice-note flag | not modelled at all |

The practical fallout: several `syncMessage` values serialise to `{}` (§4.4), and
some `dataMessage` values serialise to nothing but `timestamp` /
`expiresInSeconds` / `isExpirationUpdate` / `viewOnce` with `message:null`.
Handle both without rendering an empty bubble.

---

## 8. UNVERIFIED — needs live traffic

Everything below is derived from the `v0.14.6` source records and is
**structurally reliable but not byte-confirmed**. Capture with
`scripts/capture-envelopes.mjs` and replace the examples above.

| # | Envelope | Status |
|---|---|---|
| 1 | **1:1 text message** (§4.1) | group variant captured live; 1:1 differs only by the absence of `groupInfo` |
| 2 | **sync `sentMessage`** (§4.4) — highest priority | `syncMessage: {}` captured live; a populated `sentMessage` was not. The `@JsonUnwrapped` flattening is confirmed in source + upstream man page but not observed here |
| 3 | **reaction** (§4.7) | from source |
| 4 | **quote / reply** (§4.7) | from source |
| 5 | **edited message** (§4.7) | from source |
| 6 | **remote delete** (§4.7) | from source |
| 7 | **attachment** (§4.8) | from source; also unverified: on-disk filename convention |
| 8 | **voice note** (§4.8) | from source; the "`audio/*` + null filename" heuristic is a guess and must be checked |
| 9 | **sticker** (§4.8) | from source |
| 10 | **view-once media** (§6) | `viewOnce:false` seen live; a `true` instance not captured |
| 11 | **disappearing message** (§6) | `expiresInSeconds:0` seen live; a non-zero value and an `isExpirationUpdate:true` event not captured |
| 12 | **identity change** (§4.10) | from source; the `exception` sibling has not been observed |
| 13 | **call `offerMessage`** (§4.9) | from source. Also unverified: whether JS `JSON.parse` actually corrupts the id in practice |
| 14 | **`callEvent`** (§4.9) | subscription established live; no event observed |
| 15 | **1:1 typing indicator** (§4.6) | group typing captured live; the 1:1 variant (no `groupId`) not observed |
| 16 | **group `type:"UPDATE"`** (§4.2) | from source |
| 17 | **mentions / text styles** | from source |
| 18 | Whether this app's own `send` echoes back as a sync `sentMessage` at all (§4.4) | reasoned from `SendHelper.sendSelfMessage` + server fan-out semantics: it should **not**. Decides whether SPEC.md §8 echo protection is needed |
| 19 | `startLink` / `finishLink` in multi-account mode (§3.3) | not exercised — would create a second linked device |
| 20 | Any mutating method's real result (§3.2) | not exercised by policy |

### What the user has to do on their phone

These cannot be produced passively. **Do them all in one sitting** with the
capture script running. Use one low-stakes conversation — Note to Self works for
most of them and involves no one else.

Run this first:

```sh
signal-cli -a +1XXXXXXXXXX daemon --socket /tmp/signal-cli.sock \
  --receive-mode on-connection --no-receive-stdout &
node scripts/capture-envelopes.mjs --socket /tmp/signal-cli.sock --out envelopes.jsonl
```

Then, on the phone:

| # | Action | Produces |
|---|---|---|
| 1 | Send a text to **Note to Self** | sync `sentMessage` (#2) — **do this first, it is the most valuable** |
| 2 | Send a text to a real 1:1 contact | sync `sentMessage` with `destinationUuid` (#2) |
| 3 | Long-press a message in Note to Self → react ❤️ | reaction (#3), and the sync form |
| 4 | React again with a different emoji, then remove it | `isRemove:true` (#3) |
| 5 | Reply to a Note-to-Self message | quote (#4) |
| 6 | Long-press a sent message → **Edit** | `editMessage` (#5) |
| 7 | Long-press → **Delete for everyone** | `remoteDelete` (#6) |
| 8 | Send a photo to Note to Self | attachment (#7) |
| 9 | Record and send a voice note to Note to Self | voice note (#8) — settles the heuristic |
| 10 | Send a sticker to Note to Self | sticker (#9) |
| 11 | Send a photo with **view-once** enabled | `viewOnce:true` (#10) |
| 12 | Note to Self → set disappearing messages to **5 minutes**, send a text, then set it back to Off | `isExpirationUpdate:true` **and** `expiresInSeconds:300` (#11) |
| 13 | Ask a contact to send you a 1:1 text | 1:1 `dataMessage` (#1) |
| 14 | Ask that contact to start typing in the 1:1 and stop without sending | 1:1 typing `STARTED`/`STOPPED` (#15) |
| 15 | Ask a contact to call you; let it ring and decline | `callMessage.offerMessage` + `hangupMessage` (#13, #14) |
| 16 | Rename a group you are in, or add a member | `groupInfo.type:"UPDATE"` (#16) |
| 17 | Send a group message that `@`-mentions someone | `mentions` (#17) |

Not reproducible on demand: **identity change** (#12). It requires a contact to
reinstall Signal or change phones. Leave the handler in place and treat #12 as
verified-by-code-reading until it happens naturally. Do **not** synthesise it by
deleting local identity state on a live account.

---

## 9. Capture script

`scripts/capture-envelopes.mjs` — zero dependencies, Node ≥ 18, read-only. It
connects to the daemon's UNIX socket, appends every notification to a JSONL file,
and prints a per-type tally on Ctrl-C. It never sends anything; its only RPC
calls are `version` and, with `--subscribe`, `subscribeReceive`.

```sh
node scripts/capture-envelopes.mjs \
  --socket /tmp/signal-cli.sock \
  --out envelopes.jsonl \
  [--subscribe]   # ONLY with --receive-mode manual; see §1
  [--redact]      # scrub numbers/UUIDs/names in the console echo only
  [--quiet]
```

The JSONL file is written **unredacted** — it contains real message bodies,
phone numbers and UUIDs.

> **`.gitignore` does not currently cover it.** Add `*.jsonl` and
> `envelopes*.json` before running a capture in the repo root, or write the
> output outside the working tree. Delete the file once the shapes are
> transcribed into this document.

---

## 10. Checklist of corrections to SPEC.md

Assumptions in SPEC.md that the real surface contradicts or complicates:

1. **§6 `messages.id TEXT PRIMARY KEY`** — the id must be the sender's
   `timestamp` (with the conversation), because every reaction, quote, edit,
   delete and receipt references it. A synthetic id makes those unresolvable.
2. **§8 sync messages** — the `dataMessage` fields are `@JsonUnwrapped` into
   `sentMessage`. The obvious `syncMessage.sentMessage.dataMessage.message`
   access is `undefined`.
3. **§8 sync messages** — route on `sentMessage.destinationUuid` /
   `sentMessage.groupInfo.groupId`, never on `envelope.sourceUuid`.
4. **§8 "echo protection"** — likely unnecessary. A device does not receive sync
   transcripts for its own sends (§4.4). Confirm before building the dedupe.
5. **§3 daemon supervision** — with the default `--receive-mode on-start`,
   messages that arrive while the app is not connected are consumed and lost.
   Use `on-connection`.
6. **§12 QR linking** — `startLink`/`finishLink` only exist in multi-account
   mode (no `-a`). Single-account mode returns `-32601`.
7. **§8 calls** — group calls are not visible over JSON-RPC at all.
8. **§8 view-once / disappearing** — signal-cli writes attachments to disk before
   the app sees the envelope; the app must delete them, and there is no
   `expirationStartTimestamp` to work from.
9. **§2 "JSON-RPC over localhost"** — use a UNIX socket, not TCP.
10. **§10 "link to a secondary test account"** — worth re-stating: the account
   currently linked for verification is the user's primary.
