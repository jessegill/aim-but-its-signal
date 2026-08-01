/**
 * Dialog — a modal, in-window dialog box for the few places the buddy list needs input:
 * naming a group, renaming one, setting a local nickname, and confirming a delete.
 *
 * It exists because there is no alternative: Electron does not implement `window.prompt` or
 * `window.confirm` in renderers, and a renderer may not reach `dialog.showMessageBox` — that
 * is main-process API and renderers are pure views (SPEC.md §3).
 *
 * Built entirely from the UI library's own primitives (Window / TitleBar / Button /
 * TextInput), so it is the same visual system, not a new one.
 */

import * as React from 'react';

import { Button, TextInput, TitleBar, Window, WindowBody } from '../ui';

interface ShellProps {
  title: string;
  onCancel: () => void;
  children: React.ReactNode;
  buttons: React.ReactNode;
}

function DialogShell({ title, onCancel, children, buttons }: ShellProps) {
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 8,
        // Not a modern scrim: just enough grey to read as a modal window on top of the list.
        background: 'rgba(0, 0, 0, 0.25)',
      }}
    >
      <Window style={{ width: '100%', maxWidth: 260, boxShadow: '3px 3px 6px rgba(0,0,0,0.4)' }}>
        <TitleBar title={title} showMinimize={false} showMaximize={false} onClose={onCancel} />
        <WindowBody>
          <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {children}
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 4, paddingTop: 2 }}>
              {buttons}
            </div>
          </div>
        </WindowBody>
      </Window>
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Text prompt
 * ------------------------------------------------------------------------ */

export interface PromptSpec {
  title: string;
  label: string;
  initialValue?: string;
  placeholder?: string;
  okLabel?: string;
  /** Allow submitting an empty string — used for "clear this nickname". */
  allowEmpty?: boolean;
  onSubmit: (value: string) => void;
}

export function PromptDialog({ spec, onCancel }: { spec: PromptSpec; onCancel: () => void }) {
  const [value, setValue] = React.useState(spec.initialValue ?? '');
  const ref = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const canSubmit = spec.allowEmpty === true || value.trim().length > 0;
  const submit = () => {
    if (!canSubmit) return;
    spec.onSubmit(value.trim());
  };

  return (
    <DialogShell
      title={spec.title}
      onCancel={onCancel}
      buttons={
        <>
          <Button size="small" isDefault disabled={!canSubmit} onClick={submit}>
            {spec.okLabel ?? 'OK'}
          </Button>
          <Button size="small" onClick={onCancel}>
            Cancel
          </Button>
        </>
      }
    >
      <TextInput
        ref={ref}
        label={spec.label}
        stacked
        value={value}
        placeholder={spec.placeholder}
        maxLength={64}
        onChange={(e) => setValue(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
      />
    </DialogShell>
  );
}

/* ---------------------------------------------------------------------------
 * Confirm / message
 * ------------------------------------------------------------------------ */

export interface ConfirmSpec {
  title: string;
  body: React.ReactNode;
  okLabel?: string;
  /** Omit for a plain message box with a single OK button. */
  onConfirm?: () => void;
}

export function ConfirmDialog({ spec, onCancel }: { spec: ConfirmSpec; onCancel: () => void }) {
  return (
    <DialogShell
      title={spec.title}
      onCancel={onCancel}
      buttons={
        spec.onConfirm ? (
          <>
            <Button size="small" isDefault onClick={spec.onConfirm}>
              {spec.okLabel ?? 'OK'}
            </Button>
            <Button size="small" onClick={onCancel}>
              Cancel
            </Button>
          </>
        ) : (
          <Button size="small" isDefault onClick={onCancel}>
            {spec.okLabel ?? 'OK'}
          </Button>
        )
      }
    >
      <div style={{ lineHeight: 1.45 }}>{spec.body}</div>
    </DialogShell>
  );
}
