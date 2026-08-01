#!/usr/bin/env python3
"""
Generate the app icon and UI glyphs for the AIMgnal client.

ALL ARTWORK HERE IS ORIGINAL, drawn from scratch as code with the Python
standard library. Nothing is traced, extracted, downloaded, or derived from
AOL/AIM artwork. There is no running man, no AIM/AOL mark, and no reuse of
AOL's yellow-on-blue trade dress -- the palette is an original saturated teal
and cream (SPEC.md §9 "Assets", §10 "Naming and branding").

Design approach
---------------
Every asset is authored on a small integer pixel grid (16 or 32 units square),
the way icons were actually drawn in 2003. Both the SVG and the PNGs are
emitted from that same grid, so vector and raster can never drift apart.
PNG exports are integer nearest-neighbour scales of the grid, which keeps
every edge perfectly crisp at every size -- no resampling blur.

App icon shape: a square tile with a 2-unit stepped ("pixel chamfer") corner.
SPEC.md §9 demands square corners, and that rule is about the interface, so
the tile stays hard-edged and square rather than becoming a macOS squircle.
The 2-unit stair-step is the era-correct way pixel artists softened a corner,
and it keeps the icon from looking oversized next to rounded Dock neighbours.
The tile is inset 2 units (6.25%) inside the canvas for the same reason.

Outputs (written next to this script):
    app.svg, app-16.svg            vector source for the app icon
    app-{16,32,64,128,256,512}.png raster exports
    AIMgnal.iconset/               full macOS iconset incl. @2x retina
    AIMgnal.icns                   built with iconutil, for Electron packaging
    glyph-*.svg                    UI glyphs (SVG is the shipping format)
    glyph-*-{16,32,64}.png         convenience rasters

Usage:
    python3 generate.py            # regenerate everything
    python3 generate.py --verify   # report on what exists

Requires: Python 3 standard library only (zlib, struct). PNG is written
directly; no Pillow, no ImageMagick, no rsvg. The .icns step uses macOS
`iconutil`, which is built in; if it is missing, everything else still builds.
"""

import argparse
import os
import shutil
import struct
import subprocess
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
ICONSET = os.path.join(HERE, "AIMgnal.iconset")
ICNS = os.path.join(HERE, "AIMgnal.icns")

# --------------------------------------------------------------------------
# PALETTE -- original. Saturated teal + cream + warm amber.
# Deliberately NOT AOL's yellow-and-blue.
# --------------------------------------------------------------------------
INK        = (0x1B, 0x1B, 0x2E, 255)   # near-black navy outline
TEAL_1     = (0x3C, 0xE0, 0xD2, 255)   # tile gradient, top band
TEAL_2     = (0x21, 0xC4, 0xBA, 255)
TEAL_3     = (0x14, 0xA5, 0xA2, 255)
TEAL_4     = (0x0D, 0x86, 0x88, 255)
TEAL_5     = (0x0A, 0x6C, 0x70, 255)   # bottom band
TEAL_HI    = (0x8C, 0xF6, 0xEA, 255)   # bevel highlight
TEAL_LO    = (0x06, 0x4B, 0x50, 255)   # bevel shadow
CREAM      = (0xFF, 0xF7, 0xE4, 255)   # front speech bubble
CREAM_HI   = (0xFF, 0xFF, 0xFF, 255)
CREAM_LO   = (0xD8, 0xC9, 0xA6, 255)
AMBER      = (0xFF, 0xB8, 0x3A, 255)   # back speech bubble / accent
AMBER_HI   = (0xFF, 0xDA, 0x8E, 255)
AMBER_LO   = (0xD0, 0x87, 0x12, 255)
WARN_RED   = (0xE0, 0x3A, 0x1E, 255)   # security badge
WARN_HI    = (0xFF, 0x7A, 0x55, 255)
WARN_LO    = (0xA3, 0x22, 0x0D, 255)
GREY_BG    = (0xEC, 0xE9, 0xD8, 255)   # XP chrome grey (SPEC.md §9 token)
GREY_MID   = (0x9A, 0x99, 0x8C, 255)
GREY_DARK  = (0x6B, 0x6A, 0x60, 255)
WHITE      = (0xFF, 0xFF, 0xFF, 255)
NONE       = None                       # transparent

TILE_BANDS = [TEAL_1, TEAL_2, TEAL_3, TEAL_4, TEAL_5]


