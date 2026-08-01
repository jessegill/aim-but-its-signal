/**
 * IM window — one real OS window per conversation (SPEC.md §1).
 *
 * The window's identity arrives with the document as a query parameter (see createImWindow in
 * src/main/index.ts), not over IPC after the fact, because a window IS a conversation here.
 *
 * Lifecycle, in order:
 *   im:getInitial   → history + contact
 *   im:subscribe    → main starts pushing this conversation's events at us
 *   im:message      → append (or replace, for an edit or an echo of our own send)
 *   im:receipt      → update a delivery state in place
 *   im:removed      → the message expired or was deleted for everyone; it leaves the log
 *   im:markRead     → whenever this window has focus
 *   im:setTyping    → as the user types, on/off transitions only
 *
 * `im:removed` is security-critical, not cosmetic (SPEC.md §8): expiry and delete-for-everyone
 * are enforced in the store, and this renderer must drop the message from the visible log the
 * moment main says it is gone. It holds no copy anywhere else.
 *
 * NO PRESENCE (SPEC.md §7): typing indicators and read receipts are wired because they are
 * real per-message protocol events. There is no online/idle/away anything.
 */

import * as React from 'react';
import type { JSX } from 'react';

import type {
  Buddy,
  ConnectionState,
  GroupChat,
  Message,
  ReceiptState,
  SelfAccount,
} from '@shared/types';

import {
  Button,
  CONNECTION_LABELS,
  ImWindow,
  StatusBar,
  TitleBar,
  Window,
  WindowBody,
  imMenus,
  type FormattingState,
  type MenuSpec,
} from '../ui';
import {
  BRIDGE_MISSING,
  describeFailure,
  hasBridge,
  invoke,
  useIpcEvent,
  windowChrome,
} from './ipc';

interface AppProps {
  /** Null only if the window was opened without one; main always supplies it. */
  conversationId: string | null;
}

/**
 * Display name for the local account's own message lines.
 *
 * Deliberately the account's *display* name and not its username: this is the name a chat
 * room's member list shows for you, and own lines reading differently from your own entry in
 * the list beside them would be a puzzle. Falls back to "Me" rather than guessing.
 */
function ownName(self: SelfAccount | null): string {
  const name = self?.displayName.trim();
  return name !== undefined && name.length > 0 ? name : 'Me';
}

/**
 * Inserts or replaces a message, keeping the log ordered by send time.
 *
 * Replacement by id is what makes three separate things safe: an edited message arriving
 * again, our own optimistic row being reconciled with main's authoritative copy, and a
 * duplicate push after a resubscribe.
 */
function mergeMessage(list: Message[], incoming: Message): Message[] {
  const at = list.findIndex((m) => m.id === incoming.id);
  if (at >= 0) {
    const next = [...list];
    next[at] = incoming;
    return next;
  }
  if (list.length === 0 || incoming.sentAt >= list[list.length - 1].sentAt) {
    return [...list, incoming];
  }
  const next = [...list, incoming];
  next.sort((a, b) => a.sentAt - b.sentAt);
  return next;
}

