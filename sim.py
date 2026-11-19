"""sim.py - a fake RTL-SDR for trying the whole app without hardware.

SimSource has the same interface as RtlTcpSource and produces real-time uint8 IQ containing
modulated fake stations and aircraft, so the real demodulators, scanner, squelch, APRS and
ADS-B decoders are exercised end to end.
"""
import math
import random
import time

import numpy as np

import adsb
import afsk
import ais
import datalink

AUDIO_FS = 48000


class _Speechish:
    """Procedural voice-like audio: warbling formants gated at a syllable rate."""

    def __init__(self, seed):
        self.ph = 0.0
        self.n = 0

    def block(self, n):
        t = (np.arange(n) + self.n) / AUDIO_FS
        self.n += n
        syl = np.clip(np.sin(2 * np.pi * 3.3 * t) + 0.3, 0, 1)
        f = 350 + 250 * np.sin(2 * np.pi * 1.7 * t) + 90 * np.sin(2 * np.pi * 7.1 * t)
        ph = 2 * np.pi * np.cumsum(f) / AUDIO_FS + self.ph
        self.ph = float(ph[-1] % (2 * np.pi))
        return (0.55 * syl * (np.sin(ph) + 0.4 * np.sin(2 * ph))).astype(np.float32)


class _Musicish:
    """Procedural music: arpeggio of sine tones with a little vibrato."""

    def __init__(self, seed):
        r = random.Random(seed)
        self.notes = [r.choice([220, 261.6, 329.6, 392, 440, 523.3, 659.3]) for _ in range(16)]
        self.n = 0
        self.ph = 0.0

    def block(self, n):
        idx = np.arange(n) + self.n
        self.n += n
        step = (idx // 9600) % len(self.notes)
        f = np.array(self.notes)[step] * (1 + 0.004 * np.sin(2 * np.pi * 5 * idx / AUDIO_FS))
        ph = 2 * np.pi * np.cumsum(f) / AUDIO_FS + self.ph
        self.ph = float(ph[-1] % (2 * np.pi))
        env = 0.5 + 0.5 * np.exp(-((idx % 9600) / 9600.0) * 3)
        return (0.6 * env * (np.sin(ph) + 0.3 * np.sin(2 * ph))).astype(np.float32)


class Station:
    def __init__(self, freq, kind, label, level=0.25, on=None, period=None, dev=None, seed=0):
        self.freq, self.kind, self.label, self.level = float(freq), kind, label, level
        self.on, self.period = on, period
        self.dev = dev or {"wfm": 50000, "nfm": 2800, "am": 0}[kind]
        self.audio_src = _Musicish(seed) if kind == "wfm" else _Speechish(seed)
        self.phase = 0.0
        self.queue = np.zeros(0, dtype=np.float32)
        self.offset = random.Random(seed).uniform(0, period or 1)

    def active(self, t):
        if self.period is None:
            return True
        return ((t + self.offset) % self.period) < self.on

    def audio(self, n48):
        while len(self.queue) < n48:
            self.queue = np.concatenate((self.queue, self.audio_src.block(4800)))
        out, self.queue = self.queue[:n48], self.queue[n48:]
        return out


class AprsBeacon(Station):
    """Transmits an AFSK-1200 APRS packet every `period_s` seconds on NFM."""

    def __init__(self, freq, calls, lat, lon, period_s=22.0, **kw):
        super().__init__(freq, "nfm", "APRS", level=0.3, **kw)
        self.calls, self.lat, self.lon, self.period_s = calls, lat, lon, period_s
        self.pending = np.zeros(0, dtype=np.float32)
        self.next_t = time.time() + 3.0
        self.i = 0

    def active(self, t):
        return len(self.pending) > 0

    def audio(self, n48):
        now = time.time()
        if len(self.pending) == 0 and now >= self.next_t:
            call = self.calls[self.i % len(self.calls)]
            self.i += 1
            la = self.lat + 0.05 * math.sin(now / 90.0 + self.i) + 0.03 * (self.i % 3)
            lo = self.lon + 0.05 * math.cos(now / 70.0 + self.i) + 0.03 * (self.i % 2)

            def dm(v, w):
                a = abs(v)
                d = int(a)
                return "%0*d%05.2f" % (w, d, (a - d) * 60)
            info = "!%s%s/%s%s>Simulated APRS beacon" % (dm(la, 2), "S" if la < 0 else "N", dm(lo, 3), "W" if lo < 0 else "E")
            frame = afsk.build_ax25(call, "APRS", ["WIDE1-1"], info)
            self.pending = afsk.modulate(frame, preamble=30, amp=0.7)
            self.next_t = now + self.period_s
        take = self.pending[:n48]
        self.pending = self.pending[n48:]
        if len(take) < n48:
            take = np.concatenate((take, np.zeros(n48 - len(take), dtype=np.float32)))
        return take


class AisShip(Station):
    """A simulated ship sending AIS position reports (GMSK 9600 baud) on one of the two AIS channels."""

    def __init__(self, freq, mmsi, name, lat, lon, period_s=7.0, **kw):
        super().__init__(freq, "nfm", "AIS", level=0.3, **kw)
        self.mmsi, self.name, self.lat, self.lon, self.period_s = mmsi, name, lat, lon, period_s
        self.pending = np.zeros(0, dtype=np.float32)
        self.next_t = time.time() + 1.0
        self.n = 0

    def active(self, t):
        self._start()
        return len(self.pending) > 0

    def _start(self):
        now = time.time()
        if len(self.pending) == 0 and now >= self.next_t:
            self.n += 1
            if self.n % 4 == 0:
                bits = ais.encode_static(self.mmsi, "VK%04d" % (self.mmsi % 10000), self.name, 70)
            else:
                bits = ais.encode_position(self.mmsi, self.lat + 0.002 * self.n, self.lon + 0.001 * self.n, 8.5, 45.0)
            self.pending = np.concatenate([np.zeros(200, dtype=np.float32), ais.modulate(ais.frame_bits(bits), 0.7)])
            self.next_t = now + self.period_s

    def audio(self, n48):
        self._start()
        take = self.pending[:n48]
        self.pending = self.pending[n48:]
        if len(take) < n48:
            take = np.concatenate((take, np.zeros(n48 - len(take), dtype=np.float32)))
        return take


class IdentBeacon(Station):
    """A VOR/NDB style identifier: a 1020 Hz tone keyed in Morse on an AM carrier, repeating."""

    CODE = dict(zip("ABCDEFGHIJKLMNOPQRSTUVWXYZ", ".- -... -.-. -.. . ..-. --. .... .. .--- -.- .-.. -- -. --- .--. --.- .-. ... - ..- ...- .-- -..- -.-- --..".split()))

    def __init__(self, freq, ident, wpm=12, gap_s=5.0, **kw):
        super().__init__(freq, "am", "ident", level=0.3, **kw)
        u = 1.2 / wpm
        out = []
        t = np.arange(int(u * AUDIO_FS * 3)) / AUDIO_FS
        for ch in ident:
            for k, sym in enumerate(self.CODE[ch]):
                d = u * (1 if sym == "." else 3)
                tt = np.arange(int(d * AUDIO_FS)) / AUDIO_FS
                env = np.minimum(1, np.minimum(tt, d - tt) / 0.004)
                out.append(0.8 * np.sin(2 * np.pi * 1020 * tt) * env)
                if k < len(self.CODE[ch]) - 1:
                    out.append(np.zeros(int(u * AUDIO_FS)))
            out.append(np.zeros(int(3 * u * AUDIO_FS)))
        out.append(np.zeros(int(gap_s * AUDIO_FS)))
        self.loop = np.concatenate(out).astype(np.float32)
        self.pos = 0
        self.del_t = t

    def audio(self, n48):
        idx = (np.arange(n48) + self.pos) % len(self.loop)
        self.pos = (self.pos + n48) % len(self.loop)
        return self.loop[idx]


class _Bursts(Station):
    """Sends a prepared burst of modulating audio every `period_s` seconds (silent, carrier off, in between)."""

    def __init__(self, freq, kind, label, period_s, level=0.3, dev=None, **kw):
        super().__init__(freq, kind, label, level=level, dev=dev, **kw)
        self.period_s = period_s
        self.pending = np.zeros(0, dtype=np.float32)
        self.next_t = time.time() + 2.0
        self.n = 0

    def make(self):
        raise NotImplementedError

    def active(self, t):
        self._start()
        return len(self.pending) > 0

    def _start(self):
        now = time.time()
        if len(self.pending) == 0 and now >= self.next_t:
            self.n += 1
            self.pending = np.concatenate([np.zeros(480, dtype=np.float32), self.make()])
            self.next_t = now + self.period_s

    def audio(self, n48):
        self._start()
        take = self.pending[:n48]
        self.pending = self.pending[n48:]
        if len(take) < n48:
            take = np.concatenate((take, np.zeros(n48 - len(take), dtype=np.float32)))
        return take


class AcarsSim(_Bursts):
    MSGS = [("G-EUPT", "H1", "BA0431", "POS 033200,FL370,M42"), ("N512UA", "_d", "UA0815", ""),
            ("D-AIMA", "Q0", "LH0503", ""), ("F-HPJA", "5Z", "AF0001", "/ETA 0645 GATE 31")]

    def __init__(self, freq=131.55e6, **kw):
        super().__init__(freq, "am", "ACARS", 9.0, level=0.25, **kw)

    def make(self):
        reg, label, flight, text = self.MSGS[self.n % len(self.MSGS)]
        return datalink.acars_audio(datalink.acars_message(reg, label, text, flight=flight, msgno="M%02dA" % (self.n % 100)), 0.9)


class PagerSim(_Bursts):
    PAGES = [(1234567, 3, "TEST PAGE: SIMULATED MESSAGE 1"), (200, 0, "0412345678"), (77001, 3, "SIM: CALL BASE WHEN FREE")]

    def __init__(self, freq=148.6375e6, **kw):
        super().__init__(freq, "nfm", "Pager", 12.0, level=0.3, dev=4500, **kw)

    def make(self):
        return datalink.nrz_audio(datalink.pocsag_bits([self.PAGES[self.n % len(self.PAGES)]]), 1200)


class SondeSim(Station):
    """A weather balloon climbing from near you at 5 m/s, drifting east, bursting at 25 km, sending a frame a second."""

    def __init__(self, freq, lat, lon, serial="S0123456", **kw):
        super().__init__(freq, "nfm", "Radiosonde", level=0.3, dev=2400, **kw)
        self.lat0, self.lon0, self.serial = lat + 0.28, lon - 0.42, serial      # a launch site about 50 km away
        self.t0 = time.time() - 1500
        self.pending = np.zeros(0, dtype=np.float32)
        self.frame = 0

    def _state(self, t):
        s = t - self.t0
        burst = 25000 / 5.0
        if s < burst:
            alt, vu = 30 + 5.0 * s, 5.0
        else:
            alt, vu = max(30.0, 25030 - 12.0 * (s - burst)), -12.0
        ve, vn = 9.0, -2.0
        return (self.lat0 + vn * s / 111320.0, self.lon0 + ve * s / (111320.0 * math.cos(math.radians(self.lat0))), alt, ve, vn, vu)

    def audio(self, n48):
        while len(self.pending) < n48:
            now = time.time()
            lat, lon, alt, ve, vn, vu = self._state(now)
            self.frame += 1
            fr = datalink.rs41_frame(self.serial, self.frame, lat, lon, alt, ve, vn, vu, t=now)
            bits = [1, 0] * 64 + datalink.rs41_bits(fr)
            a = datalink.nrz_audio(bits, 4800, 1.0)
            self.pending = np.concatenate((self.pending, a, np.zeros(max(0, AUDIO_FS - len(a)), dtype=np.float32)))
        take, self.pending = self.pending[:n48], self.pending[n48:]
        return take


def default_stations(lat=0.0, lon=0.0, region="intl", country=""):
    """Practice signals for the region: FM inside its band, AM on its raster, its walkie-talkies and APRS frequency."""
    import regions
    S, r = Station, regions.get(region, country)
    lo, hi = r["fm"]
    mid = regions.fm_default(region)
    if (lo, hi) == (87.5e6, 108e6):
        fm = [88.1e6, 96.9e6, 100.0e6, 104.1e6, 106.5e6]
    else:                                               # a different FM band (Japan): spread the stations across it
        fm = [round(f / 1e5) * 1e5 for f in (lo + 0.6e6, lo + (mid - lo) * 0.45, mid, mid + (hi - mid) * 0.3, hi - 1.5e6)]
    step = r["am"][2]
    am = [round(891e3 / step) * step, round(1269e3 / step) * step]
    walk = []
    for key in r["short"]:
        chans = regions.SHORT_PLANS[key]["fn"]()
        if chans and chans[0]["f"] > 100e6:                      # a UHF/VHF walkie-talkie plan (not 27 MHz CB)
            walk = [chans[i % len(chans)] for i in (0, 6, 12)]
            break
    talk = [S(c["f"], "nfm", "Sim " + c["label"], lvl, on=on, period=per, seed=sd)
            for c, lvl, on, per, sd in zip(walk, (0.30, 0.22, 0.26), (4, 6, 3), (17, 29, 41), (10, 11, 12))]
    call = r["ham_call"][0] if r["ham_call"] else 145.5e6
    return [
        S(fm[0], "wfm", "Sim FM %.1f" % (fm[0] / 1e6), 0.30, seed=1),
        S(fm[1], "wfm", "Sim FM %.1f" % (fm[1] / 1e6), 0.35, seed=2),
        S(fm[2], "wfm", "Sim FM %.1f" % (fm[2] / 1e6), 0.40, seed=3),
        S(fm[3], "wfm", "Sim FM %.1f" % (fm[3] / 1e6), 0.28, seed=4),
        S(fm[4], "wfm", "Sim FM %.1f" % (fm[4] / 1e6), 0.22, seed=5),
        S(am[0], "am", "Sim AM %d" % (am[0] / 1e3), 0.30, seed=6),
        S(am[1], "am", "Sim AM %d" % (am[1] / 1e3), 0.25, seed=16),
        S(118.1e6, "am", "Sim ATC", 0.25, on=6, period=19, seed=7),
        S(120.5e6, "am", "Sim ATC 2", 0.20, on=4, period=31, seed=8),
        S(121.5e6, "am", "Sim guard", 0.15, on=2, period=57, seed=18),
        S(156.8e6, "nfm", "Sim Marine 16", 0.25, on=5, period=23, seed=9),
        *talk,
        S(call, "nfm", "Sim 2m calling", 0.24, on=5, period=37, seed=13),
        AprsBeacon(r["aprs"], ["N0CALL-9", "N0CALL-7", "N0CALL-1"], lat, lon, seed=14),
        AisShip(161.975e6, 235123456, "MV SIM STAR", lat - 0.1, lon + 0.1, 3.0, seed=21),
        AisShip(162.025e6, 244111222, "SIM TRAWLER", lat - 0.2, lon + 0.2, 3.5, seed=22),
        IdentBeacon(113.6e6, "TST", 12, 4.0, seed=23),
        AcarsSim(131.55e6, seed=24),
        PagerSim(148.6375e6, seed=25),
        SondeSim(401.5e6, lat, lon, seed=26),
    ]


class SimAircraft:
    def __init__(self, icao, callsign, lat, lon, heading, speed, alt, vrate=0):
        self.icao, self.callsign = icao, callsign
        self.lat0, self.lon0, self.heading, self.speed, self.alt, self.vrate = lat, lon, heading, speed, alt, vrate
        self.t0 = time.time()
        self.next_pos = self.t0 + random.random() * 0.5
        self.next_vel = self.t0 + random.random() * 0.5
        self.next_id = self.t0 + random.random() * 4
        self.odd = False

    def pos(self, t):
        d = self.speed * 0.514444 * (t - self.t0)          # metres travelled
        h = math.radians(self.heading)
        lat = self.lat0 + math.degrees(d * math.cos(h) / 6371000.0)
        lon = self.lon0 + math.degrees(d * math.sin(h) / (6371000.0 * math.cos(math.radians(self.lat0))))
        return lat, lon

    def due(self, now):
        out = []
        if now >= self.next_pos:
            lat, lon = self.pos(now)
            alt = self.alt + self.vrate * (now - self.t0) / 60.0
            out.append(adsb.encode_position(self.icao, max(alt, 0), lat, lon, self.odd))
            self.odd = not self.odd
            self.next_pos = now + 0.5
        if now >= self.next_vel:
            out.append(adsb.encode_velocity(self.icao, self.speed, self.heading, self.vrate))
            self.next_vel = now + 0.5
        if now >= self.next_id:
            out.append(adsb.encode_ident(self.icao, self.callsign))
            self.next_id = now + 5.0
        return out


def default_aircraft(lat, lon):
    return [
        SimAircraft(0x400A2D, "BAW431", lat + 0.20, lon - 0.35, 112, 430, 31000, 0),
        SimAircraft(0xA4B811, "UAL812", lat - 0.30, lon + 0.20, 335, 360, 24000, 640),
        SimAircraft(0x3C6E04, "DLH523", lat + 0.05, lon + 0.60, 262, 290, 9500, -1280),
        SimAircraft(0x4CA1F6, "EIN207", lat - 0.55, lon - 0.45, 41, 250, 14000, 0),
        SimAircraft(0xA1B2C3, "UAE413", lat + 0.65, lon + 0.15, 188, 480, 38000, 0),
    ]


class SimSource:
    name = "Simulated RTL-SDR"
    tuner = "Simulated tuner"
    kind = "Simulator"
    sim = True
    v4 = False

    def __init__(self, fs=2_400_000, freq=100.0e6, gain=30.0, stations=None, aircraft=None, lat=0.0, lon=0.0, region="intl", country=""):
        self.fs = int(fs)
        self.freq = float(freq)
        self.gain = gain if gain else 30.0
        self.stations = stations or default_stations(lat, lon, region, country)
        self.aircraft = aircraft if aircraft is not None else default_aircraft(lat, lon)
        self.home = (lat, lon)
        self.rng = np.random.default_rng(7)
        self.t0 = time.perf_counter()
        self.nsent = 0
        self.pll_fail = 0
        self.stderr_lines = ["simulated device - no hardware in use"]
        self._ov = np.zeros(0, dtype=np.complex128)
        self.direct = 0

    # control
    def set_freq(self, hz): self.freq = float(hz)
    def set_gain(self, db):
        if db is not None:
            self.gain = float(db)
    def set_agc(self, on): pass
    def set_ppm(self, ppm): pass
    def set_direct(self, mode): self.direct = int(mode)
    def set_bias_tee(self, on): pass
    def set_offset_tuning(self, on): self.offset_tuning = bool(on)
    def set_sample_rate(self, fs):
        self.fs = int(fs)
        self.t0 = time.perf_counter()
        self.nsent = 0
    def close(self): pass
    def alive(self): return True
    def take_pll_count(self):
        n, self.pll_fail = self.pll_fail, 0
        return n

    def _adsb_overlay(self, n, gscale):
        """Complex samples carrying any ADS-B bursts due in this chunk (fs must be 2.0 MS/s)."""
        ov = np.zeros(n + 600, dtype=np.complex128)
        if len(self._ov):
            k = min(len(self._ov), len(ov))
            ov[:k] += self._ov[:k]
        now = time.time()
        for ac in self.aircraft:
            for fr in ac.due(now):
                lat, lon = ac.pos(now)
                d, _ = adsb._distance_bearing(self.home[0], self.home[1], lat, lon)
                amp = 0.35 * max(0.12, 1.0 - d / 200.0)
                w = adsb.modulate([fr], gap=0, amp=amp)
                off = int(random.random() * max(n - 10, 1))
                ov[off:off + len(w)] += w * np.exp(1j * random.uniform(0, 6.283))
        self._ov = ov[n:].copy()
        return ov[:n] * gscale

    def read_samples(self, n):
        """n complex samples as raw uint8 bytes (2n bytes), paced in real time."""
        due = self.t0 + (self.nsent + n) / self.fs
        dt = due - time.perf_counter()
        if dt > 0:
            time.sleep(dt)
        elif dt < -1.0:
            self.t0 = time.perf_counter() - (self.nsent + n) / self.fs
        t_wall = time.time()
        fs = self.fs
        n48 = n * AUDIO_FS // fs
        gscale = 10 ** ((self.gain - 30.0) / 20.0)
        sig = np.zeros(n, dtype=np.complex128)
        tt = (np.arange(n) + self.nsent) / fs
        direct_ok = self.direct == 0 or self.freq < 14.4e6
        for st in self.stations:
            f_off = st.freq - self.freq
            audible = abs(f_off) <= fs / 2 * 0.98 and direct_ok
            if not audible:
                if not isinstance(st, AprsBeacon):
                    st.audio(n48)
                continue
            act = st.active(t_wall)
            a = st.audio(n48)
            if not act:
                continue
            m = np.interp(np.arange(n) / (fs / AUDIO_FS), np.arange(n48), a) if n48 > 1 else np.zeros(n)
            if st.kind == "am":
                sig += st.level * (1 + 0.8 * m) * np.exp(1j * (2 * np.pi * f_off * tt))
            else:
                ph = st.phase + np.cumsum(2 * np.pi * (f_off + st.dev * m) / fs)
                st.phase = float(ph[-1] % (2 * np.pi))
                sig += st.level * np.exp(1j * ph)
        if fs == 2_000_000 and abs(1090e6 - self.freq) < 200e3:
            sig += self._adsb_overlay(n, 1.0)
        sig *= gscale
        noise = (self.rng.standard_normal(n) + 1j * self.rng.standard_normal(n)) * (0.006 * gscale)
        iq = sig + noise + (0.03 + 0.02j)
        out = np.empty(2 * n, dtype=np.uint8)
        out[0::2] = np.clip(iq.real * 127.5 + 127.5, 0, 255).astype(np.uint8)
        out[1::2] = np.clip(iq.imag * 127.5 + 127.5, 0, 255).astype(np.uint8)
        self.nsent += n
        return out.tobytes()
