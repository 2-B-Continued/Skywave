"""space.py - satellite pass prediction and Doppler, from public orbital data (TLEs).

Uses the `sgp4` package for orbit propagation. Orbital data is downloaded from CelesTrak when
the app has internet, cached in /data/tle, and can also be pasted in by hand for offline use.
"""
import json
import math
import os
import threading
import time
import urllib.request

import satsync

try:
    from sgp4.api import Satrec
except Exception:                      # package missing: the Space tab explains this
    Satrec = None

C_KMS = 299792.458
A_WGS84, F_WGS84 = 6378.137, 1 / 298.257223563

# kind: "voice" = something you can listen to (FM/SSB); "packet" = data you can decode (APRS);
#       "digital" = needs a computer program to turn into something (weather pictures): record the raw radio data.
CATALOG = [
    {"id": "iss", "norad": 25544, "name": "International Space Station", "short": "ISS", "match": "ISS",
     "freqs": [{"label": "Voice and pictures (FM)", "f": 145800000, "mode": "nfm", "bw": 16000, "kind": "voice"},
               {"label": "Packet radio (APRS)", "f": 145825000, "mode": "nfm", "bw": 16000, "kind": "packet", "aprs": True}],
     "note": "Astronauts occasionally talk to schools and amateurs on 145.800 MHz. During special events it also sends slow-scan TV pictures there (record the audio and decode it with a free SSTV program). The packet radio beacon on 145.825 MHz is usually active."},
    {"id": "meteor-m2-3", "norad": 57166, "name": "Meteor-M2-3 (weather satellite)", "short": "Meteor-M2-3", "match": "METEOR",
     "decode": "lrpt", "mod": "oqpsk",
     "freqs": [{"label": "Weather images (digital), 137.900 MHz", "f": 137900000, "mode": "nfm", "bw": 150000, "kind": "digital", "fs": 288000},
               {"label": "Weather images (digital), 137.100 MHz", "f": 137100000, "mode": "nfm", "bw": 150000, "kind": "digital", "fs": 288000}],
     "note": "Sends digital weather pictures (LRPT) on 137.9 or 137.1 MHz, and the operators switch between them. The app checks a public community database every day and puts the channel reported as active first. If a pass records only noise, try the other one. Meteor-M2-3 is reported to have an antenna that did not fully deploy, so its signal is weak: prefer Meteor-M2-4 passes, and use a pass above 40 degrees."},
    {"id": "meteor-m2-4", "norad": 59051, "name": "Meteor-M2-4 (weather satellite)", "short": "Meteor-M2-4", "match": "METEOR",
     "decode": "lrpt", "mod": "oqpsk",
     "freqs": [{"label": "Weather images (digital), 137.900 MHz", "f": 137900000, "mode": "nfm", "bw": 150000, "kind": "digital", "fs": 288000},
               {"label": "Weather images (digital), 137.100 MHz", "f": 137100000, "mode": "nfm", "bw": 150000, "kind": "digital", "fs": 288000}],
     "note": "The best Meteor to try: its signal is reported to be much stronger than Meteor-M2-3. Usually on 137.9 MHz, sometimes 137.1. The old NOAA satellites (15, 18, 19) were switched off in 2025, so Meteor is the main source of weather pictures at 137 MHz. If a pass records only noise, try the other channel."},
    {"id": "so-50", "norad": 27607, "name": "SO-50 (amateur FM repeater)", "short": "SO-50", "match": "SAUDISAT",
     "freqs": [{"label": "Downlink (FM)", "f": 436795000, "mode": "nfm", "bw": 16000, "kind": "voice"}],
     "note": "An FM repeater in space for licensed amateurs. You can listen without a licence; it only transmits when someone keys it up, and needs a tone to switch on. May no longer be working."},
    {"id": "rs-44", "norad": 44909, "name": "RS-44 (amateur linear transponder)", "short": "RS-44", "match": "DOSAAF",
     "freqs": [{"label": "Transponder (SSB, upper sideband)", "f": 435640000, "mode": "usb", "bw": 2800, "kind": "voice"}],
     "note": "A satellite that relays many amateurs' voice and Morse conversations at once. Tune slowly across 435.610-435.640 MHz. Frequencies are from memory; confirm on amsat.org."},
    {"id": "funcube-1", "norad": 39444, "name": "FUNcube-1 (AO-73, education satellite)", "short": "FUNcube-1", "match": "FUNCUBE",
     "freqs": [{"label": "Beacon (telemetry)", "f": 145935000, "mode": "usb", "bw": 2800, "kind": "voice"}],
     "note": "Sends a steady data beacon, heard as a warbling tone; its transponder is switched on at times. Frequencies are from memory; confirm on amsat.org."},
]
# Plain-English "what is this?" text shown behind the ? button on each satellite card.
ABOUT = {
    "iss": "The International Space Station is a crewed laboratory orbiting about 400 km up, crossing the sky in around 6 to 10 minutes per pass. It carries an amateur radio station. You can sometimes hear astronauts chatting with schools, a repeating digital beacon, and, during special events, picture signals (SSTV) that Skywave can turn into images.",
    "meteor-m2-3": "A Russian weather satellite in a low orbit over the poles. It continuously broadcasts digital cloud pictures (called LRPT) that anyone can receive. Record a pass that climbs high in the sky and Skywave will build the pictures and a PDF report. You need a clear view of the sky and a flat V-shaped antenna.",
    "meteor-m2-4": "A second Russian weather satellite, a twin of Meteor-M2-3. It sends the same kind of digital cloud pictures. Having two of them means more chances each day to catch a picture. The broadcast frequency is sometimes changed by the operators, so try the other one if you only record noise.",
    "so-50": "SaudiSat-1C (SO-50) is a small amateur radio satellite that acts as an FM repeater: someone with a radio licence sends a signal up and it is rebroadcast to everyone below. You can listen without a licence, but it is often silent unless an operator switches it on, and it may no longer work.",
    "rs-44": "RS-44 is an amateur radio satellite carrying a linear transponder. It re-transmits a whole slice of the band at once, so you hear many licensed operators' voice and Morse conversations at once, each at a slightly different pitch. It is the busiest amateur satellite. Use the upper sideband setting and tune slowly.",
    "funcube-1": "FUNcube-1 (also called AO-73) is a small education satellite built by students and amateurs. It sends a steady data beacon that sounds like a warbling tone, and at times switches on a transponder that relays amateur voice. It is a good first target for checking your antenna works.",
}

