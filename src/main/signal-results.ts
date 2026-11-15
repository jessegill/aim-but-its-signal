/**
 * Pure interpretation of daemon results that the service has to act on.
 *
 * Kept apart from `service.ts` (which needs Electron) so it can be tested directly.
 */

/** One recipient a `send` did not reach. */
export interface SendFailure {
  uuid: string | null;
  number: string | null;
  /** signal-cli's result type, e.g. `IDENTITY_FAILURE`. */
  type: string;
}

export interface SendSummary {
  /** The message's identity on the wire; null if the daemon did not report one. */
  timestamp: number | null;
  failures: SendFailure[];
}

/**
 * Reads a `send` result (docs/signal-cli-rpc.md §5.4).
 *
 * signal-cli errors the whole call only when *no* recipient succeeded. When some did and some
 * did not — routine in a group, where one member's changed safety number fails just them — the
 * call succeeds and the failures are only visible here, per recipient. Ignoring them shows the
 * message as sent to people who never got it.
 */
export function summarizeSendResults(result: unknown): SendSummary {
  const record =
    typeof result === 'object' && result !== null ? (result as Record<string, unknown>) : {};
  const timestamp =
    typeof record.timestamp === 'number' && Number.isFinite(record.timestamp)
      ? record.timestamp
      : null;

  const failures: SendFailure[] = [];
  if (Array.isArray(record.results)) {
    for (const entry of record.results) {
      if (typeof entry !== 'object' || entry === null) continue;
      const item = entry as Record<string, unknown>;
      const type = typeof item.type === 'string' ? item.type : 'UNKNOWN';
      if (type === 'SUCCESS') continue;
      const address =
        typeof item.recipientAddress === 'object' && item.recipientAddress !== null
          ? (item.recipientAddress as Record<string, unknown>)
          : {};
      failures.push({
        uuid: typeof address.uuid === 'string' ? address.uuid : null,
        number: typeof address.number === 'string' ? address.number : null,
        type,
      });
    }
  }
  return { timestamp, failures };
}

/** Plain-language reason for a failure type, for the notice written into the conversation. */
export function describeSendFailure(type: string): string {
  switch (type) {
    case 'IDENTITY_FAILURE':
      return 'their safety number changed';
    case 'UNREGISTERED_FAILURE':
      return 'they are no longer on Signal';
    case 'RATE_LIMIT_FAILURE':
      return 'Signal is rate-limiting this account';
    case 'NETWORK_FAILURE':
      return 'a network error';
    case 'INVALID_PRE_KEY_FAILURE':
      return 'their keys could not be fetched';
    default:
      return 'an unknown error';
  }
}

const UNLINKED_PATTERN =
  /specified account does not exist|not registered|authorizationfailed|devicenotlinked|deauthori[sz]ed|\b401\b|\b403\b/i;

/**
 * True when an RPC failure means this computer is no longer a linked device.
 *
 * Two shapes, both seen against 0.14.6: a daemon started after the device was removed from the
 * phone drops the account and answers every account-scoped call with
 * `-32602 Specified account does not exist`; a daemon that was running at the time fails with
 * an authorization error from the server.
 */
export function isAccountGoneError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return UNLINKED_PATTERN.test(error.message);
}

/**
 * True when a `receive` notification carries an error that means the device was unlinked.
 * signal-cli reports receive-loop failures as `params.error` rather than as an RPC error.
 */
export function receiveSaysUnlinked(params: unknown): boolean {
  if (typeof params !== 'object' || params === null) return false;
  const error = (params as Record<string, unknown>).error;
  if (typeof error !== 'object' || error === null) return false;
  const record = error as Record<string, unknown>;
  const text = [record.type, record.message].filter((v) => typeof v === 'string').join(' ');
  return UNLINKED_PATTERN.test(text);
}
