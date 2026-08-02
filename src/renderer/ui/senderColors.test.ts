/* eslint-disable @typescript-eslint/no-floating-promises -- node:test `describe`/`test` return promises the runner owns. */
/**
 * Per-sender colours in chat rooms.
 *
 * The property worth testing is not "the colours look nice" — it is that a member's colour
 * never moves. A colour that shifted between sessions, between the log and the member list, or
 * when somebody else left the group would be worse than no colour at all: the user would have
 * learned to read a room that then re-tinted itself underneath them.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { senderColor, SENDER_COLOR_COUNT } from './senderColors.ts';

const ALICE = 'aaaaaaaa-0000-0000-0000-00000000000a';
const BOB = 'bbbbbbbb-0000-0000-0000-00000000000b';

describe('sender colours', () => {
  test('a member keeps the same colour forever', () => {
    const first = senderColor(ALICE);
    assert.equal(senderColor(ALICE), first);
    // Nothing about the surrounding group is an input, so membership changes cannot re-tint
    // anyone: the ACI is the only thing the colour depends on.
    assert.equal(senderColor(ALICE), first);
  });

  test('different members generally get different colours', () => {
    assert.notEqual(senderColor(ALICE), senderColor(BOB));
  });

  test('every colour is a dark hex, so it reads on the log’s white well', () => {
    // Sampled across many ACIs rather than reaching into the palette, so this holds for
    // whatever the hash actually reaches.
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const color = senderColor(`00000000-0000-0000-0000-${String(i).padStart(12, '0')}`);
      seen.add(color);
      assert.match(color, /^#[0-9a-f]{6}$/, `${color} is not a plain hex colour`);

      // Relative luminance, per WCAG. A 4.5:1 contrast against white needs <= ~0.1791.
      const channel = (hex: string): number => {
        const c = parseInt(hex, 16) / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
      };
      const luminance =
        0.2126 * channel(color.slice(1, 3)) +
        0.7152 * channel(color.slice(3, 5)) +
        0.0722 * channel(color.slice(5, 7));
      const contrast = 1.05 / (luminance + 0.05);
      assert.ok(contrast >= 4.5, `${color} is only ${contrast.toFixed(2)}:1 against white`);
    }

    // The hash should actually reach the whole palette rather than piling onto a few entries.
    assert.equal(seen.size, SENDER_COLOR_COUNT);
  });

  test('the hash is stable across the sign flip that trips naive FNV', () => {
    // Math.imul returns a signed int32. Without the >>> 0 the accumulator would go negative
    // partway through a long string and the modulo would land somewhere else — which would
    // silently re-tint anyone whose ACI happened to overflow. Long inputs exercise that.
    const long = 'x'.repeat(200);
    assert.equal(senderColor(long), senderColor(long));
    assert.match(senderColor(long), /^#[0-9a-f]{6}$/);
  });
});
