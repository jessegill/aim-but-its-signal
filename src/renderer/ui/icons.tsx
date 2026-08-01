/**
 * icons.tsx — original inline-SVG artwork.
 *
 * SPEC.md §9 / §10: do NOT ship extracted AIM or AOL artwork. The running man
 * and the AIM/AOL marks are not ours to distribute. Everything in this file is
 * drawn from scratch in the era's idiom — 16px-grid, hard edges, two-tone
 * bevels, no anti-aliased curves where a 2003 icon would have had none.
 *
 * Nothing here depicts a running figure, a yellow-on-blue "buddy" silhouette,
 * or any AOL wordmark.
 *
 * Square-corner rule applies to SVG too: no `rx`/`ry`, no `<circle>` used as
 * chrome. Circles appear only inside the abstract app mark where they read as
 * drawing, not as UI geometry.
 */

export interface IconProps {
  size?: number;
  className?: string;
  title?: string;
}

const box = (size: number) => ({ width: size, height: size, display: 'block' as const });

/* ---------------------------------------------------------------------------
 * App mark — an original "signal tower over a message slip" glyph.
 * Yellow chip, black keyline, era-appropriate. Used in title bars and banners.
 * ------------------------------------------------------------------------ */
export function AppMark({ size = 16, className, title }: IconProps) {
  return (
    <svg viewBox="0 0 16 16" style={box(size)} className={className} aria-hidden={!title}>
      {title ? <title>{title}</title> : null}
      <rect x="0" y="0" width="16" height="16" fill="#FFCC00" />
      <rect x="0" y="0" width="16" height="1" fill="#FFE680" />
      <rect x="0" y="0" width="1" height="16" fill="#FFE680" />
      <rect x="0" y="15" width="16" height="1" fill="#8A6D00" />
      <rect x="15" y="0" width="1" height="16" fill="#8A6D00" />
      {/* message slip */}
      <rect x="2" y="7" width="12" height="7" fill="#FFFFFF" />
      <rect x="2" y="7" width="12" height="1" fill="#8A6D00" />
      <path d="M2 8 L8 12 L14 8" fill="none" stroke="#1A1A1A" strokeWidth="1" />
      <rect x="2" y="7" width="12" height="7" fill="none" stroke="#1A1A1A" strokeWidth="1" />
      {/* broadcast arcs */}
      <path d="M5 5 A4 4 0 0 1 11 5" fill="none" stroke="#1A1A1A" strokeWidth="1.4" />
      <path
        d="M3 3.5 A6.5 6.5 0 0 1 13 3.5"
        fill="none"
        stroke="#1A1A1A"
        strokeWidth="1.2"
        opacity="0.75"
      />
      <rect x="7" y="4" width="2" height="2" fill="#1A1A1A" />
    </svg>
  );
}

/* ---------------------------------------------------------------------------
 * Buddy glyph — a generic 12px head-and-shoulders card, the way a 2003 address
 * book drew a contact. Deliberately monochrome and identical for every buddy:
 * there is no presence, so this glyph never varies by availability (SPEC.md §7).
 * ------------------------------------------------------------------------ */
export function BuddyGlyph({ size = 12, className, title }: IconProps) {
  return (
    <svg viewBox="0 0 12 12" style={box(size)} className={className} aria-hidden={!title}>
      {title ? <title>{title}</title> : null}
      <rect x="0" y="0" width="12" height="12" fill="#FFFFFF" stroke="#7A7A6A" />
      <rect x="4" y="2" width="4" height="4" fill="#5B6B8C" />
      <path d="M2 11 L2 9 Q2 7 6 7 Q10 7 10 9 L10 11 Z" fill="#5B6B8C" />
    </svg>
  );
}

/** Buddy glyph variant for contacts that are no longer reachable. */
export function BuddyGlyphInactive({ size = 12, className, title }: IconProps) {
  return (
    <svg viewBox="0 0 12 12" style={box(size)} className={className} aria-hidden={!title}>
      {title ? <title>{title}</title> : null}
      <rect x="0" y="0" width="12" height="12" fill="#F2F2F2" stroke="#A8A89A" />
      <rect x="4" y="2" width="4" height="4" fill="#A0A0A0" />
      <path d="M2 11 L2 9 Q2 7 6 7 Q10 7 10 9 L10 11 Z" fill="#A0A0A0" />
      <path d="M1 11 L11 1" stroke="#B00000" strokeWidth="1.4" />
    </svg>
  );
}

