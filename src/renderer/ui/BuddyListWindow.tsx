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
 *
 * ===========================================================================
 * THE TREE IS CONVERSATION-DRIVEN, NOT ROSTER-DRIVEN
 * ===========================================================================
 * SPEC.md §6 said the buddy list shows every contact. It no longer does, by
 * decision: with a real Signal account that is a list of everyone who has ever
 * had your number, most of whom you will never message, and the handful of
 * conversations that matter drown in it.
 *
 * A buddy or room appears once it has an entry in `conversations` — meaning it
 * has carried a message, or the user has pinned or archived it. The full roster
 * is still passed in and is one toggle away (`showAllConversations`), because a list
 * that only shows people who have already written to you is a list you can
 * never start a conversation from.
 *
 * Section order is fixed: Pinned, the user's own groups, Chat Rooms, Archived.
 * ===========================================================================
 */

import * as React from 'react';
import type {
  Buddy,
  BuddyId,
  ConnectionState,
  ConversationEntry,
  ConversationId,
  ConversationShelf,
  GroupChat,
  GroupId,
  Roster,
} from '../../shared/types';
import { TitleBar } from './TitleBar';
import { MenuBar, buddyListMenus, type MenuSpec } from './MenuBar';
import { Button, StatusBar, Window, WindowBody, cx } from './controls';
import { BuddyGroup } from './BuddyGroup';
import { BuddyRow, type DropIndicator } from './BuddyRow';
import { AppMark, ChatRoomGlyph } from './icons';
import { CONNECTION_LABELS } from './connection';

/**
 * Ids for the synthetic section headers. Negative so they can never collide with a real
 * `buddy_groups.id`, which is a positive SQLite rowid — and so a stray callback carrying one
 * cannot be mistaken for an instruction to rename or delete one of the user's own groups.
 */
export const PINNED_SECTION_ID = -2;
export const CHAT_ROOMS_SECTION_ID = -1;
export const ARCHIVED_SECTION_ID = -3;

export interface BuddyListWindowProps {
  /** Screen name shown in the yellow banner — the linked account itself. */
  screenName: string;
  /**
   * Title-bar text. The product's name, not the user's: AIM's own buddy list was titled with
   * the screen name, but that name is already the loudest thing on the page in the banner
   * directly below, and repeating it wastes the one place the window can say what it is.
   */
  windowTitle?: string;
  roster: Roster;
  /**
   * Signal group conversations, listed in their own fixed section below the user's groups.
   *
   * They are NOT roster entries and never mix with buddies: the roster is people (SPEC.md §6),
   * a chat room is a place. Keeping them separate is also what stops a group from being
   * dragged into a buddy group, which the exclusive-membership schema would refuse anyway.
   */
  chats?: GroupChat[];
  /**
   * Which conversations exist, and where each one sits. Anything not listed here is hidden
   * unless `showAllConversations` is on — see the note at the top of this file.
   */
  conversations?: ConversationEntry[];
  /** Reveal contacts you have never messaged, so a new conversation can be started. */
  showAllConversations?: boolean;
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
  onChatContextMenu?: (chat: GroupChat, e: React.MouseEvent) => void;
  onBuddyContextMenu?: (buddy: Buddy, e: React.MouseEvent) => void;
  onToggleGroup?: (groupId: GroupId, collapsed: boolean) => void;
  onSelectGroup?: (groupId: GroupId) => void;
  onGroupContextMenu?: (groupId: GroupId, e: React.MouseEvent) => void;

  /**
   * Drag and drop. A buddy dropped on a group's row lands just before or after it; dropped on
   * a group header, at the end of that group. `beforeBuddyId` null means the end.
   */
  onMoveBuddy?: (buddyId: BuddyId, groupId: GroupId, beforeBuddyId: BuddyId | null) => void;
  /** A group header dropped before or after another. `beforeGroupId` null means the end. */
  onMoveGroup?: (groupId: GroupId, beforeGroupId: GroupId | null) => void;
  /** A buddy or room dropped on Pinned, Archived, or (rooms only) back on Chat Rooms. */
  onShelve?: (conversationId: ConversationId, shelf: ConversationShelf) => void;

  onMinimize?: () => void;
  onMaximize?: () => void;
  onClose?: () => void;

