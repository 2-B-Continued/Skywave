"""engine.py - the radio engine: owns the dongle and runs one job at a time.

Jobs: listen (also covers scanning), adsb (plane tracking), sweep (find signals / seek),
ism (433 MHz sensors via rtl_433), health (dongle check) and record (baseband recording).
Clients (browser tabs) receive binary spectrum/audio frames and JSON events through queues.
"""
import base64
import collections
import json
import math
import os
import queue
import shlex
import shutil
import socket
import struct
import subprocess
import threading
import time
import wave

import numpy as np

import adsb
import gainmem
import sensorstore
import afsk
import banks as banks_mod
import captions as captions_mod
import morse as morse_mod
import ais as ais_mod
import datalink
import regions
import prolab
import dsp
import lab as lab_mod
import iq_tools
import sources
import timers as timers_mod
from sim import SimSource

LUT = ((np.arange(256, dtype=np.float32) - 127.5) / 127.5)
SPEC_OFFSET, SPEC_SCALE = 110.0, 2.2          # dB -> uint8:  (dB + 110) * 2.2


def q_db(db):
    return np.clip((db + SPEC_OFFSET) * SPEC_SCALE, 0, 255).astype(np.uint8)


IDLE_RELEASE_S = 600      # with nobody connected, keep the radio open this long (10 min), so coming back to the app or another device plays at once


# the gain finder's steps (dB), matching the R820T/R828D tuner's table
GAINS = (8.7, 14.4, 19.7, 25.4, 29.7, 33.8, 37.2, 40.2, 43.4, 49.6)

class Client:
    def __init__(self):
        self.q = queue.Queue(maxsize=80)
        self.alive = True
        self.dropped = 0
        self.t0 = time.time()

    MAX_LIVE = 8                                    # about 0.4 s of audio/spectrum frames: older ones are dropped, never played late

    def put(self, item):
        if isinstance(item, bytes) and self.q.qsize() >= self.MAX_LIVE:
            with self.q.mutex:                      # a slow listener catches up by skipping, so sound is never behind real time
                frames = [x for x in self.q.queue if isinstance(x, bytes)]
                keep = [x for x in self.q.queue if not isinstance(x, bytes)] + frames[-3:]   # keep the newest few: a short skip, not a 0.4 s hole
                if len(frames) > 3:
                    self.dropped += 1
                self.q.queue.clear()
                self.q.queue.extend(keep)
        try:
            self.q.put_nowait(item)
        except queue.Full:
            try:                                # drop the backlog rather than lag further behind
                while True:
                    self.q.get_nowait()
            except queue.Empty:
                pass
            self.dropped += 1
            try:
                self.q.put_nowait(item)
            except queue.Full:
                pass


class AudioClient(Client):
    """A page's sound socket (/ws?audio=1). It gets only sound, and keeps up to 1.5 s of it queued: the player on the page has
    its own cushion and handles a burst far better than a hole, so only a backlog longer than 0.5 s is trimmed (oldest first)."""
    LIMIT = 48000 * 4 // 2                         # 0.5 s of 48 kHz stereo 16-bit: never let a slow link build up delay

    def __init__(self):
        super().__init__()
        self.q = queue.Queue()
        self.queued = 0
        self.lock = threading.Lock()

    def put(self, item):
        if not isinstance(item, bytes):
            return
        with self.lock:
            self.q.put_nowait(item)
            self.queued += len(item)
            while self.queued > self.LIMIT:
                try:
                    old = self.q.get_nowait()
                except queue.Empty:
                    self.queued = 0
                    break
                self.queued -= len(old)
                self.dropped += 1

    def take(self, timeout=1.0):
        it = self.q.get(timeout=timeout)
        with self.lock:
            self.queued = max(0, self.queued - len(it))
        return it


class WavAudio:
    """Streaming 16-bit mono WAV writer."""

    def __init__(self, path, rate=48000):
        self.path = path
        self.w = wave.open(path, "wb")
        self.w.setnchannels(1)
        self.w.setsampwidth(2)
        self.w.setframerate(rate)
        self.bytes = 0

    def write(self, pcm):
        self.w.writeframes(pcm)
        self.bytes += len(pcm)

    def close(self):
        try:
            self.w.close()
        except Exception:
            pass


class Mp3Audio:
    """Streams 16-bit mono PCM into ffmpeg's MP3 encoder, so recordings are ~10x smaller than WAV."""

    def __init__(self, path, rate=48000, kbps=48):
        self.path = path
        self.bytes = 0
        self.p = subprocess.Popen(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "s16le", "-ar", str(rate), "-ac", "1", "-i", "pipe:0",
             "-codec:a", "libmp3lame", "-b:a", "%dk" % int(kbps), path],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def write(self, pcm):
        try:
            self.p.stdin.write(pcm)
            self.bytes += len(pcm)
        except (OSError, ValueError):
            pass

    def close(self):
        try:
            self.p.stdin.close()
        except Exception:
            pass
        try:
            self.p.wait(timeout=20)
        except Exception:
            self.p.kill()


def open_audio_writer(path_base, fmt, kbps=48, rate=48000):
    """Returns (writer, final_path). Falls back to WAV when MP3 is wanted but ffmpeg is missing."""
    if fmt == "mp3":
        if shutil.which("ffmpeg"):
            try:
                return Mp3Audio(path_base + ".mp3", rate, kbps), path_base + ".mp3"
            except OSError:
                pass
    return WavAudio(path_base + ".wav", rate), path_base + ".wav"


class WavBaseband:
    """Streaming 8-bit stereo (I/Q) WAV writer. RTL data is already unsigned 8-bit I/Q."""

    def __init__(self, path, rate):
        self.path = path
        self.f = open(path, "wb")
        self.rate = int(rate)
        self.bytes = 0
        self.f.write(self._header(0))

    def _header(self, n):
        return (b"RIFF" + struct.pack("<I", 36 + n) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 2, self.rate, self.rate * 2, 2, 8) +
                b"data" + struct.pack("<I", n))

    def write(self, raw):
        self.f.write(raw)
        self.bytes += len(raw)

    def close(self):
        try:
            self.f.seek(0)
            self.f.write(self._header(min(self.bytes, 0xFFFFFFF0 - 36)))
            self.f.close()
        except Exception:
            pass


def _safe_name(s):
    return "".join(c if c.isalnum() or c in "-_." else "_" for c in s)[:60]


