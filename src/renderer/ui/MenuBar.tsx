/**
 * MenuBar — classic File / Edit / People / Help strip with working dropdowns.
 *
 * Behaviour copied from Windows menus of the era:
 *   - Click a top-level item to open it; click again to close.
 *   - Once one menu is open, hovering a sibling switches to it without a click.
 *   - Escape closes; clicking anywhere outside closes.
 *
 * Presentational: every item carries an `onSelect` the host supplies.
 *
 * NO PRESENCE (SPEC.md §7): the People menu deliberately has no "Set Away
 * Message", no "Sign Off", no warn/block-by-status entries. Signal has no such
 * concepts, so faking them here would be lying to the user.
 */

import * as React from 'react';
import { GlyphCheck } from './icons';

export interface MenuItemSpec {
  /** Omit `label` and set `separator` for a divider. */
  label?: string;
  separator?: boolean;
  accelerator?: string;
  disabled?: boolean;
  checked?: boolean;
  onSelect?: () => void;
}

export interface MenuSpec {
  label: string;
  /** Index of the character to underline as the mnemonic. Default 0. */
  mnemonic?: number;
  disabled?: boolean;
  items: MenuItemSpec[];
}

export interface MenuBarProps {
  menus: MenuSpec[];
  className?: string;
}

function Mnemonic({ label, at = 0 }: { label: string; at?: number }) {
  if (at < 0 || at >= label.length) return <>{label}</>;
  return (
    <>
      {label.slice(0, at)}
      <span className="aim-menubar__mnemonic">{label[at]}</span>
      {label.slice(at + 1)}
    </>
  );
}

