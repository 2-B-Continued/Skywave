"""prolab.py - the deeper end of the Lab.

  Tones       CTCSS (sub-audible tone) and DCS (digital code) detection on NFM, and DTMF keypad tones on any audio
  Sam         synchronous AM: locks to the carrier instead of following the envelope (less fading distortion), with
              a choice of both sidebands, upper only or lower only
  ZoomScope   a fine spectrum of the tuned channel (a few hertz per point), a precise frequency counter, and short
              I/Q snapshots for the scopes in the Lab
  ChanRecorder   records just the tuned channel as 48 kHz I/Q (a small file, unlike a full-band recording)
  UdpAudio    sends the demodulated sound to another program on the network (raw 16-bit PCM over UDP)
"""
import math
import socket
import time
import wave

import numpy as np
from scipy import signal

import dsp

FS = 48000

CTCSS = [67.0, 69.3, 71.9, 74.4, 77.0, 79.7, 82.5, 85.4, 88.5, 91.5, 94.8, 97.4, 100.0, 103.5, 107.2, 110.9, 114.8, 118.8, 123.0,
         127.3, 131.8, 136.5, 141.3, 146.2, 151.4, 156.7, 159.8, 162.2, 165.5, 167.9, 171.3, 173.8, 177.3, 179.9, 183.5, 186.2, 189.9,
         192.8, 196.6, 199.5, 203.5, 206.5, 210.7, 218.1, 225.7, 229.1, 233.6, 241.8, 250.3, 254.1]
DCS_CODES = [int(c, 8) for c in (
    "023 025 026 031 032 036 043 047 051 053 054 065 071 072 073 074 114 115 116 122 125 131 132 134 143 145 152 155 156 162 165 "
    "172 174 205 212 223 225 226 243 244 245 246 251 252 255 261 263 265 266 271 274 306 311 315 325 331 332 343 346 351 356 364 365 "
    "371 411 412 413 423 431 432 445 446 452 454 455 462 464 465 466 503 506 516 523 526 532 546 565 606 612 624 627 631 632 654 "
    "662 664 703 712 723 731 732 734 743 754").split()]
DTMF_ROWS, DTMF_COLS = (697.0, 770.0, 852.0, 941.0), (1209.0, 1336.0, 1477.0, 1633.0)
DTMF_KEYS = ["123A", "456B", "789C", "*0#D"]


# ---------------------------------------------------------------------------------------------------- DCS words
def _golay_parity(info12):
    v = info12 << 11
    for i in range(22, 10, -1):
        if v & (1 << i):
            v ^= 0xC75 << (i - 11)
    return v & 0x7FF


def dcs_word(code):
    """The 23-bit word for an octal DCS code: 9 code bits, the fixed 100, then 11 Golay parity bits (sent first-bit-first
    from the least significant end)."""
    info = code | (0b100 << 9)
    return info | (_golay_parity(info) << 12)


def _rot(w, k, n=23):
    return ((w >> k) | (w << (n - k))) & ((1 << n) - 1)


def _rev(w, n=23):
    return int(format(w, "0%db" % n)[::-1], 2)


_DCS_TABLE = {}
# Several codes share words once rotated or inverted (DCS has "equivalent" codes), so normal-polarity names are
# entered first and win; the receiver's FM polarity is not known, so inverted forms are matched too.
for _tag, _inv, _r in (("N", False, False), ("I", True, False), ("N", False, True), ("I", True, True)):
    for _c in DCS_CODES:
        _w = dcs_word(_c)
        _w = (~_w & 0x7FFFFF) if _inv else _w
        _w = _rev(_w) if _r else _w
        for _k in range(23):
            _DCS_TABLE.setdefault(_rot(_w, _k), "D%03o%s" % (_c, _tag))


def dcs_bits(code, n_words=6, invert=False):
    w = dcs_word(code)
    bits = [(w >> i) & 1 for i in range(23)] * n_words
    return [1 - b for b in bits] if invert else bits


