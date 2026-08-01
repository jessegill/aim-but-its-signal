#!/usr/bin/env node
/**
 * capture-envelopes.mjs
 *
 * Connects to a running `signal-cli daemon --socket` over its UNIX socket,
 * speaks newline-delimited JSON-RPC 2.0, and appends every inbound
 * notification (and every RPC response) to a JSONL log file so we can collect
 * real envelope shapes in one pass.
 *
 * READ-ONLY. This script never sends a message, reaction, receipt, typing
 * indicator or any other outbound traffic. The only RPC calls it makes are
 * `version` (handshake) and, with --subscribe, `subscribeReceive`.
 *
 * Prerequisites — start the daemon yourself, on a UNIX socket, NOT on TCP:
 *
 *   signal-cli -a +1XXXXXXXXXX daemon \
 *     --socket /tmp/signal-cli.sock \
 *     --receive-mode on-start \
 *     --no-receive-stdout
 *
 * Usage:
 *
 *   node scripts/capture-envelopes.mjs [--socket PATH] [--out PATH]
 *                                      [--subscribe] [--redact] [--quiet]
 *
 *   --socket PATH   UNIX socket path (default: $SIGNAL_CLI_SOCKET or
 *                   /tmp/signal-cli.sock). NOTE: macOS caps UNIX socket paths
 *                   at ~104 bytes — keep it short.
 *   --out PATH      JSONL output file (default: ./envelopes.jsonl)
 *   --subscribe     Also call subscribeReceive. Required when the daemon runs
 *                   with --receive-mode manual. With on-start/on-connection
 *                   the daemon already pushes to every connected client, and
 *                   adding this will make each event arrive TWICE (once bare,
 *                   once wrapped in {subscription, result}).
 *   --redact        Scrub phone numbers / UUIDs / names in the console echo
 *                   only. The JSONL file is always written unredacted.
 *   --quiet         Do not echo to the console.
 *
 * Zero dependencies. Node >= 18.
 *
 * Stop with Ctrl-C; a per-type summary is printed on exit.
 */

import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

// ---------------------------------------------------------------- args

function parseArgs(argv) {
  const opts = {
    socket: process.env.SIGNAL_CLI_SOCKET || '/tmp/signal-cli.sock',
    out: 'envelopes.jsonl',
    subscribe: false,
    redact: false,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--socket') opts.socket = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--subscribe') opts.subscribe = true;
    else if (a === '--redact') opts.redact = true;
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '-h' || a === '--help') {
      console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0]);
      process.exit(0);
    } else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const outPath = path.resolve(opts.out);

// Opened lazily on first write, so a failed connection does not litter the
// working tree with an empty file.
let outStream = null;
const out = {
  write(line) {
    if (!outStream) outStream = fs.createWriteStream(outPath, { flags: 'a' });
    outStream.write(line);
  },
  end(cb) {
    if (outStream) outStream.end(cb);
    else cb();
  },
};

// ------------------------------------------------------- classification

/**
 * Best-effort label for an inbound `receive` notification, mirroring the
 * discriminator order documented in docs/signal-cli-rpc.md.
 * A single envelope carries exactly one of dataMessage / editMessage /
 * storyMessage / syncMessage / callMessage / receiptMessage / typingMessage.
 */