export function MenuBar({ menus, className }: MenuBarProps) {
  const [openIndex, setOpenIndex] = React.useState<number | null>(null);
  const rootRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    if (openIndex === null) return undefined;

    const onDocMouseDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpenIndex(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenIndex(null);
    };

    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openIndex]);

  return (
    <div
      className={'aim-menubar' + (className ? ' ' + className : '')}
      ref={rootRef}
      role="menubar"
    >
      {menus.map((menu, i) => {
        const open = openIndex === i;
        return (
          <div key={menu.label} style={{ position: 'relative', display: 'flex' }}>
            <button
              type="button"
              role="menuitem"
              aria-haspopup="true"
              aria-expanded={open}
              disabled={menu.disabled}
              className={'aim-menubar__item' + (open ? ' aim-menubar__item--open' : '')}
              onClick={() => setOpenIndex(open ? null : i)}
              // Hover-to-switch only once a menu is already open — matches Windows.
              onMouseEnter={() => {
                if (openIndex !== null && !menu.disabled) setOpenIndex(i);
              }}
            >
              <Mnemonic label={menu.label} at={menu.mnemonic ?? 0} />
            </button>

            {open ? (
              <div className="aim-menu" role="menu" style={{ left: 0 }}>
                {menu.items.map((item, j) =>
                  item.separator ? (
                    <div key={'sep' + j} className="aim-menu__sep" role="separator" />
                  ) : (
                    <button
                      key={(item.label ?? '') + j}
                      type="button"
                      role="menuitem"
                      className="aim-menu__item"
                      disabled={item.disabled}
                      onClick={() => {
                        setOpenIndex(null);
                        item.onSelect?.();
                      }}
                    >
                      {item.checked ? (
                        <span className="aim-menu__check">
                          <GlyphCheck size={9} />
                        </span>
                      ) : null}
                      <span className="aim-menu__label">{item.label}</span>
                      {item.accelerator ? (
                        <span className="aim-menu__accel">{item.accelerator}</span>
                      ) : null}
                    </button>
                  )
                )}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Default menu shapes. Exported as builders so windows can supply handlers
 * without re-typing the era-correct labels each time.
 * ------------------------------------------------------------------------ */

export interface BuddyListMenuHandlers {
  onNewGroup?: () => void;
  onAddBuddy?: () => void;
  onPreferences?: () => void;
  onCloseWindow?: () => void;
  onCut?: () => void;
  onCopy?: () => void;
  onPaste?: () => void;
  onFindBuddy?: () => void;
  onSendMessage?: () => void;
  onGetInfo?: () => void;
  onEditNickname?: () => void;
  onMoveToGroup?: () => void;
  onSafetyNumber?: () => void;
  onAbout?: () => void;
  onRelink?: () => void;
  /** Toggle state for the "Show Offline…"-shaped slot. See note below. */
  showEmptyGroups?: boolean;
  onToggleShowEmptyGroups?: () => void;
  /** True when exactly one buddy is selected — gates the People menu. */
  hasSelection?: boolean;
}

/**
 * Buddy-list menus.
 *
 * Note the People menu: in real AIM this is where "Set Away Message", "Sign
 * Off" and warn levels lived. Those are presence features and Signal has none,
 * so the slots are simply absent rather than filled with fakes (SPEC.md §7).
 * The View toggle is "Show Empty Groups" — an organisation preference — not
 * AIM's "Show Offline Buddies".
 */
export function buddyListMenus(h: BuddyListMenuHandlers = {}): MenuSpec[] {
  const noSel = !h.hasSelection;
  return [
    {
      label: 'File',
      items: [
        { label: 'New Group…', accelerator: '⌘G', onSelect: h.onNewGroup },
        { label: 'Add Buddy…', accelerator: '⌘N', onSelect: h.onAddBuddy },
        { separator: true },
        { label: 'Relink Device…', onSelect: h.onRelink },
        { separator: true },
        { label: 'Preferences…', accelerator: '⌘,', onSelect: h.onPreferences },
        { separator: true },
        { label: 'Close Window', accelerator: '⌘W', onSelect: h.onCloseWindow },
      ],
    },
    {
      label: 'Edit',
      items: [
        { label: 'Cut', accelerator: '⌘X', onSelect: h.onCut },
        { label: 'Copy', accelerator: '⌘C', onSelect: h.onCopy },
        { label: 'Paste', accelerator: '⌘V', onSelect: h.onPaste },
        { separator: true },
        { label: 'Find Buddy…', accelerator: '⌘F', onSelect: h.onFindBuddy },
        { separator: true },
        {
          label: 'Show Empty Groups',
          checked: h.showEmptyGroups,
          onSelect: h.onToggleShowEmptyGroups,
        },
      ],
    },
    {
      label: 'People',
      items: [
        {
          label: 'Send Instant Message',
          accelerator: '↵',
          disabled: noSel,
          onSelect: h.onSendMessage,
        },
        { label: 'Get Buddy Info', accelerator: '⌘I', disabled: noSel, onSelect: h.onGetInfo },
        { separator: true },
        { label: 'Edit Nickname…', disabled: noSel, onSelect: h.onEditNickname },
        { label: 'Move To Group…', disabled: noSel, onSelect: h.onMoveToGroup },
        { separator: true },
        { label: 'View Safety Number…', disabled: noSel, onSelect: h.onSafetyNumber },
      ],
    },
    {
      label: 'Help',
      items: [{ label: 'About', onSelect: h.onAbout }],
    },
  ];
}

export interface ImMenuHandlers {
  onSaveLog?: () => void;
  onSendFile?: () => void;
  onCloseWindow?: () => void;
  onCut?: () => void;
  onCopy?: () => void;
  onPaste?: () => void;
  onSelectAll?: () => void;
  onClearLog?: () => void;
  onGetInfo?: () => void;
  onSafetyNumber?: () => void;
  onBlock?: () => void;
  onDisappearing?: () => void;
  onAbout?: () => void;
}

export function imMenus(h: ImMenuHandlers = {}): MenuSpec[] {
  return [
    {
      label: 'File',
      items: [
        { label: 'Save Conversation…', accelerator: '⌘S', onSelect: h.onSaveLog },
        { label: 'Send File…', onSelect: h.onSendFile },
        { separator: true },
        { label: 'Close Window', accelerator: '⌘W', onSelect: h.onCloseWindow },
      ],
    },
    {
      label: 'Edit',
      items: [
        { label: 'Cut', accelerator: '⌘X', onSelect: h.onCut },
        { label: 'Copy', accelerator: '⌘C', onSelect: h.onCopy },
        { label: 'Paste', accelerator: '⌘V', onSelect: h.onPaste },
        { label: 'Select All', accelerator: '⌘A', onSelect: h.onSelectAll },
        { separator: true },
        { label: 'Clear Conversation', onSelect: h.onClearLog },
      ],
    },
    {
      label: 'People',
      items: [
        { label: 'Get Buddy Info', accelerator: '⌘I', onSelect: h.onGetInfo },
        { label: 'View Safety Number…', onSelect: h.onSafetyNumber },
        { separator: true },
        { label: 'Disappearing Messages…', onSelect: h.onDisappearing },
        { separator: true },
        { label: 'Block Buddy', onSelect: h.onBlock },
      ],
    },
    {
      label: 'Help',
      items: [{ label: 'About', onSelect: h.onAbout }],
    },
  ];
}
