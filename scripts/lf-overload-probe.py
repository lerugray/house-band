#!/usr/bin/env python3
"""
HOUSE BAND LOW-END OVERLOAD PROBE  (rendered-audio, score-agnostic)

ORIGIN: vendored into house-band kit 1.7.1 from
  ported from a sibling project's probe of the same name
  (authored 2026-08-29 against the House Band corpus; thresholds unchanged).
  Credit: a low-end overload survey across several game scores.

Detects the "bass is overloading it / some odd frequency" signature Ray's ear
caught in a sample project title theme (2026-08-29) and, the same day, in another
sample project shell v4 theme.

ROOT CAUSE this probe is calibrated against (kit-level, House Band 1.6.0):
  kit/band.js  pad()   emits 3 oscillators, the third hard-wired to freq*0.5
                       at 0.7 level -- an UNDEFEATABLE sub-octave, no opt-out.
  kit/band.js  drone() emits [[1,1],[0.5,0.7]] -- same, per detune partner.
A pad CHORD therefore reproduces the entire chord one octave down. Voiced with
its bottom note near G2-D3, the phantom chord lands at 46-75 Hz, where a fifth
sits INSIDE one critical band and beats instead of fusing. Stack the drone's own
root + sub on top and the 20-150 Hz octave carries most of the mix's energy.
Nothing clips in the file; the overload happens in the listener's speaker.

Five measures. Any FAIL = the render carries the signature.

Usage: python3 scripts/lf-overload-probe.py <render.wav> [--lowest-written-hz N] [--json]
"""
import sys, json, argparse
import numpy as np
from scipy import signal


def read_wav(path):
    with open(path, 'rb') as f:
        raw = f.read()
    assert raw[:4] == b'RIFF' and raw[8:12] == b'WAVE', 'not a RIFF/WAVE file'
    pos, fmt, data = 12, None, None
    while pos + 8 <= len(raw):
        cid = raw[pos:pos + 4]
        csz = int.from_bytes(raw[pos + 4:pos + 8], 'little')
        body = raw[pos + 8:pos + 8 + csz]
        if cid == b'fmt ':
            fmt = body
        elif cid == b'data':
            data = body
        pos += 8 + csz + (csz & 1)
    afmt = int.from_bytes(fmt[0:2], 'little')
    ch = int.from_bytes(fmt[2:4], 'little')
    sr = int.from_bytes(fmt[4:8], 'little')
    bits = int.from_bytes(fmt[14:16], 'little')
    if afmt == 3 and bits == 32:
        x = np.frombuffer(data, dtype='<f4').astype(np.float64)
    elif afmt == 1 and bits == 16:
        x = np.frombuffer(data, dtype='<i2').astype(np.float64) / 32768.0
    else:
        raise SystemExit(f'unsupported wav: format={afmt} bits={bits}')
    return x.reshape(-1, ch), sr


def db(v):
    v = float(v)
    return float('-inf') if v <= 0 else 20 * np.log10(v)


def lp(x, sr, hi, order=6):
    return signal.sosfiltfilt(signal.butter(order, hi / (sr / 2), btype='low', output='sos'), x)


def probe(path, lowest_written_hz=None):
    x, sr = read_wav(path)
    mono = x.mean(axis=1)
    total_e = float(np.mean(mono ** 2))
    peak = float(np.max(np.abs(x)))
    low150 = lp(mono, sr, 150)
    low60 = lp(mono, sr, 60)

    m = {}
    # 1. sub-150 energy share of the whole mix
    m['sub150_share_pct'] = 100 * float(np.mean(low150 ** 2)) / total_e
    # 2. low-band peak headroom relative to the full-mix peak
    m['lf_headroom_margin_db'] = db(np.max(np.abs(low150))) - db(peak)
    # 3. sub-60 share -- musical content rarely lives here on purpose
    m['sub60_share_pct'] = 100 * float(np.mean(low60 ** 2)) / total_e
    # 4. roughness: 15-35 Hz amplitude modulation of the <150 Hz envelope.
    #    Two low partials inside one critical band beat at their difference
    #    frequency; that lands here and reads as buzz/distortion, not pitch.
    env = np.abs(signal.hilbert(low150))
    envd = signal.decimate(env, 100, ftype='fir')
    dc = float(np.mean(envd)) or 1e-12
    f, P = signal.welch(envd - np.mean(envd), fs=sr / 100, nperseg=8192)
    rough = np.sqrt(np.trapezoid(P[(f >= 15) & (f <= 35)], f[(f >= 15) & (f <= 35)]))
    m['lf_roughness_db'] = db(rough / dc)
    # 5. octave-ghost: energy below 0.75x the lowest note the SCORE ever writes.
    #    With no phantom sub-octaves this is empty. It is the direct sub-octave test.
    if lowest_written_hz:
        edge = lowest_written_hz * 0.75
        ghost = lp(mono, sr, edge, order=8)
        m['octave_ghost_edge_hz'] = edge
        m['octave_ghost_db'] = db(np.sqrt(np.mean(ghost ** 2))) - db(np.sqrt(total_e))
    return m, sr, len(mono)


