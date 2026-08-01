# Resources

Sounds and icons for the client. Target platform is **macOS only**.

## Originality statement

**Every asset in this directory is original work created for this project.**

Nothing here was copied, extracted, sampled, traced, or downloaded from AOL, AIM, or any
other product. There is no running man, no AIM or AOL mark, and no reuse of AOL's
yellow-and-blue trade dress. The audio is synthesized from mathematical waveforms (sine,
triangle, square, seeded pseudo-random noise); the artwork is drawn from scratch as code on
an integer pixel grid. Both generators are committed here, so every byte of every asset can
be traced to the source that produced it and regenerated from nothing.

This satisfies SPEC.md §9 ("Do **not** ship extracted AIM or AOL artwork... Create original
look-alike assets") and §10 ("do not use 'Signal' or 'AIM'/'AOL' names, logos, or marks").

## Tooling

Both generators use the **Python 3 standard library only** — `wave`, `struct`, `zlib`,
`math`, `random`. No numpy, no scipy, no sox, no ffmpeg, no Pillow, no ImageMagick, no
librsvg. None of those are installed on this machine and none are needed. The PNG encoder
and the SVG emitter are written directly in `icons/generate.py`.

The single external tool is **`iconutil`**, which ships with macOS, used only for the final
`.icns` packaging step. If it is absent, everything else still builds.

---

## Sounds — `sounds/`

SPEC.md §9 specifies exactly three sounds, and they are **message-driven only**. SPEC.md §7
forbids presence, so there are deliberately **no sign-on, sign-off, or buddy-in/buddy-out
sounds** — Signal transmits no presence, so those events do not exist and such sounds would
be unusable.

| File | What it is | Design |
|---|---|---|
| `receive.wav` | Incoming message | Bright rising blip: three ascending tones (C6 → G6 → C7) with a triangle+square harmonic and a click transient at onset. The attention-getting one — loud enough to cut through, short enough not to nag. |
| `send.wav` | Outgoing message | Falling two-tone (G5 → C5), gentler attack, roughly half the level of receive. You already know you sent it; this is only confirmation. |
| `typing.wav` | Typing indicator | A ~45 ms lowpassed noise tick with a faint 2.2 kHz component. A keyswitch, not a note. Fires often, so it is nearly subliminal. |

Format: **WAV, 44.1 kHz, mono, 16-bit PCM.** WAV so Electron on macOS plays it natively
through an HTML5 `<audio>` element with no codec concerns.

Era-appropriate character comes from simple oscillators, fast attacks, exponential decays,
and a 12-bit quantization pass (`bit_crush`) that reproduces the texture of small
low-bit-depth 2003 system sounds. Every tone ends with a short linear release to exactly
zero — ending mid-cycle produces a click, which is the fastest way to make synthesized UI
sounds feel cheap.

### Measured properties (verified, not asserted)

| File | Rate | Ch | Bits | Duration | Peak | Peak dBFS | RMS dBFS | Clipped samples |
|---|---|---|---|---|---|---|---|---|
| `receive.wav` | 44100 | 1 | 16 | 0.2600 s | 0.8598 | −1.31 | −14.75 | 0 |
| `send.wav` | 44100 | 1 | 16 | 0.2000 s | 0.4199 | −7.54 | −19.35 | 0 |
| `typing.wav` | 44100 | 1 | 16 | 0.0450 s | 0.2002 | −13.97 | −31.69 | 0 |

All three are well under 1 second, none clip, none are silent, and the relative levels are
intentional: receive is loudest, send about half, typing barely there. Each file was also
played through CoreAudio with `afplay` and confirmed to decode and sound.

### Regenerating

```sh
python3 sounds/generate.py            # rewrite the three WAVs, then measure them
python3 sounds/generate.py --verify   # measure the existing files without rewriting
```

Generation is deterministic — the noise generators use a fixed seed, so regenerating
produces byte-identical files. `--verify` fails loudly on wrong sample rate, clipping,
near-silence, or a duration of 1 second or more.

**Tuning:** the taste knobs are the `CONFIG` dict at the top of the script (peak levels and
note frequencies) and the three `build_*()` functions (timing, envelopes, waveform mix).
Change a number, re-run, listen.

---

## Icons — `icons/`

### Method

Every asset is authored on a small integer pixel grid — 32×32 for the app icon, 16×16 for
the glyphs and the small app variant — the way icons were actually drawn in 2003. **The SVG
and the PNGs are both emitted from that same grid**, so vector and raster cannot drift
apart. PNG exports are integer nearest-neighbour scales, which keeps every edge perfectly
crisp at every size with no resampling blur.

`generate.py --verify` proves this: it decodes the written PNGs and re-parses the written
SVGs and asserts both reproduce the source grid exactly, pixel for pixel.

### Palette

Original, and deliberately **not** AOL's yellow-on-blue: saturated teal (`#3CE0D2` →
`#0A6C70`), cream (`#FFF7E4`), warm amber (`#FFB83A`), near-black navy ink (`#1B1B2E`).
The XP chrome grey `#ECE9D8` from the SPEC.md §9 style tokens is used in the avatar
placeholder so it sits correctly in the buddy list.

