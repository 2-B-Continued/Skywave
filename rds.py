"""rds.py - FM broadcast extras: stereo pilot tracking and RDS (station name, radio text, programme type).

Input is the FM discriminator output ("MPX") at 240 kS/s, scaled so 75 kHz deviation = 1.0.
The 19 kHz pilot is turned into an analytic signal (FIR Hilbert), which gives the exact phase for the
38 kHz stereo carrier (2x) and the 57 kHz RDS carrier (3x) without a slow per-sample PLL loop.
"""
import numpy as np
from scipy import signal

FS = 240000
HB = 63                                  # Hilbert taps (odd); group delay (HB-1)/2 samples
DELAY = (HB - 1) // 2
RDS_BAUD = 1187.5
POLY = 0x5B9                             # x^10 + x^8 + x^7 + x^5 + x^4 + x^3 + 1
OFFSETS = {"A": 0x0FC, "B": 0x198, "C": 0x168, "C'": 0x350, "D": 0x1B4}
PTY_US = ["None", "News", "Information", "Sports", "Talk", "Rock", "Classic rock", "Adult hits", "Soft rock", "Top 40", "Country",
          "Oldies", "Soft", "Nostalgia", "Jazz", "Classical", "R&B", "Soft R&B", "Language", "Religious music", "Religious talk",
          "Personality", "Public", "College", "Spanish talk", "Spanish music", "Hip hop", "", "", "Weather", "Emergency test", "Emergency"]
PTY_EU = ["None", "News", "Current affairs", "Information", "Sport", "Education", "Drama", "Culture", "Science", "Varied", "Pop music",
          "Rock music", "Easy listening", "Light classical", "Serious classical", "Other music", "Weather", "Finance", "Children's",
          "Social affairs", "Religion", "Phone in", "Travel", "Leisure", "Jazz", "Country", "National music", "Oldies", "Folk music",
          "Documentary", "Alarm test", "Alarm"]


def crc10(data16):
    v = data16 << 10
    for i in range(25, 9, -1):
        if v >> i & 1:
            v ^= POLY << (i - 10)
    return v & 0x3FF


def block(data16, name):
    return (data16 << 10) | (crc10(data16) ^ OFFSETS[name])


class Pilot:
    """Stateful pilot tracker: returns the delayed MPX plus unit phasors for 19/38/57 kHz."""

    def __init__(self):
        self.bp = signal.butter(2, [18.4e3, 19.6e3], "bandpass", fs=FS, output="sos")
        self.zi = np.zeros((self.bp.shape[0], 2))
        n = np.arange(HB) - DELAY
        h = np.where(n % 2 != 0, 2.0 / (np.pi * np.where(n == 0, 1, n)), 0.0) * np.hamming(HB)
        self.hq = h
        self.ziq = np.zeros(HB - 1)
        self.tail_p = np.zeros(DELAY)
        self.tail_m = np.zeros(DELAY)
        self.amp = 0.0

    def process(self, mpx):
        p, self.zi = signal.sosfilt(self.bp, mpx, zi=self.zi)
        q, self.ziq = signal.lfilter(self.hq, [1.0], p, zi=self.ziq)
        pe = np.concatenate((self.tail_p, p))
        self.tail_p = pe[len(p):len(p) + DELAY].copy()
        i = pe[:len(p)]
        me = np.concatenate((self.tail_m, mpx))
        self.tail_m = me[len(mpx):len(mpx) + DELAY].copy()
        dm = me[:len(mpx)]
        z = i + 1j * q
        mag = np.abs(z)
        self.amp = 0.9 * self.amp + 0.1 * float(np.mean(mag))
        u = z / (mag + 1e-9)
        return dm.astype(np.float32), u

    @property
    def locked(self):
        return self.amp > 0.02