  /** Bottom button strip. Defaults to IM / Info / Setup. */
  footerButtons?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

/** What is being dragged. */
type DragItem = { kind: 'buddy' | 'chat'; id: ConversationId } | { kind: 'group'; id: GroupId };

/** What it is being dragged over. `next…Id` is the visible neighbour below, for "after". */
type DropSpot =
  | { kind: 'group-row'; groupId: GroupId; buddyId: BuddyId; nextBuddyId: BuddyId | null }
  | { kind: 'group-header'; groupId: GroupId; nextGroupId: GroupId | null }
  | { kind: 'shelf'; shelf: 'pinned' | 'archived' }
  | { kind: 'rooms' };

type DropAction = { indicator: DropIndicator; run: () => void } | null;

const DRAG_MIME = 'application/x-aimgnal-item';

/** Upper half of the row means "before it", lower half "after it". */
function halfOf(e: React.DragEvent<HTMLElement>): 'before' | 'after' {
  const rect = e.currentTarget.getBoundingClientRect();
  return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
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
  onContextMenu,
  dragProps,
  dropIndicator,
}: {
  chat: GroupChat;
  selected?: boolean;
  unread?: number;
  onSelect?: (chat: GroupChat) => void;
  onOpen?: (chat: GroupChat) => void;
  onContextMenu?: (chat: GroupChat, e: React.MouseEvent) => void;
  dragProps?: React.HTMLAttributes<HTMLDivElement> & { draggable?: boolean };
  dropIndicator?: DropIndicator | null;
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
        chat.blocked && 'aim-buddy--blocked',
        dropIndicator && `aim-drop--${dropIndicator}`
      )}
      {...dragProps}
      onClick={() => onSelect?.(chat)}
      onDoubleClick={() => onOpen?.(chat)}
      onContextMenu={(e) => {
        onSelect?.(chat);
        onContextMenu?.(chat, e);
      }}
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
  windowTitle = 'AIMgnal',
  roster,
  chats = [],
  conversations = [],
  showAllConversations = false,
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
  onChatContextMenu,
  onBuddyContextMenu,
  onToggleGroup,
  onSelectGroup,
  onGroupContextMenu,
  onMoveBuddy,
  onMoveGroup,
  onShelve,
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

  /**
   * Shelf lookup, plus the set of conversations that exist at all.
   *
   * A conversation with no entry is not "normal" — it is *absent*, and absent is what hides it
   * from the tree. The two have to stay distinguishable, hence a Map rather than a default.
   */
  const byId = React.useMemo(() => {
    const map = new Map<ConversationId, ConversationEntry>();
    for (const entry of conversations) map.set(entry.id, entry);
    return map;
  }, [conversations]);

  const shelfOf = React.useCallback(
    (id: ConversationId): ConversationShelf => byId.get(id)?.shelf ?? 'normal',
    [byId]
  );

  /** Shown in its ordinary place: it exists (or we are showing everything) and is not shelved. */
  const isOrdinary = React.useCallback(
    (id: ConversationId): boolean => {
      const entry = byId.get(id);
      if (entry === undefined) return showAllConversations;
      return entry.shelf === 'normal';
    },
    [byId, showAllConversations]
  );

  const membersByGroup = React.useMemo(() => {
    const map = new Map<GroupId, (Buddy & { groupId: GroupId; sortOrder: number })[]>();
    for (const b of roster.buddies) {
      if (!isOrdinary(b.id)) continue;
      const list = map.get(b.groupId);
      if (list) list.push(b);
      else map.set(b.groupId, [b]);
    }
    for (const list of map.values()) list.sort((a, b) => a.sortOrder - b.sortOrder);
    return map;
  }, [roster.buddies, isOrdinary]);

  /** Pinned and archived cut across buddies and rooms alike — both are just conversations. */
  const pinnedBuddies = roster.buddies.filter((b) => shelfOf(b.id) === 'pinned');
  const pinnedChats = chats.filter((c) => shelfOf(c.id) === 'pinned');
  const archivedBuddies = roster.buddies.filter((b) => shelfOf(b.id) === 'archived');
  const archivedChats = chats.filter((c) => shelfOf(c.id) === 'archived');
  const ordinaryChats = chats.filter((c) => isOrdinary(c.id));

  const pinnedCount = pinnedBuddies.length + pinnedChats.length;
  const archivedCount = archivedBuddies.length + archivedChats.length;

  // Counts describe what the tree is actually showing, not the whole roster — a status bar
  // claiming 73 buddies above a list of four would be describing a different window.
  const shownBuddies = [...membersByGroup.values()].flat();
  const visibleRows = [...shownBuddies, ...ordinaryChats, ...pinnedBuddies, ...pinnedChats];
  const totalBuddies = visibleRows.length;
  const totalUnreadBuddies = visibleRows.filter((b) => (unreadByBuddy[b.id] ?? 0) > 0).length;

  // These sections collapse like any other, but their state is local rather than persisted:
  // none of them is one of the user's groups, so there is no `buddy_groups` row to remember it.
  const [roomsCollapsed, setRoomsCollapsed] = React.useState(false);
  const [pinnedCollapsed, setPinnedCollapsed] = React.useState(false);
  // Archived starts closed. It is where things go to stop being in the way.
  const [archivedCollapsed, setArchivedCollapsed] = React.useState(true);
  const unreadRooms = ordinaryChats.filter((c) => (unreadByBuddy[c.id] ?? 0) > 0).length;

  const selectedBuddy = selectedBuddyId
    ? (roster.buddies.find((b) => b.id === selectedBuddyId) ?? null)
    : null;

  /* --- drag and drop ------------------------------------------------------
   * What can go where, and nothing else:
   *   buddy → a row in one of the user's groups   before/after that row
   *   buddy → a user group's header               end of that group
   *   buddy or room → Pinned / Archived           onto that shelf
   *   room → Chat Rooms                           off its shelf
   *   group header → another group header         before/after it
   * A room never enters a buddy group (the roster is people, SPEC.md §6), and the synthetic
   * section headers never move. Everything here is also reachable from the context menus.
   * ---------------------------------------------------------------------- */

  const dragItem = React.useRef<DragItem | null>(null);
  const [dropAt, setDropAt] = React.useState<{ key: string; indicator: DropIndicator } | null>(
    null
  );

  const endDrag = (): void => {
    dragItem.current = null;
    setDropAt(null);
  };

  const actionFor = (item: DragItem, spot: DropSpot, half: 'before' | 'after'): DropAction => {
    if (item.kind === 'group') {
      if (spot.kind !== 'group-header' || spot.groupId === item.id || onMoveGroup === undefined) {
        return null;
      }
      const before = half === 'before' ? spot.groupId : spot.nextGroupId;
      return { indicator: half, run: () => onMoveGroup(item.id, before) };
    }
    switch (spot.kind) {
      case 'group-row': {
        if (item.kind !== 'buddy' || spot.buddyId === item.id || onMoveBuddy === undefined) {
          return null;
        }
        const before = half === 'before' ? spot.buddyId : spot.nextBuddyId;
        return { indicator: half, run: () => onMoveBuddy(item.id, spot.groupId, before) };
      }
      case 'group-header':
        if (item.kind !== 'buddy' || onMoveBuddy === undefined) return null;
        return { indicator: 'into', run: () => onMoveBuddy(item.id, spot.groupId, null) };
      case 'shelf':
        if (shelfOf(item.id) === spot.shelf || onShelve === undefined) return null;
        return { indicator: 'into', run: () => onShelve(item.id, spot.shelf) };
      case 'rooms':
        if (item.kind !== 'chat' || shelfOf(item.id) === 'normal' || onShelve === undefined) {
          return null;
        }
        return { indicator: 'into', run: () => onShelve(item.id, 'normal') };
    }
  };

  const dropTarget = (key: string, spot: DropSpot) => ({
    onDragOver: (e: React.DragEvent<HTMLDivElement>) => {
      const item = dragItem.current;
      if (item === null) return;
      const action = actionFor(item, spot, halfOf(e));
      if (action === null) return; // not calling preventDefault is what refuses the drop
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      if (dropAt?.key !== key || dropAt.indicator !== action.indicator) {
        setDropAt({ key, indicator: action.indicator });
      }
    },
    onDragLeave: (e: React.DragEvent<HTMLDivElement>) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setDropAt((current) => (current?.key === key ? null : current));
    },
    onDrop: (e: React.DragEvent<HTMLDivElement>) => {
      const item = dragItem.current;
      if (item === null) return;
      const action = actionFor(item, spot, halfOf(e));
      endDrag();
      if (action === null) return;
      e.preventDefault();
      e.stopPropagation();
      action.run();
    },
  });

  const dragSource = (item: DragItem) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent<HTMLDivElement>) => {
      dragItem.current = item;
      e.dataTransfer.effectAllowed = 'move';
      // Chromium starts a drag only when something is set. The payload itself is unused:
      // the item lives in a ref, so nothing dropped from outside the window can act.
      e.dataTransfer.setData(DRAG_MIME, String(item.id));
    },
    onDragEnd: endDrag,
  });

  const indicatorFor = (key: string): DropIndicator | null =>
    dropAt?.key === key ? dropAt.indicator : null;

  // A buddy and a room render identically wherever they appear — Pinned, their own group, or
  // Archived — so the row is defined once rather than three times with drifting props. Only
  // where it is dropped onto differs, which `spot` carries.
  const renderBuddy = (buddy: Buddy, spot: DropSpot): React.ReactElement => {
    const key = `${spot.kind}:${buddy.id}`;
    return (
      <BuddyRow
        key={buddy.id}
        buddy={buddy}
        selected={selectedBuddyId === buddy.id}
        unread={unreadByBuddy[buddy.id]}
        onSelect={onSelectBuddy}
        onOpen={onOpenIm}
        onContextMenu={onBuddyContextMenu}
        dragProps={{ ...dragSource({ kind: 'buddy', id: buddy.id }), ...dropTarget(key, spot) }}
        dropIndicator={indicatorFor(key)}
      />
    );
  };

  const renderChat = (chat: GroupChat, spot: DropSpot): React.ReactElement => {
    const key = `${spot.kind}:${chat.id}`;
    return (
      <ChatRoomRow
        key={chat.id}
        chat={chat}
        selected={selectedChatId === chat.id}
        unread={unreadByBuddy[chat.id]}
        onSelect={onSelectChat}
        onOpen={onOpenChat}
        onContextMenu={onChatContextMenu}
        dragProps={{ ...dragSource({ kind: 'chat', id: chat.id }), ...dropTarget(key, spot) }}
        dropIndicator={indicatorFor(key)}
      />
    );
  };

  const PINNED: DropSpot = { kind: 'shelf', shelf: 'pinned' };
  const ARCHIVED: DropSpot = { kind: 'shelf', shelf: 'archived' };
  const ROOMS: DropSpot = { kind: 'rooms' };

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
        title={windowTitle}
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
          {/* Pinned sits above everything, and is shown even when empty: it is the only place
              the pin gesture is visible, and a section that appears out of nowhere the first
              time you use a context menu is a section nobody discovers. */}
          <BuddyGroup
            group={{
              id: PINNED_SECTION_ID,
              name: 'Pinned',
              sortOrder: -1,
              collapsed: pinnedCollapsed,
            }}
            total={pinnedCount}
            countLabel={`(${String(pinnedCount)})`}
            expander={expander}
            emptyLabel="Right-click or drag anyone here to pin them"
            onToggle={(_g, collapsed) => setPinnedCollapsed(collapsed)}
            headerDragProps={dropTarget('header:pinned', PINNED)}
            headerDropIndicator={indicatorFor('header:pinned')}
          >
            {pinnedBuddies.map((b) => renderBuddy(b, PINNED))}
            {pinnedChats.map((c) => renderChat(c, PINNED))}
          </BuddyGroup>

          {groups.map((group, groupIndex) => {
            const members = membersByGroup.get(group.id) ?? [];
            const headerKey = `header:${String(group.id)}`;
            const headerSpot: DropSpot = {
              kind: 'group-header',
              groupId: group.id,
              // The full order, hidden empty groups included, so "after" is exact.
              nextGroupId: groups[groupIndex + 1]?.id ?? null,
            };
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
                headerDragProps={{
                  ...dragSource({ kind: 'group', id: group.id }),
                  ...dropTarget(headerKey, headerSpot),
                }}
                headerDropIndicator={indicatorFor(headerKey)}
              >
                {members.map((buddy, index) =>
                  renderBuddy(buddy, {
                    kind: 'group-row',
                    groupId: group.id,
                    buddyId: buddy.id,
                    nextBuddyId: members[index + 1]?.id ?? null,
                  })
                )}
              </BuddyGroup>
            );
          })}

          {ordinaryChats.length > 0 ? (
            <BuddyGroup
              group={{
                // Negative id: this section is synthetic and must never be mistaken for one of
                // the user's groups, whose ids are positive SQLite rowids.
                id: CHAT_ROOMS_SECTION_ID,
                name: 'Chat Rooms',
                sortOrder: Number.MAX_SAFE_INTEGER,
                collapsed: roomsCollapsed,
              }}
              total={ordinaryChats.length}
              unreadBuddies={unreadRooms}
              countLabel={`(${String(unreadRooms)}/${String(ordinaryChats.length)})`}
              expander={expander}
              onToggle={(_g, collapsed) => setRoomsCollapsed(collapsed)}
              headerDragProps={dropTarget('header:rooms', ROOMS)}
              headerDropIndicator={indicatorFor('header:rooms')}
            >
              {ordinaryChats.map((c) => renderChat(c, ROOMS))}
            </BuddyGroup>
          ) : null}

          {/* Archived is last and starts closed — unlike Pinned it is a destination, not
              somewhere you look first, so it stays out of the way until asked for. */}
          {archivedCount > 0 ? (
            <BuddyGroup
              group={{
                id: ARCHIVED_SECTION_ID,
                name: 'Archived',
                sortOrder: Number.MAX_SAFE_INTEGER,
                collapsed: archivedCollapsed,
              }}
              total={archivedCount}
              countLabel={`(${String(archivedCount)})`}
              expander={expander}
              onToggle={(_g, collapsed) => setArchivedCollapsed(collapsed)}
              headerDragProps={dropTarget('header:archived', ARCHIVED)}
              headerDropIndicator={indicatorFor('header:archived')}
            >
              {archivedBuddies.map((b) => renderBuddy(b, ARCHIVED))}
              {archivedChats.map((c) => renderChat(c, ARCHIVED))}
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
