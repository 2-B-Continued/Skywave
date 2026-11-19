"""lab.py - the Advanced "receiver lab": validated settings plus the extra signal processing they drive.

Everything here is optional and off by default, so the simple radio behaves exactly as before.
"""
import json
import math
import os

import numpy as np
from scipy import signal

AUDIO_FS = 48000

# name: (default, kind, a, b)   kind: bool | num(min,max) | enum(options)
SCHEMA = {
    # --- front end
    "tuner_agc": (False, "bool"),            # the tuner chip's own gain loop (RTL AGC)
    "offset_tuning": (False, "bool"),        # avoids the centre spike on R820T tuners
    "direct_mode": ("auto", "enum", ("auto", "off", "i", "q")),
    "iq_swap": (False, "bool"),              # mirror the spectrum (inverts sidebands)
    "dc_block": (True, "bool"),
    "iq_balance": (False, "bool"),           # correct gain/phase imbalance between I and Q
    "iq_gain_db": (0.0, "num", -3.0, 3.0), "iq_phase_deg": (0.0, "num", -15.0, 15.0),   # manual I/Q correction (on top of the blind one)
    "nb_guard": (1, "num", 0, 16),           # samples blanked either side of an impulse
    # --- demodulator
    "nb_on": (False, "bool"), "nb_level": (6.0, "num", 2.0, 30.0),
    "agc_mode": ("default", "enum", ("default", "off", "fast", "medium", "slow", "custom")),
    "agc_attack_ms": (5.0, "num", 1.0, 500.0), "agc_decay_ms": (300.0, "num", 10.0, 5000.0), "agc_hang_ms": (0.0, "num", 0.0, 3000.0),
    "am_det": ("env", "enum", ("env", "sam", "sam_u", "sam_l")), "pll_hz": (40.0, "num", 5.0, 300.0),
    "afc": (False, "bool"), "afc_range": (5000.0, "num", 500.0, 20000.0),
    "sq_mode": ("level", "enum", ("level", "noise", "ctcss", "dcs")), "sq_quiet": (40.0, "num", 0.0, 100.0),
    "sq_tone": (0.0, "num", 0.0, 260.0), "sq_dcs": ("", "str", 6),
    "tones": (True, "bool"), "dtmf": (True, "bool"),
    "agc_target": (0.22, "num", 0.05, 0.6), "agc_max_db": (24.0, "num", 0.0, 60.0),
    "notch_on": (False, "bool"), "notch_hz": (1000.0, "num", 50.0, 9000.0), "notch_q": (20.0, "num", 2.0, 80.0),
    "auto_notch": (False, "bool"),
    "hpf_hz": (0.0, "num", 0.0, 2000.0), "lpf_hz": (0.0, "num", 0.0, 15000.0),
    "nr_on": (False, "bool"), "nr_db": (12.0, "num", 3.0, 30.0),
    "bass_db": (0.0, "num", -12.0, 12.0), "treble_db": (0.0, "num", -12.0, 12.0), "boost_db": (0.0, "num", -12.0, 24.0),
    "limiter": (True, "bool"),
    "comp_on": (False, "bool"), "comp_thr": (-24.0, "num", -60.0, 0.0), "comp_ratio": (3.0, "num", 1.0, 20.0),
    "comp_attack": (10.0, "num", 1.0, 200.0), "comp_release": (250.0, "num", 20.0, 3000.0), "comp_makeup": (6.0, "num", 0.0, 30.0),
    "eq_on": (False, "bool"), "eq60": (0.0, "num", -15.0, 15.0), "eq250": (0.0, "num", -15.0, 15.0), "eq1k": (0.0, "num", -15.0, 15.0),
    "eq3k": (0.0, "num", -15.0, 15.0), "eq8k": (0.0, "num", -15.0, 15.0),
    "gate_on": (False, "bool"), "gate_db": (-50.0, "num", -90.0, -10.0),
    "route": ("normal", "enum", ("normal", "mono", "left", "right", "swap")),
    "udp_on": (False, "bool"), "udp_host": ("127.0.0.1", "str", 64), "udp_port": (7355, "num", 1, 65535), "udp_rate": (48000, "enum", (48000, 24000, 16000, 8000)),
    "zoom_span": (12000, "enum", (1500, 3000, 6000, 12000, 24000, 46000)),
    "ref_db": (0.0, "num", -200.0, 200.0),      # level calibration: added to every dBFS reading to show dBm
    "fm_stereo": (True, "bool"), "fm_rds": (True, "bool"),        # FM broadcast: stereo decoding, station name and text
    "squelch_hang": (0.4, "num", 0.0, 5.0), "squelch_hyst": (2.0, "num", 0.0, 10.0),   # how long and how far the gate stays open
    "cw_pitch": (700.0, "num", 300.0, 1200.0), "ssb_shift": (0.0, "num", -1000.0, 1000.0),
    # --- spectrum display
    "nfft": (4096, "enum", (1024, 2048, 4096, 8192, 16384)),
    "window": ("hann", "enum", ("hann", "hamming", "blackman", "blackmanharris", "flattop", "kaiser", "rect")),
    "avg": (6, "num", 1, 16), "fps": (10, "enum", (5, 10, 20)),
    "decim": ("peak", "enum", ("peak", "mean")),
}
DEFAULTS = {k: v[0] for k, v in SCHEMA.items()}


