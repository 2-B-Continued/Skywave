"""config.py - settings: defaults < /data/config.json < environment variables."""
import json
import os
import threading

DEFAULTS = {
    "iq_file": "",                 # play back a recorded baseband (IQ) file from the recordings folder instead of using the radio
    "iq_center": 0.0,              # centre frequency (Hz) that file was recorded at
    "sim": False,                  # use the built-in simulator instead of real hardware
    "port": 8073,
    "data_dir": "/data",
    "rtl_tcp": "",                 # "host:port" to use a remote rtl_tcp instead of the local dongle
    "sample_rate": 2400000,        # 2.4M, 1.92M, 1.2M or 0.96M
    "lat": 0.0,                    # your location: set in the first-run setup or in Settings
    "lon": 0.0,
    "alt": 0.0,                    # metres above sea level
    "region": "intl",              # which country's channel plans to show (see regions.py)
    "country": "",                 # two-letter country code of your location ("GB"): that country's own settings within a shared region, and music links
    "lang": "en",                  # interface language (files in static/lang)
    "units": "metric",             # metric | imperial
    "tz": "",                      # IANA time zone name, e.g. Europe/Berlin ("" = the server's own)
    "setup_done": False,           # has the first-run setup been completed (or skipped)?
    "devices": {"radio": 0},       # dongle index used by the receiver (a 2nd dongle is not required)
    "gain_auto": False,
    "gain_db": 28.0,
    "ppm": 0,
    "bias_t": False,
    "hf_mode": "auto",             # auto | direct | off  (direct sampling for <24 MHz on generic dongles)
    "deemph_us": 50,               # FM de-emphasis in microseconds: 50 = most of the world, 75 = Americas
    "settle_s": 0.25,              # discard this much data after a retune
    "auth_user": "",
    "auth_pass": "",
    "adsb_gain_db": 49.6,
    "sat_gain_db": 40.2,          # tuner gain while recording a satellite pass (fixed, never automatic)
    "auto_decode": True,           # turn weather satellite recordings into pictures automatically
    "audio_format": "mp3",         # wav | mp3 : format for recorded sound (mp3 is ~10x smaller)
    "mp3_kbps": 48,                # voice is fine at 48; use 96+ for music
    "captions": True,              # allow live captions on spoken channels
    "morse": True,                 # decode Morse code automatically where it is used
    "caption_model": "base.en",    # faster-whisper model: tiny.en | base.en | small.en
    "caption_save": False,         # also save captions as plain text files
    "daily_sync": True,            # refresh satellite orbits and frequencies at least once a day
    "acars_freqs": [],             # aircraft message channels in Hz ([] = the usual ones for the region)
    "pager_freq": 0,               # last pager channel listened to (Hz)
    "watch_words": [],             # words that raise an alert when they appear in a pager or aircraft message
    "mqtt": {"on": False, "host": "", "port": 1883, "user": "", "pass": "", "prefix": "skywave", "discovery": True},
    "gain_hint": True,             # warn when the signal overloads the dongle
    "conv": {"lo": 0, "invert": False, "below": 0},   # up/down-converter between antenna and dongle (Hz)
    "rigctl": {"on": False, "port": 7356, "allow": "127.0.0.1, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16"},   # Gqrx-style remote control
}

ENV_MAP = {
    "SIM": ("sim", lambda v: v.lower() in ("1", "true", "yes", "on")),
    "PORT": ("port", int),
    "DATA_DIR": ("data_dir", str),
    "RTL_TCP": ("rtl_tcp", str),
    "SAMPLE_RATE": ("sample_rate", int),
    "LAT": ("lat", float),
    "LON": ("lon", float),
    "ALT": ("alt", float),
    "GAIN_DB": ("gain_db", float),
    "PPM": ("ppm", int),
    "BIAS_T": ("bias_t", lambda v: v.lower() in ("1", "true", "yes", "on")),
    "HF_MODE": ("hf_mode", str),
    "DEEMPH_US": ("deemph_us", int),
    "SETUP_DONE": ("setup_done", lambda v: v.lower() in ("1", "true", "yes", "on")),
    "AUTH_USER": ("auth_user", str),
    "AUTH_PASS": ("auth_pass", str),
}
EDITABLE = {"iq_file", "iq_center", "lat", "lon", "alt", "gain_auto", "gain_db", "ppm", "hf_mode", "deemph_us", "devices", "bias_t",
            "settle_s", "adsb_gain_db", "sat_gain_db", "sample_rate", "auto_decode", "audio_format", "mp3_kbps", "captions", "morse",
            "caption_model", "caption_save", "daily_sync", "region", "country", "lang", "units", "tz", "setup_done",
            "acars_freqs", "pager_freq", "watch_words", "mqtt", "gain_hint", "conv", "rigctl"}
SAMPLE_RATES = (2400000, 1920000, 1200000, 960000)


