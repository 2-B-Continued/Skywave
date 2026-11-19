"""iq_tools.py - quick checks on raw radio recordings (8-bit I/Q WAV files written by the record job)."""
import wave

import numpy as np
from scipy import signal


def _read_segment(path, start_s, secs, max_frames=2_000_000):
    with wave.open(path, "rb") as w:
        fs, n = w.getframerate(), w.getnframes()
        a = int(min(max(start_s, 0), max(0, n / fs - secs)) * fs)
        w.setpos(min(a, max(n - 1, 0)))
        raw = w.readframes(min(int(secs * fs), max_frames))
    d = np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 127.5
    d = d[: len(d) // 2 * 2].reshape(-1, 2)
    return fs, (d[:, 0] + 1j * d[:, 1]).astype(np.complex64)


SIG_BAND = (8e3, 40e3)        # inside the satellite's signal: |offset| from the centre, Hz
GUARD_BAND = (70e3, 95e3)     # just outside it (a Meteor signal is about +-58 kHz wide), where there is only noise


def hump_db(x, fs):
    """How far the satellite-shaped hump stands above the noise next to it, in dB (None if the sample rate is too low).

    Compares the median power 8-40 kHz either side of the centre with the median 70-95 kHz out. A median ignores narrow
    interference lines, and the centre spike of the dongle is skipped. No signal reads about 0 dB; a decodable Meteor
    pass reads roughly 6 dB or more."""
    if fs < 200e3 or len(x) < 4096:
        return None
    f, p = signal.welch(x, fs=fs, nperseg=2048, return_onesided=False, detrend=False)
    f = np.abs(f)
    sig = p[(f >= SIG_BAND[0]) & (f <= SIG_BAND[1])]
    gd = p[(f >= GUARD_BAND[0]) & (f <= GUARD_BAND[1])]
    if len(sig) < 4 or len(gd) < 4:
        return None
    return float(10 * np.log10((np.median(sig) + 1e-12) / (np.median(gd) + 1e-12)))


def hump_level(db):
    return "none" if db is None or db < 1.0 else "weak" if db < 5 else "good" if db < 9 else "strong"


def signal_report(path, segments=8, seg_s=4.0):
    """Was a satellite-like signal in this recording at all?

    Looks at several short slices spread across the pass and keeps the best one.
    Returns {"db": strongest reading, "level": none / weak / good / strong, "series": readings across the pass}."""
    with wave.open(path, "rb") as w:
        dur = w.getnframes() / float(w.getframerate())
    series = []
    for i in range(segments):
        t0 = (dur - seg_s) * (i + 0.5) / segments
        try:
            fs, x = _read_segment(path, t0, seg_s)
        except Exception:
            continue
        v = hump_db(x, fs)
        if v is not None:
            series.append(round(v, 1))
    best = max(series) if series else -99.0
    return {"db": round(best, 1), "level": hump_level(best if series else None), "series": series}