def validate(patch, base=None):
    """Return (clean_settings, changed_keys). Unknown keys and bad values are ignored."""
    cur = dict(base or DEFAULTS)
    changed = set()
    for k, v in (patch or {}).items():
        spec = SCHEMA.get(k)
        if not spec:
            continue
        kind = spec[1]
        try:
            if kind == "bool":
                nv = bool(v)
            elif kind == "str":
                nv = "".join(ch for ch in str(v) if ch.isalnum() or ch in ".-:_")[:spec[2]]
            elif kind == "num":
                nv = float(v)
                if not (nv == nv) or nv in (float("inf"), float("-inf")):
                    continue
                nv = min(max(nv, spec[2]), spec[3])
                if isinstance(spec[0], int):
                    nv = int(round(nv))
            else:
                nv = type(spec[2][0])(v)
                if nv not in spec[2]:
                    continue
        except (TypeError, ValueError):
            continue
        if cur.get(k) != nv:
            cur[k] = nv
            changed.add(k)
    return cur, changed


def load(path):
    try:
        with open(path) as f:
            return validate(json.load(f))[0]
    except (OSError, ValueError, AttributeError):
        return dict(DEFAULTS)


def save(path, lab):
    try:
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(lab, f)
        os.replace(tmp, path)
    except OSError:
        pass


# ------------------------------------------------------------------------------------ IQ stage
def iq_manual(iq, gain_db, phase_deg):
    """Fixed I/Q correction: scale Q and remove the part of I leaking into it at the given phase error."""
    g = 10 ** (gain_db / 20.0)
    ph = math.radians(phase_deg)
    i, q = iq.real, iq.imag * g
    q = (q - i * math.sin(ph)) / math.cos(ph)
    return (i + 1j * q).astype(np.complex64)


def noise_blank(iq, level, guard=1):
    """Impulse noise blanker: samples much stronger than the typical level (ignition, power-line and
    switching spikes) are replaced by the neighbouring sample, with a little guard either side."""
    mag = np.abs(iq)
    med = float(np.median(mag)) + 1e-9
    bad = mag > level * med
    if not bad.any():
        return iq, 0
    for k in range(1, int(guard) + 1):
        bad = bad | np.roll(bad, k) | np.roll(bad, -k)
    out = iq.copy()
    idx = np.flatnonzero(~bad)
    if len(idx) < 2:
        return iq, 0
    bi = np.flatnonzero(bad)
    out[bi] = np.interp(bi, idx, iq.real[idx]) + 1j * np.interp(bi, idx, iq.imag[idx])
    return out.astype(np.complex64), int(bad.sum())


def iq_balance(iq):
    """Remove the mirror image caused by unequal I/Q gain and phase (a blind estimate from the block's statistics)."""
    i, q = iq.real, iq.imag
    pi_, pq = float(np.mean(i * i)) + 1e-12, float(np.mean(q * q)) + 1e-12
    q = q * np.sqrt(pi_ / pq)
    rho = float(np.mean(i * q)) / pi_
    q = q - rho * i
    pq2 = float(np.mean(q * q)) + 1e-12
    q = q * np.sqrt(pi_ / pq2)
    return (i + 1j * q).astype(np.complex64)


def make_window(name, n):
    w = {"hann": lambda: signal.windows.hann(n, sym=False), "hamming": lambda: signal.windows.hamming(n, sym=False),
         "blackman": lambda: signal.windows.blackman(n, sym=False), "blackmanharris": lambda: signal.windows.blackmanharris(n, sym=False),
         "flattop": lambda: signal.windows.flattop(n, sym=False), "kaiser": lambda: signal.windows.kaiser(n, 8.0, sym=False),
         "rect": lambda: np.ones(n)}.get(name, lambda: signal.windows.hann(n, sym=False))()
    return np.asarray(w, dtype=np.float32)


# ------------------------------------------------------------------------------------ audio stage
class Sos:
    def __init__(self, sos):
        self.sos = sos
        self.zi = np.zeros((sos.shape[0], 2))

    def process(self, x):
        y, self.zi = signal.sosfilt(self.sos, x, zi=self.zi)
        return y.astype(np.float32)


