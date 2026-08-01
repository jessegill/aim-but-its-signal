/**
 * ContextMenu — a right-click popup for the buddy tree.
 *
 * The UI library ships MenuBar (the File/Edit/People strip) but no free-floating popup, and
 * SPEC.md §3/§9 calls for context menus on buddies and groups. This is that popup, and
 * nothing more: it reuses the library's existing `.aim-menu` / `.aim-menu__item` styling and
 * its MenuItemSpec shape, so it looks and behaves exactly like the menu-bar dropdowns without
 * re-styling or forking anything in src/renderer/ui.
 *
 * It cannot be a native Electron Menu — renderers have no Electron access (SPEC.md §3).
 *
 * Behaviour is period-correct: click an item to run it, click anywhere else or press Escape to
 * dismiss, and the popup is nudged back on-screen if the click was near an edge.
 */

import * as React from 'react';

import type { MenuItemSpec } from '../ui';

export interface ContextMenuState {
  x: number;
  y: number;
  items: MenuItemSpec[];
}

export interface ContextMenuProps {
  menu: ContextMenuState | null;
  onClose: () => void;
}

export function ContextMenu({ menu, onClose }: ContextMenuProps) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const [offset, setOffset] = React.useState<{ dx: number; dy: number }>({ dx: 0, dy: 0 });

  React.useEffect(() => {
    if (menu === null) return undefined;
    const onDocMouseDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('blur', onClose);
    };
  }, [menu, onClose]);

  // Keep the popup inside the (often very narrow) buddy-list window.
  React.useLayoutEffect(() => {
    if (menu === null) {
      setOffset({ dx: 0, dy: 0 });
      return;
    }
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const dx = rect.right > window.innerWidth ? window.innerWidth - rect.right - 2 : 0;
    const dy = rect.bottom > window.innerHeight ? window.innerHeight - rect.bottom - 2 : 0;
    setOffset({ dx, dy });
  }, [menu]);

  if (menu === null) return null;

  return (
    <div
      ref={ref}
      className="aim-menu"
      role="menu"
      style={{
        position: 'fixed',
        top: menu.y + offset.dy,
        left: menu.x + offset.dx,
        maxHeight: '90vh',
        overflowY: 'auto',
        zIndex: 900,
      }}
    >
      {menu.items.map((item, i) =>
        item.separator === true ? (
          <div key={`sep${i}`} className="aim-menu__sep" role="separator" />
        ) : (
          <button
            key={`${item.label ?? ''}${i}`}
            type="button"
            role="menuitem"
            className="aim-menu__item"
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onSelect?.();
            }}
          >
            {item.checked === true ? <span className="aim-menu__check">•</span> : null}
            <span className="aim-menu__label">{item.label}</span>
            {item.accelerator !== undefined ? (
              <span className="aim-menu__accel">{item.accelerator}</span>
            ) : null}
          </button>
        )
      )}
    </div>
  );
}
