"""Which terminal a plane is parked at, at any airport in the world, from where it stands.

No free source lists the terminal every airline uses at every airport. What is free, and covers airports worldwide, is
OpenStreetMap's map of terminal buildings and gates (aeroway=terminal, aeroway=gate, aeroway=parking_position), and
where the plane itself was standing: the network's track of a flight includes its ground positions at the airport it
left from, and at the one it arrives at once it parks. A stand is matched to the nearest gate, and the gate to the
terminal it belongs to (or the stand to the nearest terminal building).

Each terminal found this way is also remembered by airport, airline and domestic or international, so after a plane of
an airline has been seen parked at a terminal twice, that terminal can be shown for that airline's next flights there
before they land, marked as usual rather than seen.

The maps come from the Overpass API (overpass-api.de, OpenStreetMap data, ODbL), one request per airport, kept for 30
days in the data folder. Only the airport's position is sent."""
import json
import math
import os
import re
import threading
import time
import urllib.parse
import urllib.request

OVERPASS = "https://overpass-api.de/api/interpreter"
MAP_TTL = 30 * 86400
MISS_TTL = 86400
RADIUS_M = 4500
GATE_M = 160                 # a stand this close to a gate belongs to it
TERMINAL_M = 350             # or this close to a terminal building
UA = "Skywave/1.0 (self-hosted radio receiver)"
_DOM = re.compile(r"\bdomestic\b|\bnational\b|\binland\b|\bdom\.?\b", re.I)
_INT = re.compile(r"\binternational\b|\bint'?l\.?\b|\bintl\b", re.I)


def _fetch(url, body):
    req = urllib.request.Request(url, data=urllib.parse.urlencode({"data": body}).encode(),
                                 headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=40) as r:
        return r.status, r.read(8_000_001)


def _xy(lat0, lon0, lat, lon):
    """Metres east and north of (lat0, lon0); fine over an airport's few kilometres."""
    return ((lon - lon0) * 111320.0 * math.cos(math.radians(lat0)), (lat - lat0) * 110540.0)


def _seg_m(p, a, b):
    ax, ay = a
    bx, by = b
    px, py = p
    dx, dy = bx - ax, by - ay
    t = 0.0 if dx == dy == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
    return math.hypot(px - ax - t * dx, py - ay - t * dy)


def _inside(p, poly):
    x, y = p
    hit = False
    for i in range(len(poly)):
        (x1, y1), (x2, y2) = poly[i - 1], poly[i]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / ((y2 - y1) or 1e-12) + x1:
            hit = not hit
    return hit


def _poly_m(p, poly):
    """0 inside the polygon, else the distance in metres to its edge."""
    if len(poly) >= 3 and _inside(p, poly):
        return 0.0
    return min((_seg_m(p, poly[i - 1], poly[i]) for i in range(len(poly))), default=1e9)


def terminal_label(tags):
    """A short name for a terminal from its map tags: "T1", "Domestic Terminal", "Terminal B" and so on."""
    ref, name = (tags.get("ref") or "").strip(), (tags.get("name:en") or tags.get("name") or "").strip()
    if ref and re.fullmatch(r"[A-Za-z]?\d{1,2}[A-Za-z]?|[A-Z]", ref):
        return ref if ref[0].upper() == "T" and len(ref) > 1 else "T" + ref if ref.isdigit() else "Terminal " + ref
    m = re.search(r"\bterminal\s*([A-Z]?\d{1,2}[A-Z]?|[A-Z])\b", name, re.I)
    if m:
        v = m.group(1).upper()
        return "T" + v if v[0].isdigit() else "Terminal " + v
    if name:
        return name[:48]
    return None


def kind_of(label):
    """"domestic", "international" or None, from a terminal's name."""
    if not label:
        return None
    return "domestic" if _DOM.search(label) else "international" if _INT.search(label) else None


