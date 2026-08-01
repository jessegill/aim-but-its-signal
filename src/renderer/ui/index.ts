/**
 * src/renderer/ui — shared AIM 5.1 / Windows XP component library.
 *
 * Pure presentational React. Props in, markup out. No IPC, no data fetching, no
 * network — the buddy-list and IM window apps supply everything.
 *
 * Import the theme once per renderer entry point:
 *     import 'src/renderer/ui/theme.css';
 * and put `className="aim-root"` on the element that wraps the whole window —
 * the global square-corner rule and the font stack are scoped to it.
 *
 * Two constraints run through every component in here:
 *
 *   1. NO PRESENCE (SPEC.md §7). Signal transmits no online/offline/idle/away
 *      state, so none is rendered, faked, or approximated anywhere. Typing
 *      indicators and read receipts ARE built — they are real per-message
 *      protocol events, not availability.
 *
 *   2. SECURITY OUTRANKS THE PERIOD LOOK (SPEC.md §8). SecurityNotice has no
 *      prop that hides it.
 *
 * And one visual rule that matters more than the rest: border-radius is 0
 * everywhere, enforced globally in theme.css. Never round anything.
 */

export { TitleBar } from './TitleBar';
export type { TitleBarProps } from './TitleBar';

export { MenuBar, buddyListMenus, imMenus } from './MenuBar';
export type {
  MenuBarProps,
  MenuSpec,
  MenuItemSpec,
  BuddyListMenuHandlers,
  ImMenuHandlers,
} from './MenuBar';

export {
  Window,
  WindowBody,
  Panel,
  Button,
  TextInput,
  TextArea,
  Checkbox,
  Radio,
  Select,
  StatusBar,
  Divider,
  Row,
  Col,
  Spacer,
  cx,
} from './controls';
export type {
  WindowProps,
  PanelProps,
  ButtonProps,
  TextInputProps,
  TextAreaProps,
  CheckboxProps,
  RadioProps,
  SelectProps,
  SelectOption,
  StatusBarProps,
  StatusBarCell,
} from './controls';

export { BuddyListWindow } from './BuddyListWindow';
export type { BuddyListWindowProps } from './BuddyListWindow';
export { BuddyGroup } from './BuddyGroup';
export type { BuddyGroupProps } from './BuddyGroup';
export { BuddyRow, formatDuration } from './BuddyRow';
export type { BuddyRowProps } from './BuddyRow';

export { ImWindow } from './ImWindow';
export type { ImWindowProps } from './ImWindow';
export {
  MessageLog,
  MessageRow,
  Reactions,
  QuoteStubView,
  AttachmentView,
  TypingIndicator,
  formatTime,
  formatDay,
  formatBytes,
} from './MessageLog';
export type { MessageLogProps, MessageRowProps, AttachmentViewProps } from './MessageLog';

export { FormattingToolbar } from './FormattingToolbar';
export type { FormattingToolbarProps, FormattingState } from './FormattingToolbar';

export { SecurityNotice, formatSafetyNumber } from './SecurityNotice';
export type { SecurityNoticeProps, SecurityNoticeKind } from './SecurityNotice';

export { SignOnWindow, ConnectionBadge } from './SignOnWindow';
export type { SignOnWindowProps } from './SignOnWindow';

export { CONNECTION_LABELS, CONNECTION_STATES } from './connection';
export type { ConnectionLabel } from './connection';

export * as icons from './icons';
