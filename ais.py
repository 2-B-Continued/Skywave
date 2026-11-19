"""ais.py - AIS (ship transponder) decoder for 161.975 / 162.025 MHz.

Input is the FM discriminator audio at 48 kHz (9600 baud GMSK = 5 samples per bit). Bits go through NRZI and HDLC
de-framing with CRC-16 checking, then the common message types are unpacked. Pure numpy, no outside tools.
"""
import time

import numpy as np
from scipy import signal

FS = 48000
BAUD = 9600
SPS = FS // BAUD
SIX = "@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^- !\"#$%&'()*+,-./0123456789:;<=>?"


def crc16(bits):
    crc = 0xFFFF
    for b in bits:
        crc = (crc >> 1) ^ 0x8408 if (crc ^ b) & 1 else crc >> 1
    return crc


def _uint(bits, a, n):
    v = 0
    for b in bits[a:a + n]:
        v = (v << 1) | b
    return v


def _int(bits, a, n):
    v = _uint(bits, a, n)
    return v - (1 << n) if v >= 1 << (n - 1) else v


def _text(bits, a, n):
    s = "".join(SIX[_uint(bits, a + i, 6)] for i in range(0, n, 6) if a + i + 6 <= len(bits))
    return s.replace("@", " ").strip()


def to_message_bits(rx_bits):
    """Bits arrive least-significant first in each byte; fields are most-significant first."""
    out = []
    for i in range(0, len(rx_bits) - 7, 8):
        out.extend(reversed(rx_bits[i:i + 8]))
    return out


def parse(bits):
    """bits: payload in field order (CRC removed). Returns a dict, or None for types we do not use."""
    if len(bits) < 38:
        return None
    t = _uint(bits, 0, 6)
    mmsi = _uint(bits, 8, 30)
    r = {"type": t, "mmsi": mmsi}
    if t in (1, 2, 3) and len(bits) >= 144:
        lon, lat = _int(bits, 61, 28) / 600000.0, _int(bits, 89, 27) / 600000.0
        sog = _uint(bits, 50, 10)
        r.update(status=_uint(bits, 38, 4), sog=None if sog == 1023 else sog / 10.0, cog=_uint(bits, 116, 12) / 10.0,
                 heading=_uint(bits, 128, 9))
        if abs(lon) <= 180 and abs(lat) <= 90:
            r.update(lon=lon, lat=lat)
    elif t == 5 and len(bits) >= 232:
        r.update(callsign=_text(bits, 70, 42), name=_text(bits, 112, 120), shiptype=_uint(bits, 232, 8) if len(bits) >= 240 else 0,
                 dest=_text(bits, 302, 120) if len(bits) >= 422 else "")
    elif t in (18, 19) and len(bits) >= 168:
        lon, lat = _int(bits, 57, 28) / 600000.0, _int(bits, 85, 27) / 600000.0
        sog = _uint(bits, 46, 10)
        r.update(sog=None if sog == 1023 else sog / 10.0, cog=_uint(bits, 112, 12) / 10.0)
        if abs(lon) <= 180 and abs(lat) <= 90:
            r.update(lon=lon, lat=lat)
        if t == 19 and len(bits) >= 312:
            r["name"] = _text(bits, 143, 120)
    elif t == 24 and len(bits) >= 160 and _uint(bits, 38, 2) == 0:
        r["name"] = _text(bits, 40, 120)
    else:
        return None
    return r


SHIP_TYPES = {3: "Special", 5: "Special", 6: "Passenger", 7: "Cargo", 8: "Tanker", 3 * 10: "Fishing"}


def ship_kind(code):
    d = (code or 0) // 10
    return {3: "Special craft", 4: "High-speed craft", 5: "Special craft", 6: "Passenger", 7: "Cargo", 8: "Tanker", 9: "Other"}.get(d, "")


