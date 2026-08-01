/**
 * controls.tsx — Panel, Button, TextInput, TextArea, Checkbox, Radio, Select,
 * StatusBar, Window.
 *
 * All chrome-face controls use `border: 2px outset`; all text-entry controls use
 * `border: 2px inset` on white (SPEC.md §9). Pressed state flips a button's
 * bevel to inset AND nudges its content one pixel down-and-right, which is what
 * actually sells the depression.
 *
 * Square corners are enforced globally in theme.css — nothing here needs its
 * own radius rule, and nothing here may reintroduce one.
 */

import * as React from 'react';
import { GlyphCheck, GlyphGrip, GlyphSelectArrow } from './icons';

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

/* =============================================================================
 * Window shell
 * ========================================================================== */
export interface WindowProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

/**
 * Outer frame for a frameless BrowserWindow. Compose:
 *   <Window><TitleBar …/><MenuBar …/><WindowBody>…</WindowBody><StatusBar/></Window>
 */
export function Window({ children, className, ...rest }: WindowProps) {
  return (
    <div className={cx('aim-window', className)} {...rest}>
      {children}
    </div>
  );
}

export function WindowBody({ children, className, ...rest }: WindowProps) {
  return (
    <div className={cx('aim-window__body', className)} {...rest}>
      {children}
    </div>
  );
}

/* =============================================================================
 * Panel
 * ========================================================================== */
// `title` is widened to ReactNode for the groupbox caption, so the DOM `title`
// attribute is omitted from the base type rather than conflicting with it.
export interface PanelProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  /**
   * raised  — 2px outset chrome face (default)
   * sunken  — 2px inset well on white, for content areas
   * flat    — single hairline
   * group   — etched groupbox with a notched caption
   * plain   — no border at all, just a layout box
   */
  variant?: 'raised' | 'sunken' | 'flat' | 'group' | 'plain';
  title?: React.ReactNode;
  children?: React.ReactNode;
}

export function Panel({ variant = 'raised', title, children, className, ...rest }: PanelProps) {
  const variantClass =
    variant === 'raised'
      ? ''
      : variant === 'sunken'
        ? 'aim-panel--sunken'
        : variant === 'flat'
          ? 'aim-panel--flat'
          : variant === 'group'
            ? 'aim-panel--group'
            : 'aim-panel--plain';

  return (
    <div className={cx('aim-panel', variantClass, className)} {...rest}>
      {title ? <div className="aim-panel__title">{title}</div> : null}
      {children}
    </div>
  );
}

/* =============================================================================
 * Button
 * ========================================================================== */
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Dialog default button: bold with a hard black outline outside the bevel. */
  isDefault?: boolean;
  size?: 'normal' | 'small';
  wide?: boolean;
  /** Force the depressed look (toggle buttons, open dropdowns). */
  pressed?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function ButtonImpl(
  { isDefault, size = 'normal', wide, pressed, className, type = 'button', children, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cx(
        'aim-btn',
        isDefault && 'aim-btn--default',
        size === 'small' && 'aim-btn--small',
        wide && 'aim-btn--wide',
        pressed && 'aim-btn--pressed',
        className
      )}
      aria-pressed={pressed}
      {...rest}
    >
      {children}
    </button>
  );
});

/* =============================================================================
 * Text entry
 * ========================================================================== */
export interface TextInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: React.ReactNode;
  /** Stack the label above the field instead of beside it. */
  stacked?: boolean;
  mono?: boolean;
  fieldClassName?: string;
}

export const TextInput = React.forwardRef<HTMLInputElement, TextInputProps>(function TextInputImpl(
  { label, stacked, mono, className, fieldClassName, id, ...rest },
  ref
) {
  const autoId = React.useId();
  const inputId = id ?? autoId;
  const input = (
    <input
      ref={ref}
      id={inputId}
      type={rest.type ?? 'text'}
      className={cx('aim-input', mono && 'aim-input--mono', className)}
      {...rest}
    />
  );

  if (!label) return input;

  return (
    <div className={cx('aim-field', stacked && 'aim-field--stacked', fieldClassName)}>
      <label className="aim-field__label" htmlFor={inputId}>
        {label}
      </label>
      {input}
    </div>
  );
});

export interface TextAreaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: React.ReactNode;
}

