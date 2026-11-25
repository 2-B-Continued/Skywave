"""What an aircraft is, where it is flying from and to, and where it has been, for the Planes page.

ADS-B carries a 24-bit address and a callsign, not the registration, model, operator or route, and a receiver only
hears a plane while it is in range. These free public services fill the gaps. All of them are asked from the
computer running Skywave, never from the browser, and only when the Planes page wants the answer.

- Aircraft (registration, maker and model, operator, photo): adsbdb.com, GET /v0/aircraft/<address>. When it has no
  record, the adsb.lol network (GET /v2/hex/<address>) usually knows the registration and model.
- Route (origin, destination, flight number, airline): several free sources of standing route data, asked together
  and each checked against where the plane is. The route service tar1090 uses (adsb.im, POST /api/0/routeset, with
  adsb.lol as its stand-in), the adsb.lol copy of the VRS standing data, hexdb.io and adsbdb (GET /v0/callsign/<callsign>,
  which also gives the flight number and airline). A callsign is not unique worldwide and airlines change routes, so a
  route is kept only when it passes near the plane (or, before it has a position, near the receiver). When the
  sources disagree or none fits, the airport the plane took off from (from the network's track of its flight) decides:
  a route must start there, and if none does, that airport is shown on its own.
- Path flown so far: the adsb.lol network's track for the plane's current flight (its readsb trace file), so the
  map can show the part of the journey flown outside your own receiver's range.

Airport codes are turned into names and places with the airports list (airports.py); whether the flight is domestic or
international, and its usual terminals at Australia's major airports, come from terminals.py.

Sent: the aircraft address, the callsign and, for the route check, the plane's current position (or the receiver's
position, rounded to about 10 km, before the plane has sent one). Answers are kept
in planeinfo.json in the data folder (aircraft for 30 days, routes for a day, "not known" for 6 hours); tracks are
kept in memory for a minute. Offline, the page shows what the radio heard."""
import gzip
import json
import math
import os
import re
import threading
import time
import urllib.error
import urllib.request

import airportmap
import terminals

ADSBDB_AC = "https://api.adsbdb.com/v0/aircraft/%s"
ADSBDB_CS = "https://api.adsbdb.com/v0/callsign/%s"
LOL_HEX = "https://api.adsb.lol/v2/hex/%s"
LOL_ROUTES = "https://api.adsb.lol/api/0/routeset"
IM_ROUTES = "https://adsb.im/api/0/routeset"
VRS_ROUTE = "https://vrs-standing-data.adsb.lol/routes/%s/%s.json"
HEX_ROUTE = "https://hexdb.io/api/v1/route/icao/%s"
LOL_TRACE = "https://globe.adsb.lol/data/traces/%s/trace_full_%s.json"
AC_TTL, RT_TTL, MISS_TTL, TRACE_TTL = 30 * 86400, 86400, 6 * 3600, 60
MAX = 3000
TRACE_POINTS = 1200
UA = "Skywave (self-hosted radio receiver)"
VERSION = 4
TAKEOFF_TTL = 3 * 3600
EARTH_KM = 6371.0
NEAR_KM = 400        # how far a plane may stray from the straight line of its route
HEARD_KM = 600       # how far from the receiver a plane can be heard, for checks made from the receiver's position


