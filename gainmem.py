"""Gain remembered per frequency.

"Find the best gain" stores its answer here against the tuned frequency. Coming back to that frequency, the engine
applies it straight away (no warning, no message), then quietly checks it is still right and updates it if not.
An entry covers frequencies within 100 kHz above 30 MHz (the strong signals that set the best gain are usually the
station itself or its neighbours), and within 10 kHz below. Saved to gain_memory.json in the data folder."""
import json
import os
import threading
import time

MAX = 400


def tol(f):
    return 100e3 if f >= 30e6 else 10e3


class GainMemory:
    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        self.items = []
        try:
            with open(path) as fh:
                data = json.load(fh)
            self.items = [e for e in data.get("entries", []) if isinstance(e, dict) and isinstance(e.get("f"), (int, float)) and isinstance(e.get("gain"), (int, float))]
        except (OSError, ValueError, AttributeError):
            self.items = []

    def find(self, f):
        """The entry for frequency f (the nearest within its reach), or None."""
        with self.lock:
            near = [e for e in self.items if abs(e["f"] - f) <= tol(f)]
            return dict(min(near, key=lambda e: abs(e["f"] - f))) if near else None

    def put(self, f, gain, snr=None, checked=True):
        now = time.time()
        with self.lock:
            self.items = [e for e in self.items if abs(e["f"] - f) > tol(f) / 2]   # this one replaces anything right next to it
            e = {"f": float(f), "gain": float(gain), "snr": None if snr is None else round(float(snr), 1), "t": now, "checked": now if checked else None}
            self.items.append(e)
            if len(self.items) > MAX:
                self.items.sort(key=lambda x: x.get("checked") or x["t"])
                self.items = self.items[-MAX:]
        self._save()
        return dict(e)

    def touch(self, f):
        """Mark the entry for f as checked just now (still right)."""
        with self.lock:
            near = [e for e in self.items if abs(e["f"] - f) <= tol(f)]
            if not near:
                return
            min(near, key=lambda e: abs(e["f"] - f))["checked"] = time.time()
        self._save()

    def forget(self, f):
        with self.lock:
            n = len(self.items)
            self.items = [e for e in self.items if abs(e["f"] - f) > tol(f)]
            changed = len(self.items) != n
        if changed:
            self._save()
        return changed

    def _save(self):
        with self.lock:
            data = {"entries": list(self.items)}
        tmp = self.path + ".tmp"
        try:
            with open(tmp, "w") as fh:
                json.dump(data, fh)
            os.replace(tmp, self.path)
        except OSError:
            pass
