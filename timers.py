"""timers.py - timed recordings on any frequency: "record 146.5 MHz from 7 pm for 2 hours, every day".

An item says what to tune (frequency, mode), when (start, duration, optional repeat) and what to keep:
sound (an audio file), text (a transcript of what is said) or both.
"""
import json
import os
import threading
import time
import uuid

MODES = ("wfm", "nfm", "am", "usb", "lsb", "cw")
WHAT = ("sound", "text", "both")
REPEAT = ("none", "daily", "weekdays", "weekly")
MIN_FREQ, MAX_FREQ = 100e3, 1.76e9
MAX_ITEMS = 60


def _next_start(start, repeat, now):
    """Next occurrence strictly after `now` (local wall-clock aware, so a 7 pm timer stays at 7 pm across daylight saving)."""
    if repeat == "none":
        return None
    t = start
    guard = 0
    while t <= now and guard < 4000:
        lt = time.localtime(t)
        # advance one calendar day at the same wall-clock time
        nxt = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday + (7 if repeat == "weekly" else 1), lt.tm_hour, lt.tm_min,
                           lt.tm_sec, 0, 0, -1))
        t = nxt
        if repeat == "weekdays":
            while time.localtime(t).tm_wday >= 5:
                lt = time.localtime(t)
                t = time.mktime((lt.tm_year, lt.tm_mon, lt.tm_mday + 1, lt.tm_hour, lt.tm_min, lt.tm_sec, 0, 0, -1))
        guard += 1
    return t


class TimerStore:
    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        self.items = []
        self._load()

    def _load(self):
        try:
            with open(self.path) as f:
                self.items = [i for i in json.load(f) if isinstance(i, dict) and i.get("id")]
        except (OSError, ValueError):
            self.items = []

    def _save(self):
        try:
            tmp = self.path + ".tmp"
            with open(tmp, "w") as f:
                json.dump(self.items, f, indent=1)
            os.replace(tmp, self.path)
        except OSError:
            pass

    def add(self, freq, mode, start, duration, label="", what="sound", repeat="none", bw=None):
        freq, start, duration = float(freq), float(int(float(start))), float(duration)
        if not MIN_FREQ <= freq <= MAX_FREQ:
            raise ValueError("That frequency is outside what the radio can tune")
        if mode not in MODES:
            raise ValueError("Unknown mode")
        if what not in WHAT or repeat not in REPEAT:
            raise ValueError("Unknown option")
        if not 10 <= duration <= 12 * 3600:
            raise ValueError("Duration must be between 10 seconds and 12 hours")
        with self.lock:
            if len(self.items) >= MAX_ITEMS:
                raise ValueError("Too many timers: delete some first")
            if repeat == "none" and start + duration < time.time():
                raise ValueError("That time has already passed")
            item = {"id": "t" + uuid.uuid4().hex[:8], "freq": freq, "mode": mode, "bw": bw, "start": start, "duration": duration,
                    "label": str(label or "")[:60], "what": what, "repeat": repeat, "last_run": None}
            self.items.append(item)
            self.items.sort(key=lambda i: i["start"])
            self._save()
            return dict(item)

    def delete(self, tid):
        with self.lock:
            n = len(self.items)
            self.items = [i for i in self.items if i["id"] != tid]
            if len(self.items) != n:
                self._save()

    def public(self):
        with self.lock:
            return [dict(i) for i in self.items]

    def due(self, now):
        """The item that should be running right now (start has passed, end has not), else None. Also tidies missed ones."""
        with self.lock:
            changed = False
            for i in list(self.items):
                if i["last_run"] == i["start"]:
                    continue
                end = i["start"] + i["duration"]
                if now >= end:                     # missed completely (computer was off, dongle busy)
                    self._advance_locked(i, now)
                    changed = True
                    continue
                if i["start"] <= now:
                    if changed:
                        self._save()
                    return dict(i)
            if changed:
                self._save()
        return None

    def started(self, tid):
        with self.lock:
            for i in self.items:
                if i["id"] == tid:
                    i["last_run"] = i["start"]
            self._save()

    def finished(self, tid, now=None):
        """A run ended (normally or stopped by hand): move a repeating timer on, remove a one-off."""
        now = now or time.time()
        with self.lock:
            for i in list(self.items):
                if i["id"] == tid:
                    self._advance_locked(i, now)
            self._save()

    def _advance_locked(self, item, now):
        nxt = _next_start(item["start"], item["repeat"], now)
        if nxt is None:
            self.items = [i for i in self.items if i["id"] != item["id"]]
        else:
            item["start"] = nxt
            item["last_run"] = None
            self.items.sort(key=lambda i: i["start"])
