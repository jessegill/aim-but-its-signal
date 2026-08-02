/**
 * FormattingToolbar — the strip between the message log and the input pane.
 *
 * The icon strip is AIM 5.1's, in AIM's own order and grouping:
 *
 *     A  A̲     A· A A·    B  I  U     link  🖼  ✉  ☺
 *     └colour┘ └─size─┘  └─style─┘   └───inserts────┘
 *
 * Four groups separated by rules: the two colour swatches, the three text-size
 * buttons, bold/italic/underline, then the insert actions. No font dropdown, no
 * size dropdown, and no palette of colour chips — the era's toolbar was icons.
 *
 * Presentational: it reports state changes upward and renders whatever `state`
 * it is handed. It does not own the composer's formatting model.
 *
 * A note on scope: Signal's wire format supports bold, italic, strikethrough,
 * monospace and spoiler — not fonts, sizes or colours. Underline is in the same
 * position: AIM had it, Signal cannot carry it.
 *
 * `remoteSafeOnly` marks those controls, and it does it with a **tooltip, not by
 * disabling them**. They used to be greyed out, back when clicking one changed a
 * state object that nothing read — an inert button is better greyed than live.
 * They now restyle the composer itself, so they do something real and visible
 * and being clickable is honest. What they must never do is let the user believe
 * they are sending purple 18pt Comic Sans to somebody's phone, and the hover text
 * is what prevents that.
 */

import * as React from 'react';
import { cx } from './controls';
import { GlyphEnvelope, GlyphPicture, GlyphSmiley } from './icons';

export interface FormattingState {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  mono?: boolean;
  fontFamily?: string;
  fontSize?: string;
  color?: string;
  background?: string;
}

export interface FormattingToolbarProps {
  state?: FormattingState;
  onChange?: (next: FormattingState) => void;
  /**
   * Say, on hover, which controls the protocol cannot transmit. They stay usable — they restyle
   * the composer locally — but the user is told the styling stops at this window.
   */
  remoteSafeOnly?: boolean;
  onPickColor?: (which: 'text' | 'background') => void;
  onInsertLink?: () => void;
  /** The 🖼 button — attach a picture. */
  onInsertImage?: () => void;
  /** The ✉ button — attach any file. */
  onAttach?: () => void;
  onInsertEmoticon?: () => void;
  /** Whether the emoticon palette is showing, so the smiley reads as a toggle. */
  emoticonsOpen?: boolean;
  disabled?: boolean;
  className?: string;
  /** Extra controls pinned to the right end. */
  children?: React.ReactNode;
}

/** The three steps behind the small/medium/large `A` buttons. */
const SIZES = { small: '9', medium: '11', large: '14' } as const;

interface ToggleProps {
  on?: boolean;
  label: string;
  glyph: React.ReactNode;
  style?: React.CSSProperties;
  title?: string;
  disabled?: boolean;
  onClick?: () => void;
}

/** Flat toolbar button: bevels on hover, goes inset when on or pressed. */
function Toggle({ on, label, glyph, style, title, disabled, onClick }: ToggleProps) {
  return (
    <button
      type="button"
      className={cx('aim-toolbar__btn', on && 'aim-toolbar__btn--on')}
      aria-label={label}
      aria-pressed={!!on}
      title={title ?? label}
      disabled={disabled}
      style={style}
      onClick={onClick}
    >
      {glyph}
    </button>
  );
}