class RdsDecoder:
    """Recovers RDS groups from the MPX (pilot phasor supplied) and keeps the latest station info."""

    SPS = 24000.0 / RDS_BAUD

    def __init__(self):
        self.bp = signal.butter(3, [54.6e3, 59.4e3], "bandpass", fs=FS, output="sos")
        self.zi = np.zeros((self.bp.shape[0], 2), dtype=np.float64)
        self.lp = signal.firwin(121, 2400.0, fs=FS).astype(np.float32)
        self.lp_tail = np.zeros(len(self.lp) - 1, dtype=np.complex64)
        self.dec_phase = 0
        h = int(round(self.SPS / 2))
        self.mf = np.concatenate((np.ones(h), -np.ones(h))).astype(np.float32) / (2 * h)
        self.mf_zi = np.zeros(len(self.mf) - 1, dtype=np.complex64)
        self.n_abs = 0
        self.next_s = 0.0
        self.energy = np.zeros(20)
        self.ph_acc = 0j
        self.prev = 0
        self.reg = 0
        self.nbits = 0
        self.synced = False
        self._cand = None
        self.last_n = 0
        self.expect = None
        self.fail = 0
        self.blocks = {}
        self.reset()
        self.groups = 0
        self.errors = 0

    def reset(self):
        self.info = {"pi": None, "ps": "", "rt": "", "pty": None, "pty_name": "", "tp": None, "ta": None, "ms": None, "ready": False, "af": []}
        # Station name and radio text arrive a few characters at a time, in any order, with repeats. Nothing is shown until a
        # whole, repeated copy has arrived, so the name never appears piece by piece or changes character by character.
        self._seg = {}                  # PS: address -> (two characters, times in a row they were received identically)
        self._ps_groups = 0
        self._rt_raw = [None] * 64
        self._rt_addr = set()
        self._rt_ab = None
        self._af = {}                   # alternative frequency (Hz) -> times heard; only ones heard twice are shown

    def process(self, mpx_delayed, u):
        c57 = np.conj(u ** 3)
        x, self.zi = signal.sosfilt(self.bp, mpx_delayed.astype(np.float64), zi=self.zi)
        bb = (x * c57).astype(np.complex64)
        ext = np.concatenate((self.lp_tail, bb))
        self.lp_tail = ext[len(bb):].copy()
        y = signal.lfilter(self.lp, [1.0], ext)[len(self.lp) - 1:]
        # decimate to 24 kS/s (keep phase continuity across chunks)
        idx = np.arange(self.dec_phase, len(y), 10)
        self.dec_phase = (self.dec_phase + 10 * len(idx) - len(y)) % 10 if len(idx) else self.dec_phase
        d = y[idx]
        if len(d) < 2:
            return
        m, self.mf_zi = signal.lfilter(self.mf, [1.0], d, zi=self.mf_zi)
        self._sync_and_slice(m)

    def _sync_and_slice(self, m):
        n0 = self.n_abs
        bins = ((n0 + np.arange(len(m))) % self.SPS) / self.SPS * 20
        self.energy *= 0.98
        np.add.at(self.energy, np.minimum(bins.astype(int), 19), np.abs(m))
        best = (int(np.argmax(self.energy)) + 0.5) / 20 * self.SPS
        self.ph_acc = 0.995 * self.ph_acc + np.sum(m * m)
        phi = 0.5 * np.angle(self.ph_acc)
        rot = np.exp(-1j * phi)
        if self.next_s < n0:
            self.next_s = n0 + (best - (n0 % self.SPS)) % self.SPS
        else:
            err = ((best - (self.next_s % self.SPS) + self.SPS / 2) % self.SPS) - self.SPS / 2
            if abs(err) > 1.0:
                self.next_s += 0.25 * err
        end = n0 + len(m)
        bits = []
        while self.next_s + 0.5 < end:
            i = int(self.next_s + 0.5) - n0
            if 0 <= i < len(m):
                bits.append(1 if (m[i] * rot).real > 0 else 0)
            self.next_s += self.SPS
        self.n_abs = end
        for s in bits:
            self._bit(s ^ self.prev)
            self.prev = s

    NEXT = {"A": ("B",), "B": ("C", "C'"), "C": ("D",), "C'": ("D",), "D": ("A",)}

    def _bit(self, b):
        self.reg = ((self.reg << 1) | b) & 0x3FFFFFF
        self.nbits += 1
        if self.nbits < 26:
            return
        if not self.synced:
            t = self._type(self.reg)
            if t:
                c = self._cand
                if c and self.nbits - c[1] == 26 and t in self.NEXT[c[0]]:
                    self.synced, self.fail, self.blocks = True, 0, {}
                    self._take(t)
                self._cand = (t, self.nbits)
            return
        if self.nbits - self.last_n < 26:
            return
        t = self._type(self.reg)
        if t is not None and t in self.NEXT[self.expect]:
            self.fail = 0
            self._take(t)
        else:
            self.fail += 1
            self.errors += 1
            self.last_n = self.nbits
            self.expect = self.NEXT[self.expect][0]
            if self.expect == "A":
                self.blocks = {}
            if self.fail > 12:
                self.synced, self._cand = False, None

    def _type(self, word):
        data, chk = word >> 10, word & 0x3FF
        s = crc10(data) ^ chk
        for k, v in OFFSETS.items():
            if s == v:
                return k
        return None

    def _take(self, t):
        data = self.reg >> 10
        self.last_n = self.nbits
        self._cand = (t, self.nbits)
        self.expect = t
        if t == "A":
            self.blocks = {}
        self.blocks["C" if t == "C'" else t] = data
        if t == "D":
            self._group(self.blocks)
            self.blocks = {}

    def _group(self, b):
        if "A" not in b or "B" not in b:
            return
        self.groups += 1
        info = self.info
        if info["pi"] is not None and info["pi"] != b["A"]:       # a different station: start again, show nothing stale
            self.reset()
            info = self.info
        info["pi"] = b["A"]
        B = b["B"]
        gt, ver = B >> 12, (B >> 11) & 1
        info["pty"] = (B >> 5) & 31
        info["tp"] = bool(B >> 10 & 1)
        if gt == 0 and "D" in b:
            addr = B & 3
            info["ta"] = bool(B >> 4 & 1)
            info["ms"] = "music" if B >> 3 & 1 else "speech"
            if ver == 0 and "C" in b:                                    # group 0A also carries the station's other frequencies
                for code in (b["C"] >> 8, b["C"] & 255):
                    if 1 <= code <= 204:                                 # 87.6 to 107.9 MHz in 100 kHz steps (224-249 count, 205 filler)
                        f = int(round((87.5 + code * 0.1) * 1e6))
                        self._af[f] = self._af.get(f, 0) + 1
                if len(self._af) > 40:
                    self._af = dict(sorted(self._af.items(), key=lambda kv: -kv[1])[:25])
                info["af"] = sorted(f for f, n in self._af.items() if n >= 2)[:25]
            pair = "".join(chr(c) if 32 <= c < 127 else " " for c in (b["D"] >> 8, b["D"] & 255))
            old = self._seg.get(addr)
            self._seg[addr] = (pair, old[1] + 1 if old and old[0] == pair else 1)
            self._ps_groups += 1
            if len(self._seg) == 4:
                cand = "".join(self._seg[i][0] for i in range(4)).rstrip()
                stable = all(self._seg[i][1] >= 2 for i in range(4))                 # every part seen twice in a row, unchanged
                first = not info["ps"] and self._ps_groups >= 12                      # a name that never settles (scrolling): show the first full copy
                if (stable or first) and cand != info["ps"]:
                    info["ps"] = cand
                    info["ready"] = True
        elif gt == 2:
            addr = B & 15
            ab = B >> 4 & 1
            if self._rt_ab is not None and ab != self._rt_ab:           # the station started a new message: gather it afresh
                self._rt_raw = [None] * 64
                self._rt_addr = set()
            self._rt_ab = ab
            if addr in self._rt_addr:                                    # the message has come round again, so a whole copy is in
                self._rt_publish()
                self._rt_addr = set()
            if ver == 0 and "C" in b and "D" in b:
                chars, step = (b["C"] >> 8, b["C"] & 255, b["D"] >> 8, b["D"] & 255), 4
            elif ver == 1 and "D" in b:
                chars, step = (b["D"] >> 8, b["D"] & 255), 2
            else:
                return
            for k, ch in enumerate(chars):
                self._rt_raw[addr * step + k] = ch
            self._rt_addr.add(addr)
            if 13 in chars:                                              # carriage return marks the end of the message
                self._rt_publish()

    def _rt_publish(self):
        out = []
        for ch in self._rt_raw:
            if ch is None or ch == 13:                                   # a gap, or the end marker
                break
            out.append(chr(ch) if 32 <= ch < 127 else " ")
        text = "".join(out).strip()
        if text:
            self.info["rt"] = text

    def public(self, us=False):
        i = dict(self.info)
        tab = PTY_US if us else PTY_EU
        i["pty_name"] = tab[i["pty"]] if i["pty"] is not None and i["pty"] < len(tab) else ""
        i["pi_hex"] = "%04X" % i["pi"] if i["pi"] is not None else ""
        i["groups"] = self.groups
        return i