class AirportMaps:
    def __init__(self, folder, offline=False, fetch=_fetch):
        self.folder, self.offline, self.fetch = folder, offline, fetch
        self.lock = threading.Lock()
        self.maps = {}                     # airport code -> (time, map or None)
        self.busy = set()
        self.seen_path = os.path.join(folder, "terminals-seen.json")
        try:
            with open(self.seen_path, encoding="utf-8") as f:
                self.seen = json.load(f)
        except (OSError, ValueError):
            self.seen = {}
        os.makedirs(os.path.join(folder, "airportmaps"), exist_ok=True)

    # ---------------------------------------------------------------- maps
    def _path(self, code):
        return os.path.join(self.folder, "airportmaps", re.sub(r"[^A-Z0-9]", "", code.upper())[:4] + ".json")

    def get(self, ap, wait=False):
        """The map of an airport ({"terminals": [...], "gates": [...]}), or None while it is being fetched or if
        OpenStreetMap has nothing. ap: an airport with icao or iata, lat and lon."""
        code = str(ap.get("icao") or ap.get("iata") or "").upper()
        if not code or ap.get("lat") is None or ap.get("lon") is None:
            return None
        now = time.time()
        with self.lock:
            hit = self.maps.get(code)
        if hit is None:
            try:
                with open(self._path(code), encoding="utf-8") as f:
                    d = json.load(f)
                hit = (float(d["t"]), d.get("map"))
                with self.lock:
                    self.maps[code] = hit
            except (OSError, ValueError, KeyError, TypeError):
                hit = None
        if hit and now - hit[0] < (MAP_TTL if hit[1] else MISS_TTL):
            return hit[1]
        if self.offline:
            return hit[1] if hit else None
        if wait:
            self._load(code, ap["lat"], ap["lon"])
            with self.lock:
                hit = self.maps.get(code)
            return hit[1] if hit else None
        with self.lock:
            if code in self.busy:
                return hit[1] if hit else None
            self.busy.add(code)
        threading.Thread(target=self._load, args=(code, ap["lat"], ap["lon"]), daemon=True).start()
        return hit[1] if hit else None

    def _load(self, code, lat, lon):
        q = ('[out:json][timeout:30];(way["aeroway"="terminal"](around:{r},{la},{lo});'
             'relation["aeroway"="terminal"](around:{r},{la},{lo});'
             'node["aeroway"~"^(gate|parking_position)$"](around:{r},{la},{lo}););out geom tags;').format(r=RADIUS_M, la=lat, lo=lon)
        try:
            st, raw = self.fetch(OVERPASS, q)
            m = self.parse(json.loads(raw.decode("utf-8", "replace")), lat, lon) if st == 200 else False
        except Exception:
            m = False
        finally:
            with self.lock:
                self.busy.discard(code)
        if m is False:
            return                                  # couldn't ask: try again next time
        now = time.time()
        with self.lock:
            self.maps[code] = (now, m)
        try:
            tmp = self._path(code) + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"t": now, "map": m}, f, separators=(",", ":"))
            os.replace(tmp, self._path(code))
        except OSError:
            pass

    @staticmethod
    def parse(d, lat, lon):
        """Overpass answer -> {"lat", "lon", "terminals": [{"label", "poly"}], "gates": [{"ref", "terminal", "xy"}]}
        in metres around the airport, or None when the map has no terminals."""
        terms, gates = [], []
        for el in d.get("elements") or []:
            tags = el.get("tags") or {}
            if tags.get("aeroway") == "terminal":
                rings = []
                if el.get("type") == "way" and el.get("geometry"):
                    rings.append(el["geometry"])
                for mem in el.get("members") or []:
                    if mem.get("role", "outer") in ("outer", "") and mem.get("geometry"):
                        rings.append(mem["geometry"])
                label = terminal_label(tags)
                for ring in rings:
                    poly = [_xy(lat, lon, g["lat"], g["lon"]) for g in ring if "lat" in g and "lon" in g]
                    if len(poly) >= 3:
                        terms.append({"label": label, "poly": [[round(x, 1), round(y, 1)] for x, y in poly]})
            elif el.get("type") == "node" and tags.get("aeroway") in ("gate", "parking_position") and "lat" in el:
                x, y = _xy(lat, lon, el["lat"], el["lon"])
                t = tags.get("terminal") or tags.get("airport:terminal") or ""
                gates.append({"ref": (tags.get("ref") or "")[:12], "terminal": terminal_label({"ref": t}) if t else None,
                              "xy": [round(x, 1), round(y, 1)]})
        if not terms:
            return None
        return {"lat": lat, "lon": lon, "terminals": terms, "gates": gates}

    @staticmethod
    def locate(m, points):
        """The terminal for a plane parked at one of `points` [(lat, lon)], or None. Each point is tried, and the one
        that lands closest to a gate or terminal wins: a plane also stops on taxiways, but it is parked at its gate."""
        if not m or not points:
            return None
        best = None
        for lat, lon in points[:60]:
            p = _xy(m["lat"], m["lon"], lat, lon)
            for g in m["gates"]:
                dist = math.hypot(p[0] - g["xy"][0], p[1] - g["xy"][1])
                if dist > GATE_M or (best is not None and dist >= best[0]):
                    continue
                label = g["terminal"]
                if not label:                       # the gate's terminal: the building it stands beside
                    near = min(((_poly_m(g["xy"], t["poly"]), t["label"]) for t in m["terminals"] if t["label"]), default=None)
                    label = near[1] if near and near[0] <= TERMINAL_M else None
                if label:
                    best = (dist, label, g["ref"])
            for t in m["terminals"]:
                dist = _poly_m(p, t["poly"])
                if dist <= TERMINAL_M and t["label"] and (best is None or dist + 60 < best[0]):
                    best = (dist + 60, t["label"], "")       # a gate, when there is one, says more than the building
        if not best:
            return None
        return {"terminal": best[1], "gate": best[2] or None, "kind": kind_of(best[1])}

    # ---------------------------------------------------------------- what has been seen
    def remember(self, code, airline, kind, terminal, now=None):
        if not (code and airline and terminal):
            return
        k = "%s|%s|%s" % (code.upper(), airline.upper(), kind or "")
        with self.lock:
            e = self.seen.setdefault(k, {})
            e[terminal] = e.get(terminal, 0) + 1
            if len(self.seen) > 20000:
                self.seen.pop(next(iter(self.seen)))
            data = json.dumps(self.seen, separators=(",", ":"))
        try:
            tmp = self.seen_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(data)
            os.replace(tmp, self.seen_path)
        except OSError:
            pass

    def usual(self, code, airline, kind):
        """The terminal this airline's flights have been seen at here at least twice, when one clearly leads."""
        with self.lock:
            e = dict(self.seen.get("%s|%s|%s" % (str(code).upper(), str(airline).upper(), kind or "")) or {})
        if not e:
            return None
        top = sorted(e.items(), key=lambda kv: -kv[1])
        if top[0][1] >= 2 and (len(top) == 1 or top[0][1] >= 2 * top[1][1]):
            return top[0][0]
        return None
