/**
 * Per-sender colour for chat rooms (SPEC.md §8).
 *
 * In a 1:1 window the AIM convention carries all the information there is: your text is red,
 * theirs is blue, and there are only two people. In a chat room that convention runs out — a
 * dozen people share one "them" colour, and the only thing distinguishing one voice from
 * another is a bold name that reads the same shade as every other bold name. So in a room each
 * member gets their own colour, and it is the same colour in the message log and in the member
 * list beside it.
 *
 * **Own lines stay red.** `--ink-me` is the one colour a user already knows means themselves,
 * and rotating it into the palette would cost more than it gained.
 *
 * ---------------------------------------------------------------------------------------
 * WHY A HASH AND NOT AN INDEX
 * ---------------------------------------------------------------------------------------
 * The colour is derived from the sender's ACI, which never changes. Assigning by position in
 * the member list would be prettier — no collisions until the palette runs out — but membership
 * changes, and the day someone leaves a group every person below them in the list would change
 * colour, re-tinting the entire scrollback of a conversation the user had already learned to
 * read. A hash is stable for as long as the account exists, across sessions, across windows,
 * and across a group the user leaves and rejoins.
 *
 * The cost is collisions: two members of a room larger than the palette can share a colour.
 * That is a legible failure — the names are still spelled out on every line, which is what
 * actually carries the attribution — where re-tinting the history is not.
 *
 * Palette constraints: every entry sits at roughly the same darkness so no member reads as
 * emphasised relative to another, all clear 4.5:1 against the log's white well, and none is
 * near `--ink-me`'s red, which would read as "this is you".
 */

const PALETTE = [
  '#1a4f9c', // blue
  '#14713f', // green
  '#6b3fa0', // purple
  '#8a4b00', // brown
  '#00696e', // teal
  '#a02071', // magenta
  '#5c6b12', // olive
  '#2e3e9c', // indigo
  '#0f6e5c', // sea green
  '#7d2e8c', // violet
  '#7a5b00', // dark gold
  '#34618a', // steel
] as const;

/**
 * FNV-1a. Chosen for being short, dependency-free and stable — not for any cryptographic
 * property, of which it has none and needs none. Nothing security-relevant rests on this.
 */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    // The >>> 0 keeps the accumulator unsigned; JS bit ops otherwise produce a signed int32
    // and the sign flip would make the result depend on where the string happened to overflow.
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** The stable colour for a sender in a chat room. */
export function senderColor(senderId: string): string {
  return PALETTE[hash(senderId) % PALETTE.length];
}

/** How many distinct colours exist before two members must share one. */
export const SENDER_COLOR_COUNT = PALETTE.length;
