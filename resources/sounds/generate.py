#!/usr/bin/env python3
"""
Generate the three UI sounds for the retro IM client.

ALL AUDIO HERE IS SYNTHESIZED FROM SCRATCH with the Python standard library.
Nothing is sampled, extracted, downloaded, or derived from AOL/AIM (or any
other) recordings. The waveforms below are plain math: sines, triangles,
squares and pseudo-random noise, shaped by short envelopes.

Per SPEC.md §9 there are exactly three sounds, and they are message-driven
only. SPEC.md §7 forbids presence, so there are deliberately no sign-on,
sign-off, or buddy-in/buddy-out sounds -- they would be unusable.

    receive.wav   bright, attention-getting, slightly startling
    send.wav      quiet soft confirmation
    typing.wav    very subtle short tick

Usage:
    python3 generate.py            # write WAVs next to this script, print stats
    python3 generate.py --verify   # only measure the existing files

Requires: Python 3 standard library only (math, wave, struct, random).
No numpy, no scipy, no sox, no ffmpeg.

Tweaking: every parameter that affects taste lives in the CONFIG block or in
the three build_*() functions. Change a number, re-run, listen.
"""

import argparse
import math
import os
import random
import struct
import sys
import wave

SR = 44100          # sample rate, Hz (SPEC: 44.1kHz)
CHANNELS = 1        # mono is fine for UI sounds
SAMPWIDTH = 2       # 16-bit PCM
BIT_CRUSH = 12      # quantize to this many bits for a lo-fi early-2000s edge
SEED = 20030101     # fixed seed -> byte-identical noise on every regeneration

HERE = os.path.dirname(os.path.abspath(__file__))

# --------------------------------------------------------------------------
# CONFIG -- the taste knobs
# --------------------------------------------------------------------------
CONFIG = {
    "receive": {
        "peak": 0.86,       # loud: this one has to cut through
        "note1": 1046.5,    # C6
        "note2": 1567.98,   # G6  (rising fifth reads as "incoming")
        "note3": 2093.0,    # C7  (brief top sparkle)
    },
    "send": {
        "peak": 0.42,       # roughly half the receive level: it is a confirmation
        "note1": 783.99,    # G5
        "note2": 523.25,    # C5  (falling: "gone")
    },
    "typing": {
        "peak": 0.20,       # nearly subliminal
        "tone": 2200.0,
    },
}


# --------------------------------------------------------------------------
# Oscillators -- all generated, none sampled
# --------------------------------------------------------------------------
def sine(freq, t):
    return math.sin(2.0 * math.pi * freq * t)


def triangle(freq, t):
    p = (freq * t) % 1.0
    return 4.0 * abs(p - 0.5) - 1.0


def square(freq, t):
    return 1.0 if (freq * t) % 1.0 < 0.5 else -1.0


def noise(rng):
    return rng.uniform(-1.0, 1.0)


# --------------------------------------------------------------------------
# Envelopes
# --------------------------------------------------------------------------
def env_pluck(t, dur, attack=0.002, tau=0.05, release=0.008):
    """Fast attack, exponential decay, short linear release to exactly zero.

    The release matters: ending a tone mid-cycle produces an audible click,
    which is the single easiest way to make synthesized UI sounds feel cheap.
    """
    if t < 0.0 or t > dur:
        return 0.0
    a = 1.0 if t >= attack else (t / attack)
    d = math.exp(-t / tau)
    r = 1.0
    if t > dur - release:
        r = max(0.0, (dur - t) / release)
    return a * d * r


def env_soft(t, dur, attack=0.010, tau=0.075, release=0.020):
    """Gentler attack for the send sound so it never startles."""
    return env_pluck(t, dur, attack=attack, tau=tau, release=release)


# --------------------------------------------------------------------------
# Buffer helpers
# --------------------------------------------------------------------------
def new_buffer(seconds):
    return [0.0] * int(round(seconds * SR))


