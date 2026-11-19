"""datalink.py - text and telemetry decoders that run alongside the radio.

  Acars   aircraft text messages (VHF ACARS: AM, MSK 2400 bit/s)
  Pocsag  pager messages (FSK 512, 1200 or 2400 bit/s, all three tried at once)
  Rs41    weather balloon radiosondes (Vaisala RS41: GFSK 4800 bit/s), with a tracker that keeps each balloon's flight

Each decoder takes the complex baseband of one channel at 48 kHz (see Channel) and returns a list of dicts.
Where the sense of a bit is not certain (which tone is a one, whether data is sent as tone changes, whether the
receiver flips FM), the decoders simply try every possibility and keep whichever one finds a valid frame, so a
mismatch can never silently stop them working. The matching signal generators at the bottom feed the simulator
and the tests.
"""
import math
import time

import numpy as np
from scipy import signal

import dsp

FS = 48000


# ---------------------------------------------------------------------------------------------------- building blocks
class Channel:
    """Cut one narrow channel out of the dongle's IQ: shift it to 0 Hz and decimate to 48 kHz."""

    def __init__(self, fs, freq, half_bw=9000.0):
        self.fs, self.freq = float(fs), float(freq)
        D = int(round(fs / FS))
        if abs(D * FS - fs) > 1:
            raise ValueError("sample rate must be a multiple of 48 kHz")
        self.mixer = dsp.Mixer(fs)
        self.dec = dsp.front_decimator(half_bw, min(half_bw + 9000.0, FS - half_bw), fs, D)

    def process(self, iq, center):
        return self.dec.process(self.mixer.process(iq, self.freq - center))


class Slicer:
    """Soft NRZ in, bits out. Slices at zero (callers remove DC first) and keeps the sampling clock in the middle of
    each bit by nudging it at every transition. With integrate=True each bit is decided by the sum over the whole bit
    (integrate and dump) instead of one sample in its middle, which rides through short noise spikes."""

    def __init__(self, sps, gain=0.18, integrate=False):
        self.sps, self.g, self.integrate = float(sps), gain, integrate
        self.cnt, self.last, self.acc = 0.0, 0, 0.0

    def process(self, x):
        out = []
        sps, half, g, cnt, last, acc = self.sps, self.sps / 2.0, self.g, self.cnt, self.last, self.acc
        ap = out.append
        if not self.integrate:
            for v in x.tolist():
                s = 1 if v > 0.0 else 0
                if s != last:
                    cnt -= g * (cnt - half)
                    last = s
                cnt += 1.0
                if cnt >= sps:
                    cnt -= sps
                    ap(s)
        else:
            # the clock counts from one bit's middle to the next; a bit ends where the count passes half
            for v in x.tolist():
                s = 1 if v > 0.0 else 0
                if s != last:
                    cnt -= g * (cnt - half)
                    last = s
                was = cnt
                cnt += 1.0
                acc += v
                if was < half <= cnt:
                    ap(1 if acc > 0.0 else 0)
                    acc = 0.0
                if cnt >= sps:
                    cnt -= sps
        self.cnt, self.last, self.acc = cnt, last, acc
        return out


class _Dc:
    """Slow running mean removed from a signal (the carrier offset shows up as DC after an FM discriminator)."""

    def __init__(self, tau_samples):
        a = 1.0 / tau_samples
        self.b, self.a = np.array([a]), np.array([1.0, -(1.0 - a)])
        self.zi = np.zeros(1)

    def process(self, x):
        m, self.zi = signal.lfilter(self.b, self.a, x.astype(np.float64), zi=self.zi)
        return (x - m).astype(np.float32)


def _fm(z, prev):
    ext = np.concatenate(([prev], z))
    return np.angle(ext[1:] * np.conj(ext[:-1])).astype(np.float32), z[-1] if len(z) else prev


def _bits_to_bytes_lsb(bits):
    b = np.asarray(bits, dtype=np.uint8)
    n = len(b) // 8
    if n == 0:
        return b""
    return bytes(np.packbits(b[:n * 8].reshape(n, 8)[:, ::-1], axis=1).ravel().tolist())


def _bytes_to_bits_lsb(data):
    return [(c >> i) & 1 for c in data for i in range(8)]