BW_BY_MODE = {"nfm": 16000, "wfm": 150000, "am": 12000, "usb": 2800, "lsb": 2800, "cw": 500}


def _jd(t):
    jd = 2440587.5 + t / 86400.0
    w = math.floor(jd)
    return w, jd - w


def _gmst(jd_whole, jd_frac):
    d = (jd_whole - 2451545.0) + jd_frac
    t = d / 36525.0
    g = 280.46061837 + 360.98564736629 * d + 0.000387933 * t * t - t ** 3 / 38710000.0
    return math.radians(g % 360.0)


class Observer:
    def __init__(self, lat, lon, alt_m):
        self.lat, self.lon, self.alt = math.radians(lat), math.radians(lon), alt_m / 1000.0
        e2 = F_WGS84 * (2 - F_WGS84)
        n = A_WGS84 / math.sqrt(1 - e2 * math.sin(self.lat) ** 2)
        self.pos = ((n + self.alt) * math.cos(self.lat) * math.cos(self.lon),
                    (n + self.alt) * math.cos(self.lat) * math.sin(self.lon),
                    (n * (1 - e2) + self.alt) * math.sin(self.lat))

    def look(self, sat_ecef):
        dx, dy, dz = (sat_ecef[i] - self.pos[i] for i in range(3))
        sl, cl, sp, cp = math.sin(self.lon), math.cos(self.lon), math.sin(self.lat), math.cos(self.lat)
        e = -sl * dx + cl * dy
        n = -sp * cl * dx - sp * sl * dy + cp * dz
        u = cp * cl * dx + cp * sl * dy + sp * dz
        rng = math.sqrt(dx * dx + dy * dy + dz * dz)
        return math.degrees(math.asin(max(-1, min(1, u / rng)))), math.degrees(math.atan2(e, n)) % 360.0, rng


