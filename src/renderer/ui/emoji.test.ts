/* eslint-disable @typescript-eslint/no-floating-promises -- node:test `describe`/`test` return promises the runner owns. */
/**
 * The emoji the picker offers.
 *
 * The set is hand-written, which is the right call for a curated grid and the wrong shape for
 * getting right by eye: a duplicate is invisible in a wall of glyphs, and React would drop it
 * anyway since the emoji is the key.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ALL_EMOJI, EMOJI_SECTIONS } from './emoji.ts';

describe('emoji set', () => {
  test('no duplicates, within a section or across them', () => {
    // Duplicates are keys in the grid, so a repeat is a React key collision as well as a
    // wasted cell.
    const seen = new Map<string, string>();
    for (const section of EMOJI_SECTIONS) {
      for (const emoji of section.emoji) {
        const first = seen.get(emoji);
        assert.equal(
          first,
          undefined,
          `${emoji} appears in both ${first ?? '?'} and ${section.name}`
        );
        seen.set(emoji, section.name);
      }
    }
  });

  test('every section has a name and enough to be worth a tab', () => {
    for (const section of EMOJI_SECTIONS) {
      assert.ok(section.name.length > 0);
      assert.ok(section.emoji.length >= 20, `${section.name} has only ${section.emoji.length}`);
    }
  });

  test('the first of each section works as its tab glyph', () => {
    // The tab renders section.emoji[0], so an empty section would render an empty tab.
    for (const section of EMOJI_SECTIONS) {
      assert.ok((section.emoji[0]?.length ?? 0) > 0, `${section.name} has no tab glyph`);
    }
  });

  test('nothing in here is an ASCII text emoticon', () => {
    // The picker inserts what the recipient's phone will render. `:-)` arrives as three
    // characters and is the thing this set exists to replace.
    for (const emoji of ALL_EMOJI) {
      assert.ok(
        !/^[ -~]+$/.test(emoji),
        `${emoji} is ASCII — the picker inserts Unicode emoji, not text emoticons`
      );
    }
  });
});