# ---------------------------------------------------------------------------------------------------- ACARS
ACARS_CHANNELS = {"AU": [131.550e6, 131.450e6], "NZ": [131.550e6, 131.450e6], "US": [131.550e6, 130.025e6, 129.125e6, 130.450e6],
                  "EU": [131.725e6, 131.525e6, 131.825e6], "JP": [131.450e6], "default": [131.550e6, 131.725e6]}

ACARS_LABELS = {"_d": "General response, no information", "Q0": "Link test", "H1": "Crew or printer message",
                "SA": "Media advisory", "SQ": "Ground station squitter", "5Z": "Airline downlink", "80": "Airline message",
                "QQ": "Free text", "10": "Out of gate", "11": "Off the ground", "12": "On the ground", "13": "Into the gate",
                "B6": "Flight plan request", "RA": "Printer message", "C1": "Crew message", "4M": "Airline message", "H2": "Weather report"}


def _odd(b):
    return bin(b).count("1") & 1 == 1


def _with_parity(c):
    c &= 0x7F
    return c | (0x80 if not _odd(c) else 0)


def crc_kermit(data, crc=0):
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0x8408 if crc & 1 else crc >> 1
    return crc


_SYNC_ACARS = _bytes_to_bits_lsb([_with_parity(ord("+")), _with_parity(ord("*")), 0x16, 0x16, 0x01])


class Acars:
    """VHF ACARS on one channel. The AM envelope carries MSK at 1200/2400 Hz; mixing it to 1800 Hz and taking the
    instantaneous frequency gives +/-600 Hz per bit."""

    BAUD = 2400
    KEEP = 6000                   # tone bits held (2.5 s): a whole message plus its run-up

    def __init__(self, freq):
        self.freq = freq
        # a fast high-pass, not a slow average: the carrier comes up only a few milliseconds before the data starts
        self.dc = dsp.StatefulSos(signal.butter(2, 500.0 / (FS / 2), "high", output="sos"))
        self.n = 0
        self.lp = dsp.ComplexFir(dsp.lowpass_taps(1900, 2900, FS).astype(np.complex64))
        self.prev = np.complex64(0)
        self.sl = Slicer(FS / self.BAUD, integrate=True)
        self.tones = np.zeros(0, dtype=np.uint8)
        self.base = 0              # absolute index of tones[0]
        self.done = set()          # absolute sync positions already handled
        self.count = 0
        self.level = 0.0

    def process(self, z):
        env = np.abs(z).astype(np.float32)
        self.level = 0.9 * self.level + 0.1 * float(np.mean(env))
        a = self.dc.process(env)
        k = np.arange(len(a)) + self.n
        self.n = (self.n + len(a)) % FS
        y = self.lp.process((a * np.exp(-2j * np.pi * 1800.0 * k / FS)).astype(np.complex64))
        f, self.prev = _fm(y, self.prev)
        bits = self.sl.process(f)
        if not bits:
            return []
        self.tones = np.concatenate((self.tones, np.asarray(bits, dtype=np.uint8)))
        out = self._scan()
        if len(self.tones) > self.KEEP:
            cut = len(self.tones) - self.KEEP
            self.tones = self.tones[cut:]
            self.base += cut
            self.done = {d for d in self.done if d >= self.base}
        return out

    def _hyps(self):
        t = self.tones
        d = np.empty_like(t)
        d[0] = 1
        d[1:] = (t[1:] == t[:-1])
        return (t, 1 - t, d, 1 - d)

    def _scan(self):
        out = []
        sync = np.array(_SYNC_ACARS, dtype=np.int8) * 2 - 1
        for h in self._hyps():
            if len(h) < len(sync) + 100:
                continue
            s = h.astype(np.int8) * 2 - 1
            c = np.correlate(s, sync, "valid")
            # one wrong bit in the sync is allowed: the CRC still has to pass, so this finds more bursts without false ones
            for i in np.nonzero(c >= len(sync) - 2)[0].tolist():
                absi = i + self.base
                if absi in self.done:
                    continue
                r = self._parse(h, i + len(sync))
                if r == "more":
                    continue                       # message still arriving
                self.done.add(absi)
                if r:
                    self.count += 1
                    out.append(r)
        return out

    def _parse(self, bits, start):
        chars = []
        pos = start
        end = None
        while True:
            if pos + 8 > len(bits):
                return "more" if len(chars) < 240 else None
            b = int(np.packbits(bits[pos:pos + 8][::-1])[0])
            pos += 8
            chars.append(b)
            if len(chars) > 240:
                return None
            c = b & 0x7F
            if len(chars) >= 13 and c in (0x03, 0x17):
                end = len(chars)
                break
        if pos + 16 > len(bits):
            return "more"
        bcs = _bits_to_bytes_lsb(bits[pos:pos + 16])
        body = bytes(chars)
        crc_ok = crc_kermit(body + bcs) == 0
        bad = [i for i, b in enumerate(body) if not _odd(b)]
        if not crc_ok and len(bad) == 1:
            # one character fails its parity check: one bit in it is wrong, so try each and keep the one the CRC accepts
            for k in range(8):
                fixed = bytearray(body); fixed[bad[0]] ^= 1 << k
                if crc_kermit(bytes(fixed) + bcs) == 0:
                    body, crc_ok, bad = bytes(fixed), True, []
                    chars = list(body)
                    break
        parity_ok = not bad
        if not crc_ok and not parity_ok:
            return None
        t = bytes(c & 0x7F for c in body[:end - 1]).decode("latin-1")
        mode, addr, ack, label, blk = t[0], t[1:8], t[8], t[9:11], t[11]
        text = t[13:] if len(t) > 12 and body[12] & 0x7F == 0x02 else ""
        msgno = flight = ""
        down = blk.isdigit()
        if down and len(text) >= 10:
            msgno, flight, text = text[:4], text[4:10].strip(), text[10:]
        clean = "".join(ch if (32 <= ord(ch) < 127 or ch in "\r\n") else " " for ch in text).replace("\r", "").strip()
        return {"t": time.time(), "freq": self.freq, "mode": mode, "reg": addr.strip(".").strip(), "ack": ack,
                "label": label, "what": ACARS_LABELS.get(label, ""), "block": blk, "dir": "down" if down else "up",
                "msgno": msgno, "flight": flight.replace(" ", ""), "text": clean[:400], "checked": crc_ok}


