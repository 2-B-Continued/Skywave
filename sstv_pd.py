"""sstv_pd.py - decodes slow-scan TV pictures of the PD family (PD50 to PD290) from a sound recording.

The International Space Station uses PD120 (and sometimes PD180) for its amateur-radio picture events.
The decoder finds the transmission's header, reads the mode, then reads every line (re-syncing on each line's
sync pulse so a slightly wrong clock does not smear the picture) and returns PIL images.
"""
import wave

import numpy as np
from scipy import signal

try:
    from PIL import Image
except Exception:                                  # Pillow missing
    Image = None

FS = 48000
DEC = 2                                            # frequency track is kept at 24 kHz
FT = FS // DEC

# vis: (name, width, height, ms per pixel)
MODES = {
    93: ("PD50", 320, 256, 0.286),
    99: ("PD90", 320, 256, 0.532),
    95: ("PD120", 640, 496, 0.190),
    98: ("PD160", 512, 400, 0.382),
    96: ("PD180", 640, 496, 0.286),
    97: ("PD240", 640, 496, 0.382),
    94: ("PD290", 800, 616, 0.286),
}
SYNC_MS, PORCH_MS = 20.0, 2.08


def read_wav(path):
    with wave.open(path, "rb") as w:
        n, ch, sw, fr = w.getnframes(), w.getnchannels(), w.getsampwidth(), w.getframerate()
        raw = w.readframes(n)
    if sw == 2:
        a = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
    elif sw == 1:
        a = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    else:
        raise ValueError("Unsupported sample format")
    if ch > 1:
        a = a.reshape(-1, ch).mean(axis=1)
    if fr != FS:
        from math import gcd
        g = gcd(int(fr), FS)
        a = signal.resample_poly(a, FS // g, int(fr) // g).astype(np.float32)
    return a


def freq_track(audio):
    """Instantaneous frequency (Hz) at 24 kHz, computed in chunks so long recordings stay light on memory."""
    taps = signal.firwin(255, [900, 2700], fs=FS, pass_zero=False)
    out = []
    step, pad = FS * 30, 512
    for i in range(0, len(audio), step):
        seg = audio[max(0, i - pad): i + step + pad]
        seg = signal.fftconvolve(seg, taps, mode="same")
        an = signal.hilbert(seg)
        ph = np.unwrap(np.angle(an))
        f = np.diff(ph, prepend=ph[0]) * FS / (2 * np.pi)
        a = pad if i else 0
        f = f[a: a + min(step, len(audio) - i)]
        f = np.clip(f, 900, 2700).astype(np.float32)
        n = len(f) - len(f) % DEC
        out.append(f[:n].reshape(-1, DEC).mean(axis=1))
    return np.concatenate(out) if out else np.zeros(0, np.float32)


def _blocks(f, ms=10):
    n = int(FT * ms / 1000)
    m = len(f) // n
    return np.median(f[: m * n].reshape(m, n), axis=1), n


def find_header(f, start=0):
    """Return (sample index where the image's first line starts, vis code) or None."""
    med, n = _blocks(f[start:])
    near = lambda v, c, tol=90: abs(v - c) < tol
    i, m = 0, len(med)
    while i < m - 70:
        # leader: >= 20 blocks of 1900 Hz
        if near(med[i], 1900):
            j = i
            while j < m and near(med[j], 1900):
                j += 1
            if j - i >= 20 and j + 3 < m:
                # break: 1 or 2 blocks near 1200, then a second leader of >= 20 blocks
                k = j
                while k < m and near(med[k], 1200, 60):
                    k += 1
                if 1 <= k - j <= 3:
                    l = k
                    while l < m and near(med[l], 1900):
                        l += 1
                    if l - k >= 20 and l + 4 < m:
                        # start bit: 30 ms of 1200 Hz right after the second leader
                        e = l
                        while e < m and near(med[e], 1200, 60):
                            e += 1
                        if 2 <= e - l <= 5:
                            t_start = start + l * n          # beginning of start bit
                            vis = _read_vis(f, t_start)
                            if vis is not None:
                                return t_start + int(0.300 * FT), vis
            i = max(j, i + 1)
        else:
            i += 1
    return None


def _read_vis(f, t0):
    bits = []
    for b in range(8):
        a = t0 + int((0.030 * (b + 1) + 0.006) * FT)
        z = t0 + int((0.030 * (b + 2) - 0.006) * FT)
        if z > len(f):
            return None
        bits.append(1 if np.median(f[a:z]) < 1200 else 0)
    code = sum(bit << i for i, bit in enumerate(bits[:7]))
    if sum(bits) % 2 != 0:                       # even parity over all 8 bits
        return None
    return code if code in MODES else None


def _lum(v):
    return np.clip((v - 1500.0) / 800.0 * 255.0, 0, 255)


def decode_image(f, t_img, vis):
    name, W, H, px = MODES[vis]
    scan = px * W / 1000.0                                   # seconds per colour scan
    pair = (SYNC_MS + PORCH_MS) / 1000.0 + 4 * scan          # seconds per two image lines
    csum = np.concatenate([[0.0], np.cumsum(f, dtype=np.float64)])
    rows = np.zeros((H, W, 3), np.float32)
    t = float(t_img)                                         # in seconds * FT, converted below
    t = t_img / FT
    lines_done = 0
    for k in range(H // 2):
        exp = t
        # re-sync: look for the 1200 Hz sync pulse near where it should be
        a = int((exp - 0.006) * FT)
        z = int((exp + 0.012) * FT)
        if a >= 0 and z < len(f):
            seg = f[a:z] < 1350
            if seg.any():
                idx = np.argmax(seg)
                # the pulse is 20 ms long; accept only if most of it follows
                if seg[idx: idx + int(0.012 * FT)].mean() > 0.7:
                    got = (a + idx) / FT
                    exp = exp + 0.5 * (got - exp) if abs(got - exp) < 0.006 else exp
        base = exp + (SYNC_MS + PORCH_MS) / 1000.0
        if int((base + 4 * scan) * FT) >= len(f):
            break
        chans = []
        for c in range(4):
            s0 = base + c * scan
            edges = (s0 + scan * np.arange(W + 1) / W) * FT
            idx = np.round(edges).astype(np.int64)
            idx = np.clip(idx, 0, len(f))
            cnt = np.maximum(idx[1:] - idx[:-1], 1)
            chans.append(_lum((csum[idx[1:]] - csum[idx[:-1]]) / cnt))
        y0, cr, cb, y1 = chans
        for y, row in ((y0, 2 * k), (y1, 2 * k + 1)):
            r = y + 1.402 * (cr - 128.0)
            g = y - 0.344136 * (cb - 128.0) - 0.714136 * (cr - 128.0)
            b = y + 1.772 * (cb - 128.0)
            rows[row] = np.stack([r, g, b], axis=1)
        lines_done = 2 * k + 2
        t = exp + pair
    img = Image.fromarray(np.clip(rows, 0, 255).astype(np.uint8), "RGB")
    return img, t, lines_done


def decode_all(path, progress=None):
    """Find and decode every PD picture in a recording. Returns a list of dicts: mode, image, lines, start_s."""
    audio = read_wav(path)
    f = freq_track(audio)
    results, pos = [], 0
    while True:
        hit = find_header(f, pos)
        if not hit:
            break
        t_img, vis = hit
        img, t_end, lines = decode_image(f, t_img, vis)
        name, W, H, _ = MODES[vis]
        if lines >= 16:
            results.append({"mode": name, "image": img, "lines": lines, "height": H, "start_s": t_img / FT})
        pos = max(int(t_end * FT), t_img + FT)
        if progress:
            progress(min(100.0, 100.0 * pos / max(len(f), 1)))
    return results