class AisDecoder:
    def __init__(self):
        self.mean = 0.0
        self.zi = np.zeros(3)
        self.cnt = 0.0
        self.last = 0
        self.prev_s = 0.0
        self.bits = []              # NRZI-decoded bit history since the last flag
        self.nrzi_prev = 0
        self.vessels = {}
        self.frames = 0
        self.crc_bad = 0
        self.changed = False
        self._ones = 0

    def process(self, audio):
        """audio: float32 discriminator audio at 48 kHz. Returns decoded message dicts."""
        out = []
        if len(audio) == 0:
            return out
        a, self.zi = signal.lfilter(np.ones(4) / 4.0, 1.0, np.clip(audio, -1.5, 1.5).astype(np.float64), zi=self.zi)   # clipped: between bursts the discriminator is only noise spikes
        # light smoothing: noise makes false edges
        thr = np.empty(len(a))
        m = self.mean
        for i, x in enumerate(a.tolist()):                  # slicing level = slow average of the signal (the carrier offset)
            m += 0.0025 * (x - m)
            thr[i] = m
        self.mean = m
        for x, t in zip(a.tolist(), thr.tolist()):
            s = 1 if x > t else 0
            if s != self.last:
                # transition: nudge the sampling clock so we sample in the middle of the bit
                err = self.cnt - SPS / 2.0
                self.cnt -= 0.2 * err
                self.last = s
            self.cnt += 1.0
            if self.cnt >= SPS:
                self.cnt -= SPS
                self._bit(s, out)
        return out

    def _bit(self, s, out):
        b = 1 if s == self.nrzi_prev else 0       # NRZI: no change = 1
        self.nrzi_prev = s
        if b:
            self._ones += 1
            self.bits.append(1)
            if self._ones > 12:                     # too long a run of ones: not a frame
                self.bits = []
            return
        ones, self._ones = self._ones, 0
        if ones == 6:                               # flag 01111110: a frame ended (and the next may begin)
            body = self.bits[:-7] if len(self.bits) >= 7 else []
            self.bits = []
            self._frame(body, out)
            return
        if ones == 5:                               # stuffed zero: drop it
            return
        self.bits.append(0)
        if len(self.bits) > 1100:
            self.bits = []

    def _frame(self, body, out):
        if len(body) < 40 + 16 or len(body) > 1100:
            return
        # the frame begins after the preamble/flag: body holds everything since the previous flag
        if crc16(body) != 0xF0B8:
            self.crc_bad += 1
            return
        self.frames += 1
        msg = parse(to_message_bits(body[:-16]))
        if msg:
            self._update(msg)
            out.append(msg)

    def _update(self, m):
        v = self.vessels.setdefault(m["mmsi"], {"mmsi": m["mmsi"]})
        for k in ("lat", "lon", "sog", "cog", "heading", "name", "callsign", "dest", "shiptype", "status"):
            if m.get(k) is not None and m.get(k) != "":
                v[k] = m[k]
        v["last"] = time.time()
        v["msgs"] = v.get("msgs", 0) + 1
        self.changed = True
        if len(self.vessels) > 600:
            for k in sorted(self.vessels, key=lambda x: self.vessels[x]["last"])[:100]:
                del self.vessels[k]

    def public(self):
        now = time.time()
        rows = []
        for v in sorted(self.vessels.values(), key=lambda x: -x["last"])[:120]:
            r = dict(v)
            r["age"] = int(now - v["last"])
            r["kind"] = ship_kind(v.get("shiptype"))
            rows.append(r)
        return rows


# ---------------------------------------------------------------- encoder (used by the simulator and the tests)
def _bits(v, n):
    return [(v >> (n - 1 - i)) & 1 for i in range(n)]


def _six(s, n):
    s = s.upper().ljust(n // 6, "@")[:n // 6]
    out = []
    for c in s:
        out += _bits(SIX.index(c), 6)
    return out


def encode_position(mmsi, lat, lon, sog, cog, heading=511):
    return (_bits(1, 6) + _bits(0, 2) + _bits(mmsi, 30) + _bits(0, 4) + _bits(128, 8) + _bits(int(sog * 10), 10) + [1]
            + _bits(int(round(lon * 600000)) & (2 ** 28 - 1), 28) + _bits(int(round(lat * 600000)) & (2 ** 27 - 1), 27)
            + _bits(int(cog * 10), 12) + _bits(heading, 9) + _bits(30, 6) + _bits(0, 2) + _bits(0, 3) + [0] + _bits(0, 19))


def encode_static(mmsi, callsign, name, shiptype):
    b = (_bits(5, 6) + _bits(0, 2) + _bits(mmsi, 30) + _bits(0, 2) + _bits(9000000, 30) + _six(callsign, 42) + _six(name, 120)
         + _bits(shiptype, 8))
    return (b + [0] * 424)[:424]


def frame_bits(msg_bits):
    rx = []
    for i in range(0, len(msg_bits), 8):
        rx += list(reversed(msg_bits[i:i + 8]))
    c = crc16(rx) ^ 0xFFFF
    rx += [(c >> i) & 1 for i in range(16)]
    st, ones = [], 0
    for b in rx:
        st.append(b)
        ones = ones + 1 if b else 0
        if ones == 5:
            st.append(0)
            ones = 0
    flag = [0, 1, 1, 1, 1, 1, 1, 0]
    return [0, 1] * 12 + flag + st + flag + [0] * 8


def modulate(bits, level=0.6, offset=0.0):
    """Discriminator-level audio for a frame: NRZI, Gaussian-shaped, 5 samples per bit."""
    from scipy import signal as sg
    cur, nr = 0, []
    for b in bits:
        if b == 0:
            cur ^= 1
        nr.append(cur)
    x = np.repeat(np.array(nr) * 2.0 - 1.0, SPS)
    g = sg.windows.gaussian(11, 2.2)
    g /= g.sum()
    return (np.convolve(x, g, mode="same") * level + offset).astype(np.float32)
