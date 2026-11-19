"""afsk.py - Bell-202 AFSK 1200 baud / AX.25 / APRS decoder (and a modulator for tests
and for the simulator). Pure numpy; aprslib is used for APRS payload parsing when present.
"""
import re
import time
import numpy as np

FS = 48000
BAUD = 1200
SPS = FS // BAUD          # 40 samples per symbol
MARK, SPACE = 1200.0, 2200.0


def crc16_x25(data):
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0x8408 if crc & 1 else crc >> 1
    return crc ^ 0xFFFF


def _addr(call, last=False, h=False):
    call, _, ssid = call.partition("-")
    out = bytearray((ord(c) << 1) for c in call.upper().ljust(6)[:6])
    s = 0x60 | ((int(ssid or 0) & 0xF) << 1) | (0x80 if h else 0) | (1 if last else 0)
    out.append(s)
    return bytes(out)


def build_ax25(src, dest, via, info):
    path = list(via)
    f = _addr(dest) + _addr(src, last=not path)
    for i, v in enumerate(path):
        f += _addr(v, last=(i == len(path) - 1))
    f += bytes([0x03, 0xF0]) + info.encode("latin-1")
    fcs = crc16_x25(f)
    return f + bytes([fcs & 0xFF, fcs >> 8])


def parse_ax25(frame):
    """TNC2 text ('SRC>DEST,VIA*:info') for a CRC-checked frame, or None."""
    if len(frame) < 18:
        return None
    body = frame[:-2]
    calls = []
    i = 0
    while i + 7 <= len(body) and len(calls) < 10:
        a = body[i:i + 7]
        name = "".join(chr(b >> 1) for b in a[:6]).strip()
        ssid = (a[6] >> 1) & 0xF
        calls.append((name + ("-%d" % ssid if ssid else ""), bool(a[6] & 0x80)))
        i += 7
        if a[6] & 1:
            break
    else:
        return None
    if len(calls) < 2 or i + 2 > len(body):
        return None
    ctrl, pid = body[i], body[i + 1]
    if ctrl != 0x03 or pid != 0xF0:
        return None
    info = body[i + 2:].decode("latin-1")
    dest, src = calls[0][0], calls[1][0]
    via = ",".join(c + ("*" if h else "") for c, h in calls[2:])
    return "%s>%s%s:%s" % (src, dest, "," + via if via else "", info)


def modulate(frame, preamble=45, tail=4, sps=float(SPS), amp=0.6, fs=FS):
    """HDLC-frame -> NRZI -> phase-continuous AFSK samples (float32)."""
    bits = []
    flag = [0, 1, 1, 1, 1, 1, 1, 0]
    bits += flag * preamble
    ones = 0
    for byte in frame:
        for k in range(8):
            b = (byte >> k) & 1
            bits.append(b)
            ones = ones + 1 if b else 0
            if ones == 5:
                bits.append(0)
                ones = 0
    bits += flag * tail
    tone, tones = 1, []
    for b in bits:
        if b == 0:
            tone ^= 1
        tones.append(tone)
    n = int(len(tones) * sps)
    idx = np.minimum((np.arange(n) / sps).astype(int), len(tones) - 1)
    freq = np.where(np.array(tones)[idx] == 1, MARK, SPACE)
    phase = np.cumsum(2 * np.pi * freq / fs)
    return (amp * np.sin(phase)).astype(np.float32)