def compute_passes(tles, catalog, lat, lon, alt, hours, min_el, t0):
    """Find passes in [t0, t0 + hours] that rise above min_el. Pure function of its arguments so it can run in a helper process."""
    if Satrec is None:
        return []
    obs = Observer(lat, lon, alt)
    out = []
    for s in catalog:
        t = tles.get(s["id"])
        try:
            sat = Satrec.twoline2rv(t["l1"], t["l2"])
        except Exception:
            continue

        def el_at(tt):
            p = _ecef(sat, tt)
            return obs.look(p)[0] if p else -90.0

        def az_at(tt):
            p = _ecef(sat, tt)
            return obs.look(p)[1] if p else 0.0

        step = 20.0
        tt = t0
        prev = el_at(tt)
        in_pass = prev > 0
        aos = t0 if in_pass else None
        while tt < t0 + hours * 3600:
            t2 = tt + step
            cur = el_at(t2)
            if not in_pass and cur > 0:
                lo, hi = tt, t2
                for _ in range(12):
                    mid = (lo + hi) / 2
                    if el_at(mid) > 0:
                        hi = mid
                    else:
                        lo = mid
                aos, in_pass = hi, True
            elif in_pass and cur <= 0:
                lo, hi = tt, t2
                for _ in range(12):
                    mid = (lo + hi) / 2
                    if el_at(mid) > 0:
                        lo = mid
                    else:
                        hi = mid
                los = lo
                a, b = aos, los
                for _ in range(30):
                    m1, m2 = a + (b - a) / 3, b - (b - a) / 3
                    if el_at(m1) < el_at(m2):
                        a = m1
                    else:
                        b = m2
                tca = (a + b) / 2
                mx = el_at(tca)
                if mx >= min_el:
                    out.append({"sat": s["id"], "short": s["short"], "name": s["name"], "aos": aos, "los": los,
                                "tca": tca, "max_el": round(mx, 1), "az_aos": round(az_at(aos)),
                                "az_tca": round(az_at(tca)), "az_los": round(az_at(los)),
                                "duration": round(los - aos)})
                in_pass, aos = False, None
            tt = t2
    out.sort(key=lambda p: p["aos"])
    return out


def _ecef(sat, t):
    jw, jf = _jd(t)
    e, r, v = sat.sgp4(jw, jf)
    if e != 0:
        return None
    th = _gmst(jw, jf)
    c, s = math.cos(th), math.sin(th)
    return (r[0] * c + r[1] * s, -r[0] * s + r[1] * c, r[2])


def passes_in_helper(args, timeout=120):
    """Run compute_passes in a separate, lower-priority Python process (space_worker.py) and return its result.
    Returns None if the helper could not run, so the caller can fall back."""
    if os.environ.get("SPACE_INPROC"):
        return None
    import subprocess
    import sys
    here = os.path.dirname(os.path.abspath(__file__))
    try:
        r = subprocess.run([sys.executable, os.path.join(here, "space_worker.py")], input=json.dumps(args).encode(),
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, cwd=here)
        if r.returncode != 0:
            return None
        return json.loads(r.stdout.decode())
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