### App icon

Two overlapping square speech balloons on a teal tile: an amber balloon behind (the other
person) and a cream balloon in front holding three ink dots — the universal typing ellipsis.
It reads as "instant messenger" at a glance without borrowing anyone's mark.

**Shape decision (square corners vs. the Dock).** SPEC.md §9 requires square corners
globally, and calls it "the single highest-impact rule." That rule governs the *interface*,
so the tile stays hard-edged and square rather than becoming a macOS squircle — a rounded
app icon would undercut the whole premise. The one concession to the Dock is a **2-unit
stepped corner chamfer** and a 2-unit (6.25%) inset inside the canvas. The stair-step is how
pixel artists actually softened a corner in this era, so it is era-correct rather than a
compromise, and it stops the icon from looking oversized and alien beside rounded Dock
neighbours. It is still unmistakably a square.

The 16 px artwork is a separate hand-tuned drawing, not a downscale: at that size the
two-balloon composition turns to mud, so it drops to a single balloon with three 2-unit dots.

| File | Notes |
|---|---|
| `app.svg` | Vector source, 32-unit grid |
| `app-16.svg` | Vector source, simplified 16-unit variant |
| `app-{16,32,64,128,256,512}.png` | Raster exports; the 16 px uses the simplified master |
| `RetroIM.iconset/` | Full macOS iconset, 10 members |
| `RetroIM.icns` | **What Electron packaging consumes on macOS** |

The `.icns` contains all ten standard members including every `@2x` retina variant —
16, 16@2x, 32, 32@2x, 128, 128@2x, 256, 256@2x, 512, 512@2x (up to 1024×1024 pixels). A
`.icns` missing retina variants renders blurry in the Dock. Verified by round-tripping the
`.icns` back out with `iconutil -c iconset` and confirming all ten are present.

Per-size sourcing follows normal macOS practice: the 16 pt slots (16, 16@2x) render the
simplified 16-unit artwork at 1× and 2×; everything from 32 pt up renders the 32-unit master
at 1×–32×.

### UI glyphs

Shipped as **SVG** — they are rendered in the interface at small sizes and need to stay crisp
on retina displays. PNGs at 16/32/64 are included as a convenience but SVG is the intended
format. All are drawn on a 16-unit grid with `shape-rendering="crispEdges"` and a transparent
background.

| File | Purpose |
|---|---|
| `glyph-expander-collapsed.svg` | Buddy group expander, collapsed. SPEC.md §9: "Groups show a triangle/plus expander." Solid stair-step triangle, 5×9 units. |
| `glyph-expander-expanded.svg` | Same, expanded. 9×5 units, matched weight. |
| `glyph-paperclip.svg` | Attachment affordance (SPEC.md §8, Attachments). Two nested wires — an outer "U" open at the top, an inner "n" open at the bottom — which is what makes a paperclip legible at 16 px. |
| `glyph-warning-badge.svg` | **Security warning, for safety-number / identity changes.** |
| `glyph-avatar.svg` | Default buddy avatar for roster entries with no profile image. Head-and-shoulders silhouette in a 2-unit inset well, per the SPEC.md §9 inset-border token. |

**On the warning badge:** SPEC.md §8 makes safety-number changes security-critical and
requires they be surfaced prominently — "never omit a security signal because the retro idiom
lacks a place for it," and "when retro authenticity conflicts with a security signal,
security wins." So this glyph is a high-contrast red hazard triangle with an ink outline and
a cream exclamation mark, rather than something muted and period-polite. It is styled to fit
the era (hard edges, on-grid, beveled faces) but it is designed to be noticed.

### Regenerating

```sh
python3 icons/generate.py            # redraw everything, rebuild the .icns, verify
python3 icons/generate.py --verify   # verify existing files without redrawing
```

`--verify` checks that every PNG has a valid header and is square, that all ten iconset
members exist at their correct pixel dimensions, and that every SVG and PNG matches its
source grid exactly.

**Tuning:** the palette constants are at the top of the script; each asset is one small
`draw_*()` function using `rect` / `frame` / `bubble` helpers on integer coordinates. To
change the app icon, edit `draw_app_32()` (and `draw_app_16()` for the small variant) and
re-run — the SVG, all PNGs, and the `.icns` are rebuilt together and re-verified.

### Not included

No `.ico` — there is no Windows target.
