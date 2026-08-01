/**
 * A CommonJS `require` that works whether this file ends up as ESM or CJS.
 *
 * The store has to load two things by name at runtime rather than by static import:
 *   - `electron` (so the store is still loadable in a plain-node test runner), and
 *   - the native SQLite driver (so we can probe for an encryption-capable one).
 *
 * electron-vite may emit the main process as either CJS or ESM depending on config, so this
 * picks whichever mechanism is actually present.
 */

import { createRequire } from 'node:module';

type RequireFn = (id: string) => unknown;

let cached: RequireFn | null = null;

function resolveRequire(): RequireFn {
  if (cached) return cached;
  // `typeof` on an undeclared identifier is safe and does not throw.
  if (typeof require === 'function') {
    cached = require;
  } else {
    cached = createRequire(import.meta.url);
  }
  return cached;
}

export function nodeRequire(id: string): unknown {
  return resolveRequire()(id);
}
