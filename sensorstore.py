"""Wireless sensors heard by the decoder, remembered between restarts.

Each sensor keeps its latest reading, when it was first and last heard, how often, and what you said about it:
a name, whether it is yours (shown first), or hidden (a neighbour's, a passing car). Readings that change over time
(temperature, humidity, wind, rain, power...) keep a 24-hour history in 5-minute steps, but only for sensors heard a few
times (passing cars' tyre sensors are heard once or twice and keep none).

Sensors not heard for 3 days are forgotten unless you named them, marked them yours or hid them (hidden ones are kept
30 days so they stay hidden). Saved to sensors.json in the data folder at most once a minute."""
import json
import os
import re
import threading
import time

HIST = ("temperature_C", "temperature_F", "humidity", "wind_avg_km_h", "wind_avg_m_s", "wind_max_km_h", "wind_max_m_s", "rain_mm", "rain_in",
        "pressure_hPa", "pressure_kPa", "power_W", "power_kW", "energy_kWh", "moisture", "light_lux", "lux", "uv", "uvi", "depth_cm", "battery_V")
STEP = 300                       # history: one point per 5 minutes
SPAN = 24 * 3600
MAX_DEVS = 600
SKIP = ("time", "model", "id", "channel", "protocol", "mod", "freq1", "freq2", "mic", "subtype", "raw_msg")
TPMS = re.compile(r"tpms|tire|tyre|schrader|jansite|pmv|pacific", re.I)


def key_for(d):
    return "%s|%s|%s" % (d.get("model"), d.get("id", d.get("channel", "")), d.get("channel", ""))


class SensorStore:
    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        self.devs = {}           # key -> latest record (what the page and MQTT see)
        self.hist = {}           # key -> {field: [[t, value], ...]}
        self.dirty = False
        self.saved = 0.0
        try:
            with open(path) as f:
                data = json.load(f)
            self.devs = {k: v for k, v in (data.get("devs") or {}).items() if isinstance(v, dict)}
            self.hist = {k: v for k, v in (data.get("hist") or {}).items() if isinstance(v, dict)}
        except (OSError, ValueError, AttributeError):
            pass
        self.prune()

    # ---- the decoder heard something
    def update(self, d, now=None):
        now = now or time.time()
        key = key_for(d)
        with self.lock:
            s = self.devs.get(key)
            if s is None:
                s = self.devs[key] = {"key": key, "model": d.get("model"), "id": d.get("id"), "channel": d.get("channel"), "count": 0, "first": now}
            s["count"] = s.get("count", 0) + 1
            s["seen"] = now
            for k, v in d.items():
                if k in SKIP or not isinstance(v, (str, int, float, bool)):
                    continue
                if k in s or len(s) < 48:
                    s[k] = v if not isinstance(v, str) else v[:60]
            if s["count"] >= 3 and not TPMS.search(str(s.get("model") or "")):
                h = self.hist.setdefault(key, {})
                for f in HIST:
                    v = d.get(f)
                    if isinstance(v, bool) or not isinstance(v, (int, float)):
                        continue
                    pts = h.setdefault(f, [])
                    b = int(now // STEP) * STEP
                    if pts and pts[-1][0] == b:
                        pts[-1][1] = round(float(v), 2)          # the latest reading in this 5-minute step
                    else:
                        pts.append([b, round(float(v), 2)])
                    while pts and pts[0][0] < now - SPAN:
                        pts.pop(0)
            self.dirty = True
            out = dict(s)
        if len(self.devs) > MAX_DEVS:
            self.prune(now)
        return out

    # ---- what you said about a sensor
    def set(self, key, name=None, mine=None, hidden=None):
        with self.lock:
            s = self.devs.get(key)
            if not s:
                return None
            if name is not None:
                name = str(name).strip()[:40]
                if name:
                    s["name"] = name
                else:
                    s.pop("name", None)
            if mine is not None:
                s["mine"] = bool(mine)
                if mine:
                    s["hidden"] = False
            if hidden is not None:
                s["hidden"] = bool(hidden)
                if hidden:
                    s["mine"] = False
            self.dirty = True
            return dict(s)

    def forget(self, key):
        with self.lock:
            gone = self.devs.pop(key, None) is not None
            self.hist.pop(key, None)
            self.dirty = self.dirty or gone
        return gone

    def history(self, key):
        with self.lock:
            return {f: [list(p) for p in pts] for f, pts in (self.hist.get(key) or {}).items()}

    def prune(self, now=None):
        now = now or time.time()
        with self.lock:
            for k, s in list(self.devs.items()):
                age = now - (s.get("seen") or 0)
                keep = s.get("mine") or s.get("name") or (s.get("hidden") and age < 30 * 86400) or age < 3 * 86400
                if not keep:
                    self.devs.pop(k, None)
                    self.hist.pop(k, None)
            if len(self.devs) > MAX_DEVS:                       # still too many: drop the oldest that nobody marked
                spare = sorted((s.get("seen") or 0, k) for k, s in self.devs.items() if not (s.get("mine") or s.get("name")))
                for _, k in spare[:len(self.devs) - MAX_DEVS]:
                    self.devs.pop(k, None)
                    self.hist.pop(k, None)
            for k in list(self.hist):
                if k not in self.devs:
                    self.hist.pop(k, None)
            self.dirty = True

    def save(self, force=False):
        now = time.time()
        if not self.dirty or (not force and now - self.saved < 60):
            return
        with self.lock:
            data = json.dumps({"devs": self.devs, "hist": self.hist})
            self.dirty = False
        self.saved = now
        tmp = self.path + ".tmp"
        try:
            with open(tmp, "w") as f:
                f.write(data)
            os.replace(tmp, self.path)
        except OSError:
            pass
