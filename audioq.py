"""audioq.py - streaming quality for the live sound socket.

The radio makes 48 kHz 16-bit sound (mono, or stereo for FM stereo). Each listening page picks a quality level, and its frames
are converted here before they are sent:

  level  rate     channels      coding            about        good for
  1      12 kHz   mono          8-bit mu-law      96 kbit/s    voice on a poor mobile connection
  2      16 kHz   mono          8-bit mu-law      128 kbit/s   clear speech (aircraft, marine, ham, scanners)
  3      24 kHz   as received   8-bit mu-law      192-384      music at a fraction of the data
  4      32 kHz   as received   16-bit            512-1024     full FM broadcast quality (FM stops at 15 kHz)
  5      48 kHz   as received   16-bit            768-1536     exactly what the radio makes (default)

Converted frames are type 4: [4][rate / 1000][channels][coding: 0 = 16-bit, 1 = mu-law][samples]. The resampler is a
windowed-sinc low-pass run as a polyphase filter whose state carries from frame to frame, so frame edges never click. Mu-law
here is the continuous mu = 255 curve on 8 bits (the page decodes the same curve), which keeps quiet sound clean."""
import numpy as np
from scipy import signal

LEVELS = {1: (12000, 1, 1), 2: (16000, 1, 1), 3: (24000, 0, 1), 4: (32000, 0, 0), 5: (48000, 0, 0)}   # rate, force mono, mu-law
RATE_FACTORS = {12000: (1, 4), 16000: (1, 3), 24000: (1, 2), 32000: (2, 3)}                        # up, down from 48 kHz
MP3_KBPS = {1: 48, 2: 64, 3: 96, 4: 128, 5: 192}
KBPS = {1: "about 96 kbit/s", 2: "about 128 kbit/s", 3: "about 192 kbit/s (384 in stereo)", 4: "about 512 kbit/s (1 Mbit/s in stereo)", 5: "about 768 kbit/s (1.5 Mbit/s in stereo)"}
MU = 255.0


def clamp_level(q):
    try:
        q = int(q)
    except (TypeError, ValueError):
        return 5
    return min(5, max(1, q))


def mulaw_encode(x):
    y = np.sign(x) * np.log1p(MU * np.minimum(1.0, np.abs(x))) / np.log1p(MU)
    return np.clip(np.round((y + 1.0) * 127.5), 0, 255).astype(np.uint8)


def mulaw_decode(u):
    y = u.astype(np.float32) / 127.5 - 1.0
    return np.sign(y) * np.expm1(np.abs(y) * np.log1p(MU)) / MU


class Shaper:
    """Converts one listener's 48 kHz frames to its chosen level. One per sound socket (it keeps filter state)."""

    def __init__(self, level=5):
        self.set(level)

    def set(self, level):
        self.level = clamp_level(level)
        self.rate, self.mono, self.mu = LEVELS[self.level]
        self.ch = None
        self.zi = None
        self.phase = 0
        if self.rate != 48000:
            up, down = RATE_FACTORS[self.rate]
            self.up, self.down = up, down
            cutoff = 0.9 * min(1.0 / up, 1.0 / down)            # just under the new Nyquist, relative to the upsampled rate
            self.h = (signal.firwin(24 * max(up, down) + 1, cutoff, window=("kaiser", 7.0)) * up).astype(np.float64)

    def frame(self, b):
        """b: a type 2 (mono) or 3 (stereo) frame from the engine. Returns the bytes to send (or b itself at level 5)."""
        t = b[0]
        if t not in (2, 3) or self.level == 5:
            return b
        x = np.frombuffer(b[1:1 + ((len(b) - 1) & ~1)], dtype="<i2").astype(np.float64) / 32768.0
        ch = 2 if t == 3 else 1
        x = x.reshape(-1, ch)
        if self.mono and ch == 2:
            x = x.mean(axis=1, keepdims=True)
            ch = 1
        if ch != self.ch:                                       # channel count changed (stereo pilot found or lost): fresh filter state
            self.ch = ch
            self.zi = None
            self.phase = 0
        if self.rate != 48000:
            x = self._resample(x)
        if self.mu:
            payload = mulaw_encode(x.reshape(-1)).tobytes()
        else:
            payload = (np.clip(x.reshape(-1), -1.0, 32767 / 32768.0) * 32768.0).astype("<i2").tobytes()
        return bytes((4, self.rate // 1000, ch, 1 if self.mu else 0)) + payload

    def _resample(self, x):
        n, ch = x.shape
        up, down = self.up, self.down
        if up > 1:
            z = np.zeros((n * up, ch))
            z[::up] = x
        else:
            z = x
        if self.zi is None:
            self.zi = np.zeros((len(self.h) - 1, ch))
        y, self.zi = signal.lfilter(self.h, [1.0], z, axis=0, zi=self.zi)
        start = (-self.phase) % down                            # keep the decimation grid continuous across frames
        out = y[start::down]
        self.phase = (self.phase + len(y)) % down
        return out
