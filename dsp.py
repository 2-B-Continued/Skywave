"""dsp.py - DSP building blocks for Skywave (numpy + scipy only).

Signal flow for a demodulated channel (fs = RTL sample rate, normally 2.4 MS/s):

    IQ chunk -> mix VFO to 0 Hz -> FIR decimate to 240 kS/s -> mode specific
    (WFM: FM discriminator at 240 kS/s;  others: FIR decimate to 48 kS/s first)
    -> audio at 48 kS/s float32 in [-1, 1]

Every stage keeps its own filter state, so audio is continuous across chunks.
Chunk sizes must be a multiple of the total decimation (fs / 48000).
"""
import numpy as np
from scipy import signal

AUDIO_FS = 48000
IF_FS = 240000          # intermediate rate after the first decimation stage


def lowpass_taps(cutoff, stop, fs, atten=60.0, mult=1):
    """Kaiser low-pass. Passband edge `cutoff`, stopband edge `stop` (Hz).
    The tap count is forced to be 1 (mod mult) so the decimator stays phase-aligned."""
    width = max((stop - cutoff) / (fs / 2.0), 1e-4)
    n, beta = signal.kaiserord(atten, width)
    n = int(n) | 1
    if mult > 1:
        n = ((n - 1 + mult - 1) // mult) * mult + 1
    return signal.firwin(n, (cutoff + stop) / 2.0, window=("kaiser", beta), fs=fs).astype(np.float32)


class FirDecimator:
    """Stateful FIR filter + decimate-by-D. len(x) must be a multiple of D."""

    def __init__(self, taps, D):
        self.h = np.asarray(taps, dtype=np.float32)
        self.D = int(D)
        self.L = len(self.h)
        if (self.L - 1) % self.D:
            raise ValueError("taps must be 1 mod D")
        self.tail = None

    def process(self, x):
        if self.tail is None:
            self.tail = np.zeros(self.L - 1, dtype=x.dtype)
        ext = np.concatenate((self.tail, x))
        y = signal.upfirdn(self.h, ext, 1, self.D)
        m = (self.L - 1) // self.D
        out = y[m:m + len(x) // self.D]
        self.tail = ext[len(ext) - (self.L - 1):].copy()
        return out.astype(x.dtype, copy=False)


class CascadeDecimator:
    """Decimate by D in two short stages (D/2, then 2) instead of one long filter at the full sample rate.
    The first stage only has to protect the band that the second stage keeps, so it can be very short; the second
    stage has the sharp edge but runs on half as many samples. Same stop-band as the single filter for about a third
    of the arithmetic, which matters because this runs on every sample the dongle delivers."""

    def __init__(self, cutoff, stop, fs, D, atten=60.0):
        d1 = D // 2
        mid = fs / d1
        self.a = FirDecimator(lowpass_taps(cutoff, mid - stop, fs, atten, mult=d1), d1)
        self.b = FirDecimator(lowpass_taps(cutoff, stop, mid, atten, mult=2), 2)
        self.D = int(D)

    def process(self, x):
        return self.b.process(self.a.process(x))


def front_decimator(cutoff, stop, fs, D):
    """The first (full-rate) filter of the receiver: two stages when the ratio allows it, one otherwise."""
    if D >= 8 and D % 2 == 0 and fs / (D // 2) - stop > cutoff * 1.5:
        return CascadeDecimator(cutoff, stop, fs, D)
    return FirDecimator(lowpass_taps(cutoff, stop, fs, mult=D), D)


class ComplexFir:
    """Stateful complex-tap FIR (no decimation), used for SSB/CW sidebands."""

    def __init__(self, taps):
        self.h = np.asarray(taps, dtype=np.complex64)
        self.zi = np.zeros(len(self.h) - 1, dtype=np.complex64)

    def process(self, x):
        y, self.zi = signal.lfilter(self.h, [1.0], x, zi=self.zi)
        return y.astype(np.complex64, copy=False)


class Mixer:
    """Frequency shifter with continuous phase: multiplies by exp(-j*2*pi*f*n/fs)."""

    def __init__(self, fs):
        self.fs = float(fs)
        self.phase = 0.0
        self._key = None
        self._rot = None
        self._w = 0.0

    def process(self, x, f):
        n = len(x)
        if f == 0.0:
            return x
        key = (round(f, 3), n)
        if key != self._key:
            w = 2.0 * np.pi * f / self.fs
            self._rot = np.exp(-1j * w * np.arange(n, dtype=np.float64)).astype(np.complex64)
            self._w = w
            self._key = key
        out = x * (self._rot * np.complex64(np.exp(-1j * self.phase)))
        self.phase = (self.phase + self._w * n) % (2.0 * np.pi)
        return out


class StatefulSos:
    """sosfilt with persistent state (float32 audio)."""

    def __init__(self, sos):
        self.sos = np.asarray(sos, dtype=np.float64)
        self.zi = np.zeros((self.sos.shape[0], 2))

    def process(self, x):
        y, self.zi = signal.sosfilt(self.sos, x, zi=self.zi)
        return y.astype(np.float32, copy=False)


class Discriminator:
    """FM discriminator: instantaneous frequency in radians/sample."""

    def __init__(self):
        self.prev = np.complex64(0)

    def process(self, z):
        ext = np.concatenate(([self.prev], z))
        self.prev = z[-1]
        return np.angle(ext[1:] * np.conj(ext[:-1])).astype(np.float32)


class SpectrumAnalyzer:
    """Averaged, windowed FFT of an IQ chunk, as dBFS per bin (fft-shifted)."""

    def __init__(self, nfft=4096, nseg=6, window="hann"):
        self.nfft = nfft
        self.nseg = nseg
        import lab as _lab
        self.w = _lab.make_window(window, nfft)
        self.norm = float(self.w.sum() ** 2)

    def compute(self, iq):
        n = len(iq)
        if n < self.nfft:
            raise ValueError("chunk too short")
        starts = np.linspace(0, n - self.nfft, self.nseg).astype(int)
        segs = np.stack([iq[s:s + self.nfft] for s in starts]) * self.w
        X = np.fft.fft(segs, axis=1)
        P = (X.real ** 2 + X.imag ** 2).mean(axis=0) / self.norm
        P = np.fft.fftshift(P)
        return (10.0 * np.log10(P + 1e-20)).astype(np.float32)


def noise_floor_db(spec_db):
    """Robust noise-floor estimate of a spectrum (20th percentile + bias)."""
    return float(np.percentile(spec_db, 20) + 1.5)


MODES = ("wfm", "nfm", "am", "dsb", "usb", "lsb", "cw", "raw")
DEFAULT_BW = {"wfm": 200000, "nfm": 12500, "am": 10000, "dsb": 6000, "usb": 2700, "lsb": 2700, "cw": 400, "raw": 24000}
CW_PITCH = 700.0


class Receiver:
    """Stateful demodulator for one VFO inside the IQ window."""

    def __init__(self, fs, deemph_us=50.0):
        self.fs = float(fs)
        self.total_dec = int(round(fs / AUDIO_FS))
        self.dec_a = int(round(fs / IF_FS))
        if abs(self.dec_a * IF_FS - fs) > 1 or abs(self.total_dec * AUDIO_FS - fs) > 1:
            raise ValueError("sample rate %s not supported (use 2.4M, 1.92M, 1.2M or 0.96M)" % fs)
        self.dec_b = self.total_dec // self.dec_a
        self.deemph_us = deemph_us
        self.mixer = Mixer(fs)
        self.mode = None
        self.bw = None
        self.agc_on = True
        self.agc_rate, self.agc_tscale, self.agc_gmax = 0.15, 1.0, None   # attack/decay, target scale, max-gain override (linear)
        self.cw_pitch, self.ssb_shift = CW_PITCH, 0.0
        self.agc_custom = None              # (attack s, decay s, hang s) when the Lab sets its own AGC times
        self._agc_hold = 0.0
        self.am_det, self.pll_hz, self.sam = "env", 40.0, None
        self.quiet = 0.0                    # FM quieting, 0-100: how far the noise has dropped (noise squelch)
        self.afc_hz = 0.0                   # FM carrier offset measured from the discriminator
        self.stereo_on, self.rds_on = False, False      # FM broadcast extras (switched on by the engine)
        self.side, self.stereo_active, self.rds = None, False, None
        self.configure("nfm", DEFAULT_BW["nfm"])

    @property
    def chunk_multiple(self):
        return self.total_dec

    def mix_offset(self, f_vfo):
        return f_vfo - self.cw_pitch if self.mode == "cw" else f_vfo

    def configure(self, mode, bw=None):
        if mode not in MODES:
            raise ValueError("unknown mode %r" % mode)
        bw = float(bw or DEFAULT_BW[mode])
        self.mode, self.bw = mode, bw
        fs = self.fs
        if mode == "wfm":
            bw = min(max(bw, 60000), 220000)
            self.bw = bw
            stop = IF_FS - bw / 2 - 20000
            if stop <= bw / 2 + 20000:
                stop = bw / 2 + 40000
            self.fa = front_decimator(bw / 2, stop, fs, self.dec_a)
            self.disc = Discriminator()
            self.fb = FirDecimator(lowpass_taps(15000, 19500, IF_FS, mult=self.dec_b), self.dec_b)
            a = 1.0 - np.exp(-1.0 / (AUDIO_FS * self.deemph_us * 1e-6))
            self.de_b, self.de_a = np.array([a]), np.array([1.0, -(1.0 - a)])
            self.de_zi = np.zeros(1)
            self.dc = StatefulSos(signal.butter(1, 20.0 / (AUDIO_FS / 2), "high", output="sos"))
            import rds as _rds
            self.pilot = _rds.Pilot()
            self.rds = _rds.RdsDecoder()
            self.fb2 = FirDecimator(lowpass_taps(15000, 19500, IF_FS, mult=self.dec_b), self.dec_b)
            self.de_zi2 = np.zeros(1)
            self.dc2 = StatefulSos(signal.butter(1, 20.0 / (AUDIO_FS / 2), "high", output="sos"))
            self.blend = 0.0
        else:
            self.fa = front_decimator(100000, IF_FS - 100000, fs, self.dec_a)
            if mode in ("nfm", "am", "dsb", "raw"):
                half = min(bw / 2.0, 23000.0) if mode == "raw" else bw / 2.0
                self.fb = FirDecimator(lowpass_taps(half, half + max(2500.0, 0.35 * bw), IF_FS, mult=self.dec_b), self.dec_b)
                self.cfir = None
            else:
                self.fb = FirDecimator(lowpass_taps(4500, 12000, IF_FS, mult=self.dec_b), self.dec_b)
                if mode == "usb":
                    lo, hi = max(50.0, 300.0 + self.ssb_shift), max(50.0, 300.0 + self.ssb_shift) + bw
                    f0, hb = (lo + hi) / 2, (hi - lo) / 2
                elif mode == "lsb":
                    lo, hi = max(50.0, 300.0 + self.ssb_shift), max(50.0, 300.0 + self.ssb_shift) + bw
                    f0, hb = -(lo + hi) / 2, (hi - lo) / 2
                else:
                    f0, hb = self.cw_pitch, bw / 2
                t = lowpass_taps(hb, hb + 250.0, AUDIO_FS).astype(np.float64)
                n = np.arange(len(t)) - (len(t) - 1) / 2.0
                self.cfir = ComplexFir(t * np.exp(2j * np.pi * f0 * n / AUDIO_FS))
            self.disc = Discriminator()
            self.hp = StatefulSos(signal.butter(2, 300.0 / (AUDIO_FS / 2), "high", output="sos"))
            self.lp = StatefulSos(signal.butter(4, 3400.0 / (AUDIO_FS / 2), "low", output="sos"))
            self.dc = StatefulSos(signal.butter(1, 60.0 / (AUDIO_FS / 2), "high", output="sos"))
        self.am_avg = None
        self.sam = None
        self.raw_disc = None
        self.agc_gain = 1.0

    def _agc(self, x, target=0.25, max_gain=30.0, active=True):
        """Block AGC with a linear gain ramp so there are no clicks."""
        if not self.agc_on or not len(x):
            return x
        if active:
            rms = float(np.sqrt(np.mean(x * x))) + 1e-6
            if self.agc_gmax:
                max_gain = self.agc_gmax
            want = min(max_gain, target * self.agc_tscale / rms)
            if self.agc_custom:
                att, dec, hang = self.agc_custom
                dt = len(x) / AUDIO_FS
                if want < self.agc_gain:
                    new = self.agc_gain + (1 - np.exp(-dt / att)) * (want - self.agc_gain)
                    self._agc_hold = hang
                elif self._agc_hold > 0:
                    self._agc_hold -= dt
                    new = self.agc_gain
                else:
                    new = self.agc_gain + (1 - np.exp(-dt / dec)) * (want - self.agc_gain)
            else:
                new = want if want < self.agc_gain else self.agc_gain + self.agc_rate * (want - self.agc_gain)
        else:
            new = self.agc_gain
        g = np.linspace(self.agc_gain, new, len(x), dtype=np.float32)
        self.agc_gain = new
        return x * g

    def process(self, iq, f_vfo_offset, gate_open=True):
        """iq: complex64 chunk (len multiple of total_dec). f_vfo_offset: VFO minus
        window centre, Hz. Returns float32 audio at 48 kS/s."""
        x = self.mixer.process(iq, self.mix_offset(f_vfo_offset))
        x = self.fa.process(x)
        m = self.mode
        if m == "wfm":
            d = self.disc.process(x) * np.float32(IF_FS / (2 * np.pi * 75000.0))
            want_pilot = self.stereo_on or self.rds_on
            u = None
            if want_pilot:
                d, u = self.pilot.process(d)          # delays the signal a little so it lines up with the pilot's phase
            a = self.fb.process(d)
            a, self.de_zi = signal.lfilter(self.de_b, self.de_a, a, zi=self.de_zi)
            a = self.dc.process(a.astype(np.float32))
            self.side = None
            self.stereo_active = False
            if want_pilot and self.pilot.locked:
                if self.rds_on:
                    self.rds.process(d, u)
                if self.stereo_on:
                    s38 = (-2.0 * np.imag(u * u)).astype(np.float32)     # sin(2*theta): the 38 kHz stereo carrier
                    sd = self.fb2.process(d * s38)
                    sd, self.de_zi2 = signal.lfilter(self.de_b, self.de_a, sd, zi=self.de_zi2)
                    sd = self.dc2.process(sd.astype(np.float32))
                    self.blend = min(1.0, self.blend + 0.25)
                    self.side = np.clip(sd * 0.9 * self.blend, -1.0, 1.0)
                    self.stereo_active = True
            else:
                self.blend = 0.0
            return np.clip(a * 0.9, -1.0, 1.0)
        z = self.fb.process(x)
        if m == "nfm":
            d = self.disc.process(z) * np.float32(AUDIO_FS / (2 * np.pi * 3000.0))
            self.raw_disc = d                      # unfiltered discriminator audio, for the data decoders
            # noise squelch: a real signal "quiets" the discriminator; with no carrier its output is loud, wideband noise
            hf = np.diff(d)
            nz = float(np.sqrt(np.mean(hf * hf))) if len(hf) else 1.0
            self.quiet = 0.8 * self.quiet + 0.2 * float(np.clip(100.0 * (1.0 - nz / 1.6), 0.0, 100.0))
            self.afc_hz = float(np.mean(d)) * 3000.0
            a = self.lp.process(self.hp.process(d))
            a = self._agc(a, 0.22, 8.0, active=gate_open)
        elif m == "am" and self.am_det != "env":
            if self.sam is None or self.sam.sideband != {"sam": "both", "sam_u": "upper", "sam_l": "lower"}[self.am_det]:
                import prolab
                self.sam = prolab.Sam({"sam": "both", "sam_u": "upper", "sam_l": "lower"}[self.am_det], self.pll_hz, self.bw)
            a = self.lp.process(self.sam.process(z))
            a = self._agc(a, 0.2, 4.0, active=gate_open)
        elif m == "am":
            env = np.abs(z).astype(np.float32)
            mean = float(env.mean()) + 1e-9
            if self.am_avg is None:
                self.am_avg = mean
            new = self.am_avg + 0.15 * (mean - self.am_avg)
            ref = np.linspace(self.am_avg, new, len(env), dtype=np.float32)
            self.am_avg = new
            a = (env - ref) / ref * 0.7
            a = self.lp.process(self.dc.process(a))
            a = self._agc(a, 0.2, 4.0, active=gate_open)
        elif m == "dsb":
            a = np.real(z).astype(np.float32)           # double sideband: both sidebands folded together
            a = self.dc.process(a)
            a = self._agc(a, 0.2, 400.0, active=gate_open)
        elif m == "raw":
            a = np.real(z).astype(np.float32)           # the I channel of the filtered baseband, no demodulation at all
            a = self._agc(a, 0.2, 400.0, active=gate_open)
        else:
            y = self.cfir.process(z)
            a = np.real(y).astype(np.float32)
            a = self._agc(a, 0.2, 400.0, active=gate_open)
        return np.clip(a, -1.0, 1.0)


def to_pcm16(a):
    return (np.clip(a, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


def channel_level_db(spec_db, fs, f_off, bw):
    """Power-mean level (dB) over the FFT bins of a channel f_off Hz from the window
    centre. None if the channel lies outside the window."""
    n = len(spec_db)
    binw = fs / n
    lo = int(round(n / 2 + (f_off - bw / 2) / binw))
    hi = int(round(n / 2 + (f_off + bw / 2) / binw))
    lo, hi = max(lo, 0), min(hi, n)
    if hi - lo < 1:
        return None
    seg = spec_db[lo:hi]
    return float(10.0 * np.log10(np.mean(10.0 ** (seg / 10.0))))


def fm_pilot(iq, fs, f_off):
    """Measure the 19 kHz stereo pilot of an FM broadcast station.

    iq: complex samples at rate fs with the station f_off Hz from the centre. Returns (pilot_hz, snr_db) or (None, 0).
    The pilot is locked to the station's reference, and the dongle's sample clock scales it, so a pilot that
    measures below 19000 Hz means the dongle's clock runs fast (and vice versa). Used for automatic calibration.
    """
    from scipy import signal as sg
    n = len(iq)
    x = iq.astype(np.complex64) * np.exp(-2j * np.pi * f_off * np.arange(n, dtype=np.float64) / fs).astype(np.complex64)
    q = int(round(fs / 240000.0))
    x = sg.resample_poly(x, 1, q, window=("kaiser", 6.0)).astype(np.complex64)
    rate = fs / q
    mpx = np.angle(x[1:] * np.conj(x[:-1])) * rate / (2 * np.pi)
    mpx = mpx - mpx.mean()
    m = 1 << int(np.floor(np.log2(len(mpx))))
    if m < 1 << 16:
        return None, 0.0
    w = np.hanning(m)
    pad = 4
    spec = np.abs(np.fft.rfft(mpx[:m] * w, m * pad))
    hz = np.fft.rfftfreq(m * pad, 1.0 / rate)
    band = (hz > 18800) & (hz < 19200)
    i0 = np.argmax(np.where(band, spec, 0))
    side = ((hz > 17500) & (hz < 18500)) | ((hz > 19500) & (hz < 20500))
    snr = 20 * np.log10(spec[i0] / (np.median(spec[side]) + 1e-12) + 1e-12)
    if i0 < 1 or i0 >= len(spec) - 1:
        return None, 0.0
    a, b, c = np.log(spec[i0 - 1] + 1e-12), np.log(spec[i0] + 1e-12), np.log(spec[i0 + 1] + 1e-12)
    den = a - 2 * b + c
    d = 0.5 * (a - c) / den if den != 0 else 0.0
    return float(hz[i0] + d * (hz[1] - hz[0])), float(snr)


def pilot_to_ppm(pilot_hz):
    """Clock error in parts per million for a measured pilot frequency (positive = dongle clock runs fast)."""
    return (19000.0 / pilot_hz - 1.0) * 1e6
