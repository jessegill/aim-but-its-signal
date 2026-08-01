/**
 * QrCode — renders a linking URI as a scannable QR symbol.
 *
 * SVG rather than canvas: it is resolution-independent, it scales to whatever box the sign-on
 * window gives it, and every module lands on an exact coordinate so nothing blurs at the
 * boundaries the way a scaled bitmap does. Scanners are unforgiving about that.
 *
 * The white quiet zone is part of the symbol, not decoration — four modules on every side, as
 * the standard requires. Without it many phone cameras will not lock on.
 *
 * Encoding is done by ./qr.ts, which is pure computation: no network, no filesystem, nothing
 * that would violate SPEC.md §3.
 */

import * as React from 'react';

import { encodeQr, type QrEcc } from './qr';

export interface QrCodeProps {
  /** The `sgnl://linkdevice?…` URI supplied by the main process. */
  value: string;
  /**
   * Error-correction level. M is the sensible default for a screen: it tolerates glare and a
   * camera at an angle without inflating the symbol the way Q or H would.
   */
  ecc?: QrEcc;
  /** Quiet-zone width in modules. Four is the standard minimum; do not reduce it. */
  quietZone?: number;
  /** Fallback rendered if the value cannot be encoded at all. */
  fallback?: React.ReactNode;
  className?: string;
}

export function QrCode({
  value,
  ecc = 'M',
  quietZone = 4,
  fallback = null,
  className,
}: QrCodeProps): React.ReactElement | null {
  const symbol = React.useMemo(() => {
    try {
      return encodeQr(value, ecc);
    } catch {
      // Only reachable for absurdly long input. Degrade to the caller's fallback (the sign-on
      // window shows the URI as selectable text) rather than blanking the window.
      return null;
    }
  }, [value, ecc]);

  if (symbol === null) return <>{fallback}</>;

  const dim = symbol.size + quietZone * 2;
  let path = '';
  for (let y = 0; y < symbol.size; y++) {
    for (let x = 0; x < symbol.size; x++) {
      if (symbol.modules[y][x]) path += `M${x + quietZone} ${y + quietZone}h1v1h-1z`;
    }
  }

  return (
    <svg
      className={className}
      viewBox={`0 0 ${dim} ${dim}`}
      width="100%"
      height="100%"
      // Keeps module edges on whole device pixels; anti-aliased edges cost scans.
      shapeRendering="crispEdges"
      role="img"
      aria-label="Device linking code"
    >
      <rect width={dim} height={dim} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  );
}
