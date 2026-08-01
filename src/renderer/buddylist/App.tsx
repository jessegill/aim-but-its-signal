/**
 * Buddy list window (SPEC.md §9).
 *
 * A pure view over what the main process owns. It fetches the roster once, re-fetches whenever
 * main pushes `roster:updated`, and mutates nothing locally except selection, menu/dialog
 * state, and an ephemeral unread tally. There is no store here and no cache that outlives the
 * window — main is the single source of truth (SPEC.md §3, §4).
 *
 * NO PRESENCE (SPEC.md §7). Nothing in this file reads, derives, sorts by, or displays
 * availability. The only per-buddy signal shown is unread count, which is message-derived. The
 * connection state in the banner and status bar is this device's link to the service, not a
 * person's status.
 *
 * A roster entry with zero messages is completely ordinary here (SPEC.md §6): the tree is
 * built from the roster, never from a conversation list, so a buddy nobody has ever messaged
 * renders exactly like everyone else and can be double-clicked to open a conversation.
 */

import * as React from 'react';
import type { JSX } from 'react';

import type { Buddy, BuddyId, ConnectionState, GroupId, Roster } from '@shared/types';

import { BuddyListWindow, buddyListMenus, type MenuItemSpec, type MenuSpec } from '../ui';
import { ContextMenu, type ContextMenuState } from './ContextMenu';
import { ConfirmDialog, PromptDialog, type ConfirmSpec, type PromptSpec } from './Dialog';
import {
  BRIDGE_MISSING,
  describeFailure,
  hasBridge,
  invoke,
  useIpcEvent,
  windowChrome,
} from './ipc';

const EMPTY_ROSTER: Roster = { groups: [], buddies: [] };

/**
 * The linked account's own screen name for the yellow banner.
 *
 * CONTRACT GAP: nothing in src/shared/types.ts exposes the local account's display name, so it
 * is read from the window's query string if main chooses to pass one (the same mechanism
 * createImWindow uses for conversationId) and otherwise falls back to a neutral label. It is
 * never invented from roster data.
 */
function selfScreenName(): string {
  return new URLSearchParams(window.location.search).get('screenName') ?? 'My Account';
}