def acars_message(reg, label, text, flight="", msgno="M01A", mode="2", blk="1", ack="\x15"):
    """The bytes after SOH up to and including BCS, for the generator."""
    addr = reg.rjust(7, ".")[:7]
    body = mode + addr + ack + label + blk + "\x02" + ((msgno + flight.ljust(6)[:6]) if blk.isdigit() else "") + text + "\x03"
    data = bytes(_with_parity(ord(ch)) for ch in body)
    crc = crc_kermit(data)
    return data + bytes([crc & 0xFF, crc >> 8])


def acars_audio(msg_bytes, level=0.8):
    """MSK audio (1200 Hz for a zero, 2400 Hz for a one, phase continuous) for one ACARS burst, at 48 kHz."""
    pre = [0xFF] * 16 + [_with_parity(ord("+")), _with_parity(ord("*")), 0x16, 0x16, 0x01]
    bits = _bytes_to_bits_lsb(pre + list(msg_bytes) + [_with_parity(0x7F)])
    sps = FS // 2400
    f = np.repeat(np.where(np.array(bits) > 0, 2400.0, 1200.0), sps)
    ph = 2 * np.pi * np.cumsum(f) / FS
    return (level * np.sin(ph)).astype(np.float32)


# ---------------------------------------------------------------------------------------------------- POCSAG
POCSAG_SYNC = 0x7CD215D8
POCSAG_IDLE = 0x7A89C197
_BCH_G = 0x769
_NUM = "0123456789*U -)("


def _bch_rem(v31):
    for i in range(30, 9, -1):
        if v31 & (1 << i):
            v31 ^= _BCH_G << (i - 10)
    return v31 & 0x3FF


def pocsag_codeword(info21):
    v = (info21 << 10) | _bch_rem(info21 << 10)
    cw = v << 1
    return cw | (bin(cw).count("1") & 1)


def _cw_ok(cw):
    return _bch_rem(cw >> 1) == 0 and bin(cw).count("1") % 2 == 0


def _cw_fix(cw):
    """Correct up to one wrong bit; None if it cannot be repaired."""
    if _cw_ok(cw):
        return cw
    for i in range(32):
        c = cw ^ (1 << i)
        if _cw_ok(c):
            return c
    return None


