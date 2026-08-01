/**
 * connection.ts — labels for the four connection states in SPEC.md §8.
 *
 * These describe THIS DEVICE'S link to the daemon and the account. They are not
 * presence: they say nothing about whether any other person is available, only
 * whether this client can currently send and receive. SPEC.md §8 requires all
 * four to be visible to the user.
 */

import type { ConnectionState } from '../../shared/types';

export interface ConnectionLabel {
  /** Fits a status-bar cell. */
  short: string;
  /** Sentence for tooltips and the sign-on window. */
  detail: string;
  /** True when the user must act to restore service. */
  actionable: boolean;
}

export const CONNECTION_LABELS: Record<ConnectionState, ConnectionLabel> = {
  linked: {
    short: 'Connected',
    detail: 'This device is linked and connected. Messages send and receive normally.',
    actionable: false,
  },
  linking: {
    short: 'Linking…',
    detail: 'Waiting for the code to be scanned from your phone. Keep this window open.',
    actionable: false,
  },
  unlinked: {
    short: 'Not linked',
    detail:
      'This device is not linked to an account. Scan the code from your phone to link it. No messages can be sent or received until you do.',
    actionable: true,
  },
  'daemon-down': {
    short: 'No service',
    detail:
      'The background messaging service is not running, so nothing can be sent or received. Messages sent to you are held by the server and will arrive once it restarts.',
    actionable: true,
  },
};

export const CONNECTION_STATES: ConnectionState[] = [
  'linked',
  'linking',
  'unlinked',
  'daemon-down',
];