export function FormattingToolbar({
  state = {},
  onChange,
  remoteSafeOnly = true,
  onPickColor,
  onInsertLink,
  onInsertImage,
  onAttach,
  onInsertEmoticon,
  emoticonsOpen,
  disabled,
  className,
  children,
}: FormattingToolbarProps) {
  const set = (patch: Partial<FormattingState>) => onChange?.({ ...state, ...patch });

  const cosmeticNote = remoteSafeOnly
    ? ' — shown here only; the protocol carries no font, size or colour information'
    : '';

  /** Cosmetic controls follow the toolbar's own disabled state, nothing more. */
  const cosmeticDisabled = Boolean(disabled);

  const currentSize = state.fontSize ?? SIZES.medium;
  // Medium is the default, so at rest no size button reads as pressed — AIM's strip sat flat
  // until you actually chose something. Only a deliberate small/large shows the inset bevel.
  const sizeChosen = state.fontSize !== undefined && state.fontSize !== SIZES.medium;

  return (
    <div className={cx('aim-toolbar', 'aim-fmt', className)} role="toolbar" aria-label="Formatting">
      {/* --- colour: text, then background ---------------------------------- */}
      <button
        type="button"
        className="aim-toolbar__btn"
        title={`Text colour${cosmeticNote}`}
        aria-label="Text colour"
        disabled={cosmeticDisabled}
        onClick={() => onPickColor?.('text')}
      >
        <span className="aim-fmt__letter" style={{ color: state.color ?? '#0000C0' }}>
          A
        </span>
      </button>
      <button
        type="button"
        className="aim-toolbar__btn"
        title={`Background colour${cosmeticNote}`}
        aria-label="Background colour"
        disabled={cosmeticDisabled}
        onClick={() => onPickColor?.('background')}
      >
        <span
          className="aim-fmt__letter aim-fmt__letter--onchip"
          style={{ color: '#0000C0', background: state.background ?? '#FFFFCC' }}
        >
          A
        </span>
      </button>

      <span className="aim-toolbar__sep" />

      {/* --- size: small, medium, large ------------------------------------- */}
      <Toggle
        disabled={cosmeticDisabled}
        on={sizeChosen && currentSize === SIZES.small}
        label="Small text"
        title={`Small text${cosmeticNote}`}
        glyph={
          <span className="aim-fmt__letter" style={{ fontSize: 9 }}>
            A
          </span>
        }
        onClick={() => set({ fontSize: SIZES.small })}
      />
      <Toggle
        disabled={cosmeticDisabled}
        on={sizeChosen && currentSize === SIZES.medium}
        label="Medium text"
        title={`Medium text${cosmeticNote}`}
        glyph={
          <span className="aim-fmt__letter" style={{ fontSize: 12 }}>
            A
          </span>
        }
        onClick={() => set({ fontSize: SIZES.medium })}
      />
      <Toggle
        disabled={cosmeticDisabled}
        on={sizeChosen && currentSize === SIZES.large}
        label="Large text"
        title={`Large text${cosmeticNote}`}
        glyph={
          <span className="aim-fmt__letter" style={{ fontSize: 15 }}>
            A
          </span>
        }
        onClick={() => set({ fontSize: SIZES.large })}
      />

      <span className="aim-toolbar__sep" />

      {/* --- bold / italic / underline -------------------------------------- */}
      <Toggle
        disabled={disabled}
        on={state.bold}
        label="Bold"
        glyph={<b>B</b>}
        onClick={() => set({ bold: !state.bold })}
      />
      <Toggle
        disabled={disabled}
        on={state.italic}
        label="Italic"
        glyph={<i>I</i>}
        onClick={() => set({ italic: !state.italic })}
      />
      <Toggle
        disabled={cosmeticDisabled}
        on={state.underline}
        label="Underline"
        title={`Underline${cosmeticNote}`}
        glyph={<u>U</u>}
        onClick={() => set({ underline: !state.underline })}
      />

      <span className="aim-toolbar__sep" />

      {/* --- inserts: link, picture, file, emoticon -------------------------- */}
      <button
        type="button"
        className="aim-toolbar__btn aim-fmt__link"
        title="Insert link"
        aria-label="Insert link"
        disabled={Boolean(disabled) || onInsertLink === undefined}
        onClick={onInsertLink}
      >
        link
      </button>
      <Toggle
        disabled={disabled}
        label="Insert picture"
        title="Attach a picture"
        glyph={<GlyphPicture size={14} />}
        onClick={onInsertImage}
      />
      <Toggle
        disabled={disabled}
        label="Send a file"
        title="Attach a file"
        glyph={<GlyphEnvelope size={14} />}
        onClick={onAttach}
      />
      <Toggle
        disabled={disabled}
        on={emoticonsOpen}
        label="Insert emoticon"
        title="Insert emoticon — AIM's own set, sent as text"
        glyph={<GlyphSmiley size={14} />}
        onClick={onInsertEmoticon}
      />

      <span className="aim-toolbar__spacer" />
      {children}
    </div>
  );
}