class _PocsagRate:
    def __init__(self, baud, freq):
        self.baud, self.freq = baud, freq
        self.lp = dsp.StatefulSos(signal.butter(2, min(0.95, baud * 0.9 / (FS / 2)), "low", output="sos"))
        self.sl = Slicer(FS / baud)
        self.reg = 0
        self.inv = None            # None: hunting for sync; 0/1: in a batch with that polarity
        self.cw = []
        self.bitn = 0
        self.cur = None
        self.miss = 0

    def feed(self, soft, out):
        for b in self.sl.process(self.lp.process(soft)):
            self.reg = ((self.reg << 1) | b) & 0xFFFFFFFF
            if self.inv is None:
                if bin(self.reg ^ POCSAG_SYNC).count("1") <= 2:
                    self.inv, self.bitn, self.cw = 0, 0, []
                elif bin(self.reg ^ (~POCSAG_SYNC & 0xFFFFFFFF)).count("1") <= 2:
                    self.inv, self.bitn, self.cw = 1, 0, []
                continue
            self.bitn += 1
            if self.bitn % 32:
                continue
            w = self.reg ^ (0xFFFFFFFF if self.inv else 0)
            if len(self.cw) == 16:               # this word should be the next batch's sync
                if bin(w ^ POCSAG_SYNC).count("1") <= 3:
                    self.cw = []
                    continue
                self._flush(out)
                self.inv = None
                continue
            self._word(w, len(self.cw), out)
            self.cw.append(w)

    def _word(self, w, idx, out):
        c = _cw_fix(w)
        if c == POCSAG_IDLE or (c is None and bin(w ^ POCSAG_IDLE).count("1") <= 3):
            self._flush(out)
            return
        if c is None:
            if self.cur:
                self.cur["bits"] += [None] * 20
            return
        if not c >> 31:                          # address
            self._flush(out)
            self.cur = {"addr": (((c >> 13) & 0x3FFFF) << 3) | (idx // 2), "func": (c >> 11) & 3, "bits": []}
        elif self.cur:
            self.cur["bits"] += [(c >> (30 - i)) & 1 for i in range(20)]

    def _flush(self, out):
        m, self.cur = self.cur, None
        if not m:
            return
        bits = m["bits"]
        if not bits:
            out.append({"t": time.time(), "freq": self.freq, "baud": self.baud, "addr": m["addr"], "func": m["func"], "kind": "tone", "text": ""})
            return
        alpha = []
        for i in range(0, len(bits) - 6, 7):
            grp = bits[i:i + 7]
            if None in grp:
                alpha.append("?")
                continue
            v = sum(b << k for k, b in enumerate(grp))
            if v:
                alpha.append(chr(v) if 32 <= v < 127 or v == 10 else " ")
        num = []
        for i in range(0, len(bits) - 3, 4):
            grp = bits[i:i + 4]
            num.append("?" if None in grp else _NUM[sum(b << k for k, b in enumerate(grp))])
        a, n = "".join(alpha).rstrip(), "".join(num).rstrip()
        printable = sum(ch.isalnum() or ch in " .,:;-/()'!?@#&+=" for ch in a) / max(1, len(a))
        kind = "alpha" if m["func"] == 3 or (m["func"] != 0 and printable > 0.85) else "numeric"
        text = a if kind == "alpha" else n
        if kind == "alpha" and printable < 0.6:
            return                              # mostly garbage: a false sync
        out.append({"t": time.time(), "freq": self.freq, "baud": self.baud, "addr": m["addr"], "func": m["func"], "kind": kind, "text": text.strip()[:400]})


class Pocsag:
    def __init__(self, freq, flex=True):
        self.freq = freq
        self.prev = np.complex64(0)
        self.dc = _Dc(FS * 0.03)                  # the preamble's even 1010 averages to zero within a few bits
        self.rates = [_PocsagRate(b, freq) for b in (512, 1200, 2400)]
        self.flex = FlexBridge(freq) if flex and FlexBridge.available() else None
        self.count = 0

    def process(self, z):
        d, self.prev = _fm(z, self.prev)
        d = self.dc.process(d)
        out = []
        for r in self.rates:
            r.feed(d, out)
        if self.flex:
            out += self.flex.process(d)
        self.count += len(out)
        return out

    def close(self):
        if self.flex:
            self.flex.close()


class FlexBridge:
    """FLEX pagers, through multimon-ng when it is installed (it is in the Docker image). The discriminator audio is
    resampled to 22050 Hz and piped in; its text lines are read back on a thread."""

    @staticmethod
    def available():
        import shutil
        return shutil.which("multimon-ng") is not None

    def __init__(self, freq):
        import queue
        import subprocess
        import threading
        self.freq = freq
        self.q = queue.Queue()
        self.p = subprocess.Popen(["multimon-ng", "-q", "-t", "raw", "-a", "FLEX", "-"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                  stderr=subprocess.DEVNULL, bufsize=0)

        def pump():
            for line in iter(self.p.stdout.readline, b""):
                self.q.put(line.decode("utf-8", "replace").strip())
        threading.Thread(target=pump, daemon=True).start()

    def process(self, d):
        from scipy.signal import resample_poly
        a = resample_poly(d, 147, 320)            # 48000 -> 22050
        try:
            self.p.stdin.write((np.clip(a * 25000.0, -32767, 32767)).astype("<i2").tobytes())
        except (BrokenPipeError, OSError, ValueError):
            return []
        out = []
        while not self.q.empty():
            m = parse_flex(self.q.get_nowait(), self.freq)
            if m:
                out.append(m)
        return out

    def close(self):
        try:
            self.p.kill()
        except OSError:
            pass


def parse_flex(line, freq):
    """multimon-ng FLEX lines. Two layouts are in use:
         FLEX|2024-01-01 10:00:00|1600/2/K/A|07.120|001234567|ALN|Message text
         FLEX: 2024-01-01 10:00:00 1600/2/K/A 07.120 [001234567] ALN Message text"""
    import re
    if not line.startswith("FLEX"):
        return None
    if "|" in line:
        parts = line.split("|")
        if len(parts) < 7:
            return None
        speed, cap, kind, text = parts[2], parts[4], parts[5], "|".join(parts[6:])
    else:
        m = re.match(r"FLEX:?\s+\S+\s+\S+\s+(\S+)\s+\S+\s+\[(\d+)\]\s+(\w+)\s*(.*)", line)
        if not m:
            return None
        speed, cap, kind, text = m.groups()
    try:
        baud = int(speed.split("/")[0])
    except ValueError:
        baud = 1600
    kind = {"ALN": "alpha", "NUM": "numeric", "TON": "tone"}.get(kind.strip().upper(), "alpha")
    try:
        addr = int(cap.strip())
    except ValueError:
        return None
    return {"t": time.time(), "freq": freq, "baud": baud, "addr": addr, "func": 0, "kind": kind, "text": text.strip()[:400], "proto": "FLEX"}


def pocsag_bits(pages):
    """pages: [(address, func, text)] -> bit list (preamble, then batches). Alphanumeric when func == 3."""
    words = []
    for addr, func, text in pages:
        frame = addr & 7
        while len(words) % 16 != frame * 2:
            words.append(POCSAG_IDLE)
        words.append(pocsag_codeword(((addr >> 3) << 2) | func))
        if func == 3:
            bits = [(ord(ch) >> k) & 1 for ch in text for k in range(7)]
        else:
            bits = [(_NUM.index(ch) >> k) & 1 for ch in text for k in range(4)]
        bits += [0] * (-len(bits) % 20)
        for i in range(0, len(bits), 20):
            v = 0
            for b in bits[i:i + 20]:
                v = (v << 1) | b
            words.append(pocsag_codeword((1 << 20) | v))
        words.append(POCSAG_IDLE)
    while len(words) % 16:
        words.append(POCSAG_IDLE)
    words += [POCSAG_IDLE] * 16
    out = [1 - (i & 1) for i in range(576)]
    for i, w in enumerate(words):
        if i % 16 == 0:
            out += [(POCSAG_SYNC >> (31 - k)) & 1 for k in range(32)]
        out += [(w >> (31 - k)) & 1 for k in range(32)]
    return out


def nrz_audio(bits, baud, level=0.9, smooth=True):
    sps = FS / baud
    idx = (np.arange(int(len(bits) * sps)) / sps).astype(int)
    a = np.where(np.asarray(bits)[idx] > 0, level, -level).astype(np.float32)
    if smooth:
        k = max(1, int(sps / 3))
        a = np.convolve(a, np.ones(k) / k, "same").astype(np.float32)
    return a


# ---------------------------------------------------------------------------------------------------- RS41 radiosondes
RS41_MASK = bytes([
    0x96, 0x83, 0x3E, 0x51, 0xB1, 0x49, 0x08, 0x98, 0x32, 0x05, 0x59, 0x0E, 0xF9, 0x44, 0xC6, 0x26,
    0x21, 0x60, 0xC2, 0xEA, 0x79, 0x5D, 0x6D, 0xA1, 0x54, 0x69, 0x47, 0x0C, 0xDC, 0xE8, 0x5C, 0xF1,
    0xF7, 0x76, 0x82, 0x7F, 0x07, 0x99, 0xA2, 0x2C, 0x93, 0x7C, 0x30, 0x63, 0xF5, 0x10, 0x2E, 0x61,
    0xD0, 0xBC, 0xB4, 0xB6, 0x06, 0xAA, 0xF4, 0x23, 0x78, 0x6E, 0x3B, 0xAE, 0xBF, 0x7B, 0x4C, 0xC1])
RS41_HEAD = bytes([0x10, 0xB6, 0xCA, 0x11, 0x22, 0x96, 0x12, 0xF8])
_RS41_HEAD_BITS = _bytes_to_bits_lsb(bytes(h ^ m for h, m in zip(RS41_HEAD, RS41_MASK)))
_RS41_HEAD_INT = int("".join(map(str, _RS41_HEAD_BITS)), 2)
RS41_STD, RS41_EXT = 320, 518


def crc_ccitt(data, crc=0xFFFF):
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def ecef_to_geo(x, y, z):
    a, f = 6378137.0, 1 / 298.257223563
    b = a * (1 - f)
    e2, ep2 = f * (2 - f), (a * a - b * b) / (b * b)
    p = math.hypot(x, y)
    th = math.atan2(z * a, p * b)
    lat = math.atan2(z + ep2 * b * math.sin(th) ** 3, p - e2 * a * math.cos(th) ** 3)
    lon = math.atan2(y, x)
    n = a / math.sqrt(1 - e2 * math.sin(lat) ** 2)
    alt = p / math.cos(lat) - n if abs(math.cos(lat)) > 1e-9 else abs(z) - b
    return math.degrees(lat), math.degrees(lon), alt


def geo_to_ecef(lat, lon, alt):
    a, f = 6378137.0, 1 / 298.257223563
    e2 = f * (2 - f)
    la, lo = math.radians(lat), math.radians(lon)
    n = a / math.sqrt(1 - e2 * math.sin(la) ** 2)
    return ((n + alt) * math.cos(la) * math.cos(lo), (n + alt) * math.cos(la) * math.sin(lo), (n * (1 - e2) + alt) * math.sin(la))


def _enu(lat, lon, vx, vy, vz):
    la, lo = math.radians(lat), math.radians(lon)
    e = -math.sin(lo) * vx + math.cos(lo) * vy
    n = -math.sin(la) * math.cos(lo) * vx - math.sin(la) * math.sin(lo) * vy + math.cos(la) * vz
    u = math.cos(la) * math.cos(lo) * vx + math.cos(la) * math.sin(lo) * vy + math.sin(la) * vz
    return e, n, u


def rs41_parse(frame):
    """frame: descrambled bytes of one RS41 frame. Returns a dict, or None when nothing useful checks out."""
    d = {}
    pos = 0x39
    while pos + 4 <= len(frame):
        bid, ln = frame[pos], frame[pos + 1]
        if bid == 0x76 or pos + 4 + ln > len(frame):
            break
        data = frame[pos + 2:pos + 2 + ln]
        crc = frame[pos + 2 + ln] | (frame[pos + 3 + ln] << 8)
        if crc_ccitt(data) == crc:
            if bid == 0x79 and ln >= 11:
                d["frame"] = data[0] | (data[1] << 8)
                d["serial"] = data[2:10].decode("ascii", "replace").strip("\x00 ")
                d["batt"] = round(data[10] / 10.0, 1)
            elif bid == 0x7C and ln >= 6:
                week = data[0] | (data[1] << 8)
                tow = int.from_bytes(data[2:6], "little")
                d["gps_t"] = 315964800 + week * 604800 + tow / 1000.0 - 18
            elif bid == 0x7B and ln >= 19:
                x, y, z = (int.from_bytes(data[i:i + 4], "little", signed=True) / 100.0 for i in (0, 4, 8))
                vx, vy, vz = (int.from_bytes(data[i:i + 2], "little", signed=True) / 100.0 for i in (12, 14, 16))
                if x or y or z:
                    lat, lon, alt = ecef_to_geo(x, y, z)
                    e, n, u = _enu(lat, lon, vx, vy, vz)
                    d.update(lat=round(lat, 6), lon=round(lon, 6), alt=round(alt, 1), speed=round(math.hypot(e, n), 1),
                             heading=round(math.degrees(math.atan2(e, n)) % 360, 0), climb=round(u, 1), ve=e, vn=n, sats=data[18])
        pos += ln + 4
    return d if d.get("serial") else None


class Rs41:
    """One RS41 channel."""

    def __init__(self, freq):
        self.freq = freq
        self.prev = np.complex64(0)
        self.dc = _Dc(FS * 0.1)
        self.lp = dsp.StatefulSos(signal.butter(2, 5000.0 / (FS / 2), "low", output="sos"))
        self.sl = Slicer(FS / 4800.0)
        self.reg = 0
        self.inv = None
        self.buf = []
        self.need = 0
        self.frames = 0
        self.last_t = 0.0

    def process(self, z):
        d, self.prev = _fm(z, self.prev)
        d = self.lp.process(self.dc.process(d))
        out = []
        for b in self.sl.process(d):
            if self.inv is not None:
                self.buf.append(b ^ self.inv)
                if len(self.buf) >= self.need:
                    self._frame(out)
                continue
            self.reg = ((self.reg << 1) | b) & 0xFFFFFFFFFFFFFFFF
            # the header arrives LSB-first per byte; compare bit-reversed against the shift register
            if bin(self.reg ^ _RS41_HEAD_INT).count("1") <= 3:
                self.inv, self.buf, self.need = 0, list(_RS41_HEAD_BITS), RS41_STD * 8
            elif bin(self.reg ^ (~_RS41_HEAD_INT & 0xFFFFFFFFFFFFFFFF)).count("1") <= 3:
                self.inv, self.buf, self.need = 1, list(_RS41_HEAD_BITS), RS41_STD * 8
        return out

    def _frame(self, out):
        raw = _bits_to_bytes_lsb(self.buf)
        fr = bytes(c ^ RS41_MASK[i % 64] for i, c in enumerate(raw))
        if self.need == RS41_STD * 8 and len(fr) > 0x38 and fr[0x38] == 0xF0:
            self.need = RS41_EXT * 8            # extended frame: keep reading
            return
        self.inv, self.buf, self.reg = None, [], 0
        r = rs41_parse(fr)
        if r:
            self.frames += 1
            self.last_t = time.time()
            r["freq"] = self.freq
            r["t"] = time.time()
            r["type"] = "RS41"
            out.append(r)


def rs41_frame(serial, frame_no, lat, lon, alt, ve=0.0, vn=0.0, vu=0.0, batt=2.9, t=None):
    """A standard 320-byte RS41 frame (before scrambling) for the generator and tests."""
    fr = bytearray(RS41_STD)
    fr[0:8] = RS41_HEAD
    fr[0x38] = 0x0F

    def block(pos, bid, data):
        fr[pos], fr[pos + 1] = bid, len(data)
        fr[pos + 2:pos + 2 + len(data)] = data
        c = crc_ccitt(data)
        fr[pos + 2 + len(data)], fr[pos + 3 + len(data)] = c & 0xFF, c >> 8
        return pos + 4 + len(data)
    st = bytearray(40)
    st[0:2] = frame_no.to_bytes(2, "little")
    st[2:10] = serial.encode("ascii")[:8].ljust(8, b"\x00")
    st[10] = int(round(batt * 10))
    p = block(0x39, 0x79, bytes(st))
    p = block(p, 0x7A, bytes(42))
    t = time.time() if t is None else t
    g = t + 18 - 315964800
    week, tow = int(g // 604800), int((g % 604800) * 1000)
    p = block(p, 0x7C, week.to_bytes(2, "little") + tow.to_bytes(4, "little") + bytes(24))
    p = block(p, 0x7D, bytes(89))                 # raw GPS measurements (not decoded); keeps the real frame layout
    x, y, z = geo_to_ecef(lat, lon, alt)
    la, lo = math.radians(lat), math.radians(lon)
    vx = -math.sin(lo) * ve - math.sin(la) * math.cos(lo) * vn + math.cos(la) * math.cos(lo) * vu
    vy = math.cos(lo) * ve - math.sin(la) * math.sin(lo) * vn + math.cos(la) * math.sin(lo) * vu
    vz = math.cos(la) * vn + math.sin(la) * vu
    gp = b"".join(int(round(v * 100)).to_bytes(4, "little", signed=True) for v in (x, y, z))
    gp += b"".join(int(round(v * 100)).to_bytes(2, "little", signed=True) for v in (vx, vy, vz))
    gp += bytes([9, 30, 15])
    p = block(p, 0x7B, gp)
    if p + 2 <= RS41_STD - 2:
        block(p, 0x76, bytes(RS41_STD - p - 4))
    return bytes(fr)


def rs41_bits(frame):
    return _bytes_to_bits_lsb(bytes(c ^ RS41_MASK[i % 64] for i, c in enumerate(frame)))


# ---------------------------------------------------------------------------------------------------- balloon tracking
class SondeTracker:
    """Keeps every balloon heard: its path, highest point, and (once it falls) a rough landing estimate."""

    def __init__(self):
        self.sondes = {}
        self.changed = False

    def add(self, fr, home):
        s = self.sondes.get(fr["serial"])
        if s is None:
            s = self.sondes[fr["serial"]] = {"serial": fr["serial"], "type": fr.get("type", "RS41"), "track": [], "max_alt": -1e9,
                                             "first": fr["t"], "frames": 0, "burst": False}
        s["frames"] += 1
        s["seen"] = fr["t"]
        s["freq"] = fr["freq"]
        for k in ("frame", "batt", "sats", "gps_t"):
            if k in fr:
                s[k] = fr[k]
        if "lat" in fr:
            for k in ("lat", "lon", "alt", "speed", "heading", "climb"):
                s[k] = fr[k]
            if not s["track"] or fr["t"] - s["track"][-1][3] >= 2.0:
                s["track"].append([fr["lat"], fr["lon"], round(fr["alt"]), round(fr["t"], 1)])
                if len(s["track"]) > 4000:
                    s["track"] = s["track"][::2]
            if fr["alt"] > s["max_alt"]:
                s["max_alt"] = fr["alt"]
            if s["max_alt"] - fr["alt"] > 300 and fr["climb"] < -2:
                s["burst"] = True
            s["land"] = self._landing(fr, home)
            if home:
                dist, brg = _dist_brg(home[0], home[1], fr["lat"], fr["lon"])
                s["dist"], s["brg"] = round(dist, 1), round(brg)
        self.changed = True
        return s

    @staticmethod
    def _landing(fr, home):
        """Straight-line guess: keep falling at today's rate and drifting with today's wind. Rough, and labelled so."""
        if fr.get("climb", 0) > -1.0:
            return None
        ground = home[2] if home and len(home) > 2 and home[2] is not None else 0.0
        secs = max(0.0, (fr["alt"] - ground) / -fr["climb"])
        if secs > 3 * 3600:
            return None
        k = 0.6                                   # winds weaken lower down; don't carry today's speed all the way
        lat = fr["lat"] + fr["vn"] * secs * k / 111320.0
        lon = fr["lon"] + fr["ve"] * secs * k / (111320.0 * max(0.1, math.cos(math.radians(fr["lat"]))))
        d = {"lat": round(lat, 5), "lon": round(lon, 5), "in_s": int(secs)}
        if home:
            d["dist"] = round(_dist_brg(home[0], home[1], lat, lon)[0], 1)
        return d

    def public(self, max_pts=300):
        out = []
        now = time.time()
        for s in sorted(self.sondes.values(), key=lambda x: -x["seen"]):
            d = {k: v for k, v in s.items() if k != "track"}
            tr = s["track"]
            step = max(1, len(tr) // max_pts)
            d["track"] = tr[::step] + ([tr[-1]] if tr and (len(tr) - 1) % step else [])
            d["age"] = round(now - s["seen"], 0)
            out.append(d)
        return out


def _dist_brg(la1, lo1, la2, lo2):
    p1, p2, dl = math.radians(la1), math.radians(la2), math.radians(lo2 - lo1)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    d = 2 * 6371.0 * math.asin(min(1.0, math.sqrt(a)))
    b = math.degrees(math.atan2(math.sin(dl) * math.cos(p2), math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl))) % 360
    return d, b


def gpx(sonde):
    pts = "".join('<trkpt lat="%.6f" lon="%.6f"><ele>%d</ele><time>%s</time></trkpt>' % (p[0], p[1], p[2], time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(p[3])))
                  for p in sonde.get("track", []))
    name = sonde.get("serial", "balloon")
    return ('<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Skywave" xmlns="http://www.topografix.com/GPX/1/1">'
            '<trk><name>%s</name><trkseg>%s</trkseg></trk></gpx>\n' % (name, pts))