class Engine(threading.Thread):
    def __init__(self, cfg, bank_store, space):
        super().__init__(daemon=True, name="engine")
        self.cfg, self.banks, self.space = cfg, bank_store, space
        self.clients = set()
        self.sinks = set()                      # live MP3 stream listeners (phones playing in the background)
        self.cl_lock = threading.Lock()
        self.cmdq = queue.Queue()
        self._stop_ev = threading.Event()
        self.lock = threading.Lock()
        self.src = None
        self.error = ""
        self.fs = int(cfg["sample_rate"])
        self.vfo = regions.fm_default(cfg.get("region"), cfg.get("country"))          # the middle of the region's FM band
        self.center = self.vfo + 1.1e6
        self.mode, self.bw = "wfm", 200000
        self.squelch_db = 0.0
        self.aprs_on = False
        self.rec = None
        self.rec_path = ""
        self.rec_auto = False
        self.rx = None
        self.sa = dsp.SpectrumAnalyzer(4096, 6)
        self.lab = lab_mod.load(cfg.path_for("lab.json"))
        self.fx = lab_mod.AudioFx(self.lab)
        self.sv = None                      # separate display analyser, only when the lab changes FFT size / window / averaging
        self.tones = prolab.Tones()
        self.udp = None
        self.zs = None                      # zoom spectrum + I/Q scope, while the Lab asks for them
        self.live_want = {"zoom": 0.0, "scope": 0.0}
        self.chrec = None                   # recording of just the tuned channel (48 kHz I/Q)
        self.perf = {"load": 0.0, "ms": 0.0}
        self._afc_base = None
        self.nb_hits = 0
        self._lab_display()
        self.job = "listen"
        self.table = adsb.AircraftTable(cfg["lat"], cfg["lon"])
        self._load_cover()
        self.aprs_dec = afsk.AfskDecoder()
        self.aprs_log = collections.deque(maxlen=200)
        self.aprs_calls = {}
        self.sstore = sensorstore.SensorStore(cfg.path_for("sensors.json"))   # sensors heard, remembered between restarts
        self.sensors = self.sstore.devs
        self.sensor_log = collections.deque(maxlen=100)
        self.snr = 0.0
        self.floor = -80.0
        self.level = -80.0
        self.gate = True
        self._gate_until = 0.0
        self.discard_until = 0.0
        self.tick = 0
        self.last_state = 0.0
        self.last_client_seen = time.time()
        self.scan = None
        self.scan_log = collections.deque(maxlen=200)
        self.sweep = None
        self.health = None
        self.calib = None
        self.ism = None
        self.recbb = None
        self.doppler = None
        self.sweep_result = None
        self.survey_signals = []
        self.aircraft_t = 0.0
        self.adsb_demod = None
        self.adsb_rate = (0, time.time(), 0)
        self.sched_id = None
        self.air = None                 # 'air watch': alternate between tracking planes and listening to air traffic
        self._air_internal = False
        self.sched_audio = None          # a scheduled sound recording of a satellite pass in progress
        self.cap = captions_mod.Captioner(cfg, self.emit)
        self.morse = morse_mod.MorseDecoder()
        self._morse_f = None
        self.morse_force = None              # frequency where the user asked for Morse decoding (stays on until they retune away)
        self.morse_on = False
        self.tap_name = None
        self.ais = None                         # native AIS decoder
        self._ais_hop = 0.0
        self._ais_idx = 0
        self._ais_pub = 0.0
        self.dl = None                          # aircraft messages / pagers / weather balloons riding on the listen job
        self.sondes = datalink.SondeTracker()
        self.dl_log = collections.deque(maxlen=400)   # recent aircraft and pager messages, in memory only
        self.clip = 0.0                          # share of samples hitting the converter's limits (overload)
        self.gtune = None                        # the gain finder, while it runs
        self.gmem = gainmem.GainMemory(cfg.path_for("gain_memory.json"))   # best gain remembered per frequency
        self.gm_entry = None                     # the remembered gain in use here, if any
        self._gm_key = None
        self._gm_watch = None                    # the quiet check after arriving at a remembered frequency
        self._gm_last_q = {}                     # when each entry was last re-tuned quietly (at most every 10 minutes)
        self._gm_internal = False
        self.sig = None                          # measured width and shape of the signal at the tuned frequency
        self._sig_t = 0.0
        self.adsb_hist = collections.deque(maxlen=360)   # a picture of the sky every 10 s for the last hour (replay)
        self._hist_t = 0.0
        self.dl_hook = None                     # called with ("sensor"|"sonde", dict) for outside consumers (MQTT)
        self.cap.match = self._match_planes
        self.timers = timers_mod.TimerStore(os.path.join(cfg["data_dir"], "timers.json"))
        self.on_record_done = None       # called with (path, meta) when a raw recording finishes
        self.log_hook = None             # called with each notice (server keeps a log for the Help page)
        self.dev_info = {}
        self._rx_key = None
        self._open_fail_t = 0.0
        self.set_mode_raw("wfm")

    # ------------------------------------------------------------------ clients / events
    def add_client(self, audio=False):
        c = AudioClient() if audio else Client()
        with self.cl_lock:
            self.clients.add(c)
        self.last_client_seen = time.time()
        return c

    def remove_client(self, c):
        c.alive = False
        with self.cl_lock:
            self.clients.discard(c)
        self.last_client_seen = time.time()

    def broadcast(self, item):
        """Sound frames (type 2 mono, 3 stereo) go only to sound sockets; everything else only to page sockets."""
        sound = isinstance(item, bytes) and item[:1] in (b"\x02", b"\x03")
        with self.cl_lock:
            cl = [c for c in self.clients if isinstance(c, AudioClient) == sound]
        for c in cl:
            c.put(item)

    def add_sink(self):
        with self.cl_lock:
            if len(self.sinks) >= 4:                    # a phone that went to sleep can leave a dead listener behind: the newest listener wins
                oldest = min(self.sinks, key=lambda x: x.t0)
                oldest.alive = False
                self.sinks.discard(oldest)
            c = Client()
            self.sinks.add(c)
        return c

    def remove_sink(self, c):
        c.alive = False
        with self.cl_lock:
            self.sinks.discard(c)
        self.last_client_seen = time.time()

    def _feed_sinks(self, mono=None, lr=None):
        with self.cl_lock:
            sk = list(self.sinks)
        if not sk:
            return
        if lr is None:
            lr = np.repeat(mono.astype(np.float32), 2)
        b = dsp.to_pcm16(lr)
        for c in sk:
            c.put(b)

    def emit(self, typ, **kw):
        kw["type"] = typ
        if typ == "notice" and self.log_hook:
            try:
                self.log_hook(kw.get("level", "info"), kw.get("text", ""))
            except Exception:
                pass
        self.broadcast(json.dumps(kw, separators=(",", ":")))

    def notice(self, text, level="info"):
        self.emit("notice", text=text, level=level)

    def command(self, cmd):
        if not isinstance(cmd, dict) or self.cmdq.qsize() > 500:      # junk or a flood: ignore
            return
        for v in cmd.values():
            if isinstance(v, float) and not math.isfinite(v):         # NaN / Infinity would break the tuner maths
                return
        self.cmdq.put(cmd)

    def stop(self):
        self._stop_ev.set()

    # ------------------------------------------------------------------ source management
    def _open(self, fs=None, freq=None):
        self.clip_quiet_until = time.time() + 2.5
        self._gm_key = "reopen"                  # the radio starts at the general gain: put the remembered one back
        self._close_source()
        fs = fs or self.fs
        freq = freq or self.center
        cfg = self.cfg
        try:
            if cfg["iq_file"]:
                self.src = sources.FileSource(cfg.path_for("recordings", cfg["iq_file"]), fs, cfg["iq_center"] or freq)
                fs = self.src.fs
                self.center = self.src.freq
            elif cfg["sim"]:
                self.src = SimSource(fs=fs, freq=freq, gain=cfg["sat_gain_db"] if self.job == "record" else cfg["gain_db"], lat=cfg["lat"], lon=cfg["lon"], region=cfg.get("region") or "intl", country=cfg.get("country") or "")
            else:
                rec = self.job == "record"          # satellite passes use their own fixed gain: automatic gain hunts mid-pass
                self.src = sources.RtlTcpSource(fs=fs, freq=freq, gain_db=cfg["sat_gain_db"] if rec else cfg["gain_db"],
                                                gain_auto=False if rec else cfg["gain_auto"],
                                                ppm=cfg["ppm"], device=cfg["devices"].get("radio", 0),
                                                remote=cfg["rtl_tcp"] or None, bias_t=cfg["bias_t"])
        except sources.SourceError as e:
            self.src = None
            self.error = str(e)
            self._open_fail_t = time.time()
            return False
        cv = cfg.get("conv") or {}
        if cv.get("lo") and not cfg["iq_file"]:
            self.src = sources.Converter(self.src, cv["lo"], cv.get("invert"), cv.get("below", 0))
            try:
                self.src.set_freq(freq)
            except sources.SourceError:
                pass
        self.error = ""
        self.fs = fs
        self.dev_info = {"name": self.src.name, "tuner": self.src.tuner, "v4": bool(getattr(self.src, "v4", False)),
                         "sim": bool(self.src.sim)}
        self.discard_until = time.monotonic() + cfg["settle_s"] + 0.1      # the tuner's first moments after opening
        self._rx_key = None
        self._apply_hf()
        return True

    def _close_source(self):
        if self.src:
            try:
                self.src.close()
            except Exception:
                pass
        self.src = None

    def _apply_hf(self):
        """Direct sampling for low frequencies on dongles without a built-in upconverter."""
        if not self.src:
            return
        mode = self.cfg["hf_mode"]
        want = 0
        f = self.center
        dm = self.lab.get("direct_mode", "auto")
        if dm in ("i", "q"):
            want = 1 if dm == "i" else 2
        elif dm == "off":
            want = 0
        elif mode == "direct" or (mode == "auto" and not getattr(self.src, "v4", False)
                                  and getattr(self.src, "tuner", "") != "unknown tuner"):    # an unrecognised tuner may be a newer V4-type dongle: never guess direct sampling
            if f < 24e6:
                want = 2
        try:
            self.src.set_direct(want)
        except sources.SourceError:
            pass

    def _retune(self, center, settle=None):
        if getattr(self.src, "fixed", False):
            return
        self.center = float(center)
        if self.src:
            try:
                self._apply_hf()
                self.src.set_freq(self.center)
            except sources.SourceError as e:
                self._fail(str(e))
                return
        self.discard_until = time.monotonic() + (self.cfg["settle_s"] if settle is None else settle)

    def _fail(self, msg):
        self.error = msg
        self._close_source()
        self.emit("notice", text=msg, level="error")

    def _ensure_rx(self):
        if self.fs not in (2400000, 1920000, 1200000, 960000):
            # a leftover rate from another job (e.g. ADS-B's 2.0 MS/s): go back to the configured listening rate
            self.fs = int(self.cfg["sample_rate"])
            self._close_source()
        key = (self.fs, self.cfg["deemph_us"])
        if self.rx is None or self._rx_key != key:
            self.rx = dsp.Receiver(self.fs, self.cfg["deemph_us"])
            self.rx.configure(self.mode, self.bw)
            self._rx_key = key
            self._lab_rx()
            self.chunk = (self.fs // 20) // self.rx.chunk_multiple * self.rx.chunk_multiple
            self.aprs_dec = afsk.AfskDecoder()

    def set_mode_raw(self, mode, bw=None):
        self.mode = mode
        self.bw = float(bw or dsp.DEFAULT_BW[mode])
        if self.rx:
            try:
                self.rx.configure(self.mode, self.bw)
                self.bw = self.rx.bw
            except ValueError:
                pass

    # ------------------------------------------------------------------ commands
    def _drain_commands(self):
        while True:
            try:
                c = self.cmdq.get_nowait()
            except queue.Empty:
                return
            try:
                self._do_cmd(c)
            except Exception as e:           # never let one bad message kill the engine
                self.notice("Could not do that: %s" % e, "error")

    def _do_cmd(self, c):
        cmd = c.get("cmd")
        if cmd == "tune":
            self._to_listen()
            if not c.get("keep_doppler"):
                self.doppler = None            # tuning by hand cancels satellite Doppler following
            f = float(c["freq"])
            mode = c.get("mode")
            if mode in (None, "auto"):
                name, m = banks_mod.band_for(f)
                if mode == "auto" or c.get("auto"):
                    mode = m
            if mode:
                self.set_mode_raw(mode, c.get("bw"))
            elif c.get("bw"):
                self.set_mode_raw(self.mode, c["bw"])
            self._set_vfo(f, c.get("dir", 1), c.get("recenter", False))
        elif cmd == "center":
            self._to_listen()
            self._retune(float(c["freq"]))
        elif cmd == "mode":
            self.set_mode_raw(c["mode"], c.get("bw"))
        elif cmd == "squelch":
            self.squelch_db = float(c.get("db", 0))
        elif cmd == "tap":
            self._tap_cmd(c.get("name"), c.get("freq"))
        elif cmd == "lab_live":                    # the Lab asks for the zoom spectrum / scopes; it repeats this while it shows them
            now = time.monotonic()
            for k in ("zoom", "scope"):
                if c.get(k):
                    self.live_want[k] = now + 8.0
                elif k in c:
                    self.live_want[k] = 0.0
        elif cmd == "chan_rec":
            self._chan_rec(bool(c.get("on")))
        elif cmd == "dtmf_clear":
            self.tones.dtmf = ""
        elif cmd == "gain_tune":
            if c.get("stop"):
                self._gain_tune_end(apply=False)
            elif self.job == "listen" and self.src is not None and not getattr(self.src, "fixed", False):
                self._gm_watch = None
                self.gtune = {"gains": list(GAINS), "i": -1, "t": 0.0, "res": [], "acc": [], "quiet": False,
                              "was": self._runtime_gain(), "public": {"i": 0, "n": len(GAINS)}}
        elif cmd == "gain_forget":
            if self.gmem.forget(self.vfo):
                self.gm_entry, self._gm_watch = None, None
                self._gm_key = "forgot"
                self.notice("Forgot the gain for this frequency. The general gain from Settings is used here again.", "info")
        elif cmd == "gain_down" and self.gm_entry:
            g = max(0.0, float(self.gm_entry["gain"]) - 8.0)          # lower the remembered gain for this frequency
            self.gm_entry = self.gmem.put(self.vfo, g, self.gm_entry.get("snr"))
            self._gm_key = self._gm_k(self.gm_entry)
            self._set_gain_rt(g)
            self.notice("Gain lowered to %.1f dB for this frequency." % g, "info")
        elif cmd == "gain_down":
            g = max(0.0, float(self.cfg["gain_db"]) - 8.0)
            self.cfg.update({"gain_auto": False, "gain_db": g})
            self.cfg.save()
            self._config_changed({"gain_db": g, "gain_auto": False})
            self.emit("config", config=self.cfg.public())
            self.notice("Gain lowered to %.1f dB." % g, "info")
        elif cmd == "dl_history":
            self.emit("dl_history", list=self.dl_history(), sondes=self.sondes.public(), tap=self.tap_public())
        elif cmd == "sonde_forget":
            self.sondes.sondes.pop(str(c.get("serial", "")), None)
            self.emit("sondes", list=self.sondes.public(), tap=self.tap_public())
        elif cmd == "aprs":
            self.aprs_on = bool(c.get("on"))
            if self.aprs_on:
                self.aprs_dec = afsk.AfskDecoder()
        elif cmd == "rec_audio":
            if not c.get("on") and self.sched_audio:
                self._rec_audio(False)
                self._end_sched_audio("Recording stopped. It won't restart for this pass.")
            else:
                self._rec_audio(bool(c.get("on")), auto=False, fmt=c.get("fmt") if c.get("fmt") in ("wav", "mp3") else None)
        elif cmd == "airwatch":
            if c.get("on"):
                self._air_start(c)
            else:
                self._air_stop("Back to normal.")
        elif cmd == "captions":
            if c.get("on") and not self.cfg.get("captions", True):
                self.notice("Captions are switched off in Settings.", "warn")
            else:
                self.cap.set_context(self.vfo, self.mode, banks_mod.label_for(self.vfo))
                if c.get("on") and not self.cap.allowed:
                    self.notice("Captions are only for spoken channels (walkie-talkies, aircraft, marine, ham and similar), "
                                "not for radio stations. Tune to a spoken channel first.", "warn")
                self.cap.set_on(bool(c.get("on")), c.get("save"))
        elif cmd == "morse":
            self.morse_force = self.vfo if c.get("on") else None
            if c.get("on") and self.mode == "wfm":
                self.notice("Morse decoding works on narrow channels (CW, SSB, AM or narrow FM), not on FM music stations.", "warn")
        elif cmd == "seek":
            self._start_seek(int(c.get("dir", 1)))
        elif cmd == "scan":
            self._scan_cmd(c)
        elif cmd == "job":
            self._start_job(c.get("name"), c.get("params") or {})
        elif cmd == "sweep":
            self._start_sweep(c)
        elif cmd == "doppler":
            if c.get("on"):
                self.doppler = {"sat": c["sat"], "f0": float(c["f0"])}
            else:
                self.doppler = None
        elif cmd == "lab":
            self._lab_cmd(c)
        elif cmd == "config":
            self._config_changed(c.get("changed") or {})
        elif cmd == "reset_cover":
            self.reset_cover()
        elif cmd == "clear_aircraft":
            self.table.clear()
        elif cmd == "clear_aprs":
            self.aprs_log.clear()
            self.aprs_calls.clear()
        elif cmd == "reset":
            self._close_source()
            self.error = ""
            self._open_fail_t = 0.0
            self.notice("Restarting the radio...")
        elif cmd == "ping":
            pass

    # ---- receiver lab ------------------------------------------------------------------
    def _lab_display(self):
        L = self.lab
        if (L["nfft"], L["window"], L["avg"]) == (4096, "hann", 6):
            self.sv = None
        else:
            self.sv = dsp.SpectrumAnalyzer(int(L["nfft"]), int(L["avg"]), L["window"])

    def _lab_rx(self):
        L, rx = self.lab, self.rx
        self.fx = lab_mod.AudioFx(L)
        if not rx:
            return
        rx.stereo_on, rx.rds_on = bool(L["fm_stereo"]), bool(L["fm_rds"])
        rx.agc_on = L["agc_mode"] != "off"
        rx.agc_rate = {"default": 0.15, "fast": 0.4, "medium": 0.15, "slow": 0.03}.get(L["agc_mode"], 0.15)
        rx.agc_tscale = L["agc_target"] / 0.22
        rx.agc_gmax = (10 ** (L["agc_max_db"] / 20.0)) if L["agc_mode"] != "default" else None
        rx.agc_custom = (L["agc_attack_ms"] / 1000.0, L["agc_decay_ms"] / 1000.0, L["agc_hang_ms"] / 1000.0) if L["agc_mode"] == "custom" else None
        if rx.am_det != L["am_det"] or abs(rx.pll_hz - L["pll_hz"]) > 0.5:
            rx.am_det, rx.pll_hz, rx.sam = L["am_det"], L["pll_hz"], None
        want = (L["udp_host"], int(L["udp_port"]), int(L["udp_rate"])) if L["udp_on"] and L["udp_host"] else None
        have = (self.udp.addr[0], self.udp.addr[1], prolab.FS // self.udp.k) if self.udp else None
        if want != have:
            if self.udp:
                self.udp.close()
            self.udp = None
            if want:
                try:
                    self.udp = prolab.UdpAudio(*want)
                except (OSError, ValueError) as e:
                    self.notice("Network sound could not start: %s" % e, "error")
        redo = abs(rx.cw_pitch - L["cw_pitch"]) > 0.5 or abs(rx.ssb_shift - L["ssb_shift"]) > 0.5
        rx.cw_pitch, rx.ssb_shift = L["cw_pitch"], L["ssb_shift"]
        if redo:
            rx.configure(self.mode, self.bw)

    def _lab_source(self):
        if not self.src:
            return
        L = self.lab
        try:
            self.src.set_agc(L["tuner_agc"])
            self.src.set_offset_tuning(L["offset_tuning"])
            self._apply_hf()
        except (sources.SourceError, AttributeError):
            pass

    def _lab_cmd(self, c):
        new, changed = lab_mod.validate(c.get("set") or {}, self.lab if not c.get("reset") else lab_mod.DEFAULTS)
        if c.get("reset"):
            changed = {k for k in new if new[k] != self.lab.get(k)}
        self.lab = new
        lab_mod.save(self.cfg.path_for("lab.json"), self.lab)
        if changed & {"nfft", "window", "avg"}:
            self._lab_display()
        self._lab_rx()
        if changed & {"tuner_agc", "offset_tuning", "direct_mode"}:
            self._lab_source()
        self.emit("lab", lab=self.lab)

    def _config_changed(self, changed):
        if any(k in changed for k in ("gain_db", "gain_auto")):
            self.clip_quiet_until = time.time() + 2.5
            self.clip_slow = 0.0
            if not self._gm_internal and self.gm_entry and self.gmem.forget(self.vfo):
                self.gm_entry, self._gm_key, self._gm_watch = None, None, None    # you chose a gain yourself here: that wins
        if "lat" in changed or "lon" in changed:
            self.table.set_home(self.cfg["lat"], self.cfg["lon"])
        if "sample_rate" in changed and self.job in ("listen",):
            self.fs = int(self.cfg["sample_rate"])
            self._close_source()
        if "iq_file" in changed or "iq_center" in changed:
            self._close_source()
        if "conv" in changed:
            self._close_source()
        if any(k in changed for k in ("gain_db", "gain_auto", "ppm", "bias_t", "hf_mode", "deemph_us", "devices")):
            if "deemph_us" in changed:
                self._rx_key = None
            if self.src and self.job in ("listen", "sweep", "health"):
                try:
                    if "gain_db" in changed or "gain_auto" in changed:
                        self.src.set_gain(None if self.cfg["gain_auto"] else self.cfg["gain_db"])
                    if "ppm" in changed:
                        self.src.set_ppm(int(self.cfg["ppm"]))
                    if "bias_t" in changed:
                        self.src.set_bias_tee(bool(self.cfg["bias_t"]))
                    if "hf_mode" in changed:
                        self._apply_hf()
                except sources.SourceError as e:
                    self._fail(str(e))
            if "devices" in changed:
                self._close_source()

    def _set_vfo(self, f, direction=1, recenter=False):
        self._afc_base = None
        self.vfo = float(f)
        margin = 0.36 * self.fs
        if getattr(self.src, "fixed", False):
            return                                  # playing a file: the window cannot move
        if recenter or abs(self.vfo - self.center) > margin or self.src is None and False:
            newc = self.vfo + (0.18 * self.fs if direction >= 0 else -0.18 * self.fs)
            if self.vfo < 12e6 and self.cfg["hf_mode"] != "off":
                newc = self.vfo
            self._retune(max(newc, 100e3))

    def _to_listen(self):
        if self.job not in ("listen",):
            self._stop_job()
            self.job = "listen"
            self.fs = int(self.cfg["sample_rate"])
            self._close_source()

    # ------------------------------------------------------------------ job control
    def _tap_cmd(self, name, freq=None):
        """Start or stop a decoder that rides on the listen job: ships (AIS), aircraft messages, pagers, balloons."""
        self.tap_name = None
        self.ais = None
        if self.dl:
            for c in self.dl["chans"]:
                if hasattr(c["dec"], "close"):
                    c["dec"].close()
        self.dl = None
        if not name:
            self.emit("tap_state", **self.tap_public())
            return
        if name == "ais":
            self._to_listen()
            self.ais = ais_mod.AisDecoder()
            self.tap_name = "ais"
            self.set_mode_raw("nfm", 16000)
            self._ais_idx = 0
            self._ais_hop = time.monotonic() + 4
            self._retune(161.975e6)
            self.vfo = 161.975e6
        elif name == "acars":
            self._to_listen()
            chans = self._acars_freqs(freq)
            span = self.fs * 0.8
            chans = [f for f in chans if abs(f - chans[0]) <= span][:6]
            center = (min(chans) + max(chans)) / 2.0
            if any(abs(f - center) < 40e3 for f in chans):
                center += 150e3                       # keep every channel clear of the dongle's centre spike
            self.tap_name = "acars"
            self.set_mode_raw("am", 10000)
            self._retune(center)
            self.vfo = chans[0]
            self.dl = {"kind": "acars", "chans": [self._dl_chan(f, datalink.Acars(f)) for f in chans]}
        elif name == "pager":
            self._to_listen()
            f = float(freq or self.cfg.get("pager_freq") or 0)
            if not 25e6 < f < 1.7e9:
                self.notice("Pick the pager channel first: tune to it, or type its frequency.", "warn")
                self.emit("tap_state", **self.tap_public())
                return
            if self.cfg.get("pager_freq") != f:
                self.cfg.update({"pager_freq": f})
                self.cfg.save()
            self.tap_name = "pager"
            self.set_mode_raw("nfm", 16000)
            self._retune(f + 250e3)
            self.vfo = f
            self.dl = {"kind": "pager", "chans": [self._dl_chan(f, datalink.Pocsag(f))]}
        elif name == "sonde":
            self._to_listen()
            fixed = float(freq) if freq else None
            span = self.fs * 0.8
            wins = []
            c = 400.0e6 + span / 2
            while c - span / 2 < 406.0e6:
                wins.append(c)
                c += span
            self.tap_name = "sonde"
            self.set_mode_raw("nfm", 12500)
            self.dl = {"kind": "sonde", "fixed": fixed, "wins": wins, "wi": 0, "hop": time.monotonic() + 8.0, "chans": [],
                       "lock": 0.0, "look": 0.0, "pub": 0.0}
            if fixed:
                self._retune(fixed + 250e3)
                self.vfo = fixed
                self.dl["chans"] = [self._dl_chan(fixed, datalink.Rs41(fixed))]
            else:
                self._retune(wins[0])
                self.vfo = wins[0] - 0.3e6
        self.emit("tap_state", **self.tap_public())

    def _acars_freqs(self, freq=None):
        if isinstance(freq, list) and freq:
            try:
                return [float(f) for f in freq]
            except (TypeError, ValueError):
                pass
        own = [float(f) for f in (self.cfg.get("acars_freqs") or [])]
        if own:
            return own
        return list(datalink.ACARS_CHANNELS[regions.get(self.cfg.get("region"), self.cfg.get("country"))["acars"]])

    def _dl_chan(self, f, dec):
        return {"f": float(f), "dec": dec, "ch": None, "hits": 0, "t": time.monotonic()}

    def tap_public(self):
        d = {"name": self.tap_name}
        if self.ais:
            d["count"] = self.ais.frames
            d["vessels"] = len(self.ais.vessels)
        if self.dl:
            dl = self.dl
            d["chans"] = [{"f": c["f"], "hits": c["hits"]} for c in dl["chans"]]
            if dl["kind"] == "sonde":
                d["fixed"] = dl["fixed"]
                d["scanning"] = not dl["fixed"] and time.monotonic() > dl["lock"]
                d["window"] = [self.center - self.fs * 0.4, self.center + self.fs * 0.4]
        return d

    def _tap_step(self, in_window, iq=None, spec=None):
        """Per-chunk work for the active decoder tap; called from the listen loop."""
        if self.tap_name is None:
            return
        if self.dl is not None and iq is not None:
            self._dl_step(iq, spec)
            return
        d = self.rx.raw_disc if self.rx is not None else None
        if self.ais is not None and in_window and d is not None and self.mode == "nfm":
            self.ais.process(d)
            now = time.monotonic()
            if now >= self._ais_hop:                          # share the dongle between the two AIS channels
                self._ais_idx ^= 1
                f = (161.975e6, 162.025e6)[self._ais_idx]
                self._ais_hop = now + 4
                self._retune(f)
                self.vfo = f
            if self.ais.changed and time.time() - self._ais_pub > 1.0:
                self.ais.changed = False
                self._ais_pub = time.time()
                self.emit("ais", vessels=self.ais.public(), frames=self.ais.frames)

    def _watch_hit(self, text):
        t = (text or "").lower()
        return [w for w in (self.cfg.get("watch_words") or []) if w.lower() in t]

    def _dl_step(self, iq, spec):
        dl = self.dl
        now = time.monotonic()
        if dl["kind"] == "sonde" and not dl["fixed"]:
            self._sonde_hunt(spec, now)
            if self.dl is not dl:
                return
        for c in dl["chans"]:
            if abs(c["f"] - self.center) > self.fs * 0.45:
                continue
            if c["ch"] is None or c["ch"].fs != self.fs:
                c["ch"] = datalink.Channel(self.fs, c["f"])
            for m in c["dec"].process(c["ch"].process(iq, self.center)):
                c["hits"] += 1
                c["t"] = now
                if dl["kind"] == "sonde":
                    if now > dl["lock"]:
                        self.vfo = c["f"]              # first frame: put the balloon's chirp in the speaker
                    dl["lock"] = now + 40.0
                    s = self.sondes.add(m, (self.cfg["lat"], self.cfg["lon"], self.cfg.get("alt", 0.0)))
                    if self.dl_hook:
                        self.dl_hook("sonde", s)
                    continue
                m["kind"] = dl["kind"]
                m["hit"] = self._watch_hit(" ".join(str(m.get(k, "")) for k in ("text", "flight", "reg", "addr")))
                self.dl_log.append(m)
                self.emit("dl_msg", **m)
        if dl["kind"] == "sonde" and (self.sondes.changed and time.time() - dl["pub"] > 1.0):
            self.sondes.changed = False
            dl["pub"] = time.time()
            self.emit("sondes", list=self.sondes.public(), tap=self.tap_public())

    def _sonde_hunt(self, spec, now):
        """Look across 400-406 MHz for narrow carriers, listen to each, and stay put while a balloon is decoding."""
        dl = self.dl
        if now > dl["lock"] and now >= dl["hop"]:
            dl["wi"] = (dl["wi"] + 1) % len(dl["wins"])
            dl["chans"] = []
            dl["hop"] = now + 8.0
            self._retune(dl["wins"][dl["wi"]])
            self.emit("tap_state", **self.tap_public())
            return
        if spec is None or now < dl["look"]:
            return
        dl["look"] = now + 1.0
        n = len(spec)
        binw = self.fs / n
        floor = dsp.noise_floor_db(spec)
        hot = spec > floor + 9.0
        i = 0
        found = []
        while i < n:
            if hot[i]:
                j = i
                while j < n and hot[j]:
                    j += 1
                width = (j - i) * binw
                if width < 25e3:
                    seg = 10 ** (spec[i:j] / 10.0)
                    k = float((np.arange(i, j) * seg).sum() / seg.sum())
                    f = self.center + (k - n / 2) * binw
                    if 400.0e6 <= f <= 406.0e6 and abs(f - self.center) > 20e3 and abs(f - self.center) < self.fs * 0.42:
                        found.append((float(spec[i:j].max()), round(f / 1e3) * 1e3))
                i = j
            else:
                i += 1
        for _, f in sorted(found, reverse=True)[:4]:
            if not any(abs(c["f"] - f) < 15e3 for c in dl["chans"]):
                dl["chans"].append(self._dl_chan(f, datalink.Rs41(f)))
        dl["chans"] = [c for c in dl["chans"] if c["hits"] or now - c["t"] < 20.0][-6:]

    def _pro_step(self, iq, audio, in_window):
        """Lab extras that need the live signal: tone and keypad detection, AFC, zoom spectrum and scope, channel recording."""
        L, rx = self.lab, self.rx
        if not in_window:
            return
        if self.mode == "nfm" and (L["tones"] or L["sq_mode"] in ("ctcss", "dcs")):
            self.tones.feed_disc(rx.raw_disc)
        if L["dtmf"] and self.mode in ("nfm", "am", "usb", "lsb", "dsb", "wfm") and self.gate:
            k = self.tones.feed_audio(audio)
            if k:
                self.emit("dtmf", key=k, digits=self.tones.dtmf, f=self.vfo)
        if L["afc"] and self.mode == "nfm" and self.gate and self.snr > 10 and not self.scan:
            if self._afc_base is None or abs(self.vfo - self._afc_base) > L["afc_range"] + 500:
                self._afc_base = self.vfo
            step = max(-60.0, min(60.0, 0.25 * rx.afc_hz))
            if abs(rx.afc_hz) > 40:
                self.vfo = min(self._afc_base + L["afc_range"], max(self._afc_base - L["afc_range"], self.vfo + step))
        now = time.monotonic()
        wz, ws = now < self.live_want["zoom"], now < self.live_want["scope"]
        if wz or ws:
            if self.zs is None or self.zs.fs != self.fs:
                self.zs = prolab.ZoomScope(self.fs)
            self.zs.process(iq, self.center, self.vfo, float(L["zoom_span"]), wz, ws, self.emit)
        elif self.zs is not None:
            self.zs = None
        if self.chrec is not None:
            self.chrec.write(iq, self.center)

    def _chan_rec(self, on):
        if on and self.chrec is None and self.job == "listen" and self.src is not None:
            name = "channel-%s-%.4fMHz.wav" % (time.strftime("%Y%m%d-%H%M%S"), self.vfo / 1e6)
            self.chrec = prolab.ChanRecorder(self.cfg.path_for("recordings", name), self.fs, self.vfo)
            self.chrec.name = name
            self.emit("chan_rec", on=True, file=name)
        elif not on and self.chrec is not None:
            r, self.chrec = self.chrec, None
            secs = r.close()
            self.emit("chan_rec", on=False, file=r.name, seconds=round(secs, 1))
            self.notice("Channel I/Q saved: %s (%d s). Find it in the Library." % (r.name, secs), "info")

    def _measure_signal(self, spec, off):
        """Width and shape of whatever is at the tuned frequency, from the fine spectrum (for the signal identifier)."""
        n = len(spec)
        binw = self.fs / n
        c = int(round(n / 2 + off / binw))
        span = int(min(150e3 if self.mode == "wfm" else 30e3, self.fs / 4) / binw)
        lo, hi = max(1, c - span), min(n - 1, c + span)
        if hi - lo < 8:
            return None
        seg = spec[lo:hi]
        floor = dsp.noise_floor_db(spec)
        k = int(np.argmax(seg))
        peak = float(seg[k])
        if peak < floor + 6:
            return {"snr": round(peak - floor, 1), "bw": 0, "shape": "none"}
        thr = max(floor + 3, peak - 20)
        a = k
        while a > 0 and seg[a - 1] > thr:
            a -= 1
        b = k
        while b < len(seg) - 1 and seg[b + 1] > thr:
            b += 1
        width = (b - a + 1) * binw
        body = seg[a:b + 1]
        spike = peak - float(np.median(body)) if len(body) > 4 else 0.0
        flat = float(np.std(body)) if len(body) > 4 else 99.0
        shape = "carrier" if width < 1500 else ("am" if spike > 9 else ("flat" if flat < 3.0 else "fm"))
        return {"snr": round(peak - floor, 1), "bw": int(round(width / 100.0) * 100), "shape": shape,
                "off": int(round((lo + k - n / 2) * binw - off))}

    def _gain_tune_step(self):
        """Try a range of gains on the tuned signal and keep the one with the best signal-to-noise that does not overload."""
        g = self.gtune
        now = time.monotonic()
        if g["i"] >= 0:
            if now < g["t"] - 0.6:
                return
            if now < g["t"]:
                g["acc"].append((self.snr, self.clip, self.floor))
                return
            if g["acc"]:
                g["res"].append((g["gains"][g["i"]], float(np.median([x[0] for x in g["acc"]])), float(np.mean([x[1] for x in g["acc"]])),
                                 float(np.median([x[2] for x in g["acc"]]))))
            g["acc"] = []
        g["i"] += 1
        if g["i"] >= len(g["gains"]):
            self._gain_tune_end(apply=True)
            return
        gain = g["gains"][g["i"]]
        try:
            self.src.set_gain(gain)
        except sources.SourceError:
            pass
        self.discard_until = now + 0.35
        self.clip = 0.0
        g["t"] = now + 1.2
        g["public"] = {"i": g["i"] + 1, "n": len(g["gains"]), "gain": gain, "quiet": bool(g.get("quiet"))}

    def _gain_tune_end(self, apply):
        g, self.gtune = self.gtune, None
        if not g:
            return
        quiet = g.get("quiet")
        res = g.get("res") or []
        ok = [r for r in res if r[2] < 0.002]
        best = None
        if apply and ok:
            top = max(r[1] for r in ok)
            if top >= 6:
                best = min((r for r in ok if r[1] >= top - 1.0), key=lambda r: r[0])     # the lowest gain within 1 dB of the best
            else:                                    # nothing much on this channel: highest gain that keeps the noise floor sane
                best = ok[-1]
        if best:
            # remembered for this frequency and used whenever you come back (the general gain in Settings is left alone)
            self.gm_entry = self.gmem.put(self.vfo, best[0], best[1])
            self._gm_key = self._gm_k(self.gm_entry)
            self._gm_watch = None
            self._set_gain_rt(best[0])
            if not quiet:
                self.notice("Gain set to %.1f dB for this frequency. Skywave uses it automatically whenever you come back here." % best[0], "info")
        elif quiet and apply and res:
            least = min(res, key=lambda r: (round(r[2], 3), -r[1]))      # all overload: at least the least bad one
            self.gm_entry = self.gmem.put(self.vfo, least[0], least[1])
            self._gm_key = self._gm_k(self.gm_entry)
            self._set_gain_rt(least[0])
        else:
            self._set_gain_rt(g["was"])
            if apply and not quiet:
                self.notice("Every gain setting overloaded on this frequency. A filter or attenuator, or moving the antenna, will help.", "warn")
        if not quiet:
            self.emit("gain_tune", results=[{"gain": r[0], "snr": round(r[1], 1), "clip": round(r[2] * 100, 2)} for r in res],
                      chosen=best[0] if best else None)

    # ---- gain remembered per frequency
    def _runtime_gain(self):
        """The gain the radio should use here: the remembered one, else the general setting (None = automatic)."""
        if self.gm_entry:
            return self.gm_entry["gain"]
        return None if self.cfg["gain_auto"] else float(self.cfg["gain_db"])

    def _set_gain_rt(self, gain):
        try:
            self.src.set_gain(gain)
        except (sources.SourceError, AttributeError):
            pass
        self.clip_quiet_until = time.time() + 2.5
        self.clip_slow = 0.0

    @staticmethod
    def _gm_k(e):
        return (round(e["f"]), e["gain"]) if e else None

    def _gm_tick(self):
        """Arriving at a remembered frequency: use its gain at once, then check quietly that it is still right."""
        if self.src is None or getattr(self.src, "fixed", False) or self.scan or self.air:
            return
        now = time.time()
        e = self.gmem.find(self.vfo)
        key = self._gm_k(e)
        if key != self._gm_key:
            had = self._gm_key
            self._gm_key, self.gm_entry, self._gm_watch = key, e, None
            if e:
                self._set_gain_rt(e["gain"])
                self._gm_watch = {"start": now + 3.0, "end": now + 7.0, "snr": [], "clip": []}
            elif had is not None:
                self._set_gain_rt(self._runtime_gain())          # left it: back to the general gain
            return
        w = self._gm_watch
        if not w or now < w["start"]:
            return
        w["snr"].append(self.snr)
        w["clip"].append(self.clip)
        if now < w["end"]:
            return
        self._gm_watch = None
        clip, snr = float(np.mean(w["clip"])), float(np.median(w["snr"]))
        stale = now - (e.get("checked") or e["t"]) > 86400
        bad = clip > 0.01 or (e.get("snr") is not None and e["snr"] >= 6 and snr < e["snr"] - 6)
        if (bad or stale) and now - self._gm_last_q.get(round(e["f"]), 0) > 600:
            self._gm_last_q[round(e["f"])] = now
            i = min(range(len(GAINS)), key=lambda k: abs(GAINS[k] - e["gain"]))
            pick = GAINS[max(0, i - 5):i] if clip > 0.01 else GAINS[max(0, i - 1):i + 2]   # overloading: look further down
            self.gtune = {"gains": list(pick), "i": -1, "t": 0.0, "res": [], "acc": [], "quiet": True,
                          "was": e["gain"], "public": {"i": 0, "n": len(pick), "quiet": True}}
        else:
            self.gmem.touch(self.vfo)

    def dl_history(self):
        return list(self.dl_log)[-200:]

    def _stop_job(self):
        if self.chrec is not None:
            self._chan_rec(False)
        if self.gtune:
            self._gain_tune_end(apply=False)
        if self.tap_name:
            self._tap_cmd(None)
        if self.job == "ism":
            self._ism_stop()
        if self.job == "record":
            self._record_stop()
        if self.job == "adsb":
            self.adsb_demod = None
        self.sweep = None
        self.health = None
        self.calib = None
        self.job = "listen"

    def _fallback_to_listen(self):
        """Return to plain listening after a job ended or failed to start (resets the sample rate and the source)."""
        self.job = "listen"
        self.fs = int(self.cfg["sample_rate"])
        self._close_source()

    def _start_job(self, name, params):
        if name == self.job and name in ("adsb", "ism"):
            cur = self.ism or {}
            want_tool = "rtlamr" if params.get("tool") == "rtlamr" else "rtl_433"
            have_tool = "rtlamr" if cur.get("aux") is not None else "rtl_433"
            if name == "ism" and ((params.get("freq") and params.get("freq") != cur.get("freq")) or [float(x) for x in (params.get("freqs") or [])][:4] != (cur.get("freqs") or [])
                                  or want_tool != have_tool):
                pass                                     # a different frequency, hop list or decoder: restart it
            else:
                return
        if name not in ("listen", "adsb", "ism", "health", "record", "calibrate"):
            raise ValueError("unknown job %r" % name)
        if self.air and not self._air_internal:
            self._air_stop()
        self._stop_job()
        self.scan = None
        self._rec_audio(False)
        self._end_sched_audio()
        self.emit("job", name=name)
        if name == "listen":
            # already listening with the radio open at the listening rate: keep it open (reopening costs a second or two)
            keep = self.job == "listen" and self.src is not None and self.fs == int(self.cfg["sample_rate"])
            self.job = "listen"
            self.fs = int(self.cfg["sample_rate"])
            if not keep:
                self._close_source()
        elif name == "adsb":
            self.job = "adsb"
            self.adsb_demod = adsb.Demodulator()
            self.table.set_home(self.cfg["lat"], self.cfg["lon"])
            self.fs = adsb.ADSB_FS
            self._close_source()
            self.center = 1090e6
            self.adsb_rate = (0, time.time(), 0)
        elif name == "ism":
            self._close_source()
            self._ism_start(params)
        elif name == "health":
            self._close_source()
            self.job = "health"
            self.health = {"i": 0, "results": [], "t": 0, "stage": "start"}
            self.fs = 2400000
        elif name == "record":
            self._close_source()
            self._record_start(params)
        elif name == "calibrate":
            self._close_source()
            stations = []
            for f in (params.get("stations") or [])[:6]:
                try:
                    f = float(f)
                    if 87.5e6 <= f <= 108e6:
                        stations.append(f)
                except (TypeError, ValueError):
                    pass
            self.job = "calibrate"
            self.calib = {"stations": stations, "i": 0, "results": []}
            self.fs = 2400000

    def _wanted(self):
        if self.job == "record" or self.sched_audio:
            return True
        with self.cl_lock:
            n = len(self.clients) + len(self.sinks)
        return n > 0

    # ------------------------------------------------------------------ main loop
    def run(self):
        while not self._stop_ev.is_set():
            try:
                self._drain_commands()
                self._check_schedule()
                self._check_airwatch()
                if not self._wanted():
                    if self.src or self.job == "ism":
                        if time.time() - self.last_client_seen > IDLE_RELEASE_S:
                            self._idle_release()
                    time.sleep(0.15)
                    continue
                if self.job == "ism":
                    self._step_ism()
                    continue
                if self.src is None:
                    if self.job == "record":
                        pass
                    elif time.time() - self._open_fail_t < 4.0 and self.error:
                        self._publish_state()
                        time.sleep(0.2)
                        continue
                    else:
                        self._publish_state(connecting=True)
                        fs = self.fs if self.job != "health" else 2400000
                        if not self._open(fs=fs, freq=self.center):
                            self.emit("notice", text=self.error, level="error")
                            continue
                        if self.job == "adsb":
                            self.src.set_gain(None if False else self.cfg["adsb_gain_db"])
                            self.src.set_freq(1090e6)
                        self._ensure_rx() if self.job == "listen" else None
                try:
                    if self.job == "listen":
                        self._step_listen()
                    elif self.job == "adsb":
                        self._step_adsb()
                    elif self.job == "sweep":
                        self._step_sweep()
                    elif self.job == "health":
                        self._step_health()
                    elif self.job == "record":
                        self._step_record()
                    elif self.job == "calibrate":
                        self._step_calibrate()
                except sources.SourceError as e:
                    self._fail(str(e))
                    time.sleep(0.5)
                self._publish_state()
            except Exception as e:
                import traceback
                traceback.print_exc()
                self.notice("Internal error: %s" % e, "error")
                time.sleep(0.5)
        self._close_source()

    def _idle_release(self):
        self._rec_audio(False)
        if self.job == "ism":
            self._ism_stop()
        self._stop_job()
        self.scan = None
        self._close_source()

    # ------------------------------------------------------------------ state publishing
    def state(self):
        with self.lock:
            st = {"job": self.job, "center": self.center, "vfo": self.vfo, "mode": self.mode, "bw": self.bw,
                  "fs": self.fs, "nb_hits": self.nb_hits, "squelch": self.squelch_db, "snr": round(self.snr, 1), "gate": self.gate,
                  "floor": round(self.floor, 1), "aprs": self.aprs_on, "tap": self.tap_name, "error": self.error,
                  "status": "error" if self.error else ("ok" if self.src or self.job == "ism" else "idle"),
                  "device": self.dev_info, "rec": bool(self.rec), "rec_file": os.path.basename(self.rec_path) if self.rec else "",
                  "stereo": bool(self.rx and self.rx.stereo_active and self.mode == "wfm"),
                  "rds": self._rds_public(),
                  "morse": {"on": self.morse_on, "forced": self.morse_force is not None},
                  "clip": round(self.clip * 100, 2), "clip_avg": round(getattr(self, "clip_slow", 0.0) * 100, 2), "perf": {"load": round(self.perf["load"], 1), "ms": round(self.perf["ms"], 2)},
                  "tones": self.tones.public() if self.mode == "nfm" or self.tones.dtmf else None,
                  "quiet": round(self.rx.quiet, 0) if self.rx and self.mode == "nfm" else None,
                  "afc": round(self.vfo - self._afc_base) if self._afc_base is not None and self.lab["afc"] else None,
                  "sam": {"lock": round(self.rx.sam.lock, 2), "off": round(self.rx.sam.offset_hz, 1)} if self.rx and self.rx.sam and self.mode == "am" else None,
                  "chrec": self.chrec.name if self.chrec else None, "udp": {"sent": self.udp.sent, "err": self.udp.err} if self.udp else None, "gtune": self.gtune["public"] if self.gtune else None, "ism": {"freq": self.ism["freq"], "freqs": self.ism.get("freqs") or [], "t0": self.ism["t0"], "n": self.ism.get("n", 0), "tool": "rtlamr" if self.ism.get("aux") is not None else "rtl_433"} if self.ism else None, "gmem": {"f": self.gm_entry["f"], "gain": self.gm_entry["gain"], "checked": self.gm_entry.get("checked")} if self.gm_entry else None, "sig": self.sig,
                  "doppler": self.doppler, "clients": sum(1 for c in self.clients if not isinstance(c, AudioClient)), "captions": self.cap.public(),
                  "air": ({"freqs": self.air["freqs"], "phase": self.air["phase"], "adsb_s": self.air["adsb_s"],
                           "listen_s": self.air["listen_s"], "left": round(max(0, self.air["t"] + (self.air["adsb_s"] if self.air["phase"] == "adsb" else self.air["listen_s"]) - time.time()), 1)} if self.air else None)}
            if self.scan:
                s = self.scan
                st["scan"] = {"bank": s["bank"], "name": s["name"], "state": s["state"], "hold": s["hold"],
                              "window": s["wi"] + 1, "windows": len(s["windows"]), "channels": len(s["chans"]),
                              "cur": s.get("cur"), "record": s["record"], "locked": sorted(s["lockout"]),
                              "hits": {str(k): v for k, v in list(s["hits"].items())[-60:]}}
            return st

    def _rds_public(self):
        rx = self.rx
        if not rx or self.mode != "wfm" or rx.rds is None or not rx.rds_on or rx.rds.info["pi"] is None:
            return None
        return rx.rds.public(us=self.cfg.get("region") in ("us", "ca", "mx"))

    def _publish_state(self, connecting=False):
        now = time.time()
        if now - self.last_state < 0.4 and not connecting:
            return
        self.last_state = now
        st = self.state()
        if connecting:
            st["status"] = "connecting"
        self.emit("state", **st)

    # ------------------------------------------------------------------ listen / scan
    def _read_iq(self, n):
        # Never fall behind live: if processing stalled for a moment, samples pile up in the socket from rtl_tcp and that
        # delay would stay for good (everything after it is late by the same amount). Over 0.3 s waiting: drop the extra,
        # keeping 0.1 s. Costs one system call per block.
        bl = getattr(self.src, "backlog", None)
        if bl is not None and self.fs:
            waiting = bl()
            if waiting > 2 * self.fs * 0.3:
                drop = waiting - int(2 * self.fs * 0.1)
                drop -= drop % 2
                if self.src.skip(drop):
                    self.caught_up = getattr(self, "caught_up", 0) + 1
        raw = self.src.read_samples(n)
        b = np.frombuffer(raw, dtype=np.uint8)
        hit = np.count_nonzero(b[::4] == 0) + np.count_nonzero(b[::4] == 255)     # every 4th byte is plenty for a percentage
        frac = hit / max(1, len(b) // 4)
        self.clip = 0.8 * self.clip + 0.2 * frac                 # fast: Lab's meter and the gain finder
        # slow, for the "too strong" warning: about 3 s of memory, and nothing counted while the tuner settles after the
        # radio opens or the gain changes (the first moments after a restart often clip briefly, which is not a problem)
        if time.time() < getattr(self, "clip_quiet_until", 0):
            self.clip_slow = 0.0
        else:
            self.clip_slow = 0.985 * getattr(self, "clip_slow", 0.0) + 0.015 * frac
        iq = LUT[b].view(np.complex64)
        L = self.lab
        if L["dc_block"]:
            iq = iq - iq.mean()
        if L["iq_swap"]:
            iq = np.conj(iq)
        if L["iq_balance"]:
            iq = lab_mod.iq_balance(iq)
        if L["iq_gain_db"] or L["iq_phase_deg"]:
            iq = lab_mod.iq_manual(iq, L["iq_gain_db"], L["iq_phase_deg"])
        if L["nb_on"]:
            iq, n = lab_mod.noise_blank(iq, L["nb_level"], L["nb_guard"])
            self.nb_hits += n
        return iq

    def _morse_step(self, audio, in_window):
        """Listen for Morse wherever it is normally sent. Costs nothing elsewhere."""
        if self.morse_force is not None and abs(self.morse_force - self.vfo) > 25e3:
            self.morse_force = None                        # tuned away: the manual switch was for that channel only
        forced = self.morse_force is not None and self.mode != "wfm"
        self.morse_on = bool(in_window and (forced or (self.cfg.get("morse", True) and morse_mod.relevant(self.vfo, self.mode))))
        if not self.morse_on:
            if self._morse_f is not None:
                self.morse.reset()
                self._morse_f = None
            return
        if self._morse_f is None or abs(self._morse_f - self.vfo) > 500:
            self.morse.reset()
            self._morse_f = self.vfo
        for r in self.morse.process(audio, time.time()):
            self.cap.add_external({"t": time.time(), "f": self.vfo, "mode": self.mode, "kind": "morse",
                                   "label": banks_mod.label_for(self.vfo) or "", "text": r["text"],
                                   "wpm": r["wpm"], "tone": r["tone"], "dur": 0})

    def _step_listen(self):
        self._ensure_rx()
        if self.doppler:
            self._doppler_step()
        iq = self._read_iq(self.chunk)
        if time.monotonic() < self.discard_until:
            return
        self._t_proc = time.perf_counter()
        self.tick += 1
        spec = self.sa.compute(iq)
        self.floor = dsp.noise_floor_db(spec)
        # --- scanning decides what the VFO is
        if self.scan:
            self._scan_step(spec)
        # --- signal level at the VFO
        off = self.vfo - self.center
        meas_bw = max(self.bw, 8000) if self.mode != "wfm" else 150000
        in_window = abs(off) < self.fs / 2 * 0.95
        if in_window:
            lvl = dsp.channel_level_db(spec, self.fs, off, meas_bw)
            self.level = lvl
            self.snr = 0.5 * self.snr + 0.5 * (lvl - self.floor)
        else:
            self.snr = 0.0
        if self.gtune:
            self._gain_tune_step()
        elif self.job == "listen":
            self._gm_tick()
        if in_window and time.monotonic() - self._sig_t > 1.0:
            self._sig_t = time.monotonic()
            self.sig = self._measure_signal(spec, off)
        # --- squelch gate with hysteresis and hang time
        now = time.monotonic()
        thr = self.squelch_db
        if self.scan:
            thr = self.scan["thr"]
        sqm = self.lab["sq_mode"] if self.mode == "nfm" else "level"
        if not in_window:
            gate = False
        elif sqm == "noise" and not self.scan:
            gate = self.rx.quiet >= self.lab["sq_quiet"] or (self.gate and self.rx.quiet >= self.lab["sq_quiet"] - 8)
        elif sqm == "ctcss" and not self.scan:
            want = self.lab["sq_tone"]
            gate = self.tones.ctcss is not None and (not want or abs(self.tones.ctcss - want) < 0.6)
        elif sqm == "dcs" and not self.scan:
            want = (self.lab["sq_dcs"] or "").upper().replace("D", "").rstrip("NI")
            gate = self.tones.dcs is not None and (not want or self.tones.dcs[1:4] == want.zfill(3))
        elif thr <= 0:
            gate = True
        else:
            if self.snr > thr:
                self._gate_until = now + self.lab["squelch_hang"]
            gate = now < self._gate_until or (self.gate and self.snr > thr - self.lab["squelch_hyst"])
        self.gate = gate
        # --- demodulate (always, so filters stay warm)
        if in_window:
            audio = self.fx.process(self.rx.process(iq, off, gate_open=gate))
        else:
            audio = np.zeros(len(iq) // self.rx.total_dec, dtype=np.float32)
        if self.aprs_on and in_window:
            for pkt in self.aprs_dec.process(audio):
                self._aprs_packet(pkt)
        self._morse_step(audio, in_window)
        self._pro_step(iq, audio, in_window)
        self._tap_step(in_window, iq, spec)
        if self.sched_audio is not None and in_window and self.snr > self.sched_audio.get("peak", -99.0):
            self.sched_audio["peak"] = self.snr
        out = audio if gate else np.zeros_like(audio)
        pcm = dsp.to_pcm16(out)
        if self.udp is not None:
            self.udp.send(out)
        side = self.rx.side if (in_window and gate and self.mode == "wfm" and self.rx.stereo_active) else None
        route = self.lab["route"]
        if side is not None and len(side) == len(out) and route != "mono":
            l, r = out + side * self.fx.gain, out - side * self.fx.gain
            if route == "swap":
                l, r = r, l
            elif route == "left":
                r = np.zeros_like(r)
            elif route == "right":
                l = np.zeros_like(l)
            lr = np.empty(2 * len(out), dtype=np.float32)
            lr[0::2], lr[1::2] = l, r
            self.broadcast(b"\x03" + dsp.to_pcm16(lr))
            self._feed_sinks(lr=lr)
        elif route in ("left", "right"):
            lr = np.zeros(2 * len(out), dtype=np.float32)
            lr[slice(0 if route == "left" else 1, None, 2)] = out
            self.broadcast(b"\x03" + dsp.to_pcm16(lr))
            self._feed_sinks(lr=lr)
        else:
            self.broadcast(b"\x02" + pcm)
            self._feed_sinks(mono=out)
        # Captions come last: the sound has already gone out, so reading it can only ever trail behind what you hear.
        if in_window:
            self.cap.set_context(self.vfo, self.mode, banks_mod.label_for(self.vfo))
            if self.cap.on:
                self.cap.feed(audio, self.snr, self.scan["thr"] if self.scan else self.squelch_db)
        if in_window and self.mode == "wfm" and self.rx.rds is not None:
            if abs(self.vfo - getattr(self, "_rds_f", 0)) > 5e3:
                import rds as _rds
                self._rds_f = self.vfo
                self.rx.rds = _rds.RdsDecoder()
        if self.rec and (gate or not self.rec_auto):
            self.rec.write(pcm)
        # --- spectrum frame at 10 fps
        if self.tick % max(1, int(20 // self.lab["fps"])) == 0:
            dspec = self.sv.compute(iq) if self.sv else spec
            k = len(dspec) // 1024
            s1024 = dspec if k == 1 else (dspec.reshape(1024, k).max(axis=1) if self.lab["decim"] == "peak" else dspec.reshape(1024, k).mean(axis=1))
            hdr = struct.pack(">BdIhh", 1, self.center, self.fs, int(self.floor * 10), int(self.snr * 10))
            self.broadcast(hdr + q_db(s1024).tobytes())
        ms = (time.perf_counter() - self._t_proc) * 1000.0
        dur = len(iq) / float(self.fs) * 1000.0
        self.perf["ms"] = 0.9 * self.perf["ms"] + 0.1 * ms
        self.perf["load"] = 0.9 * self.perf["load"] + 0.1 * (100.0 * ms / dur)

    def _doppler_step(self):
        now = time.time()
        if now - self.doppler.get("t", 0) < 1.0:
            return
        self.doppler["t"] = now
        d = self.space.doppler_hz(self.doppler["sat"], self.doppler["f0"])
        if d is not None:
            self.doppler["shift"] = round(d)
            self.vfo = self.doppler["f0"] + d
            if abs(self.vfo - self.center) > 0.36 * self.fs:
                self._retune(self.vfo + 0.18 * self.fs)

    def _aprs_packet(self, tnc2):
        p = afsk.parse_aprs(tnc2)
        p.pop("info", None)
        self.aprs_log.appendleft(p)
        self.aprs_calls[p["from"]] = p
        self.emit("aprs", **{k: v for k, v in p.items() if isinstance(v, (str, int, float, bool))})

    # ---- scanner ---------------------------------------------------------------------
    def _scan_cmd(self, c):
        a = c.get("action")
        if a == "start":
            self._to_listen()
            bank = self.banks.get(c["bank"])
            if not bank:
                raise ValueError("unknown list")
            chans = banks_mod.BankStore.expand(bank)
            if not chans:
                raise ValueError("That list is empty. Add some frequencies first.")
            self._rec_audio(False)
            fs = self.fs
            span = 0.78 * fs
            windows, cur = [], None
            for ch in chans:
                if cur and ch["f"] - cur["lo"] <= span:
                    cur["hi"] = ch["f"]
                    cur["chans"].append(ch)
                else:
                    cur = {"lo": ch["f"], "hi": ch["f"], "chans": [ch]}
                    windows.append(cur)
            for w in windows:
                mid = (w["lo"] + w["hi"]) / 2
                if any(abs(ch["f"] - mid) < 20e3 for ch in w["chans"]):
                    mid -= 60e3
                w["center"] = mid
            self.scan = {"bank": bank["id"], "name": bank["name"], "chans": chans, "windows": windows, "wi": 0,
                         "state": "scanning", "hold": False, "thr": float(c.get("thr", bank.get("thr", 8))),
                         "hang": float(bank.get("hang", 2.0)), "lockout": set(), "hits": collections.Counter(),
                         "record": bool(c.get("record", False)), "t_dwell": 0.0, "last_active": 0.0, "cur": None,
                         "lock": None, "lock_start": 0.0}
            self._retune(windows[0]["center"])
            self.scan["t_dwell"] = time.monotonic() + self.cfg["settle_s"] + 0.15
            self.gate = False
            self.emit("scan_started", bank=bank["id"], name=bank["name"], windows=len(windows), channels=len(chans))
        elif self.scan:
            s = self.scan
            if a == "stop":
                self._scan_unlock(log=True)
                self.scan = None
                self.gate = True
                self._rec_audio(False)
            elif a == "hold":
                s["hold"] = bool(c.get("on", not s["hold"]))
            elif a == "skip":
                self._scan_unlock(log=True)
                s["t_dwell"] = time.monotonic()
                self._scan_next_window()
            elif a == "lockout":
                f = int(c.get("freq") or (s["lock"] or {}).get("f", 0))
                if f:
                    s["lockout"].add(f)
                    if s["lock"] and s["lock"]["f"] == f:
                        self._scan_unlock(log=True)
            elif a == "unlock_all":
                s["lockout"].clear()
            elif a == "record":
                s["record"] = bool(c.get("on"))
            elif a == "thr":
                s["thr"] = float(c.get("db", 8))

    def _scan_unlock(self, log):
        s = self.scan
        if s and s["lock"]:
            if log:
                dur = time.monotonic() - s["lock_start"]
                entry = {"t": time.time() - dur, "f": s["lock"]["f"], "label": s["lock"].get("label", ""),
                         "dur": round(dur, 1)}
                self.scan_log.appendleft(entry)
                self.emit("scan_end", **entry)
            if s["record"]:
                self._rec_audio(False)
            s["lock"] = None
            s["state"] = "scanning"
            s["cur"] = None
            self.gate = False

    def _scan_next_window(self):
        s = self.scan
        if len(s["windows"]) > 1:
            s["wi"] = (s["wi"] + 1) % len(s["windows"])
            self._retune(s["windows"][s["wi"]]["center"])
        s["t_dwell"] = time.monotonic() + self.cfg["settle_s"] + 0.12

    def _scan_step(self, spec):
        s = self.scan
        now = time.monotonic()
        win = s["windows"][s["wi"]]
        if s["state"] == "locked":
            lk = s["lock"]
            lvl = dsp.channel_level_db(spec, self.fs, lk["f"] - self.center, lk["bw"])
            snr = lvl - self.floor if lvl is not None else -99
            if snr > s["thr"] - 2:
                s["last_active"] = now
            if not s["hold"] and now - s["last_active"] > s["hang"]:
                self._scan_unlock(log=True)
                s["t_dwell"] = now + 0.05
            return
        if s["hold"] or now < s["t_dwell"]:
            return
        best, best_snr = None, s["thr"]
        for ch in win["chans"]:
            if ch["f"] in s["lockout"]:
                continue
            lvl = dsp.channel_level_db(spec, self.fs, ch["f"] - self.center, ch["bw"])
            if lvl is None:
                continue
            snr = lvl - self.floor
            if snr > best_snr:
                best, best_snr = ch, snr
        if best:
            s["state"] = "locked"
            s["lock"] = best
            s["cur"] = {"f": best["f"], "label": best.get("label", ""), "mode": best["mode"]}
            s["hits"][best["f"]] += 1
            s["lock_start"] = now
            s["last_active"] = now
            self.set_mode_raw(best["mode"], best["bw"])
            self.vfo = float(best["f"])
            self.rx.agc_gain = 1.0
            self._gate_until = now + 0.5
            self.snr = best_snr
            self.emit("scan_hit", f=best["f"], label=best.get("label", ""), snr=round(best_snr, 1))
            if s["record"]:
                self._rec_audio(True, auto=True, tag=best.get("label", ""))
        elif len(s["windows"]) > 1:
            self._scan_next_window()

    # ---- audio recording -------------------------------------------------------------
    def _rec_audio(self, on, auto=False, tag="", fmt=None):
        if on and not self.rec:
            base = os.path.join(self.cfg.path_for("recordings"), "%s_%.4fMHz_%s%s" % (
                time.strftime("%Y%m%d-%H%M%S"), self.vfo / 1e6, self.mode, "_" + _safe_name(tag) if tag else ""))
            want = fmt or self.cfg.get("audio_format", "wav")
            self.rec, self.rec_path = open_audio_writer(base, want, self.cfg.get("mp3_kbps", 48))
            if want == "mp3" and self.rec_path.endswith(".wav"):
                self.notice("MP3 needs ffmpeg, which wasn't found, so this is saved as WAV instead.")
            self.rec_auto = auto
            self.rec_peak = -99.0
            self.emit("recording", on=True, file=os.path.basename(self.rec_path))
        elif not on and self.rec:
            self.rec.close()
            name = os.path.basename(self.rec_path)
            size = self.rec.bytes
            self.rec = None
            if size < 9600:                     # under 0.1 s: not worth keeping
                try:
                    os.remove(self.rec_path)
                except OSError:
                    pass
            else:
                self.emit("recording", on=False, file=name)

    # ------------------------------------------------------------------ seek and sweep
    def _start_seek(self, direction):
        self._to_listen()
        f = self.vfo
        name, mode = banks_mod.band_for(f)
        if mode == "wfm":
            lo, hi = 87.5e6, 108.0e6
            start = f + direction * 150e3
        elif mode == "am" and f < 2e6:
            lo, hi = 531e3, 1701e3
            start = f + direction * 15e3
        else:
            lo, hi = max(f - 30e6, 1e6), f + 30e6
            start = f + direction * 50e3
        a, b = (start, hi) if direction > 0 else (lo, start)
        if (direction > 0 and a >= hi) or (direction < 0 and b <= lo):
            a, b = (lo, hi)                                   # wrap around
        self._start_sweep({"start": a, "stop": b, "mode": mode, "purpose": "seek", "dir": direction,
                           "thr": 10.0, "stop_early": True, "return_to": f})

    def _start_sweep(self, c):
        if self.job not in ("listen", "sweep"):
            self._stop_job()
        start, stop = float(c["start"]), float(c["stop"])
        if stop <= start:
            raise ValueError("The end frequency must be above the start.")
        fs = int(self.cfg["sample_rate"])
        mode = c.get("mode") or banks_mod.band_for((start + stop) / 2)[1]
        purpose = c.get("purpose", "find")
        if purpose == "survey":
            res, sm, sep, snap = 25e3, 3, 50e3, 0
        elif mode == "wfm":
            res, sm, sep, snap = 25e3, 7, 150e3, 100e3
        elif mode == "am" and stop < 2e6:
            res, sm, sep, snap = 3e3, 3, 9e3, 9e3
        else:
            res, sm, sep, snap = 6.25e3, 3, 12.5e3 * 2, 0
        span = 0.78 * fs
        step = span * (0.9 if purpose == "survey" else 1.0)     # survey hops overlap, so each hop's centre spike is covered by its neighbours
        direction = int(c.get("dir", 1))
        hops = []
        if purpose == "watch":
            hops = [float(c["start"] + c["stop"]) / 2]
        elif direction >= 0:
            cen = start + span / 2
            if self.src and self.job == "listen" and abs(self.center - cen) < span / 2 and self.center - span / 2 <= start:
                cen = max(self.center, start + 1)
            while True:
                hops.append(cen)
                if cen + span / 2 >= stop:
                    break
                cen += step
        else:
            cen = stop - span / 2
            while True:
                hops.append(cen)
                if cen - span / 2 <= start:
                    break
                cen -= span
        n = int((stop - start) / res) + 1
        self.job = "sweep"
        self.fs = fs
        self.sweep = {"start": start, "stop": stop, "res": res, "mode": mode, "hops": hops, "hi": 0, "n": n,
                      "grid": np.full(n, -200.0, dtype=np.float32), "sm": sm, "sep": sep, "snap": snap,
                      "thr": float(c.get("thr", 10.0)), "purpose": purpose, "dir": direction,
                      "dc": 25e3 if purpose == "survey" else 0.0, "pass": 0, "svy": None, "t_start": time.monotonic(),
                      "watch_f": hops[0] if purpose == "watch" else None, "hist": [],
                      "early": bool(c.get("stop_early")), "t": 0.0, "avg": [], "stage": "tune",
                      "return_to": c.get("return_to"), "span": span, "last_emit": 0, "name": c.get("name", "")}
        self.emit("sweep_started", start=start, stop=stop, res=res, hops=len(hops), purpose=purpose)
        if self.src is None and False:
            pass

    def _sweep_peaks(self, sw, final=True):
        g = sw["grid"]
        valid = g > -150
        if valid.sum() < 5:
            return []
        gl = np.where(valid, g, np.nan)
        floor = float(np.nanpercentile(gl, 30))
        lin = 10 ** (np.where(valid, g, floor) / 10.0)
        k = sw["sm"]
        sm = 10 * np.log10(np.convolve(lin, np.ones(k) / k, mode="same"))
        thr = floor + sw["thr"]
        cand = np.nonzero((sm[1:-1] >= sm[:-2]) & (sm[1:-1] > sm[2:]) & (sm[1:-1] > thr))[0] + 1
        peaks = []
        for i in cand[np.argsort(-sm[cand])]:
            f = sw["start"] + i * sw["res"]
            if sw["mode"] == "wfm":
                # An FM carrier's spectrum is a broad hump whose highest point wanders with the programme.
                # The centre of its energy is a much better estimate of the carrier frequency.
                lo_i, hi_i = max(i - 5, 0), min(i + 6, len(g))
                seg = g[lo_i:hi_i]
                ok = seg > (seg.max() - 10.0)
                if ok.sum() >= 2:
                    w = 10 ** (seg[ok] / 10.0)
                    f = sw["start"] + float((np.arange(lo_i, hi_i)[ok] * w).sum() / w.sum()) * sw["res"]
            if sw["snap"]:
                f = round(f / sw["snap"]) * sw["snap"]
                if sw["mode"] == "am" and sw["stop"] < 2e6:
                    f = 531e3 + round((f - 531e3) / 9e3) * 9e3
            if f < sw["start"] - sw["res"] or f > sw["stop"] + sw["res"]:
                continue
            if any(abs(f - p["f"]) < sw["sep"] for p in peaks):
                continue
            band, m = banks_mod.band_for(f)
            peaks.append({"f": int(f), "db": round(float(sm[i] - floor), 1), "band": band or "", "mode": m})
        peaks.sort(key=lambda p: p["f"])
        return peaks

    def _emit_sweep(self, sw, done=False, peaks=None):
        q = q_db(np.where(sw["grid"] > -150, sw["grid"], -150))
        q[sw["grid"] <= -150] = 0
        msg = {"start": sw["start"], "stop": sw["stop"], "res": sw["res"], "n": sw["n"],
               "done": done, "hop": sw["hi"], "hops": len(sw["hops"]), "purpose": sw["purpose"],
               "db": base64.b64encode(q.tobytes()).decode("ascii")}
        if peaks is not None:
            msg["peaks"] = peaks
        self.emit("sweep", **msg)

    def _step_sweep(self):
        sw = self.sweep
        if sw is None:
            self._fallback_to_listen()
            return
        if self.rx is None or self._rx_key is None:
            self._ensure_rx()
        if self.fs != int(self.src.fs):
            self.src.set_sample_rate(self.fs)
        cen = sw["hops"][sw["hi"]]
        if sw["stage"] == "tune":
            if abs(cen - self.center) > 1 or sw["t"] == 0.0:
                self._retune(cen)
            self.center = cen
            sw["stage"] = "settle"
            sw["avg"] = []
            sw["t_until"] = (0.0 if (sw["purpose"] == "watch" and sw["t"] != 0.0)
                             else time.monotonic() + self.cfg["settle_s"] + 0.1)
        iq = self._read_iq(self.chunk)
        if time.monotonic() < sw["t_until"]:
            return
        sw["avg"].append(10 ** (self.sa.compute(iq) / 10.0))
        if len(sw["avg"]) < (1 if sw["purpose"] == "watch" else 2):
            return
        db = 10 * np.log10(np.mean(sw["avg"], axis=0) + 1e-20)
        nfft = len(db)
        binw = self.fs / nfft
        freqs = cen + (np.arange(nfft) - nfft / 2) * binw
        lo, hi = max(cen - sw["span"] / 2, sw["start"]), min(cen + sw["span"] / 2, sw["stop"])
        sel = (freqs >= lo) & (freqs <= hi)
        if sw["dc"]:
            sel &= np.abs(freqs - cen) > sw["dc"]
        if sw["purpose"] == "watch":
            self._watch_emit(sw, db, freqs, cen)
            sw["stage"] = "tune"
            sw["t"] = time.monotonic()
            return
        idx = np.round((freqs[sel] - sw["start"]) / sw["res"]).astype(int)
        np.maximum.at(sw["grid"], np.clip(idx, 0, sw["n"] - 1), db[sel])
        sw["hi"] += 1
        sw["stage"] = "tune"
        sw["t"] = time.monotonic()
        now = time.monotonic()
        finished = sw["hi"] >= len(sw["hops"])
        early_hit = None
        if sw["early"] and sw["purpose"] == "seek":
            pk = self._sweep_peaks(sw)
            cand = [p for p in pk if (p["f"] > self.vfo + 1e3 if sw["dir"] > 0 else p["f"] < self.vfo - 1e3)]
            if cand:
                early_hit = (min(cand, key=lambda p: p["f"]) if sw["dir"] > 0 else max(cand, key=lambda p: p["f"]))
                finished = True
        if finished and sw["purpose"] == "survey":
            self._survey_pass(sw)
            sw["hi"] = 0
            sw["grid"][:] = -200.0
            sw["last_emit"] = now
            return
        if finished:
            peaks = self._sweep_peaks(sw)
            self.sweep_result = peaks
            if sw["purpose"] == "seek":
                self.job, self.sweep = "listen", None
                if early_hit:
                    name, m = banks_mod.band_for(early_hit["f"])
                    self.set_mode_raw(m if name else self.mode)
                    self._set_vfo(early_hit["f"], sw["dir"], recenter=True)
                    self.emit("seek_done", found=True, f=early_hit["f"])
                else:
                    self.emit("seek_done", found=False)
                    self.notice("No station found in that direction. Try a different antenna position or a lower squelch.", "info")
                    if sw.get("return_to"):
                        self._set_vfo(sw["return_to"], recenter=True)
                self._ensure_rx()
                self.discard_until = time.monotonic() + self.cfg["settle_s"]
            else:
                self._emit_sweep(sw, True, peaks)
                self.job, self.sweep = "listen", None
                self.discard_until = time.monotonic() + self.cfg["settle_s"]
        elif now - sw["last_emit"] > 1.2 and sw["purpose"] == "survey":
            sw["last_emit"] = now
            self.emit("survey_progress", hop=sw["hi"], hops=len(sw["hops"]), passes=sw["pass"],
                      f=cen, elapsed=round(now - sw["t_start"], 1))
        elif now - sw["last_emit"] > 1.2 and sw["purpose"] not in ("seek", "survey"):
            sw["last_emit"] = now
            self._emit_sweep(sw, False)


    # ------------------------------------------------------------------ whole-spectrum survey
    def _survey_pass(self, sw):
        """One full pass is done: fold it into the running tally and publish the list of signals found so far."""
        from scipy.ndimage import percentile_filter
        g = sw["grid"]
        valid = g > -150
        n = sw["n"]
        if valid.sum() < 5:
            return
        sv = sw["svy"]
        if sv is None:
            sv = sw["svy"] = {"hits": np.zeros(n, np.int32), "peak": np.full(n, -200.0, np.float32),
                              "last": np.zeros(n, np.int32), "seen": np.zeros(n, np.int32)}
        fill = np.where(valid, g, np.nan)
        floor_all = float(np.nanpercentile(fill, 30))
        gg = np.where(valid, g, floor_all)
        lin = 10 ** (gg / 10.0)
        smooth = 10 * np.log10(np.convolve(lin, np.ones(3) / 3, mode="same"))
        local = percentile_filter(smooth, 30, size=401, mode="nearest")      # the noise floor drifts across a wide sweep
        ex = smooth - local
        sw["pass"] += 1
        hit = valid & (ex > sw["thr"])
        sv["hits"] += hit
        sv["seen"] += valid
        sv["last"][hit] = sw["pass"]
        sv["peak"] = np.maximum(sv["peak"], np.where(hit, ex, -200.0))
        self.survey_signals = self._survey_list(sw)
        self.emit("survey", passes=sw["pass"], signals=self.survey_signals, start=sw["start"], stop=sw["stop"],
                  elapsed=round(time.monotonic() - sw["t_start"], 1))

    def _survey_list(self, sw):
        sv = sw["svy"]
        idx = np.nonzero(sv["hits"] > 0)[0]
        if len(idx) == 0:
            return []
        groups, cur = [], [idx[0]]
        for i in idx[1:]:
            if i - cur[-1] <= 2:
                cur.append(i)
            else:
                groups.append(cur)
                cur = [i]
        groups.append(cur)
        out = []
        res = sw["res"]
        for gp in groups:
            gp = np.array(gp)
            pk = sv["peak"][gp]
            w = 10 ** (pk / 10.0)
            f = sw["start"] + float((gp * w).sum() / w.sum()) * res
            seen = int(sv["seen"][gp].max()) or 1
            hits = int(sv["hits"][gp].max())
            band, mode = banks_mod.band_for(f)
            out.append({"f": int(round(f / 1e3) * 1e3), "db": round(float(pk.max()), 1),
                        "bw": int((gp[-1] - gp[0] + 1) * res), "hits": hits, "passes": seen,
                        "duty": round(hits / seen, 2), "last": int(sv["last"][gp].max()),
                        "band": band or "", "mode": mode})
        out.sort(key=lambda r: (-r["duty"] * 100 - r["db"]))
        return out[:120]

    def _watch_emit(self, sw, db, freqs, cen):
        """Locked-on view: a zoomed spectrum around one frequency plus a level history."""
        f0 = sw["watch_f"]
        half = 100e3
        sel = (freqs >= f0 - half) & (freqs <= f0 + half)
        seg = db[sel]
        core = (freqs >= f0 - 6e3) & (freqs <= f0 + 6e3)
        lvl = float(db[core].max()) if core.any() else -120.0
        floor = float(np.percentile(seg, 30)) if len(seg) else -120.0
        sw["hist"].append(round(lvl - floor, 1))
        sw["hist"] = sw["hist"][-120:]
        self.emit("watch", f=f0, span=2 * half, level=round(lvl - floor, 1), floor=round(floor, 1),
                  hist=sw["hist"], db=base64.b64encode(q_db(seg).tobytes()).decode("ascii"))

    # ------------------------------------------------------------------ plane tracking
    def _step_adsb(self):
        if int(self.src.fs) != adsb.ADSB_FS:
            self.src.set_sample_rate(adsb.ADSB_FS)
            self.fs = adsb.ADSB_FS
        raw = self.src.read_samples(200000)
        if time.monotonic() < self.discard_until:
            return
        msgs = self.adsb_demod.process(raw)
        now = time.time()
        for m in msgs:
            self.table.update(m, now)
        if now - self.aircraft_t >= 1.0:
            n0, t0, _ = self.adsb_rate
            rate = (self.adsb_demod.count - n0) / max(now - t0, 0.001)
            self.adsb_rate = (self.adsb_demod.count, now, rate)
            self.aircraft_t = now
            st = self.table.stats()
            st["rate"] = round(rate, 1)
            snap = self.table.snapshot(now)
            self.emit("aircraft", list=snap, stats=st, home=[self.cfg["lat"], self.cfg["lon"]],
                      cover=self.table.cover)
            if now - self._hist_t >= 10.0:
                self._hist_t = now
                self.adsb_hist.append([round(now), [[a["icao"], a["callsign"], round(a["lat"], 4), round(a["lon"], 4), a["alt"], a["heading"], 1 if a["mil"] else 0]
                                                    for a in snap if a.get("lat") is not None and a["age"] < 30], round(rate, 1)])
            if self.table.cover_dirty and now - getattr(self, "_cover_saved", 0) > 60:
                self._save_cover(now)

    def _cover_file(self):
        return self.cfg.path_for("coverage.json")

    def _load_cover(self):
        """Plane coverage survives restarts, but only for the place where it was measured."""
        try:
            with open(self._cover_file()) as f:
                c = json.load(f)
            d, _ = adsb._distance_bearing(self.cfg["lat"], self.cfg["lon"], c["lat"], c["lon"])
            if d < 3.0 and len(c["cover"]) == 36:
                self.table.cover = [float(x) for x in c["cover"]]
        except (OSError, ValueError, KeyError, TypeError):
            pass

    def _save_cover(self, now):
        self._cover_saved = now
        self.table.cover_dirty = False
        try:
            with open(self._cover_file(), "w") as f:
                json.dump({"lat": self.cfg["lat"], "lon": self.cfg["lon"], "cover": self.table.cover}, f)
        except OSError:
            pass

    def reset_cover(self):
        self.table.cover = [0.0] * 36
        self._save_cover(time.time())

    # ------------------------------------------------------------------ sensors (rtl_433)
    def _ism_start(self, params):
        exe = os.environ.get("RTL433_BIN", "rtl_433")
        freq = float(params.get("freq", 433.92e6))
        aux = None
        if params.get("tool") == "rtlamr":
            argv, aux, freq = self._amr_argv(freq)
            if argv is None:
                return
        else:
            freqs = [float(x) for x in (params.get("freqs") or []) if isinstance(x, (int, float)) and 24e6 < x < 1.8e9][:4]
            fl = []
            for x in (freqs or [freq]):
                fl += ["-f", str(int(x))]
            if len(freqs) > 1:
                fl += ["-H", str(int(params.get("hop_s") or 60))]           # switch between them every minute
                freq = freqs[0]
            argv = shlex.split(exe) + ["-d", str(self.cfg["devices"].get("radio", 0))] + fl + ["-F", "json", "-M", "time:iso:utc", "-M", "level"]
            if not self.cfg["gain_auto"]:
                argv += ["-g", str(int(self.cfg["gain_db"]))]
        try:
            p = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL, bufsize=0)
        except FileNotFoundError:
            if aux is not None:
                aux.kill()
            self._fallback_to_listen()
            self.error = ""
            self.notice("The sensor decoder is not installed in this container, so the Sensors tab can't run.", "error")
            return
        q = queue.Queue()
        err = collections.deque(maxlen=30)

        def pump(pipe, handler):
            buf = b""
            while True:
                try:
                    d = pipe.read(1024)
                except Exception:
                    return
                if not d:
                    return
                buf += d
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    handler(line.decode("utf-8", "replace").strip())
        threading.Thread(target=pump, args=(p.stdout, q.put), daemon=True).start()
        threading.Thread(target=pump, args=(p.stderr, err.append), daemon=True).start()
        self.ism = {"proc": p, "q": q, "err": err, "freq": freq, "freqs": [float(x) for x in (params.get("freqs") or [])][:4], "t0": time.time(), "aux": aux, "n": 0}
        self.job = "ism"
        self.center = freq
        self.emit("sensors_started", freq=freq)

    def _amr_argv(self, freq):
        """US utility meters via rtlamr: it talks to an rtl_tcp server, so start one on the dongle first."""
        exe = shlex.split(os.environ.get("RTLAMR_BIN", "rtlamr"))
        tcp = shlex.split(os.environ.get("RTL_TCP_BIN", "rtl_tcp"))
        if not (shutil.which(exe[0]) and shutil.which(tcp[0])):
            self._fallback_to_listen()
            self.error = ""
            self.notice("The utility meter decoder (rtlamr) is not installed in this container. See the README to add it.", "warn")
            return None, None, freq
        freq = 912.6e6 if not 902e6 <= freq <= 928e6 else freq
        port = 18432
        argv_tcp = tcp + ["-a", "127.0.0.1", "-p", str(port), "-d", str(self.cfg["devices"].get("radio", 0)), "-f", str(int(freq)), "-s", "2400000"]
        if not self.cfg["gain_auto"]:
            argv_tcp += ["-g", str(int(self.cfg["gain_db"]))]
        try:
            aux = subprocess.Popen(argv_tcp, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
        except OSError as e:
            self._fallback_to_listen()
            self.notice("Could not start the radio server for rtlamr: %s" % e, "error")
            return None, None, freq
        for _ in range(30):                                   # wait for it to listen
            try:
                socket.create_connection(("127.0.0.1", port), 0.2).close()
                break
            except OSError:
                time.sleep(0.2)
        argv = exe + ["-server=127.0.0.1:%d" % port, "-format=json", "-msgtype=scm,scm+,idm,r900", "-centerfreq=%d" % int(freq), "-unique=true"]
        return argv, aux, freq

    def _ism_stop(self):
        if self.ism:
            aux = self.ism.get("aux")
            if aux is not None and aux.poll() is None:
                aux.kill()
            p = self.ism["proc"]
            if p.poll() is None:
                p.terminate()
                try:
                    p.wait(3)
                except subprocess.TimeoutExpired:
                    p.kill()
            time.sleep(0.4)
        self.ism = None

    def _step_ism(self):
        im = self.ism
        if im is None:
            self._fallback_to_listen()
            return
        try:
            line = im["q"].get(timeout=0.25)
        except queue.Empty:
            line = None
        if im["proc"].poll() is not None and im["q"].empty():
            msg = "The sensor decoder stopped. " + sources.explain_failure(list(im["err"])) if im["err"] else "The sensor decoder stopped."
            self.ism = None
            self._fallback_to_listen()
            self.notice(msg, "error")
            return
        while line:
            try:
                d = json.loads(line)
            except ValueError:
                d = None
            if isinstance(d, dict) and isinstance(d.get("Message"), dict):          # rtlamr
                msg = d["Message"]
                d = {"model": "rtlamr-%s" % str(d.get("Type", ""))[:12], "id": msg.get("EndpointID", msg.get("ID", ""))}
                d.update({str(k).lower(): v for k, v in msg.items() if k not in ("EndpointID", "ID")})
            if isinstance(d, dict) and "model" in d:
                s = self.sstore.update(d)
                im["n"] = im.get("n", 0) + 1
                self.emit("sensor", **{k: v for k, v in s.items() if isinstance(v, (str, int, float, bool))})
                if self.dl_hook:
                    self.dl_hook("sensor", s)
            try:
                line = im["q"].get_nowait()
            except queue.Empty:
                line = None
        now = time.time()
        self.sstore.save()
        if now - self.last_state > 1.0:
            self._publish_state()

    # ------------------------------------------------------------------ dongle health check
    HEALTH_FREQS = [(88.1e6, "FM radio (low end)"), (100.1e6, "FM radio (middle)"), (107.9e6, "FM radio (top)"),
                    (145.0e6, "Amateur 2 m"), (156.8e6, "Marine"), (433.92e6, "UHF / sensors"),
                    (446.1e6, "Walkie-talkies"), (1090.0e6, "Plane transponders")]

    def _step_health(self):
        h = self.health
        if h["stage"] == "start":
            h["stage"] = "tune"
            h["i"] = 0
            self.emit("health_progress", i=0, n=len(self.HEALTH_FREQS), text="Starting the check...")
        if h["i"] >= len(self.HEALTH_FREQS):
            self._health_finish()
            return
        f, label = self.HEALTH_FREQS[h["i"]]
        if h["stage"] == "tune":
            self.src.take_pll_count()
            self.src.set_freq(f)
            self.center = f
            h["t_until"] = time.monotonic() + 0.5
            h["stage"] = "settle"
            self.emit("health_progress", i=h["i"], n=len(self.HEALTH_FREQS), text="Testing %s (%.2f MHz)" % (label, f / 1e6))
        iq = self._read_iq(self.chunk)
        if h["stage"] == "settle":
            if time.monotonic() >= h["t_until"]:
                h["stage"] = "measure"
                h["acc"] = []
            return
        h["acc"].append(10 ** (self.sa.compute(iq) / 10.0))
        if len(h["acc"]) >= 3:
            db = 10 * np.log10(np.mean(h["acc"], axis=0) + 1e-20)
            pll = self.src.take_pll_count()
            h["results"].append({"f": f, "label": label, "pll_fail": pll, "floor": round(dsp.noise_floor_db(db), 1),
                                 "peak": round(float(db.max()), 1)})
            h["i"] += 1
            h["stage"] = "tune"

    def _step_calibrate(self):
        """Measure the dongle's clock error from the 19 kHz stereo pilot of strong FM stations."""
        c = self.calib
        if c["i"] >= len(c["stations"]):
            self._calib_finish()
            return
        f = c["stations"][c["i"]]
        self.emit("calibrate_progress", i=c["i"], n=len(c["stations"]), text="Measuring %.1f MHz..." % (f / 1e6))
        self.center = f + 300e3
        self.src.set_freq(self.center)
        for _ in range(3):
            self._read_iq(self.chunk)
        iq = self._read_iq(int(self.fs * 2.1))
        pilot, snr = dsp.fm_pilot(iq, self.fs, -300e3)
        row = {"f": f, "snr": round(snr, 1), "pilot_hz": None if pilot is None else round(pilot, 3), "ppm": None}
        if pilot is not None and snr >= 25 and abs(pilot - 19000) < 40:
            row["ppm"] = round(dsp.pilot_to_ppm(pilot), 1)
        c["results"].append(row)
        c["i"] += 1

    def _calib_finish(self):
        rows = self.calib["results"]
        good = sorted(r["ppm"] for r in rows if r["ppm"] is not None)
        cur = int(self.cfg["ppm"])
        out = {"ok": False, "current": cur, "stations": rows}
        if not rows:
            out["text"] = "No FM stations to test. Press Find stations on the Radio page first, then try again."
        elif not good:
            out["text"] = ("None of the stations had a clear stereo tone, so the radio cannot measure itself. Try again with a better "
                           "antenna or after finding stronger stations. Mono stations and weak signals cannot be used.")
        else:
            med = good[len(good) // 2] if len(good) % 2 else 0.5 * (good[len(good) // 2 - 1] + good[len(good) // 2])
            spread = good[-1] - good[0]
            conf = "high" if len(good) >= 3 and spread <= 10 else "medium" if len(good) >= 2 and spread <= 25 else "low"
            out.update(ok=True, residual=round(med, 1), spread=round(spread, 1), confidence=conf, suggested=int(round(cur + med)),
                       count=len(good))
            out["text"] = ("Measured with %d station%s. The radio's clock is about %.0f ppm %s than it should be. Confidence: %s%s." %
                           (len(good), "" if len(good) == 1 else "s", abs(med), "fast" if med > 0 else "slow", conf,
                            " (the stations disagree by %.0f ppm)" % spread if spread > 10 else ""))
        self.emit("calibrate_done", **out)
        self.calib = None
        self.job = "listen"
        self.fs = int(self.cfg["sample_rate"])
        self._close_source()

    def _health_finish(self):
        res = self.health["results"]
        n = len(res)
        bad = sum(1 for r in res if r["pll_fail"] > 0)
        dev = dict(self.dev_info)
        usb = sources.usb_dongles()
        lines = []
        if self.src is not None and getattr(self.src, "sim", False):
            verdict, level = "This is the built-in simulator, so there is no real hardware to check.", "info"
        elif bad == 0:
            verdict, level = "Good. The tuner locked onto every test frequency.", "good"
        elif bad <= 2:
            verdict, level = ("Mostly good. The tuner failed to lock on %d of %d test frequencies. Occasional misses are normal "
                              "for these dongles and usually harmless." % (bad, n)), "ok"
        else:
            verdict, level = ("Problem. The tuner failed to lock on %d of %d test frequencies, including the FM radio band. "
                              "A healthy dongle normally locks on nearly all of them. This points to a faulty or poor-quality "
                              "tuner. If it is new, ask the seller for a replacement and send them this report." % (bad, n)), "bad"
        tuner = dev.get("tuner", "")
        if tuner and not dev.get("sim"):
            if "R828D" in tuner or "R828S" in tuner:
                lines.append("Tuner: %s (the chip family used in RTL-SDR Blog V4 and V4L dongles)." % tuner)
            else:
                lines.append("Tuner: %s. RTL-SDR Blog V4 and V4L dongles use an R828D or R828S tuner, so this dongle is an older or generic type." % tuner)
        if usb:
            u = usb[0]
            lines.append("USB name: %s %s (serial %s)." % (u["manufacturer"] or "unknown", u["product"] or "unknown", u["serial"] or "none"))
            lines.append("A genuine RTL-SDR Blog V4 normally shows the name \"RTLSDRBlog\" / \"Blog V4\" here.")
        if sources.kernel_driver_loaded():
            lines.append("The Linux TV-tuner driver (dvb_usb_rtl28xxu) is loaded on this machine. It can interfere with the dongle.")
        report = {"verdict": verdict, "level": level, "details": lines, "results": res, "device": dev,
                  "usb": usb, "time": time.strftime("%Y-%m-%d %H:%M:%S")}
        self.emit("health_done", report=report)
        self.health = None
        self.job = "listen"
        self.fs = int(self.cfg["sample_rate"])
        self._close_source()

    # ------------------------------------------------------------------ baseband recording
    def _record_start(self, params):
        self.job = "record"
        f = float(params["freq"])
        dur = float(params.get("seconds", 600))
        label = _safe_name(params.get("label", "baseband"))
        sat0 = self.space.item(str(params.get("sat", ""))[:40]) if (self.space and params.get("sat")) else None
        fent = next((x for x in (sat0 or {}).get("freqs", []) if abs(x["f"] - f) < 1), {})
        fs = int(params.get("fs") or fent.get("fs") or 1024000)
        if not (225001 <= fs <= 300000 or 900001 <= fs <= 3200000):
            fs = 1024000
        self.fs = fs
        name = "%s_%.4fMHz_%s_iq.wav" % (time.strftime("%Y%m%d-%H%M%S"), f / 1e6, label)
        path = self.cfg.path_for("recordings", name)
        meta = {"kind": "iq", "freq": f, "fs": fs, "label": label, "t0": time.time(),
                "sat": str(params.get("sat", ""))[:40], "decode": str(params.get("decode", ""))[:20],
                "mod": str(params.get("mod", ""))[:20], "max_el": params.get("max_el"),
                "aos": params.get("aos"), "los": params.get("los"),
                "lat": self.cfg["lat"], "lon": self.cfg["lon"], "alt": self.cfg["alt"], "gain_db": self.cfg["sat_gain_db"]}
        sat = self.space.item(meta["sat"]) if (self.space and meta["sat"]) else None
        if sat:
            meta["sat_name"] = sat["name"]
            meta["norad"] = sat["norad"]
            meta["decode"] = meta["decode"] or sat.get("decode", "")
            meta["mod"] = meta["mod"] or sat.get("mod", "")
        self.recbb = {"f": f, "fs": fs, "end": time.time() + dur, "name": name, "w": None, "path": path, "t0": time.time(),
                      "last": 0, "meta": meta}
        self.center = f
        self.emit("record_started", file=name, seconds=dur)

    def _step_record(self):
        r = self.recbb
        if r is None:
            self._fallback_to_listen()
            return
        if self.src is None:
            if not self._open(fs=r["fs"], freq=r["f"]):
                self.emit("notice", text=self.error, level="error")
                time.sleep(2)
                return
        if r["w"] is None:
            r["w"] = WavBaseband(r["path"], r["fs"])
        n = 102400
        raw = self.src.read_samples(n)
        if time.monotonic() >= self.discard_until:
            r["w"].write(raw)
        now = time.time()
        if r["meta"].get("decode") == "lrpt" or 130e6 <= r["f"] <= 140e6:       # a live reading of whether the satellite is actually being HEARD
            r.setdefault("sigbuf", []).append(raw)
            if len(r["sigbuf"]) * len(raw) >= r["fs"] * 2 * 0.9:
                buf = np.frombuffer(b"".join(r["sigbuf"]), dtype=np.uint8)
                r["sigbuf"] = []
                d = buf[: len(buf) // 2 * 2].astype(np.float32).reshape(-1, 2) - 127.5
                db = iq_tools.hump_db(d[:, 0] + 1j * d[:, 1], r["fs"])
                if db is not None:
                    r["sig_now"] = round(db, 1)
                    r["sig_max"] = max(r.get("sig_max", -99.0), db)
                    r["clip"] = round(float(np.mean((buf < 3) | (buf > 252))) * 100, 1)       # % of samples hitting the ends of the 8-bit range
                    self.emit("record_signal", file=r["name"], db=r["sig_now"], level=iq_tools.hump_level(db),
                              best=round(r["sig_max"], 1), clip=r["clip"])
        if now - r["last"] > 1.0:
            r["last"] = now
            self.emit("record_progress", file=r["name"], bytes=r["w"].bytes, secs=round(now - r["t0"]),
                      left=max(0, round(r["end"] - now)))
        if now >= r["end"] or r["w"].bytes > 3.8e9:
            self._record_stop()
            self.job = "listen"
            self.fs = int(self.cfg["sample_rate"])
            self._close_source()

    def _record_stop(self):
        r = self.recbb
        if r and r.get("w"):
            r["w"].close()
            meta = dict(r.get("meta") or {}, t1=time.time(), bytes=r["w"].bytes)
            if meta.get("decode") == "lrpt" or 130e6 <= float(meta.get("freq", 0)) <= 140e6:
                try:                                          # was there a satellite in this recording at all?
                    meta["signal"] = iq_tools.signal_report(r["path"])
                except Exception:
                    pass
            sg = meta.get("signal")
            if sg:
                if r.get("clip") is not None:
                    sg["clip"] = r["clip"]
                msg = {
                    "none": "the satellite's signal could not be detected, so there is nothing to make a picture from. The satellite's position on screen comes from orbit data, not from the radio. Move the antenna outdoors or to a window with a clear view of the sky, check it is vertical and fully extended, and try a pass that climbs above 40 degrees.",
                    "weak": "only a very weak satellite signal was detected (%.1f dB). A picture is unlikely. Try a higher pass or a better antenna spot." % sg["db"],
                    "good": "the satellite's signal was detected (%.1f dB). A picture should be possible." % sg["db"],
                    "strong": "a strong satellite signal was detected (%.1f dB). Pictures should work." % sg["db"]}.get(sg["level"], "")
                if (sg.get("clip") or 0) > 2:
                    msg += " The radio's input was overloaded (%.0f%% of samples clipped): lower the satellite gain in Settings and add an FM-broadcast filter." % sg["clip"]
                self.notice("%s: %s" % (meta.get("label", "Recording"), msg), "info" if sg["level"] in ("good", "strong") else "warn")
            try:
                with open(r["path"] + ".json", "w") as f:
                    json.dump(meta, f)
            except OSError:
                pass
            self.emit("record_done", file=r["name"], bytes=r["w"].bytes)
            if self.on_record_done:
                try:
                    self.on_record_done(r["path"], meta)
                except Exception:
                    pass
        self.recbb = None
        # sched_id is deliberately kept: a recording stopped by hand must not restart while the same pass is overhead

    # ------------------------------------------------------------------ air watch
    def _match_planes(self, text):
        """Which tracked aircraft is this caption talking to? (called from the caption worker thread)"""
        with self.table.lock:
            cs = {a["callsign"].replace(" ", ""): a["icao"] for a in self.table.ac.values() if a.get("callsign")}
        return [{"icao": cs[h], "callsign": h} for h in captions_mod.match_callsigns(text, list(cs))]

    def _air_start(self, c):
        try:
            freqs = [float(f) for f in c.get("freqs", []) if 100e6 <= float(f) <= 140e6][:4]
        except (TypeError, ValueError):
            freqs = []
        if not freqs:
            self.notice("Pick at least one air-traffic channel to listen to.", "warn")
            return
        clamp = lambda v, lo, hi, d: min(max(float(v), lo), hi) if v is not None else d
        self._air_stop()
        self.air = {"freqs": freqs, "adsb_s": clamp(c.get("adsb_s"), 10, 120, 30), "listen_s": clamp(c.get("listen_s"), 8, 90, 20),
                    "phase": "adsb", "t": time.time(), "i": 0, "squelch": self.squelch_db,
                    "cap_prev": (self.cap.on, self.cap.save)}
        self._air_internal = True
        try:
            self._start_job("adsb", {})
        finally:
            self._air_internal = False
        if self.cfg.get("captions", True):
            self.cap.set_on(True, bool(c.get("save", False)))
        self.notice("Air watch on: the radio alternates between tracking planes and listening to air traffic.")

    def _air_stop(self, say=None):
        a = self.air
        if not a:
            return
        self.air = None
        self.squelch_db = a["squelch"]
        self.cap.set_on(*a["cap_prev"])
        if say:
            self.notice(say)

    def _check_airwatch(self):
        a = self.air
        if not a:
            return
        now = time.time()
        dur = a["adsb_s"] if a["phase"] == "adsb" else a["listen_s"]
        if a["phase"] == "listen" and now - self.aircraft_t >= 1.0:
            self.aircraft_t = now                       # keep the map alive while the radio is listening
            st = self.table.stats()
            st["rate"] = 0
            self.emit("aircraft", list=self.table.snapshot(now), stats=st, home=[self.cfg["lat"], self.cfg["lon"]],
                      cover=self.table.cover)
        if now - a["t"] < dur:
            return
        if a["phase"] == "listen" and self.gate and self.snr > 6 and now - a["t"] < dur + 20:
            return                                     # someone is mid-transmission: let them finish
        self._air_internal = True
        try:
            if a["phase"] == "adsb":
                f = a["freqs"][a["i"] % len(a["freqs"])]
                a["i"] += 1
                self._start_job("listen", {})
                self.set_mode_raw("am", 10000)
                self._set_vfo(f, 1, True)
                self.squelch_db = max(a["squelch"], 8.0)
                a["phase"] = "listen"
            else:
                self._start_job("adsb", {})
                a["phase"] = "adsb"
        except Exception as ex:
            self.notice("Air watch stopped: %s" % ex, "error")
            self.air = a
            self._air_stop()
        finally:
            self._air_internal = False
        a["t"] = time.time()

    def _finish_sched(self, sa, say=None):
        """End a scheduled sound/timer recording (it finished, or the user stopped it by hand) and put things back."""
        self.sched_audio = None
        self.doppler = None
        self.squelch_db = sa["squelch"]
        self._rec_audio(False)
        if sa.get("timer"):
            if sa.get("text"):
                self.cap.set_on(sa.get("cap_prev_on", False), sa.get("cap_prev_save", False))
            self.timers.finished(sa["timer"])
            self.emit("timers", list=self.timers.public())
        if say:
            self.notice(say)

    def _end_sched_audio(self, say=None):
        sa = self.sched_audio
        if sa:
            self._finish_sched(sa, say)

    def _start_timer(self, t):
        """Start a timed recording on any frequency."""
        self.timers.started(t["id"])
        self._start_job("listen", {})
        self.set_mode_raw(t.get("mode", "nfm"), t.get("bw"))
        self._set_vfo(float(t["freq"]), 1, True)
        prev = {"cap_prev_on": self.cap.on, "cap_prev_save": self.cap.save}
        sq = self.squelch_db
        if self.squelch_db <= 0:
            self.squelch_db = 8.0              # keep only real transmissions, not hours of hiss
        what = t.get("what", "sound")
        end = min(t["start"] + t["duration"], time.time() + t["duration"])
        self.sched_audio = dict(prev, end=end, label=t.get("label") or "timed recording", squelch=sq, timer=t["id"],
                                text=what in ("text", "both"), peak=-99.0)
        if what in ("sound", "both"):
            self._rec_audio(True, auto=True, tag="timer")
        if what in ("text", "both"):
            if not self.cfg.get("captions", True):
                self.notice("Captions are switched off in Settings, so this timer only saves sound.", "warn")
            else:
                self.cap.set_context(self.vfo, self.mode, banks_mod.label_for(self.vfo))
                if not self.cap.allowed:
                    self.notice("Captions aren't made for broadcast radio stations, so no transcript will be written.", "warn")
                self.cap.set_on(True, save=True)
        self.notice("Timed recording started: %s." % (t.get("label") or "%.4f MHz" % (t["freq"] / 1e6)))
        self.emit("timers", list=self.timers.public())

    def _check_schedule(self):
        now = time.time()
        if now - getattr(self, "_sched_t", 0) < 1.0:
            return
        self._sched_t = now
        # a scheduled sound recording or timer that has reached its end
        sa = self.sched_audio
        if sa and now >= sa["end"]:
            peak = sa.get("peak", -99.0)
            msg = "Finished recording %s." % sa["label"]
            if not sa.get("timer") and peak > -90:
                msg += " Strongest signal: %.0f dB above the noise%s." % (
                    peak, " (nothing was really heard)" if peak < 3 else "")
            self._finish_sched(sa, msg)
        # timed recordings on any frequency
        t = self.timers.due(now)
        if t and self.job != "record" and not self.sched_audio:
            self._start_timer(t)
            return
        due = self.space.due(now) if self.space else None
        if not due or due["id"] == self.sched_id:
            return
        kind = due.get("kind", "iq")
        if kind == "audio":
            if self.job == "record" or self.sched_audio:
                return
            self.sched_id = due["id"]
            self._start_job("listen", {})
            self.sched_audio = {"end": due["end"], "label": due.get("label", "pass"), "squelch": self.squelch_db, "peak": -99.0}
            self.squelch_db = 0.0
            self.set_mode_raw(due.get("mode", "nfm"), due.get("bw"))
            self._set_vfo(float(due["freq"]), 1, True)
            self.doppler = {"sat": due["sat"], "f0": float(due["freq"])}
            self._rec_audio(True, auto=True, tag=due.get("sat", ""))
            self.notice("Recording %s now." % due.get("label", "the satellite pass"))
        elif self.job != "record" and not self.sched_audio:
            self.sched_id = due["id"]
            self._start_job("record", {"freq": due["freq"], "seconds": due["end"] - now, "label": due.get("label", "pass"),
                                       "sat": due["sat"], "aos": due.get("aos"), "los": due.get("los"),
                                       "max_el": due.get("max_el")})
            self.notice("Recording %s now." % due.get("label", "the satellite pass"))
