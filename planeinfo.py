"""What an aircraft is and where it is going, for the Planes page.

ADS-B carries a 24-bit address and a callsign, not the registration, type, operator or route. adsbdb.com (a free public
API, data from PlaneBase) answers both in one request: GET /v0/aircraft/<address>?callsign=<callsign>. Answers are
kept: aircraft for 30 days, routes for a day, "not known" for 6 hours. Kept in planeinfo.json in the data folder.
Only the address and callsign are sent. Offline, the page simply shows what the radio heard."""
import json
import os
import re
import threading
import time
import urllib.request

API = "https://api.adsbdb.com/v0/aircraft/%s"
AC_TTL, RT_TTL, MISS_TTL = 30 * 86400, 86400, 6 * 3600
MAX = 3000


def _fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "skywave (radio receiver; plane tracker)", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            return r.status, r.read(400000)
    except urllib.error.HTTPError as e:
        return e.code, e.read(20000)


def _airport(a):
    if not isinstance(a, dict):
        return None
    return {k: a.get(k) for k in ("name", "iata_code", "icao_code", "municipality", "country_name", "country_iso_name", "latitude", "longitude")}


class PlaneInfo:
    def __init__(self, path):
        self.path = path
        self.lock = threading.Lock()
        self.ac, self.rt = {}, {}
        self.dirty = False
        self.saved = 0.0
        try:
            with open(path) as f:
                d = json.load(f)
            self.ac, self.rt = d.get("ac") or {}, d.get("rt") or {}
        except (OSError, ValueError, AttributeError):
            pass

    def get(self, icao, callsign="", fetch=_fetch, now=None):
        """-> {"aircraft": {...} or None, "route": {...} or None, "ok": bool}. ok False: couldn't ask (offline)."""
        now = now or time.time()
        icao = str(icao or "").lower()
        if not re.fullmatch(r"[0-9a-f]{6}", icao):
            return {"aircraft": None, "route": None, "ok": True}
        cs = re.sub(r"[^A-Z0-9]", "", str(callsign or "").upper())[:8]
        with self.lock:
            a, r = self.ac.get(icao), self.rt.get(cs) if cs else None
        fresh = lambda e, ttl: e is not None and now - e[0] < (ttl if e[1] else MISS_TTL)
        need_a, need_r = not fresh(a, AC_TTL), bool(cs) and not fresh(r, RT_TTL)
        ok = True
        if need_a or need_r:
            try:
                st, raw = fetch(API % icao + ("?callsign=" + cs if cs else ""))
                body = json.loads(raw.decode("utf-8", "replace")) if raw else {}
                resp = body.get("response") if isinstance(body, dict) else None
                acd = resp.get("aircraft") if isinstance(resp, dict) else None
                frd = resp.get("flightroute") if isinstance(resp, dict) else None
                if st == 200 or st == 404:
                    a = (now, self._ac(acd)) if need_a else a
                    if cs and need_r:
                        r = (now, self._route(frd))
                    with self.lock:
                        if need_a:
                            self.ac[icao] = list(a)
                        if cs and need_r:
                            self.rt[cs] = list(r)
                        self.dirty = True
                        self._trim()
                else:
                    ok = False
            except Exception:
                ok = False
        self.save()
        return {"aircraft": a[1] if a else None, "route": r[1] if r else None, "ok": ok}

    @staticmethod
    def _ac(d):
        if not isinstance(d, dict):
            return None
        out = {k: d.get(k) for k in ("registration", "type", "icao_type", "manufacturer", "registered_owner", "registered_owner_country_name",
                                     "registered_owner_country_iso_name", "registered_owner_operator_flag_code")}
        for k in ("url_photo_thumbnail", "url_photo"):
            u = d.get(k)
            out[k] = u if isinstance(u, str) and u.startswith("https://") and len(u) < 400 else None
        return out

    @staticmethod
    def _route(d):
        if not isinstance(d, dict):
            return None
        al = d.get("airline") if isinstance(d.get("airline"), dict) else {}
        return {"callsign": d.get("callsign"), "airline": al.get("name"), "airline_country": al.get("country"),
                "origin": _airport(d.get("origin")), "midpoint": _airport(d.get("midpoint")), "destination": _airport(d.get("destination"))}

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
            data = json.dumps({"ac": self.ac, "rt": self.rt})
            self.dirty = False
        self.saved = now
        tmp = self.path + ".tmp"
        try:
            with open(tmp, "w") as f:
                f.write(data)
            os.replace(tmp, self.path)
        except OSError:
            pass
