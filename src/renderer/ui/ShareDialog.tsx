/**
 * ShareDialog — "Send Picture", shown when an image (or any file) is dropped on or pasted into an
 * IM window, in a 1:1 conversation or a chat room alike.
 *
 * It previews what is about to be sent and takes a description, which travels as the message
 * text alongside the attachment — Signal's caption. Pure view: the host owns the files, the
 * description and what Send does.
 */

import * as React from 'react';

import type { PickedFile } from '../../shared/types';
import { TitleBar } from './TitleBar';
import { Button, Window, WindowBody } from './controls';
import { GlyphAttachment, GlyphPicture } from './icons';

export interface ShareItem {
  file: PickedFile;
  /** An object URL for an image the window already holds; null for anything else. */
  previewUrl: string | null;
}

export interface ShareDialogProps {
  items: ShareItem[];
  /** Who it is going to, for the prompt — a buddy's name or a room's. */
  recipientName: string;
  onSend: (description: string) => void;
  onCancel: () => void;
  onRemove: (path: string) => void;
}

function isImage(file: PickedFile): boolean {
  return file.contentType.startsWith('image/');
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ShareDialog({
  items,
  recipientName,
  onSend,
  onCancel,
  onRemove,
}: ShareDialogProps) {
  const [description, setDescription] = React.useState('');
  const textRef = React.useRef<HTMLTextAreaElement | null>(null);

  const allImages = items.every((item) => isImage(item.file));
  const title = allImages
    ? items.length === 1
      ? 'Send Picture'
      : `Send ${String(items.length)} Pictures`
    : items.length === 1
      ? 'Send File'
      : `Send ${String(items.length)} Files`;

  React.useEffect(() => {
    textRef.current?.focus();
  }, []);

  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  const send = (): void => {
    if (items.length > 0) onSend(description.trim());
  };

  const single = items.length === 1 ? items[0] : undefined;

  return (
    <div className="aim-share__scrim" role="dialog" aria-modal="true" aria-label={title}>
      <Window className="aim-share">
        <TitleBar
          title={title}
          icon={<GlyphPicture size={14} />}
          showMinimize={false}
          showMaximize={false}
          onClose={onCancel}
        />
        <WindowBody>
          <div className="aim-share__body">
            <div className="aim-share__prompt">
              {allImages ? 'Share with' : 'Send to'} <b>{recipientName}</b>:
            </div>

            {single !== undefined && single.previewUrl !== null ? (
              <div className="aim-share__preview">
                <img src={single.previewUrl} alt={single.file.name} />
              </div>
            ) : (
              <ul className="aim-share__list">
                {items.map((item) => (
                  <li key={item.file.path} className="aim-share__item">
                    <span className="aim-share__thumb">
                      {item.previewUrl !== null ? (
                        <img src={item.previewUrl} alt="" />
                      ) : (
                        <GlyphAttachment size={16} />
                      )}
                    </span>
                    <span className="aim-share__name" title={item.file.name}>
                      {item.file.name}
                    </span>
                    <span className="aim-share__size">{formatSize(item.file.size)}</span>
                    {items.length > 1 ? (
                      <button
                        type="button"
                        className="aim-share__remove"
                        title={`Don't send ${item.file.name}`}
                        onClick={() => onRemove(item.file.path)}
                      >
                        ×
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}

            {single !== undefined ? (
              <div className="aim-share__meta">
                {single.file.name} · {formatSize(single.file.size)}
              </div>
            ) : null}

            <label className="aim-field aim-field--stacked">
              <span className="aim-field__label">Description (optional):</span>
              <textarea
                ref={textRef}
                className="aim-input aim-share__description"
                rows={3}
                value={description}
                placeholder={allImages ? 'Say something about this picture…' : 'Add a message…'}
                onChange={(e) => setDescription(e.target.value)}
                onKeyDown={(e) => {
                  // Same as the composer: Enter sends, Shift+Enter is a new line.
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
            </label>

            <div className="aim-share__buttons">
              <Button size="small" onClick={onCancel}>
                Cancel
              </Button>
              <Button size="small" isDefault onClick={send} disabled={items.length === 0}>
                Send
              </Button>
            </div>
          </div>
        </WindowBody>
      </Window>
    </div>
  );
}