/* ---------------------------------------------------------------------------
 * Group expander — triangle when open, plus/minus box when the tree style is
 * "classic". Both are provided; BuddyGroup picks via a prop.
 * ------------------------------------------------------------------------ */
export function ExpanderTriangle({ open, size = 11 }: { open: boolean; size?: number }) {
  return (
    <svg viewBox="0 0 11 11" style={box(size)} aria-hidden="true">
      {open ? (
        <path d="M1.5 3.5 L9.5 3.5 L5.5 8.5 Z" fill="#2A2A2A" />
      ) : (
        <path d="M3.5 1.5 L8.5 5.5 L3.5 9.5 Z" fill="#2A2A2A" />
      )}
    </svg>
  );
}

export function ExpanderBox({ open, size = 11 }: { open: boolean; size?: number }) {
  return (
    <svg viewBox="0 0 11 11" style={box(size)} aria-hidden="true">
      <rect x="0.5" y="0.5" width="10" height="10" fill="#FFFFFF" stroke="#6B6B5C" />
      <rect x="2" y="5" width="7" height="1" fill="#000000" />
      {!open ? <rect x="5" y="2" width="1" height="7" fill="#000000" /> : null}
    </svg>
  );
}

/* --- Title bar controls (drawn, never font glyphs — fonts vary by machine) - */
export function GlyphMinimize() {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      <rect x="2" y="6" width="6" height="2" fill="currentColor" />
    </svg>
  );
}

export function GlyphMaximize({ restored }: { restored?: boolean }) {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      {restored ? (
        <>
          <rect
            x="3"
            y="1"
            width="6"
            height="5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
          />
          <rect
            x="1"
            y="4"
            width="6"
            height="5"
            fill="#1A5EC8"
            stroke="currentColor"
            strokeWidth="1.4"
          />
        </>
      ) : (
        <>
          <rect
            x="1"
            y="1"
            width="8"
            height="8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
          />
          <rect x="1" y="1" width="8" height="2.4" fill="currentColor" />
        </>
      )}
    </svg>
  );
}

export function GlyphClose() {
  return (
    <svg viewBox="0 0 10 10" width="10" height="10" aria-hidden="true">
      <path
        d="M2 2 L8 8 M8 2 L2 8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="square"
      />
    </svg>
  );
}

/** Checkmark used by Checkbox and by checked menu items. */
export function GlyphCheck({ size = 9 }: { size?: number }) {
  return (
    <svg viewBox="0 0 9 9" style={box(size)} aria-hidden="true">
      <path
        d="M1 4.5 L3.5 7 L8 1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="square"
      />
    </svg>
  );
}

export function GlyphSelectArrow() {
  return (
    <svg viewBox="0 0 7 4" width="7" height="4" aria-hidden="true">
      <path d="M0 0 L7 0 L3.5 4 Z" fill="#000000" />
    </svg>
  );
}

/* --- Message-log glyphs --------------------------------------------------- */

/** Paperclip for attachments. Hard-angled, not a smooth modern clip. */
export function GlyphAttachment({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 12 12" style={box(size)} aria-hidden="true">
      <path
        d="M8.5 3 L8.5 8.5 A2.5 2.5 0 0 1 3.5 8.5 L3.5 2.5 A1.5 1.5 0 0 1 6.5 2.5 L6.5 8"
        fill="none"
        stroke="#3A3A3A"
        strokeWidth="1.3"
      />
    </svg>
  );
}

/** Speaker for voice notes. */
export function GlyphVoice({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 12 12" style={box(size)} aria-hidden="true">
      <path d="M1 4.5 L3.5 4.5 L6.5 2 L6.5 10 L3.5 7.5 L1 7.5 Z" fill="#3A3A3A" />
      <path d="M8 4 A3 3 0 0 1 8 8" fill="none" stroke="#3A3A3A" strokeWidth="1.2" />
    </svg>
  );
}