class Space:
    def __init__(self, cfg):
        self.cfg = cfg
        self.path = cfg.path_for("tle", "tles.json")
        self.sched_path = cfg.path_for("schedule.json")
        self.custom_path = cfg.path_for("custom_sats.json")
        self.auto_path = cfg.path_for("auto_record.json")
        self.info_path = cfg.path_for("sat_info.json")
        self.info = {}
        self.auto = {}
        self.custom = []
        self.tles = {}
        self.status = ""
        self.lock = threading.Lock()
        self.sats = {}
        self.schedule = []
        self._load()

    # ------------------------------------------------------------ orbital data
    def _load(self):
        try:
            with open(self.info_path) as f:
                self.info = json.load(f)
            if not isinstance(self.info, dict):
                self.info = {}
        except (OSError, ValueError):
            self.info = {}
        try:
            with open(self.path) as f:
                self.tles = json.load(f)
        except (OSError, ValueError):
            self.tles = {}
        try:
            with open(self.auto_path) as f:
                self.auto = {k: v for k, v in json.load(f).items() if isinstance(v, dict)}
        except (OSError, ValueError):
            self.auto = {}
        try:
            with open(self.custom_path) as f:
                self.custom = [c for c in json.load(f) if isinstance(c, dict) and c.get("id") and c.get("norad")]
        except (OSError, ValueError):
            self.custom = []
        try:
            with open(self.sched_path) as f:
                self.schedule = json.load(f)
        except (OSError, ValueError):
            self.schedule = []
        self._build()

    @property
    def catalog(self):
        out = []
        for c in [dict(c, about=ABOUT.get(c["id"], c.get("about", ""))) for c in CATALOG] + [dict(c) for c in self.custom]:
            info = self.info.get(str(c["norad"]))
            if info:
                freqs, extras = satsync.annotate(c["freqs"], info)
                # channels reported active go first, so scheduled recordings pick them
                freqs.sort(key=lambda f: 0 if f.get("check") == "active" else (2 if f.get("check") == "inactive" else 1))
                c["freqs"] = freqs + extras
                c["live"] = {"status": info.get("status", ""), "t": info.get("t")}
            out.append(c)
        return out

    @property
    def sync_state(self):
        return self.info.get("_sync", {})

    def sync_age_hours(self):
        t = self.sync_state.get("t")
        return None if not t else (time.time() - t) / 3600.0

    def sync(self, fetch=None):
        """Refresh transmitter facts from SatNOGS DB for every catalog satellite (blocking; call from a thread)."""
        ok, bad, notes = 0, 0, []
        for c in [dict(c) for c in CATALOG] + [dict(c) for c in self.custom]:
            try:
                self.info[str(c["norad"])] = satsync.sync_one(c["norad"], fetch)
                ok += 1
            except Exception as e:
                bad += 1
                notes.append("%s: %s" % (c.get("short", c["norad"]), str(e)[:50]))
            if not fetch:
                time.sleep(0.6)                     # be polite to a free community service
        msg = ("Checked %d satellite(s) against the public satellite database." % ok if ok else "") + \
              (" Problems: " + "; ".join(notes[:3]) if bad else "")
        self.info["_sync"] = {"t": time.time() if ok else self.sync_state.get("t"), "ok": bool(ok), "msg": msg.strip(),
                              "tried": time.time()}
        try:
            tmp = self.info_path + ".tmp"
            with open(tmp, "w") as f:
                json.dump(self.info, f)
            os.replace(tmp, self.info_path)
        except OSError:
            pass
        return self.info["_sync"]

    def item(self, sid):
        return next((s for s in self.catalog if s["id"] == sid), None)

    def add_custom(self, name, norad, freq, mode="nfm", note=""):
        """Any satellite you like: name, NORAD number, and the frequency it transmits on."""
        norad, freq = int(norad), float(freq)
        if not (1 <= norad <= 999999) or not (1e6 <= freq <= 1.8e9):
            raise ValueError("That NORAD number or frequency doesn't look right.")
        name = str(name).strip()[:40] or ("Satellite %d" % norad)
        mode = mode if mode in ("nfm", "wfm", "am", "usb", "lsb", "cw", "raw") else "nfm"
        built = next((c for c in CATALOG if c["norad"] == norad), None)
        if built:
            raise ValueError("%s is already in the list." % built["short"])
        sid = "c%d" % norad
        fr = {"label": "Downlink (%s)" % mode.upper() if mode != "raw" else "Raw radio data", "f": freq,
              "mode": "nfm" if mode == "raw" else mode, "bw": BW_BY_MODE.get(mode, 16000) if mode != "raw" else 150000,
              "kind": "digital" if mode == "raw" else "voice"}
        entry = {"id": sid, "norad": norad, "name": name, "short": name[:14], "match": name.upper(), "custom": True,
                 "freqs": [fr], "note": str(note)[:300] or "Added by you.",
                 "about": "A satellite you added yourself (NORAD number %d). Skywave tracks it and corrects the Doppler shift for you. %s" % (norad, str(note)[:300])}
        self.custom = [c for c in self.custom if c["id"] != sid] + [entry]
        self._save_custom()
        return entry

    def set_auto(self, sid, min_el):
        """Record every pass of a satellite that climbs above min_el degrees (0 = switch off)."""
        item = self.item(sid)
        if not item:
            raise ValueError("Unknown satellite.")
        min_el = float(min_el)
        if min_el <= 0:
            self.auto.pop(sid, None)
        else:
            self.auto[sid] = {"min_el": max(5.0, min(min_el, 85.0))}
        try:
            with open(self.auto_path, "w") as f:
                json.dump(self.auto, f)
        except OSError:
            pass
        return self.apply_auto()

    def apply_auto(self):
        """Add schedule entries for upcoming passes that match the auto-record rules. Returns how many were added."""
        if not self.auto or not self.sats:
            return 0
        lowest = min(r["min_el"] for r in self.auto.values())
        added = 0
        for p in self.passes(48, lowest):
            rule = self.auto.get(p["sat"])
            item = self.item(p["sat"])
            if not rule or not item or p["max_el"] < rule["min_el"] or p["aos"] < time.time():
                continue
            fr = item["freqs"]
            di = next((i for i, f in enumerate(fr) if f.get("kind") == "digital"), -1)
            vi = next((i for i, f in enumerate(fr) if f.get("kind") != "digital"), -1)
            fi, kind = (di, "iq") if di >= 0 else (vi, "audio")
            if fi < 0:
                continue
            start, end = p["aos"] - 20, p["los"] + 10
            sid = "%s-%d-%s" % (p["sat"], int(p["aos"]), kind)
            if any(s["id"] == sid for s in self.schedule):
                continue
            if any(s["start"] < end and start < s["end"] for s in self.schedule):
                continue                        # one dongle: keep whatever was scheduled first
            f = fr[fi]
            self.add_schedule(p["sat"], p["aos"], p["los"], f["f"], "%s %s (auto)" % (item["short"], time.strftime("%a %H:%M", time.localtime(p["aos"]))),
                              kind, f.get("mode", "nfm"), f.get("bw", 16000), p["max_el"])
            added += 1
        return added

    def remove_custom(self, sid):
        self.custom = [c for c in self.custom if c["id"] != sid]
        self.tles.pop(sid, None)
        self._save_custom()
        self._save()
        self._build()

    def _save_custom(self):
        try:
            with open(self.custom_path, "w") as f:
                json.dump(self.custom, f)
        except OSError:
            pass

    def _build(self):
        self.sats = {}
        if Satrec is None:
            return
        for sid, t in self.tles.items():
            try:
                self.sats[sid] = Satrec.twoline2rv(t["l1"], t["l2"])
            except Exception:
                pass

    def available(self):
        return Satrec is not None

    def tle_age_days(self):
        if not self.tles:
            return None
        return (time.time() - min(t.get("fetched", 0) for t in self.tles.values())) / 86400.0

    def refresh(self, force=False):
        """Download orbital data for the catalog satellites (blocking; call from a thread)."""
        got, errs = 0, []
        for s in self.catalog:
            old = self.tles.get(s["id"])
            if old and not force and time.time() - old.get("fetched", 0) < 12 * 3600:
                continue
            url = "https://celestrak.org/NORAD/elements/gp.php?CATNR=%d&FORMAT=tle" % s["norad"]
            try:
                req = urllib.request.Request(url, headers={"User-Agent": "skywave/1.0"})
                with urllib.request.urlopen(req, timeout=15) as r:
                    txt = r.read().decode("ascii", "replace")
                ok = self.add_tle_text(txt, s["id"], save=False)
                got += 1 if ok else 0
                if not ok:
                    errs.append("unexpected reply for %s" % s["short"])
            except Exception as e:
                errs.append("%s: %s" % (s["short"], str(e)[:60]))
        self._save()
        self._build()
        self.status = ("Updated orbital data for %d satellite(s)." % got if got else "") + \
                      (" Problems: " + "; ".join(errs[:3]) if errs else "")
        if not got and not errs:
            self.status = "Orbital data is up to date."
        return self.status

    def add_tle_text(self, text, sid=None, save=True):
        """Accept pasted TLEs (2 or 3 line format, any number). Matches to catalog by NORAD id."""
        lines = [l.strip() for l in text.replace("\r", "").split("\n") if l.strip()]
        added = 0
        i = 0
        name = ""
        while i < len(lines):
            if lines[i].startswith("1 ") and i + 1 < len(lines) and lines[i + 1].startswith("2 "):
                l1, l2 = lines[i], lines[i + 1]
                try:
                    norad = int(l1[2:7])
                    Satrec.twoline2rv(l1, l2)
                except Exception:
                    i += 2
                    continue
                target = sid
                if target is None or int(next((s["norad"] for s in self.catalog if s["id"] == target), -1)) != norad:
                    target = next((s["id"] for s in self.catalog if s["norad"] == norad), None)
                if target:
                    self.tles[target] = {"name": name or target, "l1": l1, "l2": l2, "fetched": time.time()}
                    added += 1
                name = ""
                i += 2
            else:
                name = lines[i]
                i += 1
        if added and save:
            self._save()
            self._build()
        return added

    def _save(self):
        try:
            with open(self.path + ".tmp", "w") as f:
                json.dump(self.tles, f)
            os.replace(self.path + ".tmp", self.path)
        except OSError:
            pass

    # ------------------------------------------------------------ geometry
    def _ecef(self, sat, t):
        jw, jf = _jd(t)
        e, r, v = sat.sgp4(jw, jf)
        if e != 0:
            return None
        th = _gmst(jw, jf)
        c, s = math.cos(th), math.sin(th)
        return (r[0] * c + r[1] * s, -r[0] * s + r[1] * c, r[2])

    def look(self, sid, t=None, obs=None):
        """(elevation, azimuth, range km, range-rate km/s) of a satellite, or None."""
        sat = self.sats.get(sid)
        if not sat:
            return None
        t = t or time.time()
        obs = obs or Observer(self.cfg["lat"], self.cfg["lon"], self.cfg["alt"])
        p0, p1 = self._ecef(sat, t), self._ecef(sat, t + 1.0)
        if not p0 or not p1:
            return None
        el, az, rng = obs.look(p0)
        _, _, rng1 = obs.look(p1)
        return el, az, rng, rng1 - rng

    def heading(self, sid, t):
        """"north" or "south": which way the satellite is moving over the ground at time t (None if unknown)."""
        sat = self.sats.get(sid)
        if not sat:
            return None
        a, b = self._ecef(sat, t - 15), self._ecef(sat, t + 15)
        if not a or not b:
            return None
        return "north" if b[2] > a[2] else "south"

    def subpoint(self, sid, t):
        """(latitude, longitude) in degrees under the satellite at time t, or None."""
        sat = self.sats.get(sid)
        p = self._ecef(sat, t) if sat else None
        if not p:
            return None
        r = math.sqrt(p[0] ** 2 + p[1] ** 2 + p[2] ** 2)
        return math.degrees(math.asin(p[2] / r)), math.degrees(math.atan2(p[1], p[0]))

    def doppler_hz(self, sid, f0, t=None):
        lk = self.look(sid, t)
        return None if lk is None else -f0 * lk[3] / C_KMS

    def sky(self):
        """Current position of every satellite we have data for."""
        obs = Observer(self.cfg["lat"], self.cfg["lon"], self.cfg["alt"])
        out = []
        for s in self.catalog:
            lk = self.look(s["id"], obs=obs)
            if lk:
                out.append({"id": s["id"], "short": s["short"], "el": round(lk[0], 1), "az": round(lk[1], 1),
                            "range_km": round(lk[2]), "up": lk[0] > 0})
        return out

    def passes(self, hours=24, min_el=10.0, start=None):
        """Upcoming passes over the station. The search is thousands of orbit steps of plain Python, so it runs in a
        separate low-priority helper process: done here, it would hold Python's lock and starve the radio's thread
        (measured: one busy thread cut the radio to 3% of real time). Falls back to running here if that cannot start."""
        cat = [{"id": c["id"], "short": c["short"], "name": c["name"]} for c in self.catalog if c["id"] in self.tles]
        tles = {c["id"]: {"l1": self.tles[c["id"]]["l1"], "l2": self.tles[c["id"]]["l2"]} for c in cat}
        args = (tles, cat, float(self.cfg["lat"]), float(self.cfg["lon"]), float(self.cfg["alt"]), float(hours), float(min_el),
                float(start or time.time()))
        if not cat or Satrec is None:
            return []
        out = passes_in_helper(list(args))
        return out if out is not None else compute_passes(*args)

    def track(self, sid, t0, t1, n=60):
        """Sky path (az, el) of a pass, for drawing."""
        obs = Observer(self.cfg["lat"], self.cfg["lon"], self.cfg["alt"])
        sat = self.sats.get(sid)
        if not sat:
            return []
        pts = []
        for i in range(n + 1):
            t = t0 + (t1 - t0) * i / n
            p = self._ecef(sat, t)
            if p:
                el, az, _ = obs.look(p)
                pts.append((round(az, 1), round(el, 1)))
        return pts

    # ------------------------------------------------------------ recording schedule
    def add_schedule(self, sid, aos, los, freq, label, kind="iq", mode="nfm", bw=16000, max_el=None):
        """kind "iq" = raw radio recording (weather pictures, anything); "audio" = Doppler-corrected sound recording."""
        item = {"id": "%s-%d-%s" % (sid, int(aos), kind), "sat": sid, "start": aos - 20, "end": los + 10,
                "freq": freq, "label": label, "kind": "audio" if kind == "audio" else "iq", "mode": mode,
                "bw": bw, "aos": aos, "los": los, "max_el": max_el}
        self.schedule = [s for s in self.schedule if s["id"] != item["id"] and s["end"] > time.time()] + [item]
        self._save_sched()
        return item

    def remove_schedule(self, item_id):
        self.schedule = [s for s in self.schedule if s["id"] != item_id]
        self._save_sched()

    def due(self, now=None):
        now = now or time.time()
        for s in self.schedule:
            if s["start"] <= now < s["end"]:
                return s
        return None

    def _save_sched(self):
        try:
            with open(self.sched_path, "w") as f:
                json.dump(self.schedule, f)
        except OSError:
            pass