def add_tone(buf, start, dur, freq, gain, env, wave_mix):
    """Mix one enveloped tone into buf.

    wave_mix is a list of (oscillator, weight, harmonic_ratio) triples, which
    is how the timbre is built: a sine fundamental plus a little triangle or
    square harmonic gives the plasticky early-2000s system-sound character
    without sounding like a modern soft-synth.
    """
    i0 = int(round(start * SR))
    n = int(round(dur * SR))
    for i in range(n):
        idx = i0 + i
        if idx < 0 or idx >= len(buf):
            continue
        t = i / SR
        e = env(t, dur)
        if e == 0.0:
            continue
        s = 0.0
        for osc, weight, ratio in wave_mix:
            s += weight * osc(freq * ratio, t)
        buf[idx] += s * e * gain


def add_noise_burst(buf, start, dur, gain, rng, lowpass=0.35, env=env_pluck, tau=0.010):
    """Mix a short filtered-noise transient (the 'tick' of a key)."""
    i0 = int(round(start * SR))
    n = int(round(dur * SR))
    prev = 0.0
    for i in range(n):
        idx = i0 + i
        if idx < 0 or idx >= len(buf):
            continue
        t = i / SR
        # one-pole lowpass over white noise -> a duller, more 'wooden' tick
        prev = prev + lowpass * (noise(rng) - prev)
        buf[idx] += prev * env(t, dur, attack=0.0005, tau=tau, release=0.004) * gain


# --------------------------------------------------------------------------
# Post-processing
# --------------------------------------------------------------------------
def normalize(buf, peak):
    """Scale so the loudest sample sits exactly at `peak` (never at 1.0)."""
    m = max(abs(s) for s in buf) if buf else 0.0
    if m == 0.0:
        return buf
    g = peak / m
    return [s * g for s in buf]


def bit_crush(buf, bits=BIT_CRUSH):
    """Quantize to fewer bits. Subtle, but it is the era-correct texture:
    2003 system sounds were small low-bit-depth files."""
    levels = 2 ** (bits - 1)
    return [max(-1.0, min(1.0, round(s * levels) / levels)) for s in buf]


def write_wav(path, buf):
    frames = bytearray()
    for s in buf:
        # hard clamp; normalize() already guarantees headroom, this is a guard
        v = max(-1.0, min(1.0, s))
        frames += struct.pack("<h", int(round(v * 32767.0)))
    with wave.open(path, "wb") as w:
        w.setnchannels(CHANNELS)
        w.setsampwidth(SAMPWIDTH)
        w.setframerate(SR)
        w.writeframes(bytes(frames))


# --------------------------------------------------------------------------
# The three sounds
# --------------------------------------------------------------------------
def build_receive():
    """Bright rising blip. Short, a little startling, cuts through music.

    Three quick ascending tones (C6 -> G6 -> C7) with a tiny square-wave
    harmonic on top, plus a click transient at onset so it reads instantly
    even at low volume.
    """
    c = CONFIG["receive"]
    dur = 0.26
    buf = new_buffer(dur)
    rng = random.Random(SEED)

    bright = [(sine, 1.00, 1.0), (triangle, 0.30, 2.0), (square, 0.07, 3.0)]

    add_noise_burst(buf, 0.000, 0.012, 0.28, rng, lowpass=0.75, tau=0.003)
    add_tone(buf, 0.000, 0.090, c["note1"], 0.85,
             lambda t, d: env_pluck(t, d, attack=0.0015, tau=0.038), bright)
    add_tone(buf, 0.055, 0.120, c["note2"], 0.90,
             lambda t, d: env_pluck(t, d, attack=0.0015, tau=0.045), bright)
    add_tone(buf, 0.110, 0.150, c["note3"], 0.34,
             lambda t, d: env_pluck(t, d, attack=0.0020, tau=0.055), bright)
    return normalize(buf, c["peak"])


def build_send():
    """Soft falling confirmation. Deliberately quieter than receive -- you
    already know you sent it, this is only reassurance."""
    c = CONFIG["send"]
    dur = 0.20
    buf = new_buffer(dur)

    soft = [(sine, 1.00, 1.0), (triangle, 0.16, 2.0)]

    add_tone(buf, 0.000, 0.100, c["note1"], 0.75,
             lambda t, d: env_soft(t, d, attack=0.006, tau=0.045), soft)
    add_tone(buf, 0.048, 0.150, c["note2"], 0.68,
             lambda t, d: env_soft(t, d, attack=0.008, tau=0.060), soft)
    return normalize(buf, c["peak"])


