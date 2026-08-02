/**
 * The on-disk attachment cache, and the rules about what is allowed to reach it.
 *
 * ---------------------------------------------------------------------------------------
 * THE DAEMON WRITES FIRST — this module cleans up after it
 * ---------------------------------------------------------------------------------------
 * Verified behaviour of signal-cli 0.14.6: it downloads attachments into its own
 * `$XDG_DATA_HOME/signal-cli/attachments/` **before** it delivers the JSON envelope to us.
 * By the time we can make any decision, the bytes — including view-once media — are already
 * on disk in a directory we do not own.
 *
 * So "never persisted" cannot mean "never written". What this module guarantees is:
 *
 *   - view-once media is never copied into our cache and never reaches the database, and
 *   - the daemon's copy is shredded the moment we see the envelope.
 *
 * There is an unavoidable window between the daemon's write and our shred. Closing it
 * entirely would require running signal-cli with `--ignore-attachments`, which this client
 * deliberately does **not** do: SPEC.md §8 requires ordinary attachments to render. That is a
 * conscious trade, not an oversight. If the trade is ever revisited, `--ignore-attachments`
 * plus an explicit per-message download is the alternative.
 *
 * Note that `viewOnceOpen` is not serialised in any envelope, so we can never learn that the
 * media was opened on another device. This does not matter here precisely *because* we never
 * keep it: there is no local copy whose lifetime would need that signal.
 *
 * Ordinary attachments are copied into our cache and the daemon's copy is shredded too
 * ({@link AttachmentCacheOptions.shredSourceAfterIngest}). Leaving it would put a second,
 * unmanaged copy outside the reach of expiry sweeps and deletions — a disappearing-message
 * attachment would quietly survive its timer in the daemon's directory.
 *
 * ---------------------------------------------------------------------------------------
 * VIEW-ONCE: three independent barriers
 * ---------------------------------------------------------------------------------------
 *   1. Here — {@link AttachmentCache.ingest} refuses to copy view-once media into the cache,
 *      and shreds the file the daemon downloaded.
 *   2. In `messages.ts` — view-once attachments are filtered out before the insert runs.
 *   3. In the schema — `attachments.view_once` carries `CHECK (view_once = 0)`, so an INSERT
 *      of view-once media fails at the database level.
 *
 * Shredding caveat, stated honestly: on APFS with copy-on-write and wear-levelling SSDs,
 * overwriting a file in place is best-effort, not a guarantee that the original blocks are
 * unreachable. The real defence is never writing the bytes into our cache in the first place
 * (which is what we do) plus FileVault on the volume. The overwrite is defence in depth.
 *
 * `shred` deliberately accepts any absolute path, including files this process did not
 * create: cleaning up the daemon's directory is the entire point. Both processes run as the
 * same user, so the unlink always succeeds; on POSIX it succeeds even while signal-cli still
 * holds the descriptor open.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

import type { Attachment } from '../../shared/types.ts';
import { assertSafeDatabaseLocation } from './encryption.ts';

export interface AttachmentCacheOptions {
  /** Absolute directory for cached attachments, normally `<userData>/attachments`. */
  dir: string;
  /** Skips the cloud-sync location guard. Tests only. */
  skipLocationGuard?: boolean;
  /**
   * Shred the daemon's own copy after a successful ingest, so exactly one managed copy
   * exists. Defaults to true; turning it off leaves attachments in the daemon's directory
   * where expiry sweeps and deletions cannot reach them.
   */
  shredSourceAfterIngest?: boolean;
}

/** One file the user chose, on its way out. */
export interface OutgoingFile {
  /** Stable, derived from the message id and position, so re-adopting is a no-op. */
  id: string;
  /** Absolute path to the user's own file. */
  path: string;
}

export interface AttachmentCache {
  readonly dir: string;
  /**
   * Copies a downloaded attachment into the cache and returns it with `path` rewritten.
   * Returns `null` for view-once media, having shredded the daemon's copy.
   */
  ingest(messageId: string, attachment: Attachment): Attachment | null;
  /**
   * Copies files the *user* chose into the cache, under an outgoing message's id.
   *
   * Unlike {@link ingest} this **never shreds the source**: that file is the user's own
   * document sitting in their own folder, not the daemon's scratch copy. Deleting it would be
   * catastrophic and is not a thing this app is allowed to do.
   *
   * A copy is taken rather than the original path being recorded, for the same reason inbound
   * attachments are copied: the cached copy is the one expiry sweeps and deletions can reach.
   * A sent file in a disappearing-message conversation has its *cached* copy shredded on the
   * timer; the user's own original is theirs and is untouched.
   *
   * Files that cannot be read are skipped rather than throwing — the message itself has already
   * been sent by the time this runs, and losing the log line for it would be the worse outcome.
   */
  adopt(messageId: string, files: OutgoingFile[]): Attachment[];
  /** Overwrites and unlinks a single file. Safe to call on a path that no longer exists. */
  shred(filePath: string | null | undefined): void;
  /** Shreds every given path, then removes any now-empty per-message directories. */
  shredAll(filePaths: (string | null | undefined)[]): void;
  /** Removes everything cached for a message. */
  purgeMessage(messageId: string): void;
}