export function App(): JSX.Element {
  const [roster, setRoster] = React.useState<Roster>(EMPTY_ROSTER);
  const [connection, setConnection] = React.useState<ConnectionState>('linking');
  const [selectedBuddyId, setSelectedBuddyId] = React.useState<BuddyId | null>(null);
  const [selectedGroupId, setSelectedGroupId] = React.useState<GroupId | null>(null);
  const [showEmptyGroups, setShowEmptyGroups] = React.useState(true);
  const [windowActive, setWindowActive] = React.useState(() => document.hasFocus());
  const [error, setError] = React.useState<string | null>(hasBridge() ? null : BRIDGE_MISSING);
  const [menu, setMenu] = React.useState<ContextMenuState | null>(null);
  const [prompt, setPrompt] = React.useState<PromptSpec | null>(null);
  const [confirm, setConfirm] = React.useState<ConfirmSpec | null>(null);

  /**
   * Unread counts: ephemeral and message-derived (SPEC.md §7 — this is not presence).
   *
   * CONTRACT GAP: no channel reports unread counts, so this counts inbound `im:message` pushes
   * for conversations whose id matches a roster buddy id and clears when that conversation is
   * opened. If main's ConversationId is not the BuddyId for 1:1 chats, nothing is counted and
   * the tree shows zeros rather than showing something wrong.
   */
  const [unreadByBuddy, setUnreadByBuddy] = React.useState<Record<BuddyId, number>>({});

  /* --- data --------------------------------------------------------------- */

  const refresh = React.useCallback(async (): Promise<void> => {
    try {
      const next = await invoke('roster:get');
      setRoster(next);
      setError(null);
    } catch (err) {
      setError(describeFailure('roster:get', err));
    }
  }, []);

  /** Runs a mutation, surfaces failure, and re-reads the roster main owns. */
  const mutate = React.useCallback(
    (channel: string, run: () => Promise<unknown>): void => {
      void (async () => {
        try {
          await run();
          setError(null);
          await refresh();
        } catch (err) {
          setError(describeFailure(channel, err));
        }
      })();
    },
    [refresh]
  );

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  React.useEffect(() => {
    void (async () => {
      try {
        setConnection(await invoke('connection:get'));
      } catch {
        // Not fatal: the pushed connection:state event is the primary source. Until either
        // arrives the window shows "Linking…" rather than claiming to be connected.
      }
    })();
  }, []);

  useIpcEvent('roster:updated', () => void refresh());
  useIpcEvent('connection:state', (state) => setConnection(state));
  useIpcEvent('im:message', (conversationId, message) => {
    if (message.outgoing) return;
    setUnreadByBuddy((prev) => ({ ...prev, [conversationId]: (prev[conversationId] ?? 0) + 1 }));
  });

  React.useEffect(() => {
    const onFocus = (): void => setWindowActive(true);
    const onBlur = (): void => setWindowActive(false);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  /* --- derived ------------------------------------------------------------ */

  const groups = React.useMemo(
    () => [...roster.groups].sort((a, b) => a.sortOrder - b.sortOrder),
    [roster.groups]
  );
  const selectedBuddy = React.useMemo(
    () => roster.buddies.find((b) => b.id === selectedBuddyId) ?? null,
    [roster.buddies, selectedBuddyId]
  );

  /* --- actions ------------------------------------------------------------ */

  const openIm = React.useCallback(
    (buddy: Buddy): void => {
      // Opening clears this buddy's local tally; main owns real read state via im:markRead.
      setUnreadByBuddy((prev) => {
        if (!(buddy.id in prev)) return prev;
        const next = { ...prev };
        delete next[buddy.id];
        return next;
      });
      mutate('window:openIm', () => invoke('window:openIm', buddy.id));
    },
    [mutate]
  );

  const toggleGroup = React.useCallback(
    (groupId: GroupId, collapsed: boolean): void => {
      // Optimistic: a tree that waits for a round trip before expanding feels broken. The
      // refresh() inside mutate() re-reads the truth immediately after, and a failure both
      // reverts the row and says what broke.
      setRoster((prev) => ({
        ...prev,
        groups: prev.groups.map((g) => (g.id === groupId ? { ...g, collapsed } : g)),
      }));
      mutate('group:setCollapsed', () => invoke('group:setCollapsed', groupId, collapsed));
    },
    [mutate]
  );

  const promptNewGroup = React.useCallback(
    (then?: (groupId: GroupId) => void): void => {
      setPrompt({
        title: 'New Group',
        label: 'Group name:',
        placeholder: 'Family',
        okLabel: 'Create',
        onSubmit: (name) => {
          setPrompt(null);
          void (async () => {
            try {
              const groupId = await invoke('group:create', name);
              setError(null);
              then?.(groupId);
              await refresh();
            } catch (err) {
              setError(describeFailure('group:create', err));
            }
          })();
        },
      });
    },
    [refresh]
  );

  const promptNickname = React.useCallback(
    (buddy: Buddy): void => {
      setPrompt({
        title: 'Edit Nickname',
        label: `Local nickname for ${buddy.displayName}:`,
        initialValue: buddy.nickname ?? '',
        placeholder: buddy.displayName,
        // Submitting empty clears the override — the local name is optional (SPEC.md §2).
        allowEmpty: true,
        onSubmit: (value) => {
          setPrompt(null);
          mutate('roster:setNick', () =>
            invoke('roster:setNick', buddy.id, value.length === 0 ? null : value)
          );
        },
      });
    },
    [mutate]
  );

  const moveGroup = React.useCallback(
    (groupId: GroupId, delta: number): void => {
      const index = groups.findIndex((g) => g.id === groupId);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= groups.length) return;
      // `sortOrder` is sent as the desired position in the ordered list; main is expected to
      // re-index the others. See the group:reorder note in the report.
      mutate('group:reorder', () => invoke('group:reorder', groupId, target));
    },
    [groups, mutate]
  );

  /* --- context menus ------------------------------------------------------ */

  const groupAssignmentItems = React.useCallback(
    (buddy: Buddy & { groupId: GroupId }): MenuItemSpec[] => [
      ...groups.map((g) => ({
        label: `Move to “${g.name}”`,
        checked: g.id === buddy.groupId,
        disabled: g.id === buddy.groupId,
        onSelect: () => mutate('roster:move', () => invoke('roster:move', buddy.id, g.id)),
      })),
      {
        label: 'Move to New Group…',
        onSelect: () =>
          promptNewGroup((groupId) =>
            mutate('roster:move', () => invoke('roster:move', buddy.id, groupId))
          ),
      },
    ],
    [groups, mutate, promptNewGroup]
  );

  const onBuddyContextMenu = React.useCallback(
    (buddy: Buddy, e: React.MouseEvent): void => {
      e.preventDefault();
      const entry = roster.buddies.find((b) => b.id === buddy.id);
      if (entry === undefined) return;
      const hasNick = (buddy.nickname ?? '').trim().length > 0;
      setSelectedBuddyId(buddy.id);
      setSelectedGroupId(null);
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          { label: 'Send Instant Message', accelerator: '↵', onSelect: () => openIm(buddy) },
          { separator: true },
          { label: 'Set Nickname…', onSelect: () => promptNickname(buddy) },
          {
            label: 'Remove Nickname',
            disabled: !hasNick,
            onSelect: () =>
              mutate('roster:setNick', () => invoke('roster:setNick', buddy.id, null)),
          },
          { separator: true },
          ...groupAssignmentItems(entry),
        ],
      });
    },
    [roster.buddies, openIm, promptNickname, mutate, groupAssignmentItems]
  );

  const onGroupContextMenu = React.useCallback(
    (groupId: GroupId, e: React.MouseEvent): void => {
      e.preventDefault();
      const index = groups.findIndex((g) => g.id === groupId);
      const group = groups[index];
      if (group === undefined) return;
      const members = roster.buddies.filter((b) => b.groupId === groupId).length;
      setSelectedGroupId(groupId);
      setSelectedBuddyId(null);
      setMenu({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            label: group.collapsed ? 'Expand Group' : 'Collapse Group',
            onSelect: () => toggleGroup(groupId, !group.collapsed),
          },
          { separator: true },
          { label: 'New Group…', onSelect: () => promptNewGroup() },
          {
            label: 'Rename Group…',
            onSelect: () =>
              setPrompt({
                title: 'Rename Group',
                label: 'Group name:',
                initialValue: group.name,
                okLabel: 'Rename',
                onSubmit: (name) => {
                  setPrompt(null);
                  mutate('group:rename', () => invoke('group:rename', groupId, name));
                },
              }),
          },
          {
            label: 'Delete Group',
            onSelect: () =>
              setConfirm({
                title: 'Delete Group',
                okLabel: 'Delete',
                body: (
                  <>
                    Delete the group <b>{group.name}</b>?
                    {members > 0 ? (
                      <>
                        {' '}
                        Its {members} {members === 1 ? 'buddy' : 'buddies'} move back to the default
                        group. Nobody is removed from your contacts — groups are local organisation
                        only.
                      </>
                    ) : null}
                  </>
                ),
                onConfirm: () => {
                  setConfirm(null);
                  mutate('group:delete', () => invoke('group:delete', groupId));
                },
              }),
          },
          { separator: true },
          { label: 'Move Up', disabled: index <= 0, onSelect: () => moveGroup(groupId, -1) },
          {
            label: 'Move Down',
            disabled: index >= groups.length - 1,
            onSelect: () => moveGroup(groupId, 1),
          },
        ],
      });
    },
    [groups, roster.buddies, toggleGroup, promptNewGroup, mutate, moveGroup]
  );

  /* --- menu bar ------------------------------------------------------------ */

  const menus: MenuSpec[] = React.useMemo(() => {
    const built = buddyListMenus({
      hasSelection: selectedBuddy !== null,
      showEmptyGroups,
      onToggleShowEmptyGroups: () => setShowEmptyGroups((v) => !v),
      onNewGroup: () => promptNewGroup(),
      onCloseWindow: windowChrome.close,
      onSendMessage: selectedBuddy ? () => openIm(selectedBuddy) : undefined,
      onEditNickname: selectedBuddy ? () => promptNickname(selectedBuddy) : undefined,
      onMoveToGroup: selectedBuddy
        ? () => {
            const entry = roster.buddies.find((b) => b.id === selectedBuddy.id);
            if (entry === undefined) return;
            setMenu({ x: 8, y: 44, items: groupAssignmentItems(entry) });
          }
        : undefined,
      onAbout: () =>
        setConfirm({
          title: 'About',
          body: (
            <>
              A 2003-era instant messenger shell riding a modern encrypted network as a linked
              device. This client shows no online, idle, or away state — the protocol transmits
              none, so none is invented.
            </>
          ),
        }),
    });

    // The remaining slots each need a main-process capability that no channel in
    // src/shared/types.ts provides (add buddy, preferences, buddy info, safety numbers,
    // relink, clipboard, search). They are greyed out rather than left looking live and doing
    // nothing when clicked.
    return built.map((m) => ({
      ...m,
      items: m.items.map((item) =>
        item.separator === true
          ? item
          : { ...item, disabled: item.disabled === true || item.onSelect === undefined }
      ),
    }));
  }, [
    selectedBuddy,
    showEmptyGroups,
    promptNewGroup,
    openIm,
    promptNickname,
    roster.buddies,
    groupAssignmentItems,
  ]);

  /* --- render -------------------------------------------------------------- */

  return (
    <div
      className="aim-root chrome"
      style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <BuddyListWindow
        /* The library sizes itself for the showcase page; in a real frameless BrowserWindow
           the window IS the component, so it fills whatever the OS gives it. */
        style={{ width: '100%', flex: '1 1 auto', minHeight: 0 }}
        screenName={selfScreenName()}
        roster={roster}
        connection={connection}
        unreadByBuddy={unreadByBuddy}
        selectedBuddyId={selectedBuddyId}
        selectedGroupId={selectedGroupId}
        windowActive={windowActive}
        hideEmptyGroups={!showEmptyGroups}
        menus={menus}
        onSelectBuddy={(b) => {
          setSelectedBuddyId(b.id);
          setSelectedGroupId(null);
        }}
        onOpenIm={openIm}
        onBuddyContextMenu={onBuddyContextMenu}
        onSelectGroup={(id) => {
          setSelectedGroupId(id);
          setSelectedBuddyId(null);
        }}
        onToggleGroup={toggleGroup}
        onGroupContextMenu={onGroupContextMenu}
        onMinimize={windowChrome.minimize}
        onMaximize={windowChrome.maximize}
        onClose={windowChrome.close}
      />

      {/* Failures are shown, never swallowed: a window that quietly stops updating is worse
          than one that says what broke. */}
      {error !== null ? (
        <div className="aim-im__warning" role="alert" style={{ flex: '0 0 auto' }}>
          {error}
        </div>
      ) : null}

      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
      {prompt !== null ? (
        <PromptDialog spec={prompt} onCancel={() => setPrompt(null)} />
      ) : confirm !== null ? (
        <ConfirmDialog spec={confirm} onCancel={() => setConfirm(null)} />
      ) : null}
    </div>
  );
}