# --------------------------------------------------------------------------
# Canvas: a size x size grid of RGBA tuples (or None for transparent)
# --------------------------------------------------------------------------
class Canvas:
    def __init__(self, size):
        self.size = size
        self.px = [[NONE] * size for _ in range(size)]

    def inside(self, x, y):
        return 0 <= x < self.size and 0 <= y < self.size

    def set(self, x, y, c):
        if self.inside(x, y):
            self.px[y][x] = c

    def get(self, x, y):
        return self.px[y][x] if self.inside(x, y) else NONE

    def rect(self, x, y, w, h, c):
        for yy in range(y, y + h):
            for xx in range(x, x + w):
                self.set(xx, yy, c)

    def hline(self, x, y, w, c):
        self.rect(x, y, w, 1, c)

    def vline(self, x, y, h, c):
        self.rect(x, y, 1, h, c)

    def frame(self, x, y, w, h, c):
        """1-unit outline rectangle (square corners, per SPEC.md §9)."""
        self.hline(x, y, w, c)
        self.hline(x, y + h - 1, w, c)
        self.vline(x, y, h, c)
        self.vline(x + w - 1, y, h, c)


# --------------------------------------------------------------------------
# PNG writer (pure stdlib)
# --------------------------------------------------------------------------
def _chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def write_png(path, canvas, scale):
    """Nearest-neighbour integer upscale -> 8-bit RGBA PNG."""
    w = h = canvas.size * scale
    raw = bytearray()
    for y in range(canvas.size):
        row = bytearray()
        for x in range(canvas.size):
            c = canvas.px[y][x] or (0, 0, 0, 0)
            row += bytes(c) * scale
        for _ in range(scale):
            raw += b"\x00" + row
    png = (b"\x89PNG\r\n\x1a\n"
           + _chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
           + _chunk(b"IDAT", zlib.compress(bytes(raw), 9))
           + _chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)
    return w


# --------------------------------------------------------------------------
# SVG writer (same grid -> merged horizontal runs, crisp edges)
# --------------------------------------------------------------------------
def write_svg(path, canvas, title):
    s = canvas.size
    parts = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" '
        'viewBox="0 0 %d %d" shape-rendering="crispEdges">' % (s, s, s, s),
        "<title>%s</title>" % title,
        "<!-- Original artwork for this project. Generated by generate.py. "
        "Not derived from AOL/AIM assets. -->",
    ]
    for y in range(s):
        x = 0
        while x < s:
            c = canvas.px[y][x]
            if c is None:
                x += 1
                continue
            run = 1
            while x + run < s and canvas.px[y][x + run] == c:
                run += 1
            fill = "#%02X%02X%02X" % c[:3]
            op = "" if c[3] == 255 else ' fill-opacity="%.3f"' % (c[3] / 255.0)
            parts.append('<rect x="%d" y="%d" width="%d" height="1" fill="%s"%s/>'
                         % (x, y, run, fill, op))
            x += run
    parts.append("</svg>")
    with open(path, "w") as f:
        f.write("\n".join(parts) + "\n")


# --------------------------------------------------------------------------
# Shared drawing helpers
# --------------------------------------------------------------------------
def tile_spans(x0, y0, size, cut):
    """Row spans for a square with `cut`-unit stepped (chamfered) corners."""
    spans = {}
    for i in range(size):
        if i < cut:
            d = cut - i
        elif i >= size - cut:
            d = i - (size - cut) + 1
        else:
            d = 0
        spans[y0 + i] = (x0 + d, x0 + size - 1 - d)
    return spans


