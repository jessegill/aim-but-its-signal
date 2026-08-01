/**
 * TitleBar — XP Luna title bar.
 *
 * This is REAL window chrome. The app is macOS-only and every BrowserWindow is
 * frameless (`frame: false`), so this component is the only chrome the window
 * has: it is the drag handle, and its buttons are the only minimize / maximize /
 * close controls that exist.
 *
 * Presentational only. `onMinimize` / `onMaximize` / `onClose` are plain
 * callbacks — the integration layer wires them to IPC. This component never
 * touches `ipcRenderer`.
 *
 * Controls sit on the RIGHT, Windows-style. Not macOS traffic lights.
 */

import * as React from 'react';
import { AppMark, GlyphClose, GlyphMaximize, GlyphMinimize } from './icons';

export interface TitleBarProps {
  title: string;
  /** Rendered at 16px on the left. Defaults to the app mark. */
  icon?: React.ReactNode;
  /** Inactive windows get the washed-out Luna gradient. */
  active?: boolean;
  onMinimize?: () => void;
  onMaximize?: () => void;
  onClose?: () => void;
  /** Hide individual controls (e.g. the sign-on window has no maximize). */
  showMinimize?: boolean;
  showMaximize?: boolean;
  showClose?: boolean;
  /** True when the window is currently maximized — swaps the restore glyph. */
  maximized?: boolean;
  /** Double-clicking the bar toggles maximize, as on Windows. */
  onTitleDoubleClick?: () => void;
  className?: string;
}

export function TitleBar({
  title,
  icon,
  active = true,
  onMinimize,
  onMaximize,
  onClose,
  showMinimize = true,
  showMaximize = true,
  showClose = true,
  maximized = false,
  onTitleDoubleClick,
  className,
}: TitleBarProps) {
  const handleDoubleClick = onTitleDoubleClick ?? onMaximize;

  return (
    <div
      className={
        'aim-titlebar' +
        (active ? '' : ' aim-titlebar--inactive') +
        (className ? ' ' + className : '')
      }
      onDoubleClick={handleDoubleClick}
    >
      <span className="aim-titlebar__icon">{icon ?? <AppMark size={16} />}</span>
      <span className="aim-titlebar__text">{title}</span>

      {/* -webkit-app-region: no-drag lives on this container AND on each button
          in theme.css. Without it the controls sit inside the drag region and
          silently never receive clicks. */}
      <span className="aim-titlebar__buttons">
        {showMinimize ? (
          <button
            type="button"
            className="aim-titlebar__btn"
            title="Minimize"
            aria-label="Minimize"
            onClick={onMinimize}
            disabled={!onMinimize}
          >
            <GlyphMinimize />
          </button>
        ) : null}
        {showMaximize ? (
          <button
            type="button"
            className="aim-titlebar__btn"
            title={maximized ? 'Restore' : 'Maximize'}
            aria-label={maximized ? 'Restore' : 'Maximize'}
            onClick={onMaximize}
            disabled={!onMaximize}
          >
            <GlyphMaximize restored={maximized} />
          </button>
        ) : null}
        {showClose ? (
          <button
            type="button"
            className="aim-titlebar__btn aim-titlebar__btn--close"
            title="Close"
            aria-label="Close"
            onClick={onClose}
            disabled={!onClose}
          >
            <GlyphClose />
          </button>
        ) : null}
      </span>
    </div>
  );
}
