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
import type {
  Buddy,
  BuddyId,
  ConnectionState,
  ConversationId,
  GroupChat,
  GroupId,
  Roster,
} from '../../shared/types';
import { TitleBar } from './TitleBar';
import { MenuBar, buddyListMenus, type MenuSpec } from './MenuBar';
import { Button, StatusBar, Window, WindowBody, cx } from './controls';
import { BuddyGroup } from './BuddyGroup';
import { BuddyRow } from './BuddyRow';
import { AppMark, ChatRoomGlyph } from './icons';
import { CONNECTION_LABELS } from './connection';

/**
 * Id for the synthetic "Chat Rooms" section header. Negative so it can never collide with a
 * real `buddy_groups.id`, which is a positive SQLite rowid — and so a stray callback carrying
 * it cannot be mistaken for an instruction to rename or delete one of the user's own groups.
 */
export const CHAT_ROOMS_SECTION_ID = -1;

export interface BuddyListWindowProps {
  /** Screen name shown in the yellow banner — the linked account itself. */
  screenName: string;
  roster: Roster;
  /**
   * Signal group conversations, listed in their own fixed section below the user's groups.
   *
   * They are NOT roster entries and never mix with buddies: the roster is people (SPEC.md §6),
   * a chat room is a place. Keeping them separate is also what stops a group from being
   * dragged into a buddy group, which the exclusive-membership schema would refuse anyway.
   */
  chats?: GroupChat[];
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

  /** Selected chat room, if the selection is a room rather than a buddy. */
  selectedChatId?: ConversationId | null;

  onSelectBuddy?: (buddy: Buddy) => void;
  onOpenIm?: (buddy: Buddy) => void;
  onSelectChat?: (chat: GroupChat) => void;
  /** Double-click a room — opens its chat-room window. */
  onOpenChat?: (chat: GroupChat) => void;
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

/**
 * One chat room in the buddy list.
 *
 * Deliberately its own component rather than a `BuddyRow` fed a synthetic Buddy: a room has no
 * nickname, no phone number and no registration state, and every one of those affordances would
 * have to be suppressed. The member count in the tooltip is membership, never availability
 * (SPEC.md §7).
 */
function ChatRoomRow({
  chat,
  selected,
  unread,
  onSelect,
  onOpen,
}: {
  chat: GroupChat;
  selected?: boolean;
  unread?: number;
  onSelect?: (chat: GroupChat) => void;
  onOpen?: (chat: GroupChat) => void;
}) {
  const title = [
    chat.name,
    `${String(chat.members.length)} members`,
    chat.isMember ? null : 'You have left this group — cannot send',
    chat.blocked ? 'Blocked' : null,
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
        !chat.isMember && 'aim-buddy--unregistered',
        chat.blocked && 'aim-buddy--blocked'
      )}
      onClick={() => onSelect?.(chat)}
      onDoubleClick={() => onOpen?.(chat)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onOpen?.(chat);
        }
      }}
    >
      <span className="aim-buddy__icon">
        <ChatRoomGlyph size={12} />
      </span>
      <span className="aim-buddy__name">{chat.name}</span>
      {unread !== undefined && unread > 0 ? (
        <span className="aim-buddy__unread" title={`${String(unread)} unread`}>
          ({unread})
        </span>
      ) : null}
    </div>
  );
}

export function BuddyListWindow({
  screenName,
  roster,
  chats = [],
  unreadByBuddy = {},
  connection = 'linked',
  selectedBuddyId = null,
  selectedGroupId = null,
  selectedChatId = null,
  windowActive = true,
  menus,
  expander = 'triangle',
  hideEmptyGroups = false,
  onSelectBuddy,
  onOpenIm,
  onSelectChat,
  onOpenChat,
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

  // The rooms section collapses like any other, but its state is local rather than persisted:
  // it is not one of the user's groups, so it has no row in `buddy_groups` to remember it.
  const [roomsCollapsed, setRoomsCollapsed] = React.useState(false);
  const unreadRooms = chats.filter((c) => (unreadByBuddy[c.id] ?? 0) > 0).length;

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

          {chats.length > 0 ? (
            <BuddyGroup
              group={{
                // Negative id: this section is synthetic and must never be mistaken for one of
                // the user's groups, whose ids are positive SQLite rowids.
                id: CHAT_ROOMS_SECTION_ID,
                name: 'Chat Rooms',
                sortOrder: Number.MAX_SAFE_INTEGER,
                collapsed: roomsCollapsed,
              }}
              total={chats.length}
              unreadBuddies={unreadRooms}
              countLabel={`(${String(unreadRooms)}/${String(chats.length)})`}
              expander={expander}
              onToggle={(_g, collapsed) => setRoomsCollapsed(collapsed)}
            >
              {chats.map((chat) => (
                <ChatRoomRow
                  key={chat.id}
                  chat={chat}
                  selected={selectedChatId === chat.id}
                  unread={unreadByBuddy[chat.id]}
                  onSelect={onSelectChat}
                  onOpen={onOpenChat}
                />
              ))}
            </BuddyGroup>
          ) : null}
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