def fill_spans(cv, spans, colors):
    """Fill row spans with a banded vertical gradient (chunky, not smooth)."""
    ys = sorted(spans)
    for i, y in enumerate(ys):
        band = colors[min(len(colors) - 1, i * len(colors) // len(ys))]
        x0, x1 = spans[y]
        cv.rect(x0, y, x1 - x0 + 1, 1, band)


def outline_spans(cv, spans, color):
    """Ink every cell of the shape that touches the outside (4-neighbour)."""
    cells = set()
    for y, (x0, x1) in spans.items():
        for x in range(x0, x1 + 1):
            cells.add((x, y))
    for (x, y) in sorted(cells):
        if any((x + dx, y + dy) not in cells
               for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
            cv.set(x, y, color)


def bevel_spans(cv, spans, hi, lo, ink):
    """Classic 2-unit-outset look: light on top/left, dark on bottom/right.
    Applied to the ring just inside the ink outline."""
    cells = {}
    for y, (x0, x1) in spans.items():
        for x in range(x0, x1 + 1):
            cells[(x, y)] = True
    for (x, y) in sorted(cells):
        if cv.get(x, y) == ink:
            continue
        if cv.get(x, y - 1) == ink or cv.get(x - 1, y) == ink:
            cv.set(x, y, hi)
    for (x, y) in sorted(cells):
        if cv.get(x, y) == ink or cv.get(x, y) == hi:
            continue
        if cv.get(x, y + 1) == ink or cv.get(x + 1, y) == ink:
            cv.set(x, y, lo)


def bubble(cv, x, y, w, h, fill, hi, lo, ink=INK):
    """A square speech-balloon body: ink frame, flat fill, 1-unit inner bevel."""
    cv.rect(x, y, w, h, fill)
    cv.frame(x, y, w, h, ink)
    cv.hline(x + 1, y + 1, w - 2, hi)
    cv.vline(x + 1, y + 1, h - 2, hi)
    cv.hline(x + 1, y + h - 2, w - 2, lo)
    cv.vline(x + w - 2, y + 1, h - 2, lo)


# --------------------------------------------------------------------------
# APP ICON -- 32-unit master
# --------------------------------------------------------------------------
def draw_app_32():
    """Two overlapping square speech balloons on a saturated teal tile.

    Reads as "instant messenger" at a glance without borrowing anyone's mark:
    the back balloon (amber, the other person) and the front balloon (cream,
    you) with three ink dots -- the universal "typing" ellipsis.
    """
    cv = Canvas(32)

    # tile: inset 2 units, 2-unit stepped corners
    spans = tile_spans(2, 2, 28, cut=2)
    fill_spans(cv, spans, TILE_BANDS)
    outline_spans(cv, spans, INK)
    bevel_spans(cv, spans, TEAL_HI, TEAL_LO, INK)

    # back balloon (amber) -- the other person, sitting behind yours
    bubble(cv, 17, 5, 11, 10, AMBER, AMBER_HI, AMBER_LO)
    cv.rect(20, 8, 6, 1, INK)     # two ink "text lines" so it reads as speech
    cv.rect(20, 11, 4, 1, INK)

    # front balloon (cream)
    bubble(cv, 4, 10, 20, 14, CREAM, CREAM_HI, CREAM_LO)

    # stepped tail, down and to the left
    cv.rect(7, 24, 5, 1, CREAM); cv.set(6, 24, INK); cv.set(12, 24, INK)
    cv.rect(7, 25, 4, 1, CREAM); cv.set(6, 25, INK); cv.set(11, 25, INK)
    cv.rect(7, 26, 2, 1, CREAM); cv.set(6, 26, INK); cv.set(9, 26, INK)
    cv.rect(6, 27, 3, 1, INK)
    for x in range(7, 12):        # erase the balloon's own bottom ink where
        if cv.get(x, 23) == INK:  # the tail joins it
            cv.set(x, 23, CREAM)

    # three ink dots (the ellipsis)
    for dx in (7, 12, 17):
        cv.rect(dx, 15, 3, 3, INK)

    return cv


def draw_app_16():
    """Hand-tuned 16-unit variant. At 16px the two-balloon composition turns
    to mud, so it drops to one balloon with three 2-unit dots."""
    cv = Canvas(16)
    spans = tile_spans(0, 0, 16, cut=1)
    fill_spans(cv, spans, TILE_BANDS)
    outline_spans(cv, spans, INK)

    bubble(cv, 2, 3, 12, 8, CREAM, CREAM_HI, CREAM_LO)
    cv.rect(4, 11, 3, 1, CREAM); cv.set(3, 11, INK); cv.set(7, 11, INK)
    cv.rect(4, 12, 2, 1, CREAM); cv.set(3, 12, INK); cv.set(6, 12, INK)
    cv.rect(3, 13, 3, 1, INK)
    for x in range(4, 7):
        if cv.get(x, 10) == INK:
            cv.set(x, 10, CREAM)
    for dx in (4, 7, 10):
        cv.rect(dx, 6, 2, 2, INK)
    return cv


# --------------------------------------------------------------------------
# UI GLYPHS -- 16-unit grids, transparent background
# --------------------------------------------------------------------------
def draw_expander(pointing):
    """Group expander for the buddy list tree (SPEC.md §9: 'Groups show a
    triangle/plus expander'). `pointing` is 'right' (collapsed) or 'down'
    (expanded). Solid ink stair-step triangle -- no anti-aliasing, on grid."""
    cv = Canvas(16)
    if pointing == "right":
        # 5 wide x 9 tall, apex right, centred on (7,7)
        for i in range(9):
            cv.rect(5, 3 + i, 5 - abs(i - 4), 1, INK)
    else:
        # 9 wide x 5 tall, apex down, centred on (7,7)
        for i in range(5):
            cv.rect(3 + i, 5 + i, 9 - 2 * i, 1, INK)
    return cv


def draw_paperclip():
    """Attachment affordance (SPEC.md §8 'Attachments'). An upright pixel
    paperclip: outer loop, inner loop, drawn as stair-steps."""
    cv = Canvas(16)
    C = INK
    # A paperclip is two nested wires: an outer "U" open at the top and an
    # inner "n" open at the bottom. Drawn as stair-steps so it stays legible
    # at 16px without anti-aliasing.
    # outer U: legs x=3 and x=11, y 2..10, stepped bottom
    cv.vline(3, 2, 9, C)
    cv.vline(11, 2, 9, C)
    cv.set(4, 11, C); cv.set(10, 11, C)
    cv.set(5, 12, C); cv.set(9, 12, C)
    cv.rect(6, 13, 3, 1, C)
    # inner n: legs x=5 and x=9, y 6..11, stepped top
    cv.vline(5, 6, 6, C)
    cv.vline(9, 6, 6, C)
    cv.set(6, 5, C); cv.set(8, 5, C)
    cv.set(7, 4, C)
    return cv


def draw_warning_badge():
    """Security warning badge -- used for safety-number / identity changes.

    SPEC.md §8 makes this security-critical and says it must be surfaced
    prominently, and §8 again: 'When retro authenticity conflicts with a
    security signal, security wins.' Hence high-contrast red rather than a
    muted period-correct grey: a hard-edged hazard triangle with an ink
    outline and a cream exclamation mark."""
    cv = Canvas(16)
    rows = {}
    for i in range(13):                 # apex at y=1, base at y=13
        y = 1 + i
        half = (i + 1) // 2
        rows[y] = (7 - half, 8 + half)
    for y, (x0, x1) in rows.items():
        cv.rect(x0, y, x1 - x0 + 1, 1, WARN_RED)
    outline_spans(cv, rows, INK)
    # bevel: light on the upper-left face, dark on the lower-right
    for y, (x0, x1) in rows.items():
        if cv.get(x0 + 1, y) == WARN_RED:
            cv.set(x0 + 1, y, WARN_HI)
        if cv.get(x1 - 1, y) == WARN_RED:
            cv.set(x1 - 1, y, WARN_LO)
    # exclamation mark
    cv.rect(7, 5, 2, 5, CREAM)
    cv.rect(7, 11, 2, 2, CREAM)
    return cv


def draw_avatar_placeholder():
    """Generic buddy avatar for roster entries with no profile image.
    Chunky head-and-shoulders silhouette in a beveled square well
    (SPEC.md §9: square corners, 2-unit inset borders)."""
    cv = Canvas(16)
    cv.rect(0, 0, 16, 16, GREY_BG)
    cv.frame(0, 0, 16, 16, INK)
    # inset border (SPEC.md §9 'Text inputs: border 2px inset')
    cv.hline(1, 1, 14, GREY_DARK)
    cv.vline(1, 1, 14, GREY_DARK)
    cv.hline(1, 14, 14, WHITE)
    cv.vline(14, 1, 14, WHITE)
    # head (corners notched so it reads round, not robotic)
    cv.rect(6, 3, 4, 1, GREY_MID)
    cv.rect(5, 4, 6, 3, GREY_MID)
    cv.rect(6, 7, 4, 1, GREY_MID)
    # shoulders, with a clear neck gap at y=8
    cv.rect(6, 9, 4, 1, GREY_MID)
    cv.rect(5, 10, 6, 1, GREY_MID)
    cv.rect(4, 11, 8, 1, GREY_MID)
    cv.rect(3, 12, 10, 2, GREY_MID)
    return cv


GLYPHS = {
    "glyph-expander-collapsed": (lambda: draw_expander("right"),
                                 "Buddy group expander, collapsed"),
    "glyph-expander-expanded":  (lambda: draw_expander("down"),
                                 "Buddy group expander, expanded"),
    "glyph-paperclip":          (draw_paperclip, "Attachment"),
    "glyph-warning-badge":      (draw_warning_badge,
                                 "Security warning (safety number change)"),
    "glyph-avatar":             (draw_avatar_placeholder,
                                 "Default buddy avatar placeholder"),
}

# macOS iconset members: (filename, pixel size, which master, scale)
ICONSET_MEMBERS = [
    ("icon_16x16.png",       16,  "16", 1),
    ("icon_16x16@2x.png",    32,  "16", 2),
    ("icon_32x32.png",       32,  "32", 1),
    ("icon_32x32@2x.png",    64,  "32", 2),
    ("icon_128x128.png",     128, "32", 4),
    ("icon_128x128@2x.png",  256, "32", 8),
    ("icon_256x256.png",     256, "32", 8),
    ("icon_256x256@2x.png",  512, "32", 16),
    ("icon_512x512.png",     512, "32", 16),
    ("icon_512x512@2x.png",  1024, "32", 32),
]


def build():
    app32, app16 = draw_app_32(), draw_app_16()
    masters = {"32": app32, "16": app16}
    made = []

    write_svg(os.path.join(HERE, "app.svg"), app32, "AIMgnal app icon")
    write_svg(os.path.join(HERE, "app-16.svg"), app16,
              "AIMgnal app icon (16px variant)")
    made += ["app.svg", "app-16.svg"]

    # standalone PNG exports; 16px uses the simplified master
    for size in (16, 32, 64, 128, 256, 512):
        master, scale = ("16", 1) if size == 16 else ("32", size // 32)
        name = "app-%d.png" % size
        write_png(os.path.join(HERE, name), masters[master], scale)
        made.append(name)

    # full macOS iconset (retina variants included -- a .icns without @2x
    # renders blurry in the Dock)
    if os.path.isdir(ICONSET):
        shutil.rmtree(ICONSET)
    os.makedirs(ICONSET)
    for name, _size, master, scale in ICONSET_MEMBERS:
        write_png(os.path.join(ICONSET, name), masters[master], scale)
    made.append("AIMgnal.iconset/ (%d files)" % len(ICONSET_MEMBERS))

    if shutil.which("iconutil"):
        subprocess.run(["iconutil", "-c", "icns", ICONSET, "-o", ICNS],
                       check=True)
        made.append("AIMgnal.icns")
    else:
        print("warning: iconutil not found; skipped .icns", file=sys.stderr)

    for base, (fn, title) in GLYPHS.items():
        cv = fn()
        write_svg(os.path.join(HERE, base + ".svg"), cv, title)
        made.append(base + ".svg")
        for size in (16, 32, 64):
            write_png(os.path.join(HERE, "%s-%d.png" % (base, size)),
                      cv, size // 16)
        made.append("%s-{16,32,64}.png" % base)

    return made


# --------------------------------------------------------------------------
# Verification
# --------------------------------------------------------------------------
def png_info(path):
    with open(path, "rb") as f:
        head = f.read(33)
    if head[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    w, h, depth, ctype = struct.unpack(">IIBB", head[16:26])
    return w, h, depth, ctype


def read_png(path):
    """Decode one of our own PNGs back to (width, height, rows-of-RGBA).
    We always write filter type 0, so no un-filtering is needed."""
    with open(path, "rb") as f:
        data = f.read()
    pos, idat = 8, bytearray()
    w = h = 0
    while pos < len(data):
        ln = struct.unpack(">I", data[pos:pos + 4])[0]
        tag = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + ln]
        if tag == b"IHDR":
            w, h = struct.unpack(">II", body[:8])
        elif tag == b"IDAT":
            idat += body
        pos += 12 + ln
    raw = zlib.decompress(bytes(idat))
    stride = w * 4 + 1
    rows = []
    for y in range(h):
        line = raw[y * stride:(y + 1) * stride]
        if line[0] != 0:
            raise ValueError("unexpected PNG filter type in %s" % path)
        body = line[1:]
        rows.append([tuple(body[x * 4:x * 4 + 4]) for x in range(w)])
    return w, h, rows


def svg_to_grid(path):
    """Re-parse one of our SVGs back into a pixel grid."""
    import xml.etree.ElementTree as ET
    root = ET.parse(path).getroot()
    s = int(float(root.get("width")))
    cv = Canvas(s)
    for r in root.iter("{http://www.w3.org/2000/svg}rect"):
        x, y = int(r.get("x")), int(r.get("y"))
        w, h = int(r.get("width")), int(r.get("height"))
        fill = r.get("fill")
        op = r.get("fill-opacity")
        c = (int(fill[1:3], 16), int(fill[3:5], 16), int(fill[5:7], 16),
             255 if op is None else int(round(float(op) * 255)))
        cv.rect(x, y, w, h, c)
    return cv


# svg basename -> the function that draws its master grid
SOURCES = {
    "app": draw_app_32,
    "app-16": draw_app_16,
}
SOURCES.update({name: fn for name, (fn, _t) in GLYPHS.items()})


def cross_check():
    """Prove the shipped SVG and the shipped PNG are the same artwork.

    Both are emitted from one grid, so a mismatch means a bug in an exporter.
    """
    ok = True
    for base, fn in sorted(SOURCES.items()):
        master = fn()
        svg_path = os.path.join(HERE, base + ".svg")
        if os.path.exists(svg_path):
            got = svg_to_grid(svg_path)
            if got.size != master.size or got.px != master.px:
                ok = False
                print("    !! %s.svg does not match its source grid" % base)

        png_path = os.path.join(HERE, base + ".png")
        if base == "app":
            png_path = os.path.join(HERE, "app-32.png")
        elif base == "app-16":
            png_path = os.path.join(HERE, "app-16.png")
        else:
            png_path = os.path.join(HERE, base + "-16.png")
        if not os.path.exists(png_path):
            continue
        w, h, rows = read_png(png_path)
        scale = w // master.size
        for y in range(h):
            for x in range(w):
                want = master.px[y // scale][x // scale] or (0, 0, 0, 0)
                if rows[y][x] != want:
                    ok = False
                    print("    !! %s differs from source grid at (%d,%d)"
                          % (os.path.basename(png_path), x, y))
                    break
            else:
                continue
            break
    return ok


def verify():
    ok = True
    print("%-34s %11s %9s %8s" % ("file", "dimensions", "format", "bytes"))
    print("-" * 66)
    targets = [f for f in sorted(os.listdir(HERE))
               if f.endswith(".png") or f.endswith(".svg") or f.endswith(".icns")]
    for f in targets:
        p = os.path.join(HERE, f)
        size = os.path.getsize(p)
        if f.endswith(".png"):
            info = png_info(p)
            if not info:
                ok = False
                print("%-34s  BAD PNG HEADER" % f)
                continue
            w, h, depth, ctype = info
            print("%-34s %5dx%-5d %9s %8d"
                  % (f, w, h, "RGBA%d" % depth, size))
            if w != h:
                ok = False
                print("    !! not square")
        else:
            print("%-34s %11s %9s %8d"
                  % (f, "-", f.split(".")[-1], size))
        if size == 0:
            ok = False
            print("    !! empty file")

    missing = []
    for name, want, _master, _scale in ICONSET_MEMBERS:
        p = os.path.join(ICONSET, name)
        if not os.path.exists(p):
            missing.append(name)
            continue
        info = png_info(p)
        if not info or info[0] != want or info[1] != want:
            ok = False
            print("    !! %s is %s, expected %dx%d" % (name, info, want, want))
    print("\niconset members present: %d/%d"
          % (len(ICONSET_MEMBERS) - len(missing), len(ICONSET_MEMBERS)))
    if missing:
        ok = False
        print("    !! missing: %s" % ", ".join(missing))

    print("cross-checking SVG and PNG against source grids...")
    if not cross_check():
        ok = False
    else:
        print("    all exports match their source grid exactly")
    return ok


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--verify", action="store_true")
    args = ap.parse_args()
    if not args.verify:
        for m in build():
            print("wrote %s" % m)
        print()
    if not verify():
        sys.exit("icon verification failed")
    print("\nall icons OK")


if __name__ == "__main__":
    main()
