"""Morse code (CW) decoder.

Works on demodulated audio (48 kHz mono). It looks for a steady keyed tone, learns the sending speed by itself and
turns the dots and dashes into text. It is deliberately strict about what counts as Morse, so noise and speech do not
produce text.
"""
import collections

import numpy as np
from scipy import signal

TABLE = {
    ".-": "A", "-...": "B", "-.-.": "C", "-..": "D", ".": "E", "..-.": "F", "--.": "G", "....": "H", "..": "I",
    ".---": "J", "-.-": "K", ".-..": "L", "--": "M", "-.": "N", "---": "O", ".--.": "P", "--.-": "Q", ".-.": "R",
    "...": "S", "-": "T", "..-": "U", "...-": "V", ".--": "W", "-..-": "X", "-.--": "Y", "--..": "Z",
    "-----": "0", ".----": "1", "..---": "2", "...--": "3", "....-": "4", ".....": "5", "-....": "6", "--...": "7",
    "---..": "8", "----.": "9", ".-.-.-": ".", "--..--": ",", "..--..": "?", "-..-.": "/", "-...-": "=",
    ".-.-.": "+", "-....-": "-", ".----.": "'", "-.--.": "(", "-.--.-": ")", "---...": ":", ".-..-.": '"',
    "...-..-": "$", ".--.-.": "@", "-.-.--": "!",
}

# Where Morse is actually sent: (low Hz, high Hz). CW is always relevant when the mode is CW.
_HAM_CW = [(1.8e6, 1.84e6), (3.5e6, 3.57e6), (5.3e6, 5.4e6), (7.0e6, 7.04e6), (10.1e6, 10.13e6), (14.0e6, 14.07e6),
           (18.068e6, 18.095e6), (21.0e6, 21.07e6), (24.89e6, 24.915e6), (28.0e6, 28.07e6), (50.0e6, 50.1e6),
           (144.0e6, 144.11e6), (432.0e6, 432.11e6), (1296.0e6, 1296.11e6)]
_IDENT = [(190e3, 535e3),            # non-directional beacons (NDB)
          (108.0e6, 117.975e6)]      # VOR / ILS identifiers
_BEACONS = [(28.17e6, 28.3e6), (50.0e6, 50.08e6), (144.4e6, 144.49e6), (432.4e6, 432.5e6)]  # amateur beacons
_REPEATERS = [(145.0e6, 148.0e6), (438.0e6, 440.0e6), (420.0e6, 450.0e6)]   # ham repeaters send their call sign in Morse
_HF = (1.6e6, 30.0e6)                                                         # utility, marine and military Morse on shortwave
_CODE_MODES = {"cw", "usb", "lsb", "am", "nfm", "dsb"}


def relevant(freq, mode):
    """Is this a place where Morse is likely? Decoding only runs there, so speech and music are left alone."""
    if mode == "cw":
        return True
    if mode not in _CODE_MODES or mode == "wfm":
        return False
    if mode in ("usb", "lsb", "dsb") and _HF[0] <= freq <= _HF[1]:
        return True
    if mode == "nfm" and any(lo <= freq <= hi for lo, hi in _REPEATERS):
        return True
    return any(lo <= freq <= hi for lo, hi in _HAM_CW + _IDENT + _BEACONS)