class AfskDecoder:
    """Feed 48 kS/s audio, get decoded TNC2 strings."""

    def __init__(self):
        self.n0 = 0
        self.tail_m = np.zeros(SPS - 1, dtype=np.complex128)
        self.tail_s = np.zeros(SPS - 1, dtype=np.complex128)
        self.phase = 0.0
        self.last_tone = 1
        self.sampled = False
        self.prev_tone = 1
        self.ones = 0
        self.cur = []
        self.in_frame = False
        self.stats = {"frames": 0, "crc_fail": 0}

    def _window_energy(self, x, f, tail):
        n = np.arange(len(x)) + self.n0
        mixed = x * np.exp(-2j * np.pi * f * n / FS)
        ext = np.concatenate((tail, mixed))
        c = np.concatenate(([0], np.cumsum(ext)))
        w = c[SPS:] - c[:-SPS]
        return (w.real ** 2 + w.imag ** 2), ext[-(SPS - 1):]

    def process(self, audio):
        x = np.asarray(audio, dtype=np.float64)
        if not len(x):
            return []
        em, self.tail_m = self._window_energy(x, MARK, self.tail_m)
        es, self.tail_s = self._window_energy(x, SPACE, self.tail_s)
        self.n0 += len(x)
        d = (em - es) / (em + es + 1e-12)
        out = []
        tones = d > 0
        ph, last, samp = self.phase, self.last_tone, self.sampled
        half = SPS / 2.0
        for t in tones.tolist():
            ph += 1.0
            tone = 1 if t else 0
            if tone != last:
                err = ((ph + half) % SPS) - half
                ph -= 0.3 * err
                last = tone
            if ph >= half and not samp:
                samp = True
                bit = 1 if tone == self.prev_tone else 0
                self.prev_tone = tone
                f = self._hdlc(bit)
                if f is not None:
                    out.append(f)
            if ph >= SPS:
                ph -= SPS
                samp = False
        self.phase, self.last_tone, self.sampled = ph, last, samp
        return out

    def _hdlc(self, bit):
        if bit:
            self.ones += 1
            return None
        ones, self.ones = self.ones, 0
        res = None
        if ones >= 7:
            self.cur, self.in_frame = [], False
        elif ones == 6:
            if self.in_frame and len(self.cur) >= 1:
                res = self._finish(self.cur[:-1])
            self.cur, self.in_frame = [], True
        elif ones == 5:
            if self.in_frame:
                self.cur.extend([1] * 5)
        else:
            if self.in_frame:
                self.cur.extend([1] * ones)
                self.cur.append(0)
        if self.in_frame and len(self.cur) > 8 * 400:
            self.cur, self.in_frame = [], False
        return res

    def _finish(self, bits):
        if len(bits) % 8 or len(bits) < 8 * 18:
            return None
        arr = np.array(bits, dtype=np.uint8).reshape(-1, 8)
        data = bytes((arr * (1 << np.arange(8))).sum(axis=1).astype(np.uint8).tolist())
        if crc16_x25(data[:-2]) != (data[-2] | data[-1] << 8):
            self.stats["crc_fail"] += 1
            return None
        self.stats["frames"] += 1
        return parse_ax25(data)


_POS = re.compile(r"[!=/@](?:\d{6}[hz/])?(\d{2})(\d{2}\.\d{2})([NS])(.)(\d{3})(\d{2}\.\d{2})([EW])(.)(.*)", re.S)


def parse_aprs(tnc2):
    """dict with source/path/raw and, when available, lat/lon/symbol/comment/weather."""
    head, _, info = tnc2.partition(":")
    src, _, path = head.partition(">")
    res = {"t": time.time(), "from": src, "path": path, "raw": tnc2, "info": info}
    done = False
    try:
        import aprslib
        p = aprslib.parse(tnc2)
        for k_src, k_dst in (("latitude", "lat"), ("longitude", "lon"), ("altitude", "alt"),
                             ("speed", "speed"), ("course", "course"), ("comment", "comment"),
                             ("symbol", "symbol"), ("symbol_table", "table"), ("format", "format"),
                             ("message_text", "message"), ("addresse", "to"), ("object_name", "object"),
                             ("status", "status")):
            if k_src in p:
                res[k_dst] = p[k_src]
        if p.get("weather"):
            res["weather"] = p["weather"]
        done = "lat" in res or "message" in res or "status" in res or "weather" in res
    except Exception as e:
        res["parse_error"] = str(e)[:80]
    if not done and "lat" not in res:                   # tiny fallback: plain uncompressed positions
        m = _POS.match(info)
        if m:
            la = int(m.group(1)) + float(m.group(2)) / 60.0
            lo = int(m.group(5)) + float(m.group(6)) / 60.0
            res["lat"] = -la if m.group(3) == "S" else la
            res["lon"] = -lo if m.group(7) == "W" else lo
            res["table"], res["symbol"] = m.group(4), m.group(8)
            res["comment"] = m.group(9).strip()
    return res
