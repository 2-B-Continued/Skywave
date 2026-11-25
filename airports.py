"""Airports of the world, for naming where a plane took off from and for reading routes given as airport codes.

The list comes from OurAirports (ourairports.com, public domain): airports with scheduled flights, plus every large
and medium airport. It is downloaded once by the computer running Skywave, kept as airports.json in the data folder
and refreshed every 30 days. Until it arrives, or with no internet, lookups simply find nothing."""
import csv
import io
import json
import math
import os
import threading
import time
import urllib.request

SOURCE = "https://davidmegginson.github.io/ourairports-data/airports.csv"
MAX_AGE = 30 * 86400
RETRY = 3600
UA = "Skywave (self-hosted radio receiver)"
KINDS = {"large_airport": 3, "medium_airport": 2, "small_airport": 1}


def _download(url=SOURCE):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read(60_000_000).decode("utf-8", "replace")


def parse_csv(text):
    """OurAirports CSV -> compact rows [icao, iata, name, city, country, lat, lon, size]."""
    rows = []
    for x in csv.DictReader(io.StringIO(text)):
        size = KINDS.get(x.get("type") or "")
        if not size or (size == 1 and x.get("scheduled_service") != "yes"):
            continue
        try:
            lat, lon = float(x["latitude_deg"]), float(x["longitude_deg"])
        except (KeyError, TypeError, ValueError):
            continue
        icao = (x.get("icao_code") or x.get("gps_code") or x.get("ident") or "").strip().upper()
        iata = (x.get("iata_code") or "").strip().upper()
        if not icao and not iata:
            continue
        rows.append([icao, iata, (x.get("name") or "").strip()[:80], (x.get("municipality") or "").strip()[:60],
                     (x.get("iso_country") or "").strip().upper()[:2], round(lat, 4), round(lon, 4),
                     size + (1 if x.get("scheduled_service") == "yes" else 0)])
    return rows


def _km(la1, lo1, la2, lo2):
    p1, p2 = math.radians(la1), math.radians(la2)
    h = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lo2 - lo1) / 2) ** 2
    return 12742 * math.asin(min(1.0, math.sqrt(h)))


class Airports:
    def __init__(self, path, offline=False, download=_download):
        self.path, self.offline, self.download = path, offline, download
        self.lock = threading.Lock()
        self.rows, self.code, self.grid, self.t = [], {}, {}, 0.0
        self.tried = None                          # when a download was last tried
        try:
            with open(path, encoding="utf-8") as f:
                d = json.load(f)
            self._index(d.get("rows") or [], float(d.get("t") or 0))
        except (OSError, ValueError, TypeError):
            pass

    def _index(self, rows, t):
        code, grid = {}, {}
        for r in rows:
            for c in (r[0], r[1]):
                if c and (c not in code or r[7] > code[c][7]):
                    code[c] = r
            grid.setdefault((int(math.floor(r[5])), int(math.floor(r[6]))), []).append(r)
        with self.lock:
            self.rows, self.code, self.grid, self.t = rows, code, grid, t

    def refresh(self, now=None):
        """Download the list when it is missing or old. Runs at most once an hour; call it from a background thread."""
        now = now or time.time()
        if self.offline or (self.rows and now - self.t < MAX_AGE) or (self.tried is not None and now - self.tried < RETRY):
            return False
        self.tried = now
        return self._load(now)

    def _load(self, now):
        try:
            rows = parse_csv(self.download())
        except Exception:
            return False
        if len(rows) < 1000:                   # a broken download: keep what we have
            return False
        self._index(rows, now)
        try:
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"t": now, "rows": rows}, f, separators=(",", ":"))
            os.replace(tmp, self.path)
        except OSError:
            pass
        return True

    def ensure(self):
        """Start a background download if the list is missing or old."""
        if not self.offline and (not self.rows or time.time() - self.t >= MAX_AGE) and (self.tried is None or time.time() - self.tried >= RETRY):
            self.tried = time.time()
            threading.Thread(target=self._load, args=(self.tried,), daemon=True).start()

    @staticmethod
    def _out(r, km=None):
        out = {"icao": r[0] or None, "iata": r[1] or None, "name": r[2], "city": r[3], "country": r[4], "lat": r[5], "lon": r[6]}
        if km is not None:
            out["km"] = round(km, 1)
        return out

    def by_code(self, code):
        code = str(code or "").strip().upper()
        with self.lock:
            r = self.code.get(code)
        return self._out(r) if r else None

    def nearest(self, lat, lon, max_km=15.0, scheduled=True):
        """The closest airport within max_km of (lat, lon), preferring airports with scheduled flights."""
        best, cells = None, int(max_km / 100) + 1
        with self.lock:
            for dy in range(-cells, cells + 1):
                for dx in range(-cells, cells + 1):
                    for r in self.grid.get((int(math.floor(lat)) + dy, (int(math.floor(lon)) + dx + 180) % 360 - 180), ()):
                        if scheduled and r[7] < 2:
                            continue
                        d = _km(lat, lon, r[5], r[6])
                        if d <= max_km and (best is None or d - 3 * r[7] < best[0] - 3 * best[1][7]):
                            best = (d, r)
        return self._out(best[1], best[0]) if best else None