# ---------------------------------------------------------------------------------------------------- tones
class Tones:
    """Watches the audio for squelch tones and keypad tones. ctcss/dcs read the raw NFM discriminator (the receiver's
    voice filter removes everything under 300 Hz); dtmf reads the demodulated audio."""

    def __init__(self):
        self.dec = dsp.FirDecimator(dsp.lowpass_taps(300.0, 560.0, FS, 50.0, mult=40), 40)    # 48 kHz -> 1200 Hz
        self.lf = np.zeros(0, dtype=np.float32)
        self.n_lf = 0
        n = 1440                                                           # 1.2 s at 1200 Hz
        t = np.arange(n) / 1200.0
        self.win = np.hanning(n).astype(np.float32)
        self.bank = np.exp(-2j * np.pi * np.outer(CTCSS, t)).astype(np.complex64)
        self.ctcss = None
        self._cand, self._cand_n = None, 0
        self._last_ctcss_t = 0.0
        self.dcs = None
        self._dcs_reg = 0
        self._dcs_hits = {}
        self._dcs_t = 0.0
        self.sl = None
        self._dc = 0.0
        # DTMF: 48 kHz -> 8 kHz, 205-sample Goertzel blocks
        self.dt_dec = dsp.FirDecimator(dsp.lowpass_taps(3400.0, 3900.0, FS, 50.0, mult=6), 6)
        self.dt_buf = np.zeros(0, dtype=np.float32)
        k = np.arange(205)
        self.dt_bank = np.exp(-2j * np.pi * np.outer(DTMF_ROWS + DTMF_COLS, k) / 8000.0).astype(np.complex64)
        self.dt_prev, self.dt_held = None, None
        self.dtmf = ""
        self.dtmf_t = 0.0

    # ---- CTCSS + DCS
    def feed_disc(self, d):
        if d is None or not len(d):
            return
        lf = self.dec.process(d.astype(np.float32))
        self.lf = np.concatenate((self.lf, lf))[-1440:]
        self.n_lf += len(lf)
        self._dcs_feed(lf)
        if self.n_lf >= 600 and len(self.lf) >= 1440:                     # every half second
            self.n_lf = 0
            self._ctcss_check()

    def _ctcss_check(self):
        x = (self.lf - self.lf.mean()) * self.win
        p = np.abs(self.bank @ x) ** 2
        tot = float(np.sum(x * x)) * len(x) / 2 + 1e-12
        i = int(np.argmax(p))
        others = np.delete(p, [j for j in (i - 1, i, i + 1) if 0 <= j < len(p)])
        ok = p[i] > 12 * float(np.median(others)) and p[i] / tot > 0.25
        tone = CTCSS[i] if ok else None
        if tone == self._cand:
            self._cand_n += 1
        else:
            self._cand, self._cand_n = tone, 1
        now = time.time()
        if tone is not None and self._cand_n >= 2:
            self.ctcss = tone
            self._last_ctcss_t = now
        elif now - self._last_ctcss_t > 1.5:
            self.ctcss = None

    def _dcs_feed(self, lf):
        if self.sl is None:
            from datalink import Slicer
            self.sl = Slicer(1200.0 / 134.4, 0.1)
        # remove the slow drift, then slice
        m = signal.lfilter([0.002], [1, -0.998], lf.astype(np.float64))
        bits = self.sl.process((lf - m).astype(np.float32))
        now = time.time()
        for b in bits:
            self._dcs_reg = ((self._dcs_reg << 1) | b) & 0x7FFFFF
            code = _DCS_TABLE.get(self._dcs_reg)
            if code:
                self._dcs_hits[code] = self._dcs_hits.get(code, 0) + 1
                if self._dcs_hits[code] >= 3:
                    self.dcs = code
                    self._dcs_t = now
        if now - self._dcs_t > 1.5:
            self.dcs = None
            self._dcs_hits = {}

    # ---- DTMF
    def feed_audio(self, a):
        if a is None or not len(a):
            return None
        self.dt_buf = np.concatenate((self.dt_buf, self.dt_dec.process(a.astype(np.float32))))
        out = None
        while len(self.dt_buf) >= 205:
            blk, self.dt_buf = self.dt_buf[:205], self.dt_buf[205:]
            key = self._dtmf_block(blk)
            if key and key == self.dt_prev and key != self.dt_held:
                self.dt_held = key
                self.dtmf = (self.dtmf + key)[-32:]
                self.dtmf_t = time.time()
                out = key
            elif key is None and self.dt_prev is None:
                self.dt_held = None
            self.dt_prev = key
        return out

    def _dtmf_block(self, x):
        e = float(np.sum(x * x)) + 1e-12
        if e < 1e-4:
            return None
        p = np.abs(self.dt_bank @ x) ** 2 * (2.0 / 205)
        r, c = p[:4], p[4:]
        ri, ci = int(np.argmax(r)), int(np.argmax(c))
        rs, cs = np.sort(r), np.sort(c)
        if rs[-1] < 6 * rs[-2] or cs[-1] < 6 * cs[-2]:
            return None
        if (r[ri] + c[ci]) < 0.6 * e:
            return None
        twist = 10 * math.log10((c[ci] + 1e-12) / (r[ri] + 1e-12))
        if not -8.0 < twist < 8.0:
            return None
        return DTMF_KEYS[ri][ci]

    def public(self):
        return {"ctcss": self.ctcss, "dcs": self.dcs, "dtmf": self.dtmf, "dtmf_age": round(time.time() - self.dtmf_t, 1) if self.dtmf else None}