def _fetch(url, body=None):
    """-> (HTTP status, body bytes). A POST sends `body` as JSON."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, "Accept": "application/json", "Accept-Encoding": "gzip",
                                                          **({"Content-Type": "application/json"} if data else {})})
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            st, raw = r.status, r.read(4000000)
    except urllib.error.HTTPError as e:
        st, raw = e.code, e.read(20000)
    return st, raw


def _json(raw):
    """Parsed JSON, or None. Gzip-packed answers (the network's track files) are unpacked first."""
    try:
        if raw[:2] == b"\x1f\x8b":
            raw = gzip.decompress(raw)
        return json.loads(raw.decode("utf-8", "replace")) if raw else None
    except (ValueError, OSError, EOFError):
        return None


def _num(v):
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _airport_adsbdb(a):
    if not isinstance(a, dict):
        return None
    return {"name": a.get("name"), "iata": a.get("iata_code"), "icao": a.get("icao_code"), "city": a.get("municipality"),
            "country": a.get("country_iso_name"), "lat": _num(a.get("latitude")), "lon": _num(a.get("longitude"))}


def _airport_lol(a):
    if not isinstance(a, dict):
        return None
    return {"name": a.get("name"), "iata": a.get("iata"), "icao": a.get("icao"), "city": a.get("location"),
            "country": a.get("countryiso2"), "lat": _num(a.get("lat")), "lon": _num(a.get("lon"))}


def _gc_km(a, b):
    """Great-circle distance between two (lat, lon) points in km."""
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * EARTH_KM * math.asin(min(1.0, math.sqrt(h)))


def _leg_km(p, a, b):
    """Shortest distance in km from point p to the great-circle leg from a to b (not beyond its ends)."""
    ab = _gc_km(a, b)
    ap, bp = _gc_km(a, p), _gc_km(b, p)
    if ab < 1:
        return ap
    def bearing(x, y):
        la1, lo1, la2, lo2 = map(math.radians, (x[0], x[1], y[0], y[1]))
        return math.atan2(math.sin(lo2 - lo1) * math.cos(la2),
                          math.cos(la1) * math.sin(la2) - math.sin(la1) * math.cos(la2) * math.cos(lo2 - lo1))
    d13 = ap / EARTH_KM
    xt = math.asin(max(-1.0, min(1.0, math.sin(d13) * math.sin(bearing(a, p) - bearing(a, b)))))
    along = math.acos(max(-1.0, min(1.0, math.cos(d13) / max(1e-12, math.cos(xt))))) * EARTH_KM
    if math.cos(bearing(a, p) - bearing(a, b)) < 0 or along > ab:
        return min(ap, bp)
    return abs(xt) * EARTH_KM


def route_fits(route, pos, slack=0.0):
    """True when the route passes within reach of pos (lat, lon); None when it can't be checked."""
    pts = [route.get("origin")] + list(route.get("stops") or []) + [route.get("destination")]
    pts = [(x["lat"], x["lon"]) for x in pts if isinstance(x, dict) and _num(x.get("lat")) is not None and _num(x.get("lon")) is not None]
    if pos is None or len(pts) < 2:
        return None
    length = sum(_gc_km(pts[i], pts[i + 1]) for i in range(len(pts) - 1))
    reach = max(NEAR_KM, 0.15 * length) + slack            # long flights wander further from the straight line
    return min(_leg_km(pos, pts[i], pts[i + 1]) for i in range(len(pts) - 1)) <= reach


def _title(s):
    """'BOEING 737-800' -> 'Boeing 737-800': makers' names in capitals read better in title case; model codes stay."""
    if not isinstance(s, str) or not s.strip():
        return None
    return " ".join(w.capitalize() if w.isalpha() and len(w) > 3 else w for w in s.strip().split())


class PlaneInfo:
    def __init__(self, path, airports=None, maps=None):
        self.path = path
        self.maps = maps                               # airportmap.AirportMaps: terminals from where planes park
        self.airports = airports                       # airports.Airports, for codes and the takeoff airport
        self.to = {}                                   # address -> (time, callsign, takeoff airport or None)
        self.lock = threading.Lock()
        self.ac, self.rt = {}, {}
        self.tr = {}
        self.dirty = False
        self.saved = 0.0
        try:
            with open(path) as f:
                d = json.load(f)
            if d.get("v") == VERSION:                  # older files hold answers in an earlier shape: start afresh
                self.ac, self.rt = d.get("ac") or {}, d.get("rt") or {}
        except (OSError, ValueError, AttributeError):
            pass

    # ---------------------------------------------------------------- aircraft and route
    def get(self, icao, callsign="", lat=None, lon=None, fetch=_fetch, now=None, home=None, chosen=True):
        """-> {"aircraft": {...} or None, "route": {...} or None, "ok": bool}. ok False: couldn't ask (offline).
        lat, lon: where the plane is, if known. home: (lat, lon) of the receiver, used when the plane has no position.
        chosen: the plane is the one picked on the page, so its takeoff airport may be looked up (a larger download)
        when the route sources disagree or none fits; for the others a takeoff airport already found is still used."""
        now = now or time.time()
        icao = str(icao or "").lower()
        if not re.fullmatch(r"[0-9a-f]{6}", icao):
            return {"aircraft": None, "route": None, "ok": True}
        cs = re.sub(r"[^A-Z0-9]", "", str(callsign or "").upper())[:8]
        with self.lock:
            a, r = self.ac.get(icao), self.rt.get(cs) if cs else None
        fresh = lambda e, ttl: e is not None and now - e[0] < (ttl if e[1] else MISS_TTL)
        ok = True
        if not fresh(a, AC_TTL):
            got = self._aircraft(icao, fetch)
            if got is False:
                ok = False
            else:
                a = [now, got]
                self._keep(self.ac, icao, a)
        pos = (lat, lon) if _num(lat) is not None and _num(lon) is not None else None
        near = home if home and _num(home[0]) is not None and _num(home[1]) is not None else None
        if cs and not fresh(r, RT_TTL):
            ask = pos or (near and (round(near[0], 1), round(near[1], 1)))
            got = self._route(cs, ask[0] if ask else None, ask[1] if ask else None, fetch)
            if got is False:
                ok = False
            else:
                r = [now, got]
                self._keep(self.rt, cs, r)
        self.save()
        route = None
        if r:
            route, unsure = self._compose(r[1], cs, pos, near)
            if unsure:                                 # the sources disagree or none fits: where did it take off?
                take = self.takeoff(icao, cs, fetch, now) if chosen else self._known_takeoff(icao, cs, now)
                if take:
                    route, _ = self._compose(r[1], cs, pos, near, take)
        if route and route.get("origin") and self.maps:
            self._terminals(route, icao, cs, fetch, now, chosen)
        return {"aircraft": a[1] if a else None, "route": route, "ok": ok}

    def _keep(self, store, key, val):
        with self.lock:
            store[key] = list(val)
            self.dirty = True
            self._trim()

    def _aircraft(self, icao, fetch):
        """-> dict, None (no record anywhere) or False (couldn't ask)."""
        try:
            st, raw = fetch(ADSBDB_AC % icao)
        except Exception:
            return False
        if st not in (200, 404):
            return False
        body = _json(raw) or {}
        resp = body.get("response") if isinstance(body, dict) else None
        d = resp.get("aircraft") if isinstance(resp, dict) else None
        out = None
        if isinstance(d, dict):
            out = {k: d.get(k) for k in ("registration", "type", "icao_type", "manufacturer", "registered_owner",
                                         "registered_owner_country_name", "registered_owner_country_iso_name")}
            for k in ("url_photo_thumbnail", "url_photo"):
                u = d.get(k)
                out[k] = u if isinstance(u, str) and u.startswith("https://") and len(u) < 400 else None
        if out is None or not out.get("type"):
            lol = self._aircraft_lol(icao, fetch)
            if lol:
                out = dict(out or {}, **{k: v for k, v in lol.items() if v and not (out or {}).get(k)})
        return out

    @staticmethod
    def _aircraft_lol(icao, fetch):
        try:
            st, raw = fetch(LOL_HEX % icao)
        except Exception:
            return None
        body = _json(raw) if st == 200 else None
        acs = body.get("ac") if isinstance(body, dict) else None
        d = acs[0] if isinstance(acs, list) and acs and isinstance(acs[0], dict) else None
        if not d:
            return None
        return {"registration": d.get("r"), "icao_type": d.get("t"), "description": _title(d.get("desc")),
                "registered_owner": d.get("ownOp"), "year": d.get("year")}

    def _route(self, cs, lat, lon, fetch):
        """-> {"set", "vrs", "hex", "db": candidate or None}, None (no source knows the callsign) or False (none could
        be asked). The sources are asked at the same time."""
        jobs = {"set": lambda: self._route_set(cs, lat, lon, fetch), "vrs": lambda: self._route_vrs(cs, fetch),
                "hex": lambda: self._route_hex(cs, fetch), "db": lambda: self._route_adsbdb(cs, fetch)}
        got = {}
        def run(k):
            try:
                got[k] = jobs[k]()
            except Exception:
                got[k] = False
        ts = [threading.Thread(target=run, args=(k,), daemon=True) for k in jobs]
        for t in ts:
            t.start()
        for t in ts:
            t.join(12)
        if all(got.get(k) is False or k not in got for k in jobs):
            return False
        out = {k: (got.get(k) or None) for k in jobs}
        return out if any(out.values()) else None

    def _place(self, x):
        """An airport from a route, with its name and position filled in from the airports list when missing."""
        if not isinstance(x, dict):
            return None
        if (_num(x.get("lat")) is None or not x.get("name")) and self.airports:
            known = self.airports.by_code(x.get("icao") or x.get("iata"))
            if known:
                x = dict(known, **{k: v for k, v in x.items() if v not in (None, "")})
        return dict(x)                                 # a copy: what is added for this answer stays out of the kept data

    @staticmethod
    def _same(a, b):
        """True when two airports are the same place: a shared code, or within 10 km of each other."""
        for k in ("icao", "iata"):
            if a.get(k) and b.get(k) and str(a[k]).upper() == str(b[k]).upper():
                return True
        if all(_num(x.get(k)) is not None for x in (a, b) for k in ("lat", "lon")):
            return _gc_km((a["lat"], a["lon"]), (b["lat"], b["lon"])) < 10
        return False

    def _compose(self, raw, cs, pos, home, takeoff=None):
        """The sources' answers -> (route or None, unsure). A route is kept only when it passes near the plane (or,
        before it has a position, within hearing of the receiver), and, when the takeoff airport is known, only when
        it starts there (a multi-stop route is cut to start at that stop). unsure: the takeoff airport would help,
        because no route fits or the routes that fit disagree."""
        if not isinstance(raw, dict):
            return None, False
        where, slack = (pos, 0.0) if pos else (home, HEARD_KM)
        good = []
        for k in ("set", "vrs", "hex", "db"):
            c = raw.get(k)
            if not c or not c.get("origin") or not c.get("destination"):
                continue
            legs = [self._place(x) for x in [c["origin"]] + list(c.get("stops") or []) + [c["destination"]]]
            legs = [x for x in legs if x]
            if len(legs) < 2:
                continue
            if takeoff:
                i = next((i for i, x in enumerate(legs[:-1]) if self._same(x, takeoff)), None)
                if i is None:
                    continue
                legs = legs[i:]
            cand = dict(c, origin=legs[0], destination=legs[-1], stops=legs[1:-1], key=k)
            if route_fits(cand, where, slack) is False:
                continue
            good.append(cand)
        ends = {(str(c["origin"].get("icao") or c["origin"].get("iata")), str(c["destination"].get("icao") or c["destination"].get("iata"))) for c in good}
        unsure = not takeoff and (not good or len(ends) > 1)
        db = raw.get("db") or {}
        pick = good[0] if good else None
        # adsbdb's airline is certain when the callsign starts with that airline's three-letter code, which is unique
        # worldwide; otherwise only when its route is the one shown
        code = str(db.get("airline_icao") or "")
        airline_ok = (len(code) == 3 and cs.startswith(code)) or any(c["key"] == "db" for c in good)
        out = {"callsign": cs}
        if airline_ok:
            out.update({k: db.get(k) for k in ("airline", "airline_country")})
            # the flight number: adsbdb's, or the airline's two-letter code with the callsign's number
            num = re.sub(r"^0+", "", cs[len(code):]) if code and cs.startswith(code) else ""
            out["flight"] = db.get("flight") or ((db.get("airline_iata") or "") + num if db.get("airline_iata") and num.isdigit() else None)
        if pick:
            out.update({k: v for k, v in pick.items() if k not in ("key", "flight", "airline", "airline_country", "airline_icao", "airline_iata", "airline_callsign")})
            out["source"] = pick.get("source")
        elif takeoff:
            out.update({"origin": takeoff, "destination": None, "stops": [], "source": "track"})
        elif any(raw.get(k) and raw[k].get("origin") for k in ("set", "vrs", "hex", "db")):
            out["mismatch"] = True                      # routes are on record for this callsign, but none fits today
        if not any(out.get(k) for k in ("airline", "origin", "flight", "mismatch")):
            return None, unsure
        return terminals.annotate(out, cs), unsure

    def _terminals(self, route, icao, cs, fetch, now, chosen):
        """Terminals at both ends, from where the plane stood (for the chosen plane: its track shows where it was parked
        before takeoff and, once landed, where it parked), else the terminal this airline has usually been seen at."""
        tr = self.trace(icao, fetch, now) if chosen else {}
        airline = cs[:3] if re.fullmatch(r"[A-Z]{3}", cs[:3]) else ""
        for key, pts in (("origin", tr.get("dep_ground") or []), ("destination", tr.get("arr_ground") or [])):
            ap = route.get(key)
            if not isinstance(ap, dict) or _num(ap.get("lat")) is None:
                continue
            code = ap.get("icao") or ap.get("iata")
            near = [p for p in pts if _gc_km(p, (ap["lat"], ap["lon"])) < 8]
            got = self.maps.locate(self.maps.get(ap), near) if near else None
            if got:
                ap["terminal"], ap["terminal_seen"] = got["terminal"], True
                if got["gate"]:
                    ap["gate"] = got["gate"]
                self.maps.remember(code, airline, route.get("kind"), got["terminal"])
            elif not ap.get("terminal") and airline:
                usual = self.maps.usual(code, airline, route.get("kind"))
                if usual:
                    ap["terminal"] = usual
            if ap.get("terminal") and not route.get("kind"):   # "Domestic Terminal" says what kind of flight it is
                route["kind"] = airportmap.kind_of(ap["terminal"])

    def _known_takeoff(self, icao, cs, now):
        with self.lock:
            hit = self.to.get(icao)
        return hit[2] if hit and hit[1] == cs and now - hit[0] < TAKEOFF_TTL else None

    def takeoff(self, icao, cs, fetch=_fetch, now=None):
        """The airport the plane took off from on this flight, from the network's track, or None. A track that starts
        on the ground or low down is next to the airport; one that starts high began out of the network's reach."""
        now = now or time.time()
        if not self.airports:
            return None
        with self.lock:
            hit = self.to.get(icao)
        if hit and hit[1] == cs and now - hit[0] < (TAKEOFF_TTL if hit[2] else 300):
            return hit[2]
        tr = self.trace(icao, fetch, now)
        pts = tr.get("points") or []
        found = None
        if pts:
            t, lat, lon, alt = pts[0][:4]
            if alt is None or alt <= 4000:
                found = self.airports.nearest(lat, lon, 8 if not alt else 30)
            if found:
                found.pop("km", None)
        if tr.get("ok") or found:
            with self.lock:
                self.to[icao] = (now, cs, found)
                for k in [k for k, v in self.to.items() if now - v[0] > TAKEOFF_TTL]:
                    del self.to[k]
        return found

    @staticmethod
    def _record(rec, source):
        """One standing-route record (routeset, VRS standing data) -> candidate, or None. Airports come either in full
        (_airports) or as a code list ("YSSY-YMML"), which is filled in from the airports list later."""
        if not isinstance(rec, dict):
            return None
        aps = [_airport_lol(x) for x in rec.get("_airports") or []]
        aps = [x for x in aps if x]
        if len(aps) < 2:
            codes = rec.get("airport_codes") or rec.get("_airport_codes_iata") or ""
            codes = [c for c in re.split(r"[-,\s]+", str(codes).upper()) if re.fullmatch(r"[A-Z0-9]{3,4}", c)]
            aps = [{"icao": c} if len(c) == 4 else {"iata": c} for c in codes]
        if len(aps) < 2:
            return None
        return {"origin": aps[0], "destination": aps[-1], "stops": aps[1:-1], "source": source}

    def _route_set(self, cs, lat, lon, fetch):
        """The routeset service tar1090 uses, then adsb.lol's copy of it."""
        plane = {"callsign": cs, "lat": lat if _num(lat) is not None else 0, "lng": lon if _num(lon) is not None else 0}
        result = False
        for url, name in ((IM_ROUTES, "adsb.im"), (LOL_ROUTES, "adsb.lol")):
            try:
                st, raw = fetch(url, {"planes": [plane]})
            except Exception:
                continue
            if st not in (200, 201):
                continue
            body = _json(raw)
            recs = body if isinstance(body, list) else []
            rec = next((r for r in recs if isinstance(r, dict) and str(r.get("callsign", "")).upper() == cs), None)
            got = self._record(rec, name)
            if got:
                return got
            result = None
        return result

    def _route_vrs(self, cs, fetch):
        """The VRS standing data (public domain) as published by adsb.lol, one file per callsign."""
        if len(cs) < 3:
            return None
        try:
            st, raw = fetch(VRS_ROUTE % (cs[:2], cs))
        except Exception:
            return False
        if st == 404:
            return None
        if st != 200:
            return False
        return self._record(_json(raw), "VRS standing data")

    def _route_hex(self, cs, fetch):
        try:
            st, raw = fetch(HEX_ROUTE % cs)
        except Exception:
            return False
        if st == 404:
            return None
        if st != 200:
            return False
        d = _json(raw)
        if not isinstance(d, dict) or str(d.get("flight", cs)).upper() != cs:
            return None
        return self._record({"airport_codes": d.get("route")}, "hexdb.io")

    @staticmethod
    def _route_adsbdb(cs, fetch):
        try:
            st, raw = fetch(ADSBDB_CS % cs)
        except Exception:
            return False
        if st not in (200, 404):
            return False
        body = _json(raw) or {}
        resp = body.get("response") if isinstance(body, dict) else None
        d = resp.get("flightroute") if isinstance(resp, dict) else None
        if not isinstance(d, dict):
            return None
        al = d.get("airline") if isinstance(d.get("airline"), dict) else {}
        o, m, t = _airport_adsbdb(d.get("origin")), _airport_adsbdb(d.get("midpoint")), _airport_adsbdb(d.get("destination"))
        out = {"flight": d.get("callsign_iata"), "airline": al.get("name"), "airline_country": al.get("country_iso") or al.get("country"),
               "airline_icao": al.get("icao"), "airline_iata": al.get("iata")}
        if o and t:
            out.update({"origin": o, "destination": t, "stops": [m] if m else [], "source": "adsbdb"})
        return out

    # ---------------------------------------------------------------- the path flown so far
    def trace(self, icao, fetch=_fetch, now=None):
        """The network's track of the plane's current flight: {"points": [[unix time, lat, lon, altitude ft or None]],
        "ok": bool}. Points are thinned to at most TRACE_POINTS; altitude 0 means on the ground."""
        now = now or time.time()
        icao = str(icao or "").lower()
        if not re.fullmatch(r"[0-9a-f]{6}", icao):
            return {"points": [], "ok": True}
        with self.lock:
            hit = self.tr.get(icao)
        if hit and now - hit[0] < TRACE_TTL:
            return hit[1]
        try:
            st, raw = fetch(LOL_TRACE % (icao[-2:], icao))
        except Exception:
            return {"points": [], "ok": False}
        if st == 404:
            out = {"points": [], "ok": True}
        elif st != 200:
            return {"points": [], "ok": False}
        else:
            d = _json(raw)
            out = dict(self._ground(d), points=self._leg(d), ok=True)
        with self.lock:
            self.tr[icao] = (now, out)
            for k in [k for k, v in self.tr.items() if now - v[0] > TRACE_TTL * 5]:
                del self.tr[k]
        return out

    @staticmethod
    def _ground(d):
        """Where the plane stood still on the ground: before this flight took off ("dep_ground") and, once it has
        landed, after ("arr_ground"). Each is a list of (lat, lon), at most 60, newest last."""
        if not isinstance(d, dict) or not isinstance(d.get("trace"), list):
            return {"dep_ground": [], "arr_ground": []}
        rows = [r for r in d["trace"] if isinstance(r, list) and len(r) >= 5 and _num(r[1]) is not None and _num(r[2]) is not None]
        start = 0
        for i, r in enumerate(rows):
            if len(r) > 6 and isinstance(r[6], int) and r[6] & 2:
                start = i
        ground = lambda r: r[3] == "ground"
        still = lambda r: ground(r) and (_num(r[4]) is None or _num(r[4]) < 2.5)
        air = [i for i in range(len(rows)) if not ground(rows[i]) and _num(rows[i][3]) is not None]
        mine = [i for i in air if i >= start]
        if not mine:
            return {"dep_ground": [], "arr_ground": []}
        up, down = mine[0], mine[-1]
        before = [i for i in air if i < up]
        since = before[-1] + 1 if before else 0          # after the previous flight landed
        dep = [(rows[i][1], rows[i][2]) for i in range(since, up) if still(rows[i])]
        arr = [(rows[i][1], rows[i][2]) for i in range(down + 1, len(rows)) if still(rows[i])]
        return {"dep_ground": dep[-60:], "arr_ground": arr[:60]}

    @staticmethod
    def _leg(d):
        """readsb trace -> the points of the latest leg. Each trace row is [seconds after `timestamp`, lat, lon,
        altitude or "ground", ground speed, track, flags, ...]; flag bit 2 marks the start of a new leg."""
        if not isinstance(d, dict) or not isinstance(d.get("trace"), list):
            return []
        t0 = _num(d.get("timestamp")) or 0
        rows = [r for r in d["trace"] if isinstance(r, list) and len(r) >= 3 and _num(r[1]) is not None and _num(r[2]) is not None]
        start = 0
        for i, r in enumerate(rows):
            if len(r) > 6 and isinstance(r[6], int) and r[6] & 2:
                start = i
        rows = rows[start:]
        step = max(1, len(rows) // TRACE_POINTS + (1 if len(rows) % TRACE_POINTS else 0))
        pts = []
        for i, r in enumerate(rows):
            if i % step and i != len(rows) - 1:
                continue
            alt = r[3] if len(r) > 3 else None
            alt = 0 if alt == "ground" else (round(alt) if _num(alt) is not None else None)
            pts.append([round(t0 + (_num(r[0]) or 0)), round(r[1], 5), round(r[2], 5), alt])
        return pts

    # ---------------------------------------------------------------- storage
    def _trim(self):
        for store in (self.ac, self.rt):
            if len(store) > MAX:
                for k, _ in sorted(store.items(), key=lambda kv: kv[1][0])[:len(store) - MAX]:
                    store.pop(k, None)

    def save(self, force=False):
        now = time.time()
        if not self.dirty or (not force and now - self.saved < 60):
            return
        with self.lock:
            data = json.dumps({"v": VERSION, "ac": self.ac, "rt": self.rt})
            self.dirty = False
        self.saved = now
        tmp = self.path + ".tmp"
        try:
            with open(tmp, "w") as f:
                f.write(data)
            os.replace(tmp, self.path)
        except OSError:
            pass