function classify(msg) {
  if (msg.method === 'callEvent') return 'callEvent';
  if (msg.method !== 'receive') return msg.method || 'response';

  // `--receive-mode manual` + subscribeReceive wraps the payload in
  // {subscription, result}; otherwise params IS the payload.
  const p = msg.params ?? {};
  const payload = p.result ?? p;
  const env = payload.envelope;

  if (!env) return payload.exception ? 'exception-only' : 'unknown';

  const tags = [];
  if (payload.exception) tags.push(`exception:${payload.exception.type}`);

  if (env.typingMessage) tags.push(`typing:${env.typingMessage.action}`);
  if (env.receiptMessage) {
    const r = env.receiptMessage;
    tags.push(
      `receipt:${r.isDelivery ? 'delivery' : r.isRead ? 'read' : r.isViewed ? 'viewed' : 'unknown'}`
    );
  }
  if (env.callMessage) tags.push('call');
  if (env.storyMessage) tags.push('story');
  if (env.editMessage) tags.push('edit');

  const describeData = (d, prefix) => {
    if (!d) return;
    if (d.remoteDelete) tags.push(`${prefix}remoteDelete`);
    else if (d.reaction) tags.push(`${prefix}reaction${d.reaction.isRemove ? ':remove' : ''}`);
    else if (d.sticker) tags.push(`${prefix}sticker`);
    else if (d.isExpirationUpdate) tags.push(`${prefix}expirationUpdate`);
    else if (d.pollCreate || d.pollVote || d.pollTerminate) tags.push(`${prefix}poll`);
    else if (d.attachments?.length) {
      const kinds = d.attachments.map((a) => a.contentType).join(',');
      tags.push(`${prefix}attachment(${kinds})`);
    } else if (d.message != null) tags.push(`${prefix}text`);
    else tags.push(`${prefix}data`);

    if (d.quote) tags.push(`${prefix}quote`);
    if (d.viewOnce) tags.push(`${prefix}VIEW_ONCE`);
    if (d.expiresInSeconds) tags.push(`${prefix}expires:${d.expiresInSeconds}s`);
    if (d.groupInfo) tags.push(`${prefix}group`);
    if (d.mentions?.length) tags.push(`${prefix}mentions`);
  };

  if (env.syncMessage) {
    const s = env.syncMessage;
    if (s.sentMessage) describeData(s.sentMessage, 'SYNC-SENT:');
    if (s.sentStoryMessage) tags.push('SYNC-SENT:story');
    if (s.readMessages) tags.push(`SYNC-READ x${s.readMessages.length}`);
    if (s.blockedNumbers || s.blockedGroupIds) tags.push('SYNC-BLOCKED');
    if (s.type) tags.push(`SYNC-${s.type}`);
    if (!tags.some((t) => t.startsWith('SYNC'))) tags.push('SYNC-other');
  }

  if (env.dataMessage) describeData(env.dataMessage, '');
  if (env.editMessage?.dataMessage) describeData(env.editMessage.dataMessage, 'EDIT:');

  return tags.length ? tags.join(' + ') : 'envelope-only';
}

// ----------------------------------------------------------- redaction

const numbers = new Map();
const uuids = new Map();
function placeholderFor(map, value, prefix) {
  if (!map.has(value)) map.set(value, `${prefix}${map.size + 1}`);
  return map.get(value);
}

function redact(obj) {
  const json = JSON.stringify(obj);
  return json
    .replace(/\+\d{7,15}/g, (m) => placeholderFor(numbers, m, '+1555000'))
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (m) =>
      placeholderFor(uuids, m, 'UUID-')
    )
    .replace(/"(sourceName|name|groupName|givenName|familyName)":"[^"]*"/g, '"$1":"Alice"');
}

// --------------------------------------------------------------- stats

const counts = new Map();
let total = 0;

function record(label) {
  counts.set(label, (counts.get(label) || 0) + 1);
  total++;
}

function summary() {
  const lines = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `  ${String(v).padStart(4)}  ${k}`);
  return `\ncaptured ${total} notification(s) -> ${outPath}\n${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------- main

const sock = net.createConnection(opts.socket);
let nextId = 1;
const pending = new Map();

function call(method, params) {
  const id = `cap-${nextId++}`;
  const req = { jsonrpc: '2.0', id, method };
  if (params !== undefined) req.params = params;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    sock.write(JSON.stringify(req) + '\n');
  });
}

sock.on('error', (err) => {
  console.error(`socket error on ${opts.socket}: ${err.message}`);
  console.error('Is the daemon running? Try:');
  console.error(
    `  signal-cli -a +1XXXXXXXXXX daemon --socket ${opts.socket} --receive-mode on-connection --no-receive-stdout`
  );
  process.exit(1);
});

let buf = '';
sock.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      out.write(JSON.stringify({ capturedAt: Date.now(), unparseable: line }) + '\n');
      console.error('UNPARSEABLE LINE:', line.slice(0, 400));
      continue;
    }

    // RPC response to one of our own calls -> resolve, do not log as an event.
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      continue;
    }

    const label = classify(msg);
    record(label);
    out.write(JSON.stringify({ capturedAt: Date.now(), label, message: msg }) + '\n');

    if (!opts.quiet) {
      const body = opts.redact ? redact(msg) : JSON.stringify(msg);
      console.log(`\n[${new Date().toISOString()}] ${label}`);
      console.log(body);
    }
  }
});

sock.on('close', () => {
  console.error('\ndaemon closed the connection');
  process.stderr.write(summary());
  out.end(() => process.exit(0));
});

sock.on('connect', async () => {
  const v = await call('version');
  console.error(`connected to ${opts.socket} (signal-cli ${v?.result?.version ?? '?'})`);
  console.error(`appending to ${outPath}`);

  if (opts.subscribe) {
    const r = await call('subscribeReceive');
    console.error(`subscribeReceive -> subscription ${JSON.stringify(r?.result)}`);
    console.error('NOTE: with --receive-mode on-start/on-connection this duplicates every event.');
  }
  console.error('waiting for inbound events... (Ctrl-C to stop)\n');
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    process.stderr.write(summary());
    sock.end();
    out.end(() => process.exit(0));
  });
}
