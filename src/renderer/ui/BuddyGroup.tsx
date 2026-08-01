/**
 * BuddyGroup — a collapsible group header plus its buddy rows.
 *
 * ===========================================================================
 * WHAT THE TWO NUMBERS IN `Buddies (3/8)` MEAN
 * ===========================================================================
 * In real AIM 5.1 the header read `Buddies (3/8)` = 3 buddies ONLINE out of 8.
 * That is presence, and Signal transmits none of it (SPEC.md §7), so that
 * meaning is unavailable and must not be faked or approximated.
 *
 * This library keeps the visual form — it is a big part of the look — and gives
 * it a meaning derived from real message events:
 *
 *     Buddies (3/8)  =  3 of the 8 buddies in this group have UNREAD messages.
 *
 * Unread is message-derived, not availability-derived: it comes from messages
 * that actually arrived and read receipts the user actually generated. It is
 * also the number a user most wants at a glance in a messenger, which is why it
 * earns the slot.
 *
 * Every group header carries a `title` tooltip spelling this out in words, so
 * no user ever has to guess whether the left number means "online".
 *
 * If a host prefers a different message-derived numerator it can pass
 * `countLabel` to override the rendered text outright — but it must stay
 * message-derived. Do not wire availability into it; there is none.
 * ===========================================================================
 */

import * as React from 'react';
import type { BuddyGroup as BuddyGroupModel } from '../../shared/types';
import { ExpanderBox, ExpanderTriangle } from './icons';
import { cx } from './controls';

export interface BuddyGroupProps {
  group: BuddyGroupModel;
  /** Total buddies in this group — the right-hand number. */
  total: number;
  /**
   * Buddies in this group that have unread messages — the left-hand number.
   * Message-derived. Never availability-derived.
   */
  unreadBuddies?: number;
  /** Override the whole `(n/m)` string. Must remain message-derived. */
  countLabel?: string;
  /** `triangle` (AIM 5.x) or `plus` (classic tree). */
  expander?: 'triangle' | 'plus';
  selected?: boolean;
  onToggle?: (group: BuddyGroupModel, collapsed: boolean) => void;
  onSelect?: (group: BuddyGroupModel) => void;
  onContextMenu?: (group: BuddyGroupModel, e: React.MouseEvent) => void;
  /** BuddyRow elements. */
  children?: React.ReactNode;
  /** Shown when the group is expanded and has no members. */
  emptyLabel?: string;
  className?: string;
}

export function BuddyGroup({
  group,
  total,
  unreadBuddies = 0,
  countLabel,
  expander = 'triangle',
  selected,
  onToggle,
  onSelect,
  onContextMenu,
  children,
  emptyLabel = 'No buddies in this group',
  className,
}: BuddyGroupProps) {
  const open = !group.collapsed;
  const count = countLabel ?? `(${unreadBuddies}/${total})`;

  const tooltip =
    countLabel !== undefined
      ? `${group.name} — ${countLabel}`
      : `${group.name}: ${unreadBuddies} of ${total} ${
          total === 1 ? 'buddy has' : 'buddies have'
        } unread messages. (This client shows no online/offline state — Signal does not transmit any.)`;

  const Expander = expander === 'plus' ? ExpanderBox : ExpanderTriangle;

  return (
    <div className={cx('aim-group', selected && 'aim-group--selected', className)} role="group">
      <div
        role="treeitem"
        aria-expanded={open}
        tabIndex={-1}
        title={tooltip}
        className="aim-group__header"
        onClick={() => {
          onSelect?.(group);
          onToggle?.(group, open);
        }}
        onContextMenu={(e) => {
          onSelect?.(group);
          onContextMenu?.(group, e);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle?.(group, open);
          }
        }}
      >
        <span className="aim-group__expander">
          <Expander open={open} />
        </span>
        <span className="aim-group__name">{group.name}</span>
        <span className="aim-group__count">{count}</span>
      </div>

      {open ? (
        <div className="aim-group__children">
          {total === 0 ? <div className="aim-group__empty">{emptyLabel}</div> : children}
        </div>
      ) : null}
    </div>
  );
}