export const TextArea = React.forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextAreaImpl(
  { label, className, id, ...rest },
  ref
) {
  const autoId = React.useId();
  const areaId = id ?? autoId;
  const area = (
    <textarea
      ref={ref}
      id={areaId}
      className={cx('aim-input', 'aim-input--textarea', className)}
      {...rest}
    />
  );
  if (!label) return area;
  return (
    <div className="aim-field aim-field--stacked">
      <label className="aim-field__label" htmlFor={areaId}>
        {label}
      </label>
      {area}
    </div>
  );
});

/* =============================================================================
 * Checkbox / Radio
 * ========================================================================== */
export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: React.ReactNode;
}

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(function CheckboxImpl(
  { label, checked, disabled, className, ...rest },
  ref
) {
  return (
    <label className={cx('aim-check', disabled && 'aim-check--disabled', className)}>
      <input
        ref={ref}
        type="checkbox"
        className="aim-check__native"
        checked={checked}
        disabled={disabled}
        {...rest}
      />
      <span className="aim-check__box" aria-hidden="true">
        {checked ? <GlyphCheck size={9} /> : null}
      </span>
      {label ? <span className="aim-check__label">{label}</span> : null}
    </label>
  );
});

export interface RadioProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: React.ReactNode;
}

/** Square radio — the corner rule wins over the usual round radio glyph. */
export const Radio = React.forwardRef<HTMLInputElement, RadioProps>(function RadioImpl(
  { label, checked, disabled, className, ...rest },
  ref
) {
  return (
    <label className={cx('aim-check', disabled && 'aim-check--disabled', className)}>
      <input
        ref={ref}
        type="radio"
        className="aim-check__native"
        checked={checked}
        disabled={disabled}
        {...rest}
      />
      <span className="aim-check__box aim-check__box--radio" aria-hidden="true">
        {checked ? <i /> : null}
      </span>
      {label ? <span className="aim-check__label">{label}</span> : null}
    </label>
  );
});

/* =============================================================================
 * Select
 * ========================================================================== */
export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  options: SelectOption[];
  /** Width of the control in px; the native element fills it. */
  width?: number | string;
  wrapperClassName?: string;
}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(function SelectImpl(
  { options, width, className, wrapperClassName, disabled, ...rest },
  ref
) {
  return (
    <span
      className={cx('aim-select', disabled && 'aim-select--disabled', wrapperClassName)}
      style={width !== undefined ? { width } : undefined}
    >
      <select
        ref={ref}
        className={cx('aim-select__native', className)}
        disabled={disabled}
        {...rest}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      <span className="aim-select__arrow" aria-hidden="true">
        <GlyphSelectArrow />
      </span>
    </span>
  );
});

/* The render functions above are suffixed `Impl` only to avoid shadowing the
   exported consts; devtools should still show the friendly names. */
Button.displayName = 'Button';
TextInput.displayName = 'TextInput';
TextArea.displayName = 'TextArea';
Checkbox.displayName = 'Checkbox';
Radio.displayName = 'Radio';
Select.displayName = 'Select';

/* =============================================================================
 * StatusBar
 * ========================================================================== */
export interface StatusBarCell {
  content: React.ReactNode;
  /** Exactly one cell should grow; the rest size to content. */
  grow?: boolean;
  width?: number;
  title?: string;
}

export interface StatusBarProps {
  cells: StatusBarCell[];
  /** Show the diagonal resize grip at the right end. */
  grip?: boolean;
  className?: string;
}

export function StatusBar({ cells, grip = true, className }: StatusBarProps) {
  return (
    <div className={cx('aim-statusbar', className)}>
      {cells.map((cell, i) => (
        <div
          key={i}
          className={cx('aim-statusbar__cell', cell.grow && 'aim-statusbar__cell--grow')}
          style={cell.width !== undefined ? { width: cell.width, flex: '0 0 auto' } : undefined}
          title={cell.title}
        >
          {cell.content}
        </div>
      ))}
      {grip ? (
        <span className="aim-statusbar__grip">
          <GlyphGrip />
        </span>
      ) : null}
    </div>
  );
}

/* =============================================================================
 * Misc layout helpers
 * ========================================================================== */
export function Divider({ className }: { className?: string }) {
  return <div className={cx('aim-hr', className)} role="separator" />;
}

export function Row({ children, className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx('aim-row', className)} {...rest}>
      {children}
    </div>
  );
}

export function Col({ children, className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cx('aim-col', className)} {...rest}>
      {children}
    </div>
  );
}

export function Spacer() {
  return <span className="aim-spacer" />;
}

export { cx };
