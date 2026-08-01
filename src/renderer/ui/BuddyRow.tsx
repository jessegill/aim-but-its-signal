/**
 * BuddyRow — one contact in the buddy tree. 16px tall, tight (SPEC.md §9).
 *
 * NO PRESENCE (SPEC.md §7). There is no status icon, no colour-by-availability,
 * no idle time, no away flag, no warning level. Every buddy renders identically
 * regardless of whether they happen to have Signal open — because the protocol
 * does not tell us, and inventing it would be a lie.
 *
 * The only per-row state that varies is message-derived and therefore real:
 * unread count, and whether the contact is unregistered or blocked.
 *
 * Double-click opens the IM window. That is the AIM gesture and it is the one
 * SPEC.md §9 calls for; single click only selects.
 */

import * as React from 'react';
import type { Buddy } from '../../shared/types';
import { BuddyGlyph, BuddyGlyphInactive } from './icons';
import { cx } from './controls';

export interface BuddyRowProps {
  buddy: Buddy;
  selected?: boolean;
  /**
   * Unread message count for this buddy's conversation. Message-derived, not
   * presence. 0 or undefined renders nothing.
   */
  unread?: number;
  /**
   * When a local nickname is set, also show the resolved Signal display name in
   * dim text beside it, so the override never hides who this actually is.
   */
  showRealNameWithNickname?: boolean;
  onSelect?: (buddy: Buddy) => void;
  /** Double-click — the canonical "open an IM window" gesture. */
  onOpen?: (buddy: Buddy) => void;
  onContextMenu?: (buddy: Buddy, e: React.MouseEvent) => void;
  className?: string;
}

export function BuddyRow({
  buddy,
  selected,
  unread,
  showRealNameWithNickname = true,
  onSelect,
  onOpen,
  onContextMenu,
  className,
}: BuddyRowProps) {
  const hasNick = !!buddy.nickname && buddy.nickname.trim().length > 0;
  const primary = hasNick ? buddy.nickname! : buddy.displayName;
  const inactive = buddy.unregistered || buddy.blocked;

  const title = [
    primary,
    hasNick ? `(Signal name: ${buddy.displayName})` : null,
    buddy.number,
    buddy.unregistered ? 'No longer registered — cannot send' : null,
    buddy.blocked ? 'Blocked' : null,
    buddy.messageExpirationTime > 0
      ? `Disappearing messages: ${formatDuration(buddy.messageExpirationTime)}`
      : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div
      role="treeitem"
      aria-selected={!!selected}
      tabIndex={-1}
      title={title}
      className={cx(
        'aim-buddy',
        selected && 'aim-buddy--selected',
        buddy.unregistered && 'aim-buddy--unregistered',
        buddy.blocked && 'aim-buddy--blocked',
        className
      )}
      onClick={() => onSelect?.(buddy)}
      onDoubleClick={() => onOpen?.(buddy)}
      onContextMenu={(e) => {
        onSelect?.(buddy);
        onContextMenu?.(buddy, e);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onOpen?.(buddy);
        }
      }}
    >
      <span className="aim-buddy__icon">
        {inactive ? <BuddyGlyphInactive size={12} /> : <BuddyGlyph size={12} />}
      </span>

      <span className={cx('aim-buddy__name', hasNick && 'aim-buddy__name--nick')}>{primary}</span>

      {hasNick && showRealNameWithNickname ? (
        <span className="aim-buddy__realname">({buddy.displayName})</span>
      ) : null}

      {buddy.messageExpirationTime > 0 ? (
        <span className="aim-buddy__tag" title="Disappearing messages are on for this contact">
          ⧗
        </span>
      ) : null}

      {unread && unread > 0 ? (
        <span className="aim-buddy__unread" title={`${unread} unread`}>
          {unread > 99 ? '99+' : unread}
        </span>
      ) : null}
    </div>
  );
}

export function formatDuration(seconds: number): string {
  if (seconds <= 0) return 'off';
  if (seconds % 604800 === 0) return `${seconds / 604800}w`;
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}