def dtmf_audio(keys, on=0.08, off=0.06, level=0.4):
    out = []
    for k in keys:
        r = next(i for i, row in enumerate(DTMF_KEYS) if k in row)
        c = DTMF_KEYS[r].index(k)
        t = np.arange(int(on * FS)) / FS
        out.append(level * (np.sin(2 * np.pi * DTMF_ROWS[r] * t) + np.sin(2 * np.pi * DTMF_COLS[c] * t)))
        out.append(np.zeros(int(off * FS)))
    return np.concatenate(out).astype(np.float32)


# ---------------------------------------------------------------------------------------------------- synchronous AM
class Sam:
    """Synchronous AM. A frequency-locked loop takes out any tuning error, a narrow filter recovers the carrier's
    phase, and the signal is turned by that phase so the audio sits in the real part. Selective fading, which tears
    plain AM apart on shortwave, mostly disappears; the sideband choice dodges a neighbour on one side."""

    def __init__(self, sideband="both", loop_hz=40.0, bw=10000.0):
        self.sideband = sideband
        self.f = 0.0                     # tracked carrier offset, rad/sample
        self.ph = 0.0
        a = 1.0 - math.exp(-2 * math.pi * loop_hz / FS)
        self.cb, self.ca = np.array([a]), np.array([1.0, -(1.0 - a)])
        self.czi = np.zeros(1, dtype=np.complex128)
        self.lock = 0.0
        self.offset_hz = 0.0
        half = max(1500.0, bw / 2.0)
        if sideband in ("upper", "lower"):
            t = dsp.lowpass_taps(half / 2, half / 2 + 600.0, FS).astype(np.float64)
            n = np.arange(len(t)) - (len(t) - 1) / 2.0
            f0 = (half / 2 + 80.0) * (1 if sideband == "upper" else -1)
            self.sb = dsp.ComplexFir(t * np.exp(2j * np.pi * f0 * n / FS))
        else:
            self.sb = None
        self.dc = dsp.StatefulSos(signal.butter(1, 40.0 / (FS / 2), "high", output="sos"))

    def process(self, z):
        if not len(z):
            return np.zeros(0, dtype=np.float32)
        z = z.astype(np.complex64)
        # frequency lock: the carrier dominates an AM signal, so the average phase step is its offset
        d = z[1:] * np.conj(z[:-1])
        step = float(np.angle(d.sum())) if len(d) else 0.0
        self.f += 0.2 * (step - self.f)
        n = len(z)
        ph = self.ph + self.f * np.arange(1, n + 1)
        self.ph = float(ph[-1] % (2 * math.pi))
        zd = z * np.exp(-1j * ph).astype(np.complex64)
        c, self.czi = signal.lfilter(self.cb, self.ca, zd.astype(np.complex128), zi=self.czi)
        cm = np.abs(c) + 1e-9
        y = zd * (np.conj(c) / cm).astype(np.complex64)
        self.lock = float(np.mean(np.abs(np.real(y))) / (np.mean(np.abs(y)) + 1e-9))
        self.offset_hz = self.f * FS / (2 * math.pi)
        if self.sb is not None:
            y = self.sb.process(y.astype(np.complex64)) * 2.0
        a = (np.real(y) / cm - 1.0) * 0.7
        return self.dc.process(a.astype(np.float32))