/**
 * Content type from a filename extension.
 *
 * Only used for files *we* send. Inbound attachments carry a content type on the envelope and
 * that one is authoritative; this is a local guess whose only consumer is the message log,
 * which uses it to decide whether to render a thumbnail. signal-cli sniffs the file itself for
 * what actually goes on the wire, so a wrong guess here mislabels nothing outside this app.
 */
export function guessContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase().slice(1);
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

const CONTENT_TYPES: Record<string, string> = {
  bmp: 'image/bmp',
  gif: 'image/gif',
  heic: 'image/heic',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  webp: 'image/webp',

  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',

  m4v: 'video/mp4',
  mov: 'video/quicktime',
  mp4: 'video/mp4',
  webm: 'video/webm',

  csv: 'text/csv',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  json: 'application/json',
  md: 'text/markdown',
  pdf: 'application/pdf',
  rtf: 'application/rtf',
  txt: 'text/plain',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  zip: 'application/zip',
};

export function createAttachmentCache(options: AttachmentCacheOptions): AttachmentCache {
  const shredSourceAfterIngest = options.shredSourceAfterIngest ?? true;
  const dir = path.resolve(options.dir);
  if (!options.skipLocationGuard) assertSafeDatabaseLocation(path.join(dir, 'placeholder'));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  function messageDir(messageId: string): string {
    // Message ids come from the daemon; never let one escape the cache root.
    const safe = messageId.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 128);
    return path.join(dir, safe);
  }

  function shred(filePath: string | null | undefined): void {
    if (!filePath) return;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return; // already gone
    }
    if (!stat.isFile()) return;
    try {
      const fd = fs.openSync(filePath, 'r+');
      try {
        // Overwrite in chunks so a large attachment does not balloon memory.
        const chunk = randomBytes(Math.min(stat.size, 1 << 16));
        let written = 0;
        while (written < stat.size) {
          const len = Math.min(chunk.length, stat.size - written);
          fs.writeSync(fd, chunk, 0, len, written);
          written += len;
        }
        fs.fsyncSync(fd);
        fs.ftruncateSync(fd, 0);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* If we cannot overwrite it we still unlink it below. */
    }
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      /* nothing more we can do */
    }
  }

  return {
    dir,

    ingest(messageId, attachment) {
      if (attachment.viewOnce) {
        // Never persisted — not to the cache, not to the database. Destroy the daemon's copy.
        shred(attachment.path);
        return null;
      }
      if (!attachment.path) return { ...attachment };

      let source: fs.Stats;
      try {
        source = fs.statSync(attachment.path);
      } catch {
        return { ...attachment, path: null };
      }
      if (!source.isFile()) return { ...attachment, path: null };

      const target = messageDir(messageId);
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });
      const ext = path.extname(attachment.filename ?? attachment.path) || '';
      const safeId = attachment.id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
      const destination = path.join(target, `${safeId}${ext}`);

      fs.copyFileSync(attachment.path, destination);
      fs.chmodSync(destination, 0o600);

      // The daemon's copy is now redundant. Leaving it would put a second copy outside the
      // reach of expiry and deletion — see the note at the top of this file.
      if (shredSourceAfterIngest && path.resolve(attachment.path) !== destination) {
        shred(attachment.path);
      }

      return {
        ...attachment,
        path: destination,
        size: attachment.size ?? source.size,
      };
    },

    adopt(messageId, files) {
      if (files.length === 0) return [];
      const target = messageDir(messageId);
      fs.mkdirSync(target, { recursive: true, mode: 0o700 });

      const adopted: Attachment[] = [];
      for (const file of files) {
        let source: fs.Stats;
        try {
          source = fs.statSync(file.path);
        } catch {
          continue; // Moved or deleted between the picker and the send.
        }
        if (!source.isFile()) continue;

        const name = path.basename(file.path);
        const ext = path.extname(name);
        const safeId = file.id.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
        const destination = path.join(target, `${safeId}${ext}`);

        try {
          fs.copyFileSync(file.path, destination);
          fs.chmodSync(destination, 0o600);
        } catch {
          continue;
        }

        adopted.push({
          id: file.id,
          contentType: guessContentType(name),
          filename: name,
          size: source.size,
          path: destination,
          viewOnce: false,
          // Nothing in this app records a voice note; the composer sends files, not recordings.
          isVoiceNote: false,
        });
      }
      return adopted;
    },

    shred,

    shredAll(filePaths) {
      const dirs = new Set<string>();
      for (const filePath of filePaths) {
        if (!filePath) continue;
        dirs.add(path.dirname(filePath));
        shred(filePath);
      }
      for (const candidate of dirs) {
        if (candidate === dir || !candidate.startsWith(dir + path.sep)) continue;
        try {
          if (fs.readdirSync(candidate).length === 0) fs.rmdirSync(candidate);
        } catch {
          /* not empty, or already gone */
        }
      }
    },

    purgeMessage(messageId) {
      const target = messageDir(messageId);
      let entries: string[];
      try {
        entries = fs.readdirSync(target);
      } catch {
        return;
      }
      for (const entry of entries) shred(path.join(target, entry));
      try {
        fs.rmSync(target, { recursive: true, force: true });
      } catch {
        /* already gone */
      }
    },
  };
}