class Config:
    def __init__(self):
        self._lock = threading.Lock()
        self.v = json.loads(json.dumps(DEFAULTS))
        self.env_overrides = set()
        d = os.environ.get("DATA_DIR", self.v["data_dir"])
        self.path = os.path.join(d, "config.json")
        try:
            with open(self.path) as f:
                saved = json.load(f)
            for k, val in saved.items():
                if k in DEFAULTS:
                    self.v[k] = val
        except (OSError, ValueError):
            pass
        for env, (key, conv) in ENV_MAP.items():
            if env in os.environ and os.environ[env] != "":
                try:
                    self.v[key] = conv(os.environ[env])
                    self.env_overrides.add(key)
                except ValueError:
                    pass
        os.makedirs(self.v["data_dir"], exist_ok=True)
        for sub in ("recordings", "tle", "transcripts"):
            os.makedirs(os.path.join(self.v["data_dir"], sub), exist_ok=True)

    def __getitem__(self, k):
        return self.v[k]

    def get(self, k, default=None):
        return self.v.get(k, default)

    def update(self, changes):
        """Apply editable changes; returns the dict of keys that changed."""
        changed = {}
        with self._lock:
            for k, val in changes.items():
                if k not in EDITABLE or k in self.env_overrides:
                    continue
                if k == "sample_rate" and int(val) not in SAMPLE_RATES:
                    continue
                if k in ("lat", "lon", "alt", "gain_db", "ppm", "deemph_us", "settle_s", "adsb_gain_db", "sat_gain_db"):
                    try:
                        val = float(val)
                    except (TypeError, ValueError):
                        continue
                if k == "lat" and not -90 <= val <= 90:
                    continue
                if k == "lon" and not -180 <= val <= 180:
                    continue
                if k == "sample_rate":
                    val = int(val)
                if k == "iq_file":
                    val = os.path.basename(str(val or ""))
                if k == "iq_center":
                    try:
                        val = float(val)
                    except (TypeError, ValueError):
                        continue
                if k == "audio_format" and val not in ("wav", "mp3"):
                    continue
                if k == "region":
                    import regions
                    val = regions.canon(val)            # a single-country id (uk, nz, ...) maps to its shared entry
                if k == "lang":
                    val = str(val)
                    if not val.replace("-", "").isalnum() or len(val) > 10:
                        continue
                if k == "country":
                    val = str(val or "").upper()
                    if val and not (len(val) == 2 and val.isalpha()):
                        continue
                if k == "units" and val not in ("metric", "imperial"):
                    continue
                if k == "tz":
                    val = str(val)
                    if val:
                        try:
                            import zoneinfo
                            zoneinfo.ZoneInfo(val)
                        except Exception:
                            continue
                if k in ("lat", "lon", "alt"):
                    try:
                        val = float(val)
                    except (TypeError, ValueError):
                        continue
                    if (k == "lat" and not -90 <= val <= 90) or (k == "lon" and not -180 <= val <= 180):
                        continue
                if k in ("setup_done", "gain_hint"):
                    val = bool(val)
                if k == "acars_freqs":
                    try:
                        val = sorted({round(float(x)) for x in (val or []) if 118e6 <= float(x) <= 138e6})[:8]
                    except (TypeError, ValueError):
                        continue
                if k == "pager_freq":
                    try:
                        val = float(val)
                    except (TypeError, ValueError):
                        continue
                if k == "conv":
                    try:
                        val = {"lo": float(val.get("lo") or 0), "invert": bool(val.get("invert")), "below": max(0.0, float(val.get("below") or 0))}
                    except (AttributeError, TypeError, ValueError):
                        continue
                    if not -20e9 < val["lo"] < 20e9:
                        continue
                if k == "rigctl":
                    try:
                        port = min(max(int(val.get("port", 7356)), 1024), 65535)
                        allow = ",".join(p.strip() for p in str(val.get("allow", "127.0.0.1")).split(",") if p.strip())[:300]
                        val = {"on": bool(val.get("on")), "port": port, "allow": allow or "127.0.0.1"}
                    except (AttributeError, TypeError, ValueError):
                        continue
                if k == "watch_words":
                    if not isinstance(val, list):
                        continue
                    val = [str(w).strip()[:40] for w in val if str(w).strip()][:30]
                if k == "mqtt":
                    if not isinstance(val, dict):
                        continue
                    m = dict(self.v.get("mqtt") or DEFAULTS["mqtt"])
                    for mk in ("on", "discovery"):
                        if mk in val:
                            m[mk] = bool(val[mk])
                    for mk in ("host", "user", "pass", "prefix"):
                        if mk in val and not (mk == "pass" and val[mk] is None):
                            m[mk] = str(val[mk] or "").strip()[:120]
                    if "port" in val:
                        try:
                            m["port"] = min(max(int(val["port"]), 1), 65535)
                        except (TypeError, ValueError):
                            pass
                    m["prefix"] = "".join(ch for ch in m["prefix"] if ch.isalnum() or ch in "_-/") or "skywave"
                    val = m
                if k == "mp3_kbps":
                    try:
                        val = min(max(int(val), 24), 192)
                    except (TypeError, ValueError):
                        continue
                if k == "caption_model" and val not in ("tiny.en", "base.en", "small.en"):
                    continue
                if k in ("auto_decode", "captions", "caption_save", "daily_sync", "morse"):
                    val = bool(val)
                if self.v.get(k) != val:
                    self.v[k] = val
                    changed[k] = val
            if changed:
                self.save()
        return changed

    def save(self):
        try:
            tmp = self.path + ".tmp"
            with open(tmp, "w") as f:
                json.dump({k: self.v[k] for k in EDITABLE if k in self.v}, f, indent=1)
            os.replace(tmp, self.path)
        except OSError:
            pass

    def public(self):
        d = {k: self.v[k] for k in self.v if k not in ("auth_pass",)}
        d["auth_enabled"] = bool(self.v["auth_user"])
        m = dict(self.v.get("mqtt") or {})
        m["has_pass"] = bool(m.pop("pass", ""))          # the broker password never goes to a browser
        d["mqtt"] = m
        d["locked"] = sorted(self.env_overrides)
        return d

    def path_for(self, *parts):
        return os.path.join(self.v["data_dir"], *parts)