# ---------------------------------------------------------------------------------------------------- zoom + scope
class ZoomScope:
    def __init__(self, fs):
        self.fs = fs
        self.ch = None
        self.buf = np.zeros(0, dtype=np.complex64)
        self.avg = None
        self.t = 0.0
        self.snap_t = 0.0
        self.N = 16384
        self.win = signal.windows.blackmanharris(self.N, sym=False).astype(np.float32)
        self.win_norm = float(self.win.sum() ** 2)
        self.last_f = None

    def process(self, iq, center, vfo, span, want_zoom, want_scope, emit):
        if self.ch is None or self.ch.fs != self.fs:
            from datalink import Channel
            self.ch = Channel(self.fs, vfo, half_bw=min(22000.0, span / 2 + 2000.0))
        if self.last_f is None or abs(vfo - self.last_f) > 1.0:
            self.avg = None
            self.last_f = vfo
        self.ch.freq = vfo
        z = self.ch.process(iq, center)
        self.buf = np.concatenate((self.buf, z))[-self.N * 2:]
        now = time.monotonic()
        if want_zoom and now - self.t > 0.4 and len(self.buf) >= self.N:
            self.t = now
            x = self.buf[-self.N:] * self.win
            P = np.fft.fftshift(np.abs(np.fft.fft(x)) ** 2) / self.win_norm
            self.avg = P if self.avg is None or len(self.avg) != len(P) else 0.6 * self.avg + 0.4 * P
            db = 10 * np.log10(self.avg + 1e-20)
            rbw = FS / self.N
            half = int(min(span, FS) / 2 / rbw)
            c = self.N // 2
            seg = db[c - half:c + half]
            k = int(np.argmax(seg))
            # parabolic interpolation around the strongest bin: the frequency counter reads to a fraction of a bin
            frac = 0.0
            if 0 < k < len(seg) - 1:
                a, b, cc = seg[k - 1], seg[k], seg[k + 1]
                den = a - 2 * b + cc
                frac = 0.5 * (a - cc) / den if den else 0.0
            off = float((k + float(frac) - half) * rbw)
            pts = 1024
            step = max(1, len(seg) // pts)
            red = seg[:len(seg) // step * step].reshape(-1, step).max(axis=1)
            floor = float(np.percentile(seg, 20))
            emit("zoom", f0=vfo, span=int(2 * half * rbw), rbw=round(rbw, 3), bins=[round(float(v), 1) for v in red],
                 peak_hz=round(float(vfo) + off, 2), peak_db=round(float(seg[k]), 1), floor=round(floor, 1), snr=round(float(seg[k]) - floor, 1))
        if want_scope and now - self.snap_t > 0.25 and len(self.buf) >= 1024:
            self.snap_t = now
            s = self.buf[-768:]
            r = float(np.sqrt(np.mean(np.abs(s) ** 2))) + 1e-9
            s = s / r
            emit("iqsnap", i=[round(float(v), 3) for v in s.real], q=[round(float(v), 3) for v in s.imag], fs=FS, rms_db=round(20 * math.log10(r), 1))


class ChanRecorder:
    """The tuned channel as 48 kHz two-channel (I and Q) 16-bit WAV."""

    def __init__(self, path, fs, freq):
        from datalink import Channel
        self.path = path
        self.ch = Channel(fs, freq, half_bw=20000.0)
        self.w = wave.open(path, "wb")
        self.w.setnchannels(2)
        self.w.setsampwidth(2)
        self.w.setframerate(FS)
        self.n = 0
        self.scale = None

    def write(self, iq, center):
        z = self.ch.process(iq, center)
        if self.scale is None:
            self.scale = 0.25 / (float(np.sqrt(np.mean(np.abs(z) ** 2))) + 1e-9)
        s = np.empty(2 * len(z), dtype=np.float32)
        s[0::2], s[1::2] = z.real * self.scale, z.imag * self.scale
        self.w.writeframes((np.clip(s, -1, 1) * 32767).astype("<i2").tobytes())
        self.n += len(z)

    def close(self):
        try:
            self.w.close()
        except Exception:
            pass
        return self.n / FS


class UdpAudio:
    """Raw signed 16-bit little-endian mono PCM over UDP, like the audio-out of other SDR programs, for feeding
    decoders running elsewhere (for example WSJT-X, fldigi, multimon-ng or dsd)."""

    def __init__(self, host, port, rate=48000):
        self.addr = (host, int(port))
        self.k = max(1, int(FS // int(rate)))
        self.dec = dsp.FirDecimator(dsp.lowpass_taps(0.42 * FS / self.k, 0.5 * FS / self.k, FS, 60.0, mult=self.k), self.k) if self.k > 1 else None
        self.s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sent = 0
        self.err = ""
        self.pend = np.zeros(0, dtype=np.float32)

    def send(self, a):
        if self.dec is not None:
            x = np.concatenate((self.pend, a.astype(np.float32)))
            n = len(x) // self.k * self.k
            self.pend = x[n:]
            a = self.dec.process(x[:n]) if n else np.zeros(0, dtype=np.float32)
        b = (np.clip(a, -1, 1) * 32767).astype("<i2").tobytes()
        try:
            for i in range(0, len(b), 1400):
                self.s.sendto(b[i:i + 1400], self.addr)
            self.sent += len(b)
            self.err = ""
        except OSError as e:
            self.err = str(e)

    def close(self):
        try:
            self.s.close()
        except OSError:
            pass