class MorseDecoder:
    FS = 8000
    N = 256
    HOP = 64                       # 8 ms per step
    HOP_S = 64 / 8000.0
    LO_BIN = 12                    # 375 Hz
    HI_BIN = 40                    # 1250 Hz

    def __init__(self):
        self.lp = signal.firwin(63, 3400.0 / 24000.0)
        self.win = np.hanning(self.N).astype(np.float32)
        self.reset()

    def reset(self):
        self.zi = np.zeros(len(self.lp) - 1)
        self.phase = 0
        self.buf = np.zeros(0, dtype=np.float32)
        self.avg = np.zeros(self.HI_BIN - self.LO_BIN + 1)
        self.k = None
        self.hist = collections.deque(maxlen=375)       # ~3 s of tone strength
        self.on = False
        self.run = 0                # hops spent in the current on/off state
        self.segs = []              # [(is_on, hops)]
        self.idle = 0
        self.steps = 0
        self.last_text = ""
        self.last_t = 0.0

    # ------------------------------------------------------------ streaming
    def process(self, audio, now=0.0):
        """Feed 48 kHz audio. Returns a list of {text, wpm, tone} results (usually empty)."""
        if audio is None or len(audio) == 0:
            return []
        y, self.zi = signal.lfilter(self.lp, 1.0, audio.astype(np.float64), zi=self.zi)
        y = y[self.phase::6]
        self.phase = (self.phase - len(audio)) % 6
        self.buf = np.concatenate([self.buf, y.astype(np.float32)])
        out = []
        while len(self.buf) >= self.N:
            fr = self.buf[:self.N] * self.win
            self.buf = self.buf[self.HOP:]
            p = np.abs(np.fft.rfft(fr)[self.LO_BIN:self.HI_BIN + 1]) ** 2
            self._step(p, out, now)
        return out

    def _step(self, p, out, now):
        self.steps += 1
        self.avg = 0.985 * self.avg + 0.015 * p
        if self.k is None or self.steps % 25 == 0:
            k = int(np.argmax(self.avg))
            med = float(np.median(self.avg)) + 1e-12
            self.k = k if self.avg[k] > 4.0 * med else None
        kk = self.k if self.k is not None else int(np.argmax(self.avg))
        a, b = max(kk - 1, 0), min(kk + 2, len(p))
        e = float(np.sum(p[a:b]))
        self.hist.append(e)
        if len(self.hist) < 125:                         # need about a second to judge what "on" and "off" look like
            return
        h = np.fromiter(self.hist, dtype=np.float64)
        lo, hi = float(np.percentile(h, 15)), float(np.percentile(h, 96))
        keyed = self.k is not None and hi > 1e-9 and hi > 6.0 * max(lo, 1e-12)
        if keyed:
            thr = max((lo * hi) ** 0.5, 0.03 * hi, 0.05)        # never let a silent stretch (lo near 0) set the bar at the noise
            on = e > thr * (0.8 if self.on else 1.25)
        else:
            on = False
        if on == self.on:
            self.run += 1
        else:
            if self.run:
                self.segs.append((self.on, self.run))
            self.on, self.run = on, 1
        if not on:
            self.idle += 1
        else:
            self.idle = 0
        n_on = sum(1 for s in self.segs if s[0])
        # finished a transmission (quiet for 2.5 s), or the text is getting long
        if (self.idle > 312 and n_on >= 5) or n_on > 260:
            r = self._decode(self.segs + ([(self.on, self.run)] if self.run and not self.on else []))
            self.segs, self.idle = [], 0
            if r:
                r["tone"] = int(round((self.LO_BIN + (self.k or 0)) * self.FS / self.N))
                key = r["text"]
                if key != self.last_text or now - self.last_t > 90:    # beacons repeat the same ident: say it once a while
                    out.append(r)
                    self.last_text, self.last_t = key, now
        elif self.idle > 312:
            self.segs = []

    # ------------------------------------------------------------ decoding
    def _decode(self, segs):
        # drop glitches: very short tones, and very short gaps inside a tone
        clean = []
        for is_on, n in segs:
            if clean and clean[-1][0] == is_on:
                clean[-1][1] += n
            elif not is_on and n < 2 and clean:
                clean[-1][1] += n
            elif is_on and n < 2:
                if clean:
                    clean[-1][1] += n
            else:
                clean.append([is_on, n])
        # merge again after the glitch removal
        m = []
        for is_on, n in clean:
            if m and m[-1][0] == is_on:
                m[-1][1] += n
            else:
                m.append([is_on, n])
        while m and not m[0][0]:
            m.pop(0)
        while m and not m[-1][0]:
            m.pop()
        if len([1 for s_, n in m if s_]) >= 8:                  # an over-long tone is a carrier or an artefact, not a dash
            med = float(np.median([n for s_, n in m if s_]))
            m = [x for x in m if not (x[0] and x[1] > 8 * med)]
        ons = np.array([n for s_, n in m if s_], dtype=np.float64)
        if len(ons) < 5:
            return None
        lo_c, hi_c = float(ons.min()), float(ons.max())
        for _ in range(12):                                # two-cluster 1-D k-means
            thr = (lo_c + hi_c) / 2.0
            a, b = ons[ons <= thr], ons[ons > thr]
            if len(a) == 0 or len(b) == 0:
                break
            lo_c, hi_c = float(a.mean()), float(b.mean())
        a, b = ons[ons <= (lo_c + hi_c) / 2.0], ons[ons > (lo_c + hi_c) / 2.0]
        if len(b) and 2.0 <= hi_c / lo_c <= 4.8:
            dot = 0.5 * (lo_c + hi_c / 3.0)
            for grp in (a, b):                              # keying has to be regular, or it is not Morse
                if len(grp) >= 3 and grp.std() / grp.mean() > 0.4:
                    return None
        else:
            if hi_c / lo_c > 1.8 or (len(ons) and ons.std() / ons.mean() > 0.4):
                return None
            dot = float(np.median(ons))                       # all the same length: a run of dots (or dashes)
        wpm = 1.2 / (dot * self.HOP_S)
        if not 5.0 <= wpm <= 45.0:
            return None
        text, sym, bad = [], "", 0
        for i, (is_on, n) in enumerate(m):
            if is_on:
                sym += "." if n < 2.0 * dot else "-"
            else:
                if n >= 2.0 * dot:
                    ch = TABLE.get(sym)
                    if sym:
                        text.append(ch or "?")
                        bad += ch is None
                    sym = ""
                    if n >= 5.0 * dot:
                        text.append(" ")
        if sym:
            ch = TABLE.get(sym)
            text.append(ch or "?")
            bad += ch is None
        s = "".join(text).strip()
        letters = [c for c in s if c != " "]
        if len(letters) < 3 or bad > 0.25 * len(letters) or len(set(letters)) < 2:
            return None
        return {"text": " ".join(s.split()), "wpm": round(wpm)}