/** Handset for call notices. */
export function GlyphCall({ size = 12 }: { size?: number }) {
  return (
    <svg viewBox="0 0 12 12" style={box(size)} aria-hidden="true">
      <path
        d="M2 2 L4.5 2 L5.5 4.5 L4 5.5 A5 5 0 0 0 6.5 8 L7.5 6.5 L10 7.5 L10 10 A1 1 0 0 1 9 11 A9 9 0 0 1 1 3 A1 1 0 0 1 2 2 Z"
        fill="#004A7A"
      />
    </svg>
  );
}

/** Sticker placeholder mark. */
export function GlyphSticker({ size = 24 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" style={box(size)} aria-hidden="true">
      <rect x="2" y="2" width="20" height="20" fill="#FFFFFF" stroke="#8A8A7A" />
      <path d="M16 2 L22 8 L16 8 Z" fill="#D8D4C2" stroke="#8A8A7A" />
      <rect x="6" y="10" width="3" height="3" fill="#5B6B8C" />
      <rect x="15" y="10" width="3" height="3" fill="#5B6B8C" />
      <path d="M6 16 L12 19 L18 16" fill="none" stroke="#5B6B8C" strokeWidth="1.5" />
    </svg>
  );
}

/** Tombstone / deleted-message mark. */
export function GlyphTombstone({ size = 11 }: { size?: number }) {
  return (
    <svg viewBox="0 0 11 11" style={box(size)} aria-hidden="true">
      <rect x="1" y="2" width="9" height="7" fill="#EDEDED" stroke="#8A8A8A" />
      <path d="M2.5 4.5 L8.5 4.5 M2.5 6.5 L6.5 6.5" stroke="#B0B0B0" strokeWidth="1" />
      <path d="M0.5 10.5 L10.5 0.5" stroke="#8A8A8A" strokeWidth="1" />
    </svg>
  );
}

/**
 * Security warning mark — a hard-edged shield with an exclamation. Used by
 * SecurityNotice. Deliberately the loudest glyph in the set: SPEC.md §8 says
 * security outranks retro authenticity.
 */
export function GlyphSecurity({ size = 22 }: { size?: number }) {
  return (
    <svg viewBox="0 0 22 22" style={box(size)} aria-hidden="true">
      <path d="M11 1 L20 4 L20 11 Q20 18 11 21 Q2 18 2 11 L2 4 Z" fill="#A80000" stroke="#5A0000" />
      <path d="M11 3 L18 5.3 L18 11 Q18 16.6 11 19 Q4 16.6 4 11 L4 5.3 Z" fill="#D42020" />
      <rect x="10" y="6" width="2" height="8" fill="#FFFFFF" />
      <rect x="10" y="15" width="2" height="2" fill="#FFFFFF" />
    </svg>
  );
}

/** Pencil for the typing indicator. Typing is a protocol event, not presence. */
export function GlyphTyping({ size = 11 }: { size?: number }) {
  return (
    <svg viewBox="0 0 11 11" style={box(size)} aria-hidden="true">
      <path d="M1 10 L2 7 L8 1 L10 3 L4 9 Z" fill="#FFCC00" stroke="#6B6B5C" strokeWidth="0.9" />
      <path d="M8 1 L10 3" stroke="#6B6B5C" strokeWidth="0.9" />
      <path d="M1 10 L2.6 9.4" stroke="#3A3A3A" strokeWidth="1" />
    </svg>
  );
}

/** Status-bar resize grip (three diagonal pip rows). */
export function GlyphGrip() {
  return (
    <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
      {[
        [9, 2],
        [9, 5],
        [6, 5],
        [9, 8],
        [6, 8],
        [3, 8],
      ].map(([x, y], i) => (
        <g key={i}>
          <rect x={x} y={y} width="2" height="2" fill="#FFFFFF" />
          <rect x={x} y={y} width="1.4" height="1.4" fill="#808080" />
        </g>
      ))}
    </svg>
  );
}
