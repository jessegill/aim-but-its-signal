/* eslint-disable @typescript-eslint/no-floating-promises -- node:test `test` returns a promise the runner owns. */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  describeSendFailure,
  isAccountGoneError,
  receiveSaysUnlinked,
  summarizeSendResults,
} from '../signal-results.ts';

test('send results: all successful means no failures', () => {
  const summary = summarizeSendResults({
    timestamp: 1700000000000,
    results: [{ recipientAddress: { uuid: 'u1', number: null }, type: 'SUCCESS' }],
  });
  assert.equal(summary.timestamp, 1700000000000);
  assert.deepEqual(summary.failures, []);
});

test('send results: a partial group failure is reported per recipient', () => {
  const summary = summarizeSendResults({
    timestamp: 1700000000001,
    results: [
      { recipientAddress: { uuid: 'u1' }, type: 'SUCCESS' },
      { recipientAddress: { uuid: 'u2', number: null }, type: 'IDENTITY_FAILURE' },
      { recipientAddress: { uuid: 'u3' }, type: 'UNREGISTERED_FAILURE' },
    ],
  });
  assert.deepEqual(
    summary.failures.map((f) => [f.uuid, f.type]),
    [
      ['u2', 'IDENTITY_FAILURE'],
      ['u3', 'UNREGISTERED_FAILURE'],
    ]
  );
  assert.equal(describeSendFailure('IDENTITY_FAILURE'), 'their safety number changed');
});

test('send results: malformed input never throws', () => {
  assert.deepEqual(summarizeSendResults(null), { timestamp: null, failures: [] });
  assert.deepEqual(summarizeSendResults({ results: 'nope' }), { timestamp: null, failures: [] });
  assert.deepEqual(summarizeSendResults({ results: [null, 3] }).failures, []);
});

test('account-gone detection matches what the daemon actually says', () => {
  // Observed live: a daemon started after the device was unlinked.
  // RpcError's message format: `<method>: <daemon message> (<code>)`.
  assert.ok(isAccountGoneError(new Error('send: Specified account does not exist (-32602)')));
  assert.ok(isAccountGoneError(new Error('User +10000000000 is not registered.')));
  assert.ok(isAccountGoneError(new Error('AuthorizationFailedException: 403')));
  assert.ok(!isAccountGoneError(new Error('signal-cli daemon connection closed')));
  assert.ok(!isAccountGoneError('not an error'));
});

test('receive errors that mean the device was unlinked are recognised', () => {
  assert.ok(receiveSaysUnlinked({ error: { type: 'AuthorizationFailedException', message: '' } }));
  assert.ok(!receiveSaysUnlinked({ error: { type: 'ProtocolInvalidMessageException' } }));
  assert.ok(!receiveSaysUnlinked({ envelope: {} }));
  assert.ok(!receiveSaysUnlinked(null));
});
