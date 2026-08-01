/**
 * FormattingToolbar — the strip between the message log and the input pane.
 *
 * Era-correct contents, in AIM 5.1 order: font family, size, B / I / U, text
 * colour, background colour, then the small extras (link, emoticon, quote).
 * Flat buttons that gain a bevel on hover and go inset when active — exactly
 * how a 2003 toolbar behaved.
 *
 * Presentational: it reports state changes upward and renders whatever `state`
 * it is handed. It does not own the composer's formatting model.
 *
 * A note on scope: Signal's wire format supports bold, italic, strikethrough,
 * monospace and spoiler — not fonts, sizes or colours. So the family/size/colour
 * controls are cosmetic-local by nature. `remoteSafeOnly` greys them out and
 * says so on hover, rather than letting the user believe they are sending
 * purple 18pt Comic Sans to somebody's phone.
 */

import * as React from 'react';
import { Select, cx } from './controls';

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
  /** Grey out anything the protocol cannot actually transmit. */
  remoteSafeOnly?: boolean;
  onPickColor?: (which: 'text' | 'background') => void;
  onInsertLink?: () => void;
  onInsertEmoticon?: () => void;
  onQuoteSelection?: () => void;
  onAttach?: () => void;
  disabled?: boolean;
  className?: string;
  /** Extra controls pinned to the right end. */
  children?: React.ReactNode;
}

/* Fonts a 2003 Windows box actually had. macOS ships Verdana/Georgia/Courier
 * New/Trebuchet; Tahoma and Comic Sans may be missing, which is fine — the
 * dropdown is a label list, not a promise. */
const FONTS = [
  'Tahoma',
  'Verdana',
  'Arial',
  'Times New Roman',
  'Courier New',
  'Georgia',
  'Trebuchet MS',
  'Comic Sans MS',
];

const SIZES = ['8', '9', '10', '11', '12', '14', '18', '24'];

const SWATCHES = [
  '#000000',
  '#808080',
  '#D40000',
  '#C87A00',
  '#008000',
  '#0000C0',
  '#800080',
  '#FFCC00',
];

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
  onInsertEmoticon,
  onQuoteSelection,
  onAttach,
  disabled,
  className,
  children,
}: FormattingToolbarProps) {
  const set = (patch: Partial<FormattingState>) => onChange?.({ ...state, ...patch });

  const cosmeticTitle = remoteSafeOnly
    ? 'Not transmitted — the protocol carries no font, size or colour information'
    : undefined;

  /** Cosmetic controls are dead when the protocol cannot carry them. */
  const cosmeticDisabled = Boolean(disabled) || remoteSafeOnly;

  return (
    <div className={cx('aim-toolbar', 'aim-fmt', className)} role="toolbar" aria-label="Formatting">
      <Select
        wrapperClassName="aim-fmt__font"
        aria-label="Font"
        title={cosmeticTitle ?? 'Font'}
        disabled={cosmeticDisabled}
        value={state.fontFamily ?? 'Tahoma'}
        onChange={(e) => set({ fontFamily: e.target.value })}
        options={FONTS.map((f) => ({ value: f, label: f }))}
      />
      <Select
        wrapperClassName="aim-fmt__size"
        aria-label="Font size"
        title={cosmeticTitle ?? 'Size'}
        disabled={cosmeticDisabled}
        value={state.fontSize ?? '11'}
        onChange={(e) => set({ fontSize: e.target.value })}
        options={SIZES.map((s) => ({ value: s, label: s }))}
      />

      <span className="aim-toolbar__sep" />

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
        disabled={disabled}
        on={state.underline}
        label="Underline"
        glyph={<u>U</u>}
        onClick={() => set({ underline: !state.underline })}
      />
      <Toggle
        disabled={disabled}
        on={state.strike}
        label="Strikethrough"
        glyph={<s>S</s>}
        onClick={() => set({ strike: !state.strike })}
      />
      <Toggle
        disabled={disabled}
        on={state.mono}
        label="Monospace"
        glyph={<span style={{ fontFamily: 'var(--aim-font-mono)', fontSize: 11 }}>M</span>}
        onClick={() => set({ mono: !state.mono })}
      />

      <span className="aim-toolbar__sep" />

      {/* Colour buttons: an "A" sitting on a colour chip — the AIM/Office idiom. */}
      <button
        type="button"
        className="aim-toolbar__btn"
        title={cosmeticTitle ?? 'Text colour'}
        aria-label="Text colour"
        disabled={cosmeticDisabled}
        onClick={() => onPickColor?.('text')}
      >
        <span className="aim-fmt__stack">
          <span style={{ fontWeight: 'bold' }}>A</span>
          <span className="aim-fmt__swatch" style={{ background: state.color ?? '#000000' }} />
        </span>
      </button>
      <button
        type="button"
        className="aim-toolbar__btn"
        title={cosmeticTitle ?? 'Background colour'}
        aria-label="Background colour"
        disabled={cosmeticDisabled}
        onClick={() => onPickColor?.('background')}
      >
        <span className="aim-fmt__stack">
          <span style={{ fontWeight: 'bold', background: '#ffffcc', padding: '0 2px' }}>A</span>
          <span className="aim-fmt__swatch" style={{ background: state.background ?? '#FFFFFF' }} />
        </span>
      </button>

      {/* Quick palette, the way the era did it: eight chips, no picker dialog. */}
      <span className="aim-toolbar__sep" />
      {SWATCHES.map((c) => (
        <button
          key={c}
          type="button"
          className="aim-toolbar__btn"
          style={{ width: 14 }}
          title={cosmeticTitle ?? `Text colour ${c}`}
          aria-label={`Text colour ${c}`}
          disabled={cosmeticDisabled}
          onClick={() => set({ color: c })}
        >
          <span
            style={{
              display: 'block',
              width: 9,
              height: 9,
              background: c,
              border: '1px solid #5A5A5A',
            }}
          />
        </button>
      ))}

      <span className="aim-toolbar__sep" />

      <Toggle
        disabled={disabled}
        label="Insert link"
        glyph={<span style={{ fontSize: 11 }}>🔗</span>}
        onClick={onInsertLink}
      />
      <Toggle
        disabled={disabled}
        label="Insert emoticon"
        glyph={<span style={{ fontFamily: 'var(--aim-font-ui)', fontSize: 11 }}>:-)</span>}
        style={{ width: 28 }}
        onClick={onInsertEmoticon}
      />
      <Toggle
        disabled={disabled}
        label="Quote selection"
        glyph={<span style={{ fontSize: 13 }}>❝</span>}
        onClick={onQuoteSelection}
      />
      <Toggle
        disabled={disabled}
        label="Attach file"
        glyph={<span style={{ fontSize: 12 }}>📎</span>}
        onClick={onAttach}
      />

      <span className="aim-toolbar__spacer" />
      {children}
    </div>
  );
}