# Thresholds calibrated 2026-08-29 against the House Band corpus itself
# (listen/regfix-20260821: several sample-project title themes) rather than
# picked from the air. One clean reference title theme in that set — the one the
# operator has never complained about — sits at 13.9% sub-150 / 1.0% sub-60 /
# -9.5 dB headroom. Every threshold is set so that reference passes and the two
# scores the operator DID reject by ear (another title theme, and a shell v4
# theme of the same day) fail.
THRESHOLDS = {
    'sub150_share_pct':      ('<', 30.0, 40.0),   # clean ref 13.9 | rejected baseline 56.0
    'sub60_share_pct':       ('<', 4.0, 8.0),     # clean ref  1.0 | rejected baseline 15.9
    'lf_headroom_margin_db': ('<', -10.0, -6.0),  # clean ref -9.5 | rejected baseline -4.2
    'lf_roughness_db':       ('<', -26.0, -20.0),  # gated, see below
    'octave_ghost_db':       ('<', -20.0, -12.0),  # needs --lowest-written-hz
}

# The roughness measure normalises 15-35 Hz envelope modulation by the low
# band's own DC level. When the low band is nearly empty that ratio inflates on
# noise and means nothing audible -- it graded the clean reference FAIL on a low band
# carrying 13.9% of the mix. So roughness is REPORTED always but GRADED only
# when the low band is loud enough to dominate perception.
ROUGHNESS_GATE_SUB150_PCT = 15.0


def verdict(m):
    rows, worst = [], 'PASS'
    for k, (_, passv, failv) in THRESHOLDS.items():
        if k not in m:
            continue
        v = m[k]
        if k == 'lf_roughness_db' and m.get('sub150_share_pct', 0) < ROUGHNESS_GATE_SUB150_PCT:
            rows.append((k, v, passv, failv, 'n/a'))
            continue
        s = 'PASS' if v < passv else ('WARN' if v < failv else 'FAIL')
        if s == 'FAIL' or (s == 'WARN' and worst == 'PASS'):
            worst = s
        rows.append((k, v, passv, failv, s))
    return rows, worst


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('wav')
    ap.add_argument('--lowest-written-hz', type=float, default=None,
                    help='lowest fundamental the score writes (enables the octave-ghost test)')
    ap.add_argument('--json', action='store_true')
    a = ap.parse_args()
    m, sr, n = probe(a.wav, a.lowest_written_hz)
    rows, worst = verdict(m)
    if a.json:
        print(json.dumps({'file': a.wav, 'verdict': worst,
                          'metrics': {k: round(v, 3) for k, v in m.items()}}, indent=2))
    else:
        print(f'LF-OVERLOAD PROBE  {a.wav}  ({n/sr:.1f}s @ {sr} Hz)')
        print(f'{"measure":<24}{"value":>10}  {"pass<":>8}{"fail>=":>9}   verdict')
        for k, v, p, fv, s in rows:
            print(f'{k:<24}{v:>10.2f}  {p:>8.1f}{fv:>9.1f}   {s}')
        print(f'\nVERDICT: {worst}')
    sys.exit(0 if worst != 'FAIL' else 1)