def build_typing():
    """Very subtle short tick -- a keyswitch, not a note. Fires often, so it
    must never become annoying: low level, ~40ms, no pitch to speak of."""
    c = CONFIG["typing"]
    dur = 0.045
    buf = new_buffer(dur)
    rng = random.Random(SEED + 7)

    add_noise_burst(buf, 0.000, 0.030, 0.90, rng, lowpass=0.45, tau=0.006)
    add_tone(buf, 0.000, 0.028, c["tone"], 0.22,
             lambda t, d: env_pluck(t, d, attack=0.0005, tau=0.006, release=0.006),
             [(sine, 1.0, 1.0), (square, 0.10, 2.0)])
    return normalize(buf, c["peak"])


SOUNDS = {
    "receive.wav": build_receive,
    "send.wav": build_send,
    "typing.wav": build_typing,
}


# --------------------------------------------------------------------------
# Verification -- duration / peak / RMS / sample rate / clipping
# --------------------------------------------------------------------------
def measure(path):
    with wave.open(path, "rb") as w:
        nch, sw, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
        raw = w.readframes(n)
    samples = struct.unpack("<%dh" % (len(raw) // 2), raw)
    peak = max(max(samples), -min(samples)) if samples else 0
    rms = math.sqrt(sum(float(s) * s for s in samples) / len(samples)) if samples else 0.0
    clipped = sum(1 for s in samples if s >= 32767 or s <= -32768)
    return {
        "path": path,
        "sample_rate": sr,
        "channels": nch,
        "bit_depth": sw * 8,
        "frames": n,
        "duration_s": n / float(sr),
        "peak": peak / 32768.0,
        "peak_dbfs": (20 * math.log10(peak / 32768.0)) if peak else float("-inf"),
        "rms": rms / 32768.0,
        "rms_dbfs": (20 * math.log10(rms / 32768.0)) if rms else float("-inf"),
        "clipped_samples": clipped,
        "bytes": os.path.getsize(path),
    }


def report(paths):
    ok = True
    hdr = "%-14s %7s %5s %4s %9s %8s %9s %8s %6s" % (
        "file", "rate", "ch", "bits", "dur(s)", "peak", "peak dBFS", "rms dBFS", "clip")
    print(hdr)
    print("-" * len(hdr))
    for p in paths:
        m = measure(p)
        print("%-14s %7d %5d %4d %9.4f %8.4f %9.2f %8.2f %6d" % (
            os.path.basename(m["path"]), m["sample_rate"], m["channels"], m["bit_depth"],
            m["duration_s"], m["peak"], m["peak_dbfs"], m["rms_dbfs"], m["clipped_samples"]))
        problems = []
        if m["sample_rate"] != SR:
            problems.append("wrong sample rate")
        if m["duration_s"] >= 1.0:
            problems.append("not well under 1 second")
        if m["clipped_samples"] > 0:
            problems.append("clipping")
        if m["peak"] > 0.95:
            problems.append("peak too hot")
        if m["peak"] < 0.05:
            problems.append("inaudible / near-silent")
        if problems:
            ok = False
            print("    !! " + "; ".join(problems))
    return ok


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--verify", action="store_true",
                    help="measure existing files without regenerating")
    ap.add_argument("--outdir", default=HERE)
    args = ap.parse_args()

    paths = [os.path.join(args.outdir, name) for name in SOUNDS]

    if not args.verify:
        for name, build in SOUNDS.items():
            path = os.path.join(args.outdir, name)
            buf = bit_crush(build())
            write_wav(path, buf)
            print("wrote %s" % path)
        print()

    missing = [p for p in paths if not os.path.exists(p)]
    if missing:
        sys.exit("missing: %s" % ", ".join(missing))

    ok = report(paths)
    if not ok:
        sys.exit("one or more sounds failed validation")
    print("\nall sounds OK")


if __name__ == "__main__":
    main()