def _shelf(fs, f0, gain_db, high):
    """RBJ low/high shelf biquad as an SOS row."""
    A = 10 ** (gain_db / 40.0)
    w0 = 2 * np.pi * f0 / fs
    cw, sw = np.cos(w0), np.sin(w0)
    al = sw / 2 * np.sqrt(2)
    sa = 2 * np.sqrt(A) * al
    if high:
        b0, b1, b2 = A * ((A + 1) + (A - 1) * cw + sa), -2 * A * ((A - 1) + (A + 1) * cw), A * ((A + 1) + (A - 1) * cw - sa)
        a0, a1, a2 = (A + 1) - (A - 1) * cw + sa, 2 * ((A - 1) - (A + 1) * cw), (A + 1) - (A - 1) * cw - sa
    else:
        b0, b1, b2 = A * ((A + 1) - (A - 1) * cw + sa), 2 * A * ((A - 1) - (A + 1) * cw), A * ((A + 1) - (A - 1) * cw - sa)
        a0, a1, a2 = (A + 1) + (A - 1) * cw + sa, -2 * ((A - 1) + (A + 1) * cw), (A + 1) + (A - 1) * cw - sa
    return np.array([[b0 / a0, b1 / a0, b2 / a0, 1.0, a1 / a0, a2 / a0]])


def _peak(fs, f0, gain_db, q):
    """RBJ peaking EQ biquad as an SOS row."""
    A = 10 ** (gain_db / 40.0)
    w0 = 2 * np.pi * min(f0, fs * 0.45) / fs
    al = np.sin(w0) / (2 * q)
    b0, b1, b2 = 1 + al * A, -2 * np.cos(w0), 1 - al * A
    a0, a1, a2 = 1 + al / A, -2 * np.cos(w0), 1 - al / A
    return np.array([[b0 / a0, b1 / a0, b2 / a0, 1.0, a1 / a0, a2 / a0]])