export function App({ conversationId }: AppProps): JSX.Element {
  const [contact, setContact] = React.useState<Buddy | null>(null);
  /** Non-null iff this conversation is a Signal group; makes the window a chat room. */
  const [group, setGroup] = React.useState<GroupChat | null>(null);
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [connection, setConnection] = React.useState<ConnectionState>('linking');
  const [theirTyping, setTheirTyping] = React.useState(false);
  const [typingName, setTypingName] = React.useState<string | null>(null);
  const [self, setSelf] = React.useState<SelfAccount | null>(null);
  const [windowActive, setWindowActive] = React.useState(() => document.hasFocus());
  const [formatting, setFormatting] = React.useState<FormattingState | undefined>(undefined);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(hasBridge() ? null : BRIDGE_MISSING);
  const [notice, setNotice] = React.useState<string | null>(null);

  const typingTimeout = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const typingSent = React.useRef(false);

  /* --- load ---------------------------------------------------------------- */

  const load = React.useCallback(async (): Promise<void> => {
    if (conversationId === null) {
      setError('This window was opened without a conversation id, so it has nothing to show.');
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const initial = await invoke('im:getInitial', conversationId);
      setContact(initial.contact);
      setGroup(initial.group);
      setMessages([...initial.messages].sort((a, b) => a.sentAt - b.sentAt));
      setError(null);
      // Subscribe only after the history is in hand, so a message that lands mid-load cannot
      // be overwritten by the initial snapshot.
      await invoke('im:subscribe', conversationId);
    } catch (err) {
      setError(describeFailure('im:getInitial', err));
    } finally {
      setLoading(false);
    }
  }, [conversationId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  /**
   * Re-reads the conversation without re-subscribing or flashing the loading state.
   *
   * Sender names are resolved in main at read time, so a roster or group sync can change every
   * name in the log — a group member who was a bare ACI a moment ago now has a name. Without
   * this the window would keep showing the truncated ACI until it was closed and reopened.
   */
  const refresh = React.useCallback(async (): Promise<void> => {
    if (conversationId === null) return;
    try {
      const initial = await invoke('im:getInitial', conversationId);
      setContact(initial.contact);
      setGroup(initial.group);
      setMessages([...initial.messages].sort((a, b) => a.sentAt - b.sentAt));
    } catch {
      // The window already has a usable copy; a failed refresh is not worth an error strip.
    }
  }, [conversationId]);

  useIpcEvent('roster:updated', () => void refresh());

  React.useEffect(() => {
    void (async () => {
      try {
        setConnection(await invoke('connection:get'));
      } catch {
        // The pushed connection:state event is the primary source; until something arrives the
        // window says "Linking…" rather than claiming to be connected.
      }
      try {
        setSelf(await invoke('self:get'));
      } catch {
        // Own lines read "Me" until this resolves, which is honest rather than wrong.
      }
    })();
  }, []);

  const markRead = React.useCallback((): void => {
    if (conversationId === null) return;
    void invoke('im:markRead', conversationId).catch(() => {
      // Read receipts are best-effort. Failing to send one must never break the window, and it
      // is not worth a banner — the error strip is reserved for things the user can act on.
    });
  }, [conversationId]);

  /* --- pushed events -------------------------------------------------------- */

  useIpcEvent('im:message', (cid, message) => {
    if (cid !== conversationId) return;
    setMessages((prev) => mergeMessage(prev, message));
    if (!message.outgoing) {
      setTheirTyping(false);
      if (document.hasFocus()) markRead();
    }
  });

  useIpcEvent('im:receipt', (cid, messageId, state: ReceiptState) => {
    if (cid !== conversationId) return;
    setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, receipt: state } : m)));
  });

  useIpcEvent('im:removed', (cid, messageId) => {
    if (cid !== conversationId) return;
    // Expired or deleted for everyone (SPEC.md §8). It leaves the log immediately; nothing
    // here keeps a second copy of it.
    setMessages((prev) => prev.filter((m) => m.id !== messageId));
  });

  useIpcEvent('im:typing', (cid, isTyping, senderName) => {
    if (cid !== conversationId) return;
    setTheirTyping(isTyping);
    // Kept on the "stopped" event too, so the indicator does not blank the name mid-fade.
    if (senderName) setTypingName(senderName);
  });

  useIpcEvent('connection:state', (state) => setConnection(state));

  /* Typing indicators have no guaranteed "stopped" event — a sender who closes their app
     simply goes quiet. Time it out so the status bar never sticks on "…is typing". */
  React.useEffect(() => {
    if (!theirTyping) return undefined;
    const timer = setTimeout(() => setTheirTyping(false), 15000);
    return () => clearTimeout(timer);
  }, [theirTyping]);

  /* --- focus ---------------------------------------------------------------- */

  React.useEffect(() => {
    const onFocus = (): void => {
      setWindowActive(true);
      markRead();
    };
    const onBlur = (): void => setWindowActive(false);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    if (document.hasFocus()) markRead();
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, [markRead]);

  /* --- typing --------------------------------------------------------------- */

  const setTyping = React.useCallback(
    (isTyping: boolean): void => {
      if (conversationId === null || typingSent.current === isTyping) return;
      typingSent.current = isTyping;
      void invoke('im:setTyping', conversationId, isTyping).catch(() => {
        // Typing is advisory. A failure must not interrupt composing a message.
      });
      if (typingTimeout.current) clearTimeout(typingTimeout.current);
      if (isTyping) {
        // Backstop for the ImWindow's own idle timer, so a window that loses focus in an odd
        // way cannot leave the other end thinking we are still typing.
        typingTimeout.current = setTimeout(() => setTyping(false), 12000);
      }
    },
    [conversationId]
  );

  React.useEffect(
    () => () => {
      if (typingTimeout.current) clearTimeout(typingTimeout.current);
      if (typingSent.current && conversationId !== null) {
        // Best-effort: the window is going away, and a rejected advisory call must not become
        // an unhandled rejection on the way out.
        void invoke('im:setTyping', conversationId, false).catch(() => undefined);
      }
    },
    [conversationId]
  );

  /* --- send ------------------------------------------------------------------ */

  const send = React.useCallback(
    (body: string): void => {
      if (conversationId === null) return;
      setTyping(false);
      void (async () => {
        try {
          const { messageId } = await invoke('im:send', conversationId, body);
          setError(null);
          // Optimistic row so the log never looks like it swallowed the message. Main echoes
          // the authoritative copy on im:message under the same id, which replaces this one.
          setMessages((prev) =>
            mergeMessage(prev, {
              id: messageId,
              conversationId,
              senderId: '',
              senderName: ownName(self),
              outgoing: true,
              body,
              sentAt: Date.now(),
              receivedAt: null,
              expiresAt: null,
              editedAt: null,
              quote: null,
              reactions: [],
              attachments: [],
              kind: 'text',
              receipt: 'sending',
            })
          );
        } catch (err) {
          setError(describeFailure('im:send', err));
        }
      })();
    },
    [conversationId, setTyping, self]
  );

  /* --- menus ------------------------------------------------------------------ */

  const menus: MenuSpec[] = React.useMemo(() => {
    const built = imMenus({
      onCloseWindow: windowChrome.close,
      onSendFile: () => setNotice(ATTACH_NOTICE),
      onSafetyNumber: () => setNotice(SAFETY_NOTICE),
    });
    // Slots needing a main-process capability no channel provides (saving a log, clipboard,
    // buddy info, blocking, changing the disappearing timer) are greyed rather than inert.
    return built.map((m) => ({
      ...m,
      items: m.items.map((item) =>
        item.separator === true
          ? item
          : { ...item, disabled: item.disabled === true || item.onSelect === undefined }
      ),
    }));
  }, []);

  /* --- render ------------------------------------------------------------------ */

  const shell = (children: React.ReactNode): JSX.Element => (
    <div
      className="aim-root chrome"
      style={{ height: '100%', display: 'flex', flexDirection: 'column' }}
    >
      {children}
      {error !== null || notice !== null ? (
        <div className="aim-im__warning" role="alert" style={{ flex: '0 0 auto' }}>
          {error ?? notice}
        </div>
      ) : null}
    </div>
  );

  // No contact yet: the window still has to be real chrome the user can move and close.
  if (contact === null) {
    return shell(
      <Window style={{ width: '100%', flex: '1 1 auto', minHeight: 0 }}>
        <TitleBar
          title="Instant Message"
          active={windowActive}
          onMinimize={windowChrome.minimize}
          onMaximize={windowChrome.maximize}
          onClose={windowChrome.close}
        />
        <WindowBody>
          <div
            style={{
              flex: '1 1 auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              alignItems: 'flex-start',
              padding: 10,
            }}
          >
            <div>
              {loading
                ? 'Opening conversation…'
                : 'This conversation could not be loaded from the messaging service.'}
            </div>
            {!loading ? (
              <Button size="small" isDefault onClick={() => void load()}>
                Try Again
              </Button>
            ) : null}
          </div>
        </WindowBody>
        <StatusBar
          cells={[
            { grow: true, content: conversationId ?? 'no conversation' },
            {
              width: 96,
              content: CONNECTION_LABELS[connection].short,
              title: CONNECTION_LABELS[connection].detail,
            },
          ]}
        />
      </Window>
    );
  }

  const offline = connection !== 'linked';

  return shell(
    <ImWindow
      /* The library sizes itself for the showcase page; in a real frameless BrowserWindow the
         window IS the component, so it fills whatever the OS gives it. */
      style={{ width: '100%', height: '100%', flex: '1 1 auto', minHeight: 0 }}
      contact={contact}
      group={group}
      selfName={ownName(self)}
      messages={messages}
      menus={menus}
      windowActive={windowActive}
      theirTyping={theirTyping}
      typingName={typingName}
      onTypingChange={setTyping}
      onSend={send}
      // Voice playback would need the file off disk, which a renderer cannot have
      // (SPEC.md §3), so the library shows "open on phone" instead of a dead play button.
      canPlayVoice={false}
      sendDisabled={offline}
      sendDisabledReason={offline ? CONNECTION_LABELS[connection].detail : undefined}
      formatting={formatting}
      onFormattingChange={setFormatting}
      onAttach={() => setNotice(ATTACH_NOTICE)}
      onOpenAttachment={() => setNotice(OPEN_ATTACHMENT_NOTICE)}
      onVerifySafetyNumber={() => setNotice(SAFETY_NOTICE)}
      onMinimize={windowChrome.minimize}
      onMaximize={windowChrome.maximize}
      onClose={windowChrome.close}
    />
  );
}

/* These three actions all need a main-process capability that no channel in
   src/shared/types.ts exposes yet. Saying so is better than a button that does nothing. */
const ATTACH_NOTICE =
  'Attaching a file needs a file picker in the main process — a renderer cannot browse the ' +
  'disk (SPEC.md §3). Not wired yet.';
const OPEN_ATTACHMENT_NOTICE =
  'Opening an attachment needs the main process to hand it to the system — not wired yet.';
const SAFETY_NOTICE =
  'Safety numbers come from the messaging service and need a main-process channel to fetch ' +
  'and verify them. Not wired yet — verify on your phone in the meantime.';
