/**
 * BuddyListWindow — narrow and tall (SPEC.md §9), composed of
 * TitleBar / MenuBar / yellow identity banner / group tree / button strip /
 * StatusBar.
 *
 * Pure view. The host passes a Roster and callbacks; nothing here touches IPC.
 *
 * NO PRESENCE (SPEC.md §7): the banner shows the linked account's own name and
 * the app's link state — that is connection state, not a person's availability.
 * There is no away-message field, no status dropdown, no sign-off button, and
 * the tree is never sorted or grouped by anything availability-derived.
 */

import * as React from 'react';
import type { Buddy, BuddyId, ConnectionState, GroupId, Roster } from '../../shared/types';
import { TitleBar } from './TitleBar';
import { MenuBar, buddyListMenus, type MenuSpec } from './MenuBar';
import { Button, StatusBar, Window, WindowBody, cx } from './controls';
import { BuddyGroup } from './BuddyGroup';
import { BuddyRow } from './BuddyRow';
import { AppMark } from './icons';
import { CONNECTION_LABELS } from './connection';

export interface BuddyListWindowProps {
  /** Screen name shown in the yellow banner — the linked account itself. */
  screenName: string;
  roster: Roster;
  /** conversation/buddy id -> unread count. Message-derived. */
  unreadByBuddy?: Record<BuddyId, number>;
  connection?: ConnectionState;
  selectedBuddyId?: BuddyId | null;
  selectedGroupId?: GroupId | null;
  windowActive?: boolean;
  menus?: MenuSpec[];
  expander?: 'triangle' | 'plus';
  /** Hide groups with no members. */
  hideEmptyGroups?: boolean;

  onSelectBuddy?: (buddy: Buddy) => void;
  onOpenIm?: (buddy: Buddy) => void;
  onBuddyContextMenu?: (buddy: Buddy, e: React.MouseEvent) => void;
  onToggleGroup?: (groupId: GroupId, collapsed: boolean) => void;
  onSelectGroup?: (groupId: GroupId) => void;
  onGroupContextMenu?: (groupId: GroupId, e: React.MouseEvent) => void;

  onMinimize?: () => void;
  onMaximize?: () => void;
  onClose?: () => void;

  /** Bottom button strip. Defaults to IM / Info / Setup. */
  footerButtons?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export function BuddyListWindow({
  screenName,
  roster,
  unreadByBuddy = {},
  connection = 'linked',
  selectedBuddyId = null,
  selectedGroupId = null,
  windowActive = true,
  menus,
  expander = 'triangle',
  hideEmptyGroups = false,
  onSelectBuddy,
  onOpenIm,
  onBuddyContextMenu,
  onToggleGroup,
  onSelectGroup,
  onGroupContextMenu,
  onMinimize,
  onMaximize,
  onClose,
  footerButtons,
  className,
  style,
}: BuddyListWindowProps) {
  const groups = React.useMemo(
    () => [...roster.groups].sort((a, b) => a.sortOrder - b.sortOrder),
    [roster.groups]
  );

  const membersByGroup = React.useMemo(() => {
    const map = new Map<GroupId, (Buddy & { groupId: GroupId; sortOrder: number })[]>();
    for (const b of roster.buddies) {
      const list = map.get(b.groupId);
      if (list) list.push(b);
      else map.set(b.groupId, [b]);
    }
    for (const list of map.values()) list.sort((a, b) => a.sortOrder - b.sortOrder);
    return map;
  }, [roster.buddies]);

  const totalBuddies = roster.buddies.length;
  const totalUnreadBuddies = roster.buddies.filter((b) => (unreadByBuddy[b.id] ?? 0) > 0).length;

  const selectedBuddy = selectedBuddyId
    ? (roster.buddies.find((b) => b.id === selectedBuddyId) ?? null)
    : null;

  const defaultFooter = (
    <>
      <Button
        size="small"
        disabled={!selectedBuddy}
        onClick={() => selectedBuddy && onOpenIm?.(selectedBuddy)}
        title="Open an IM window with the selected buddy"
      >
        IM
      </Button>
      <Button size="small" disabled={!selectedBuddy} title="Buddy info">
        Info
      </Button>
      <Button size="small" title="Preferences">
        Setup
      </Button>
    </>
  );

  return (
    <Window className={cx('aim-buddylist', className)} style={style}>
      <TitleBar
        title={screenName}
        active={windowActive}
        onMinimize={onMinimize}
        onMaximize={onMaximize}
        onClose={onClose}
      />
      <MenuBar menus={menus ?? buddyListMenus({ hasSelection: !!selectedBuddy })} />

      <WindowBody>
        <div className="aim-buddylist__banner">
          <AppMark size={22} />
          <span className="aim-buddylist__banner-text">
            <span className="aim-buddylist__screenname" title={screenName}>
              {screenName}
            </span>
            {/* Link state of THIS device — not anybody's availability. */}
            <span className="aim-buddylist__sublabel">{CONNECTION_LABELS[connection].short}</span>
          </span>
        </div>

        <div className="aim-buddylist__tree" role="tree" aria-label="Buddy list">
          {groups.map((group) => {
            const members = membersByGroup.get(group.id) ?? [];
            if (hideEmptyGroups && members.length === 0) return null;
            const unreadBuddies = members.filter((b) => (unreadByBuddy[b.id] ?? 0) > 0).length;

            return (
              <BuddyGroup
                key={group.id}
                group={group}
                total={members.length}
                unreadBuddies={unreadBuddies}
                expander={expander}
                selected={selectedGroupId === group.id}
                onToggle={(g, collapsed) => onToggleGroup?.(g.id, collapsed)}
                onSelect={(g) => onSelectGroup?.(g.id)}
                onContextMenu={(g, e) => onGroupContextMenu?.(g.id, e)}
              >
                {members.map((buddy) => (
                  <BuddyRow
                    key={buddy.id}
                    buddy={buddy}
                    selected={selectedBuddyId === buddy.id}
                    unread={unreadByBuddy[buddy.id]}
                    onSelect={onSelectBuddy}
                    onOpen={onOpenIm}
                    onContextMenu={onBuddyContextMenu}
                  />
                ))}
              </BuddyGroup>
            );
          })}
        </div>

        <div className="aim-buddylist__footer">{footerButtons ?? defaultFooter}</div>
      </WindowBody>

      <StatusBar
        cells={[
          {
            grow: true,
            // Same convention as the group headers, spelled out on hover.
            content: `${totalUnreadBuddies}/${totalBuddies} unread`,
            title: `${totalUnreadBuddies} of ${totalBuddies} buddies have unread messages. This client shows no online/offline state.`,
          },
          {
            width: 84,
            content: CONNECTION_LABELS[connection].short,
            title: CONNECTION_LABELS[connection].detail,
          },
        ]}
      />
    </Window>
  );
}