class AudioFx:
    """Post-demodulation audio chain: notch, auto-notch, filters, noise reduction, tone, boost, limiter."""

    def __init__(self, lab):
        self.lab = dict(lab)
        fs = AUDIO_FS
        L = self.lab
        self.notch = Sos(np.array([[*signal.iirnotch(L["notch_hz"], L["notch_q"], fs)[0], 1.0, *signal.iirnotch(L["notch_hz"], L["notch_q"], fs)[1][1:]]])) if L["notch_on"] else None
        self.hpf = Sos(signal.butter(4, L["hpf_hz"] / (fs / 2), "high", output="sos")) if L["hpf_hz"] > 0 else None
        self.lpf = Sos(signal.butter(4, min(L["lpf_hz"], fs / 2 * 0.95) / (fs / 2), "low", output="sos")) if L["lpf_hz"] > 0 else None
        self.bass = Sos(_shelf(fs, 150.0, L["bass_db"], False)) if abs(L["bass_db"]) > 0.05 else None
        self.treb = Sos(_shelf(fs, 3500.0, L["treble_db"], True)) if abs(L["treble_db"]) > 0.05 else None
        self.gain = 10 ** (L["boost_db"] / 20.0)
        bands = [(60.0, "eq60", 0.9), (250.0, "eq250", 1.0), (1000.0, "eq1k", 1.0), (3000.0, "eq3k", 1.0), (8000.0, "eq8k", 0.9)]
        rows = [_peak(fs, f, L[k], q) for f, k, q in bands if L.get("eq_on") and abs(L[k]) > 0.05]
        self.eq = Sos(np.vstack(rows)) if rows else None
        self.comp_env = 0.0
        self.gate_g = 1.0
        # adaptive (LMS) auto-notch: predicts and removes steady tones such as heterodyne whistles
        self.anc_w = np.zeros(32, dtype=np.float64)
        self.anc_buf = np.zeros(32 + 8, dtype=np.float64)
        # spectral-subtraction noise reduction state
        self.nfft = 512
        self.win = np.sqrt(signal.windows.hann(self.nfft, sym=False)).astype(np.float32)
        self.noise = None
        self.emin = None
        self.tail = np.zeros(self.nfft // 2, dtype=np.float32)
        self.ola = np.zeros(self.nfft // 2, dtype=np.float32)
        self.pend = np.zeros(0, dtype=np.float32)
        self.active = bool(self.notch or self.hpf or self.lpf or self.bass or self.treb or L["nr_on"] or L["auto_notch"]
                           or abs(L["boost_db"]) > 0.05 or self.eq or L.get("comp_on") or L.get("gate_on"))

    # ---- LMS: the delayed input predicts the periodic part; the error is what is left
    def _auto_notch(self, x):
        n, d = 32, 8
        w, mu = self.anc_w, 0.002
        buf = np.concatenate([self.anc_buf, x.astype(np.float64)])
        out = np.empty(len(x))
        for i in range(len(x)):
            ref = buf[i:i + n][::-1]            # samples delayed by d relative to the current one
            y = float(w @ ref)
            e = buf[i + n + d - 1] - y
            nrm = float(ref @ ref) + 1e-4
            w += (mu * 8) * e * ref / nrm
            out[i] = e
        self.anc_buf = buf[-(n + d):] if len(buf) >= n + d else buf
        return out

    def _nr(self, x):
        """Spectral subtraction with 50% overlap; the noise floor is tracked as the running minimum."""
        N, H = self.nfft, self.nfft // 2
        data = np.concatenate([self.pend, x])
        out = []
        pos = 0
        over = 10 ** (-self.lab["nr_db"] / 20.0)
        while len(data) - pos >= N:
            seg = data[pos:pos + N] * self.win
            S = np.fft.rfft(seg)
            mag = np.abs(S)
            e = float(np.mean(mag * mag)) + 1e-12
            self.emin = e if self.emin is None else min(e, self.emin * 1.01)
            if self.noise is None:
                self.noise = mag.copy()
            elif e < 2.5 * self.emin:                      # a quiet frame: learn the noise from it
                self.noise = 0.92 * self.noise + 0.08 * mag
            g = np.maximum(1.0 - 1.9 * self.noise / (mag + 1e-9), over)
            y = np.fft.irfft(S * g, N).astype(np.float32) * self.win
            out.append(self.ola + y[:H])
            self.ola = y[H:]
            pos += H
        self.pend = data[pos:]
        if not out:
            return np.zeros(len(x), dtype=np.float32)
        o = np.concatenate(out)
        # keep the output the same length as the input (a fixed latency of one frame)
        if len(o) < len(x):
            o = np.concatenate([np.zeros(len(x) - len(o), dtype=np.float32), o])
        return o[-len(x):] if len(o) > len(x) else o

    def _env(self, x, att_ms, rel_ms, state):
        """Peak envelope follower, run on 1 ms blocks so it costs almost nothing."""
        blk = 48
        n = len(x) // blk * blk
        pk = np.abs(x[:n]).reshape(-1, blk).max(axis=1) if n else np.zeros(0)
        a, r = math.exp(-1.0 / max(att_ms, 0.1)), math.exp(-1.0 / max(rel_ms, 0.1))
        env = np.empty(len(pk))
        e = state
        for i, v in enumerate(pk.tolist()):
            e = a * e + (1 - a) * v if v > e else r * e + (1 - r) * v
            env[i] = e
        full = np.repeat(env, blk) if len(env) else np.zeros(0)
        if len(full) < len(x):
            full = np.concatenate([full, np.full(len(x) - len(full), e)])
        return full.astype(np.float32), e

    def _comp(self, x):
        L = self.lab
        env, self.comp_env = self._env(x, L["comp_attack"], L["comp_release"], self.comp_env)
        lvl = 20 * np.log10(env + 1e-6)
        over = np.maximum(lvl - L["comp_thr"], 0.0)
        g_db = -over * (1.0 - 1.0 / L["comp_ratio"]) + L["comp_makeup"]
        return (x * (10 ** (g_db / 20.0))).astype(np.float32)

    def _gate(self, x):
        """Noise gate: opens in about a millisecond when the sound rises above the threshold, closes over ~60 ms."""
        env, self.gate_env = self._env(x, 1.0, 80.0, getattr(self, "gate_env", 0.0))
        want = (20 * np.log10(env + 1e-9) > self.lab["gate_db"]).astype(np.float64)
        a = math.exp(-1.0 / (0.06 * AUDIO_FS))
        g, self.gate_zi = signal.lfilter([1 - a], [1, -a], want, zi=getattr(self, "gate_zi", np.array([a * self.gate_g])))
        g = np.maximum(g, want * 0.98)                      # instant open
        self.gate_zi = np.array([a * g[-1]]) if len(g) else self.gate_zi
        return (x * g).astype(np.float32)

    def process(self, a):
        if not self.active or not len(a):
            return a
        x = a.astype(np.float32)
        if self.hpf:
            x = self.hpf.process(x)
        if self.lpf:
            x = self.lpf.process(x)
        if self.notch:
            x = self.notch.process(x)
        if self.lab["auto_notch"]:
            x = self._auto_notch(x).astype(np.float32)
        if self.lab["nr_on"]:
            x = self._nr(x)
        if self.bass:
            x = self.bass.process(x)
        if self.treb:
            x = self.treb.process(x)
        if self.eq:
            x = self.eq.process(x)
        if self.lab.get("gate_on"):
            x = self._gate(x)
        if self.lab.get("comp_on"):
            x = self._comp(x)
        x = x * np.float32(self.gain)
        if self.lab["limiter"]:
            x = np.tanh(x * 0.9).astype(np.float32) / np.float32(np.tanh(0.9))
        return np.clip(x, -1.0, 1.0)
