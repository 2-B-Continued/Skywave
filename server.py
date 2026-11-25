#!/usr/bin/env python3
"""server.py - Skywave: the web server.

Serves the single-page interface, a small JSON API, and one WebSocket per browser tab that carries
live audio, spectrum frames and events. Everything uses the Python standard library.
"""
import base64
import collections
import hashlib
import hmac
import ipaddress
import gzip
import json
import airportmap as airportmap_mod
import airports as airports_mod
import planeinfo as planeinfo_mod
import mimetypes
import os
import platform
import queue
import re
import shlex
import shutil
import socket
import struct
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import art as art_mod
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import banks as banks_mod
import regions as regions_mod
import config as config_mod
import datalink
import mqtt as mqtt_mod
import rigctl as rigctl_mod
import engine as engine_mod
import geo
import audioq
import sources
import space as space_mod
import weather as weather_mod

VERSION = "1.0.0"
HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")
_STATIC_CACHE = {}                  # (path, etag, gzipped) -> bytes, so files are read and compressed once
PASS_LOCK = threading.Lock()        # one satellite pass search at a time
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("font/ttf", ".ttf")
mimetypes.add_type("application/manifest+json", ".webmanifest")

# commands a browser may send over the WebSocket (anything else is ignored)
WS_COMMANDS = {"tune", "center", "mode", "squelch", "aprs", "rec_audio", "seek", "scan", "job", "sweep", "doppler",
               "clear_aircraft", "reset_cover", "clear_aprs", "ping", "reset", "captions", "airwatch", "tap", "audio_claim",
               "morse", "dl_history", "sonde_forget", "gain_tune", "gain_down", "gain_forget", "lab_live", "chan_rec", "dtmf_clear"}


def apply_tz(tz):
    """Use the time zone chosen in setup for log lines, file names and timed recordings."""
    if tz:
        os.environ["TZ"] = tz
        try:
            time.tzset()
        except AttributeError:
            pass


def load_prefs(path):
    try:
        with open(path) as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def save_prefs(path, prefs):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(prefs, f)
    os.replace(tmp, path)


def available_languages(static_dir):
    d = os.path.join(static_dir, "lang")
    out = [{"code": "en", "name": "English"}]
    try:
        for n in sorted(os.listdir(d)):
            if n.endswith(".json"):
                with open(os.path.join(d, n), encoding="utf-8") as f:
                    meta = json.load(f).get("_meta", {})
                code = n[:-5]
                if code != "en" and re.fullmatch(r"[a-z]{2,3}(-[A-Za-z]{2,4})?", code):
                    out.append({"code": code, "name": str(meta.get("name", code))[:40]})
    except (OSError, ValueError):
        pass
    return out[:1] + sorted(out[1:], key=lambda l: l["name"].casefold())


class App:
    def __init__(self):
        self.cfg = config_mod.Config()
        banks_mod.set_region(self.cfg["region"], self.cfg.get("country"))
        self.banks = banks_mod.BankStore(self.cfg.path_for("banks.json"), self.cfg["region"], self.cfg.get("country"))
        apply_tz(self.cfg["tz"])
        self.prefs = load_prefs(self.cfg.path_for("ui.json"))
        art_mod.set_store(self.cfg.path_for("art"))
        global PLANEINFO
        self.airports = airports_mod.Airports(self.cfg.path_for("airports.json"), offline=bool(os.environ.get("NO_NET")))
        self.airportmaps = airportmap_mod.AirportMaps(self.cfg["data_dir"], offline=bool(os.environ.get("NO_NET")))
        PLANEINFO = planeinfo_mod.PlaneInfo(self.cfg.path_for("planeinfo.json"), self.airports, self.airportmaps)
        self.space = space_mod.Space(self.cfg)
        self.eng = engine_mod.Engine(self.cfg, self.banks, self.space)
        self.eng.log_hook = self.add_log
        self.weather = weather_mod.Decoder(self.cfg, self.eng.emit, self.space)
        self.eng.on_record_done = self._recording_done
        self.mqtt = mqtt_mod.Bridge(self.cfg)
        self.eng.dl_hook = self.mqtt.hook
        self.mqtt.start()
        self.log = collections.deque(maxlen=300)
        self.rig = rigctl_mod.Server(self.eng, self.cfg, lambda lvl, t: self.add_log(lvl, t))
        self.rig.apply()
        self.t0 = time.time()
        self.fav_path = self.cfg.path_for("favourites.json")
        self.pass_cache = {}
        self.add_log("info", "Skywave %s starting%s" % (VERSION, " (simulator mode)" if self.cfg["sim"] else ""))

    def _recording_done(self, path, meta):
        """A raw recording finished: weather satellite passes are turned into pictures automatically."""
        if self.cfg["auto_decode"] and meta.get("decode") == "lrpt" and self.weather.status()["available"]:
            try:
                self.weather.submit(os.path.basename(path))
                self.add_log("info", "Turning %s into weather pictures." % os.path.basename(path))
            except ValueError:
                pass

    def restore(self, blob):
        """Load a settings file made by "Download my settings". Returns what was restored."""
        done = []
        if not isinstance(blob, dict):
            raise ValueError("That is not a settings file.")
        if isinstance(blob.get("config"), dict):
            changed = self.cfg.update(blob["config"])
            if changed:
                self.eng.command({"cmd": "config", "changed": changed})
            done.append("settings")
        if isinstance(blob.get("favourites"), list):
            self.set_favourites(blob["favourites"])
            done.append("favourites")
        for b in blob.get("banks") or []:
            try:
                self.banks.put(b)
            except ValueError:
                pass
        if blob.get("banks"):
            done.append("scanner lists")
        for c in blob.get("custom_satellites") or []:
            try:
                self.space.add_custom(c["name"], c["norad"], c["freqs"][0]["f"], "raw" if c["freqs"][0].get("kind") == "digital" else c["freqs"][0].get("mode", "nfm"), c.get("note", ""))
            except (ValueError, KeyError, IndexError, TypeError):
                pass
        if blob.get("custom_satellites"):
            done.append("satellites")
        for sid, r in (blob.get("auto_record") or {}).items():
            try:
                self.space.set_auto(sid, r["min_el"])
            except (ValueError, KeyError, TypeError):
                pass
        return done

    def add_log(self, level, text):
        self.log.appendleft({"t": time.time(), "level": level, "text": text})

    # ---------------------------------------------------------------- favourites
    def favourites(self):
        try:
            with open(self.fav_path) as f:
                v = json.load(f)
            return v if isinstance(v, list) else []
        except (OSError, ValueError):
            return []

    def set_favourites(self, items):
        clean = []
        for it in items[:200]:
            try:
                clean.append({"f": int(float(it["f"])), "name": str(it.get("name", ""))[:40],
                              "mode": str(it.get("mode", "nfm"))[:6]})
            except (KeyError, TypeError, ValueError):
                continue
        with open(self.fav_path, "w") as f:
            json.dump(clean, f)
        return clean

    # ---------------------------------------------------------------- snapshot sent on connect
    def snapshot(self):
        e = self.eng
        aprs = []
        for p in list(e.aprs_log)[:60]:
            aprs.append({k: v for k, v in p.items() if isinstance(v, (str, int, float, bool))})
        return {"type": "hello", "version": VERSION, "config": self.cfg.public(), "state": e.state(),
                "banks": self.banks.banks, "favourites": self.favourites(),
                "catalog": self.space.catalog, "decoder": self.weather.status(),
                "space": {"available": self.space.available(), "tle_age_days": self.space.tle_age_days(),
                          "status": self.space.status, "schedule": self.space.schedule, "auto": self.space.auto,
                          "sync": self.space.sync_state},
                "bandplan": [{"a": a, "b": b, "name": n, "mode": m} for a, b, n, m in banks_mod.BAND_PLAN],
                "region": regions_mod.public(self.cfg["region"], self.cfg.get("country")), "langs": available_languages(STATIC),
                "prefs": self.prefs,
                "lab": self.eng.lab,
                "scan_log": list(e.scan_log)[:50], "aprs": aprs,
                "sensors": [{k: v for k, v in s.items() if isinstance(v, (str, int, float, bool))}
                            for s in e.sensors.values()],
                "peaks": e.sweep_result or [], "sim": bool(self.cfg["sim"]), "stream": bool(shutil.which("ffmpeg")),
                "tools": {"rtlamr": bool(shutil.which(shlex.split(os.environ.get("RTLAMR_BIN", "rtlamr"))[0])) and
                                    (bool(self.cfg["rtl_tcp"]) or bool(shutil.which(shlex.split(os.environ.get("RTL_TCP_BIN", "rtl_tcp"))[0])))},
                "samples": config_mod.SAMPLE_RATES, "timers": e.timers.public(), "captions_log": list(e.cap.log)[-40:],
                "captions": e.cap.status()}

    # ---------------------------------------------------------------- transcripts
    def transcripts(self):
        d = self.cfg.path_for("transcripts")
        out = []
        try:
            for n in os.listdir(d):
                p = os.path.join(d, n)
                if n.endswith(".txt") and os.path.isfile(p):
                    st = os.stat(p)
                    try:
                        with open(p, encoding="utf-8") as f:
                            lines = [x for x in f.read().splitlines() if x.startswith("[")]
                    except OSError:
                        lines = []
                    out.append({"name": n, "size": st.st_size, "t": st.st_mtime, "lines": len(lines),
                                "preview": " ".join(x[11:] for x in lines[:3])[:200]})
        except OSError:
            pass
        out.sort(key=lambda r: -r["t"])
        return out

    # ---------------------------------------------------------------- recordings
    def recordings(self):
        d = self.cfg.path_for("recordings")
        out = []
        try:
            for n in os.listdir(d):
                p = os.path.join(d, n)
                if os.path.isfile(p) and n.lower().endswith((".wav", ".mp3")):
                    st = os.stat(p)
                    row = {"name": n, "size": st.st_size, "t": st.st_mtime, "iq": n.endswith("_iq.wav")}
                    try:
                        with open(p + ".json") as f:
                            m = json.load(f)
                        row.update(sat=m.get("sat", ""), sat_name=m.get("sat_name", ""), decode=m.get("decode", ""), signal=m.get("signal"),
                                   freq=m.get("freq"), max_el=m.get("max_el"))
                    except (OSError, ValueError):
                        pass
                    out.append(row)
        except OSError:
            pass
        out.sort(key=lambda r: -r["t"])
        return out

    # ---------------------------------------------------------------- diagnostics
    def diag(self):
        e = self.eng
        src = e.src
        info = {"version": VERSION, "uptime_s": int(time.time() - self.t0), "python": platform.python_version(),
                "sim": bool(self.cfg["sim"]), "usb": sources.usb_dongles(),
                "kernel_driver": sources.kernel_driver_loaded(), "device": e.dev_info, "job": e.job,
                "error": e.error, "clients": len(e.clients), "sample_rate": e.fs,
                "rtl_tcp_output": list(getattr(src, "stderr", []))[-25:] if src else [],
                "pll_failures_seen": getattr(src, "pll_total_lines", 0) if src else 0,
                "orbit_data_age_days": self.space.tle_age_days(), "data_dir": self.cfg["data_dir"]}
        return info


APP = None


def json_default(o):
    try:
        return float(o)
    except Exception:
        return str(o)


# ======================================================================================= WebSocket
def ws_frame(op, payload):
    n = len(payload)
    h = bytes([0x80 | op])
    if n < 126:
        h += bytes([n])
    elif n < 65536:
        h += bytes([126]) + struct.pack(">H", n)
    else:
        h += bytes([127]) + struct.pack(">Q", n)
    return h + payload


def read_exact(f, n):
    buf = b""
    while len(buf) < n:
        d = f.read(n - len(buf))
        if not d:
            raise EOFError
        buf += d
    return buf


def ws_read(f, limit=1 << 20):
    """Read one complete (possibly fragmented) message. Returns (opcode, payload)."""
    msg, first_op = b"", None
    while True:
        b1, b2 = read_exact(f, 2)
        fin, op = b1 & 0x80, b1 & 0x0F
        n = b2 & 0x7F
        if n == 126:
            n = struct.unpack(">H", read_exact(f, 2))[0]
        elif n == 127:
            n = struct.unpack(">Q", read_exact(f, 8))[0]
        if n > limit:
            raise EOFError
        mask = read_exact(f, 4) if b2 & 0x80 else None
        data = read_exact(f, n) if n else b""
        if mask and data:
            x = int.from_bytes(data, "big") ^ int.from_bytes((mask * (n // 4 + 1))[:n], "big")
            data = x.to_bytes(n, "big")
        if op >= 8:                           # control frame
            return op, data
        if first_op is None:
            first_op = op
        msg += data
        if len(msg) > limit:                  # the limit covers the whole message, not just each piece of it
            raise EOFError
        if fin:
            return first_op, msg


# ======================================================================================= HTTP
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "Skywave/" + VERSION
    timeout = 30                                  # a connection that goes quiet is dropped (slow-client protection)

    def end_headers(self):
        # Safe defaults on every response: no content sniffing, no framing (clickjacking), no referrer leaks
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        # Scripts only from this server's own files: text from the air or from outside services that slipped into the
        # page unescaped still could not run (no inline scripts, no inline event handlers, no eval).
        self.send_header("Content-Security-Policy", "script-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; "
                                                    "frame-ancestors 'none'")
        super().end_headers()

    def _host_ok(self):
        """With sign-in off, answer only to names a home network uses. A web page elsewhere can point its own domain
        name at this machine (DNS rebinding); the browser then treats Skywave as part of that page and the Origin check
        alone cannot tell. With sign-in on the browser never sends the password to such a name, so no check is needed."""
        if APP.cfg["auth_user"]:
            return True
        return host_allowed(self.headers.get("Host", ""))

    def _same_origin(self):
        """Browsers send Origin on WebSockets and cross-site POSTs. If it names another site, refuse: otherwise any web
        page open in the same browser could control the radio."""
        o = self.headers.get("Origin")
        if not o or o == "null":
            return o is None
        hosts = {self.headers.get("Host", "").lower(), self.headers.get("X-Forwarded-Host", "").lower()} - {""}
        try:
            return urllib.parse.urlsplit(o).netloc.lower() in hosts
        except ValueError:
            return False

    def log_message(self, fmt, *args):
        pass

    # ---------------------------------------------------------------- helpers
    def _send(self, code, body=b"", ctype="application/json", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body, default=json_default, separators=(",", ":")).encode()
        elif isinstance(body, str):
            body = body.encode()
        extra = dict(extra or {})
        if ctype == "application/json" and len(body) > 4096 and "gzip" in (self.headers.get("Accept-Encoding") or ""):
            body = gzip.compress(body, 5)                 # big lists (plane history, passes) shrink about eightfold
            extra["Content-Encoding"] = "gzip"
            extra["Vary"] = "Accept-Encoding"
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.send_header("Cache-Control", "no-store")
        for k, v in extra.items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)
        self.close_connection = True

    def _json(self, obj, code=200):
        self._send(code, obj)

    def _err(self, code, msg):
        self._send(code, {"error": msg})

    def _body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            raise ValueError("bad request")
        if n < 0 or n > 2 << 20:
            raise ValueError("request too large")
        raw = self.rfile.read(n) if n else b""
        body = json.loads(raw.decode("utf-8")) if raw else {}
        if not isinstance(body, dict):
            raise ValueError("bad request")
        return body

    def _authorised(self):
        user, pw = APP.cfg["auth_user"], APP.cfg["auth_pass"]
        if not user:
            return True
        h = self.headers.get("Authorization", "")
        if h.startswith("Basic "):
            try:
                u, _, p = base64.b64decode(h[6:]).decode("utf-8").partition(":")
                ok_u = hmac.compare_digest(u.encode(), user.encode())
                ok_p = hmac.compare_digest(p.encode(), pw.encode())
                if ok_u and ok_p:
                    return True
            except Exception:
                pass
            time.sleep(0.6)                      # slows down password guessing
        return False

    def _challenge(self):
        self._send(401, b"Sign in to use Skywave.", "text/plain",
                   {"WWW-Authenticate": 'Basic realm="Skywave", charset="UTF-8"'})

    # ---------------------------------------------------------------- routing
    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        try:
            u = urllib.parse.urlsplit(self.path)
            path = urllib.parse.unquote(u.path)
            if path == "/healthz":
                return self._send(200, b"ok", "text/plain")
            if not self._authorised():
                return self._challenge()
            if not self._host_ok():
                return self._err(403, HOST_REFUSED)
            q = dict(urllib.parse.parse_qsl(u.query))
            if path in ("/ws", "/stream.mp3") and not self._same_origin():
                return self._err(403, "Cross-site requests are not allowed.")
            if path == "/ws":
                return self.websocket()
            if path.startswith("/api/"):
                return self.api("GET", path[5:], q, {})
            if path == "/stream.mp3":
                return self.serve_stream()
            if path.startswith("/rec/"):
                return self.serve_recording(path[5:])
            if path.startswith("/dec/"):
                return self.serve_decoded(path[5:])
            if path.startswith("/txt/"):
                return self.serve_transcript(path[5:])
            return self.static(path)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except Exception as e:
            try:
                APP.add_log("error", "%s %s failed: %s" % (self.command, self.path.split("?")[0][:80], e))
                self._err(500, "Something went wrong. 'Show technical details' in Settings has more.")
            except Exception:
                pass

    def do_POST(self):
        try:
            if not self._authorised():
                return self._challenge()
            if not self._host_ok() or not self._same_origin():
                return self._err(403, "Cross-site requests are not allowed.")
            u = urllib.parse.urlsplit(self.path)
            path = urllib.parse.unquote(u.path)
            if not path.startswith("/api/"):
                return self._err(404, "not found")
            return self.api("POST", path[5:], dict(urllib.parse.parse_qsl(u.query)), self._body())
        except (BrokenPipeError, ConnectionResetError):
            pass
        except ValueError as e:
            self._err(400, str(e))
        except Exception as e:
            try:
                APP.add_log("error", "%s %s failed: %s" % (self.command, self.path.split("?")[0][:80], e))
                self._err(500, "Something went wrong. 'Show technical details' in Settings has more.")
            except Exception:
                pass

    # ---------------------------------------------------------------- static files
    def static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        full = os.path.normpath(os.path.join(STATIC, path.lstrip("/")))
        if not full.startswith(STATIC + os.sep) or not os.path.isfile(full):
            return self._err(404, "not found")
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        st = os.stat(full)
        etag = '"%x-%x"' % (int(st.st_mtime), st.st_size)
        cache = "public, max-age=604800" if path.startswith(("/fonts/", "/vendor/")) else "no-cache"   # vendor: fixed library versions
        if self.headers.get("If-None-Match") == etag:           # the browser already has this exact file
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", cache)
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            return
        texty = ctype.startswith("text/") or ctype.endswith(("javascript", "json", "xml")) or ctype == "image/svg+xml"
        gz = texty and st.st_size > 1024 and "gzip" in self.headers.get("Accept-Encoding", "")
        key = (full, etag, gz)
        data = _STATIC_CACHE.get(key)
        if data is None:
            with open(full, "rb") as f:
                data = f.read()
            if gz:
                data = gzip.compress(data, 6)
            if len(_STATIC_CACHE) > 300:
                _STATIC_CACHE.clear()
            _STATIC_CACHE[key] = data
        self.send_response(200)
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith("text/") or ctype.endswith("javascript") else ""))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache)
        self.send_header("ETag", etag)
        if texty:
            self.send_header("Vary", "Accept-Encoding")
        if gz:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)
        self.close_connection = True

    def export(self, what, q):
        """Downloadable lists: aircraft (CSV or KML), scanner log, sensors, sweep peaks."""
        import csv
        import io
        a, now = APP, time.time()
        stamp = time.strftime("%Y%m%d-%H%M")
        if what in ("aircraft.csv", "aircraft.kml"):
            rows = [r for r in a.eng.table.snapshot(now)]
            if what.endswith("csv"):
                buf = io.StringIO()
                w = csv.writer(buf)
                w.writerow(["icao", "callsign", "latitude", "longitude", "altitude_ft", "speed_kt", "heading", "distance_km", "bearing"])
                for r in rows:
                    w.writerow([r["icao"], r["callsign"], r.get("lat"), r.get("lon"), r.get("alt"), r.get("speed"), r.get("heading"),
                                r.get("dist_km"), r.get("bearing")])
                return self._download(buf.getvalue().encode(), "text/csv", "aircraft-%s.csv" % stamp)
            pm = []
            for r in rows:
                if r.get("lat") is None:
                    continue
                trail = " ".join("%s,%s,%d" % (p[1], p[0], (r.get("alt") or 0) * 0.3048) for p in r.get("trail", []))
                name = (r["callsign"] or r["icao"]).replace("&", "&amp;").replace("<", "&lt;")
                pm.append("<Placemark><name>%s</name><description>%s ft, %s kt</description><Point><altitudeMode>absolute</altitudeMode>"
                          "<coordinates>%s,%s,%d</coordinates></Point></Placemark>" % (name, r.get("alt"), r.get("speed"), r["lon"], r["lat"], (r.get("alt") or 0) * 0.3048))
                if trail:
                    pm.append("<Placemark><name>%s track</name><LineString><altitudeMode>absolute</altitudeMode><coordinates>%s</coordinates></LineString></Placemark>" % (name, trail))
            kml = '<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Skywave aircraft</name>%s</Document></kml>' % "".join(pm)
            return self._download(kml.encode(), "application/vnd.google-earth.kml+xml", "aircraft-%s.kml" % stamp)
        if what == "scanlog.csv":
            buf = io.StringIO()
            w = csv.writer(buf)
            w.writerow(["time", "frequency_mhz", "label", "seconds"])
            for e in list(a.eng.scan_log):
                w.writerow([time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(e.get("t", now))), round(e.get("f", 0) / 1e6, 4), e.get("label", ""),
                            e.get("dur", "")])
            return self._download(buf.getvalue().encode(), "text/csv", "scanner-log-%s.csv" % stamp)
        if what == "sensors.csv":
            buf = io.StringIO()
            w = csv.writer(buf)
            rows = [{k: v for k, v in s.items() if isinstance(v, (str, int, float, bool))} for s in a.eng.sensors.values()]
            cols = sorted({k for r in rows for k in r})
            w.writerow(cols)
            for r in rows:
                w.writerow([r.get(c, "") for c in cols])
            return self._download(buf.getvalue().encode(), "text/csv", "sensors-%s.csv" % stamp)
        if what.startswith("balloon-") and what.endswith((".gpx", ".csv")):
            serial = what[8:-4]
            sd = a.eng.sondes.sondes.get(serial)
            if not sd:
                return self._err(404, "That balloon is not in the list any more.")
            safe = "".join(ch for ch in serial if ch.isalnum()) or "balloon"
            if what.endswith(".gpx"):
                return self._download(datalink.gpx(sd).encode(), "application/gpx+xml", "balloon-%s.gpx" % safe)
            buf = io.StringIO()
            w = csv.writer(buf)
            w.writerow(["time_utc", "latitude", "longitude", "altitude_m"])
            for p_ in sd["track"]:
                w.writerow([time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(p_[3])), p_[0], p_[1], p_[2]])
            return self._download(buf.getvalue().encode(), "text/csv", "balloon-%s.csv" % safe)
        if what == "aircraft-messages.csv":
            buf = io.StringIO()
            w = csv.writer(buf)
            w.writerow(["time", "frequency_mhz", "registration", "flight", "label", "meaning", "direction", "text"])
            for m in a.eng.dl_history():
                if m.get("kind") == "acars":
                    w.writerow([time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(m["t"])), round(m["freq"] / 1e6, 3), m["reg"], m["flight"],
                                m["label"], m["what"], m["dir"], m["text"]])
            return self._download(buf.getvalue().encode(), "text/csv", "aircraft-messages-%s.csv" % stamp)
        if what == "backup.json":
            blob = {"config": {k: v for k, v in a.cfg.public().items() if k in config_mod.EDITABLE}, "favourites": a.favourites(),
                    "banks": [b for b in a.banks.banks if not b.get("builtin")], "custom_satellites": a.space.custom, "auto_record": a.space.auto}
            return self._download(json.dumps(blob, indent=1).encode(), "application/json", "skywave-settings-%s.json" % stamp)
        return self._err(404, "unknown download")

    def _download(self, data, ctype, name):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Content-Disposition", 'attachment; filename="%s"' % name)
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)
        self.close_connection = True

    def serve_decoded(self, rest):
        did, _, name = rest.partition("/")
        full = APP.weather.file_path(did, name)
        if not full or not name.lower().endswith((".png", ".jpg", ".jpeg", ".pdf")):
            return self._err(404, "not found")
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        with open(full, "rb") as f:
            data = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        if "download" in self.path:
            nice = "%s.%s" % (did, name.rsplit(".", 1)[-1]) if name != "report.pdf" else "weather-pass-%s.pdf" % did[:15]
            self.send_header("Content-Disposition", 'attachment; filename="%s"' % nice)
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)
        self.close_connection = True

    def serve_transcript(self, name):
        d = APP.cfg.path_for("transcripts")
        full = os.path.normpath(os.path.join(d, os.path.basename(name)))
        if not full.startswith(os.path.normpath(d) + os.sep) or not os.path.isfile(full) or not full.endswith(".txt"):
            return self._err(404, "not found")
        with open(full, "rb") as f:
            data = f.read()
        hdr = {}
        if "download" in self.path:
            hdr["Content-Disposition"] = 'attachment; filename="%s"' % os.path.basename(full)
        return self._send(200, data, "text/plain; charset=utf-8", hdr)

    def serve_recording(self, name):
        d = APP.cfg.path_for("recordings")
        full = os.path.normpath(os.path.join(d, os.path.basename(name)))
        if not full.startswith(os.path.normpath(d) + os.sep) or not os.path.isfile(full):
            return self._err(404, "not found")
        size = os.path.getsize(full)
        start, end, code = 0, size - 1, 200
        rng = self.headers.get("Range", "")
        m = re.match(r"bytes=(\d*)-(\d*)$", rng)
        if m and (m.group(1) or m.group(2)):
            if m.group(1):
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else size - 1
            else:
                start = max(size - int(m.group(2)), 0)
            end = min(end, size - 1)
            if start > end:
                return self._send(416, b"", "text/plain", {"Content-Range": "bytes */%d" % size})
            code = 206
        self.send_response(code)
        self.send_header("Content-Type", "audio/mpeg" if full.lower().endswith(".mp3") else "audio/wav")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if code == 206:
            self.send_header("Content-Range", "bytes %d-%d/%d" % (start, end, size))
        if "download" in self.path:
            self.send_header("Content-Disposition", 'attachment; filename="%s"' % os.path.basename(full))
        self.send_header("Connection", "close")
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(full, "rb") as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = f.read(min(1 << 20, left))
                if not chunk:
                    break
                self.wfile.write(chunk)
                left -= len(chunk)
        self.close_connection = True

    # ---------------------------------------------------------------- JSON API
    def api(self, method, route, q, body):
        a = APP
        e = a.eng
        if method == "GET":
            if route == "hello":
                return self._json(a.snapshot())
            if route == "recordings":
                return self._json({"files": a.recordings(), "free_gb": _free_gb(a.cfg["data_dir"])})
            if route == "transcripts":
                return self._json({"files": a.transcripts()})
            if route == "sensor_history":
                return self._json({"key": q.get("key", ""), "hist": e.sstore.history(q.get("key", "")), "step": 300})
            if route == "art":
                # parse=1: only read the song out of the text, nothing is looked up (cover art turned off)
                res = None if q.get("parse") == "1" else art_mod.lookup(q.get("q", ""), country=_country(a.cfg, q.get("cc", "")))
                if res:
                    return self._json({"art": "/api/artimg/" + res["id"], "artist": res["artist"], "title": res["title"],
                                       "album": res["album"], "track": res.get("track")})
                # no cover found: the song as the station wrote it, so it still goes on the list of songs heard
                p = art_mod.parse(q.get("q", ""))
                artist, title = ((p[1], p[0]) if p[2] else (p[0], p[1])) if p else ("", "")
                return self._json({"art": None, "artist": artist, "title": title, "album": "", "track": None, "song": bool(p)})
            if route == "artlinks":
                cc = _country(a.cfg, q.get("cc", ""))
                L = art_mod.links(q.get("track", ""), cc, q.get("artist", ""), q.get("title", ""))
                return self._json({"links": L, "country": cc, "ok": bool(L)})
            if route.startswith("svcicon/"):
                im = art_mod.icon(route[8:])
                if not im:
                    return self._err(404, "no icon")
                return self._send(200, im[1], im[0], {"Cache-Control": "public, max-age=604800"})
            if route.startswith("artimg/"):
                im = art_mod.image(route[7:])
                if not im:
                    return self._err(404, "no such picture")
                return self._send(200, im[1], im[0], {"Cache-Control": "public, max-age=86400"})
            if route == "geocode":
                try:
                    return self._json({"results": geo.geocode(q.get("q", ""), q.get("region", ""), suggest=q.get("suggest") == "1")})
                except geo.Busy:
                    return self._json({"results": [], "error": "The place search services are busy right now. Try again in a "
                                       "minute, or enter your coordinates by hand below."})
                except Exception as ex:
                    return self._json({"results": [], "error": "Could not reach the place search: %s" % str(ex)[:80]})
            if route == "diag":
                return self._json(a.diag())
            if route == "log":
                return self._json({"lines": list(a.log)[:200]})
            if route == "space/passes":
                hours = min(max(float(q.get("hours", 24)), 1), 72)
                min_el = min(max(float(q.get("min_el", 10)), 0), 80)
                key = (round(a.cfg["lat"], 2), round(a.cfg["lon"], 2), hours, min_el, len(a.space.tles))
                with PASS_LOCK:                                # one search at a time; a second page asking waits for the first
                    hit = a.pass_cache.get(key)
                    if not hit or time.time() - hit[0] > 900:  # passes barely change: work them out every 15 minutes at most
                        hit = (time.time(), a.space.passes(hours + 0.25, min_el))
                        a.pass_cache = {key: hit}
                now = time.time()
                out = {"passes": [p for p in hit[1] if p["los"] > now and p["aos"] < now + hours * 3600],
                       "sky": a.space.sky(), "now": now, "available": a.space.available(),
                       "tle_age_days": a.space.tle_age_days(), "status": a.space.status, "schedule": a.space.schedule}
                return self._json(out)
            if route == "space/aim":
                return self._json({"sky": a.space.sky(), "now": time.time(), "lat": a.cfg["lat"], "lon": a.cfg["lon"]})
            if route == "space/track":
                return self._json({"track": a.space.track(q["sat"], float(q["t0"]), float(q["t1"]))})
            if route.startswith("export/"):
                return self.export(route[7:], q)
            if route == "decodes":
                return self._json({"items": a.weather.list(), "status": a.weather.status()})
            if route == "rigctl":
                return self._json(a.rig.public())
            if route == "perf":
                import resource
                ru = resource.getrusage(resource.RUSAGE_SELF)
                return self._json({"engine": e.perf, "cpu_s": round(ru.ru_utime + ru.ru_stime, 1), "rss_mb": round(ru.ru_maxrss / 1024, 1),
                                   "threads": threading.active_count(), "clients": len(e.clients), "uptime_s": round(time.time() - a.t0),
                                   "caught_up": getattr(e, "caught_up", 0), "sound_trims": sum(c.dropped for c in list(e.clients) if isinstance(c, engine_mod.AudioClient))})
            if route == "planes/info":                    # registration, model, operator, photo, route (adsbdb, adsb.lol)
                if os.environ.get("NO_NET"):
                    return self._json({"aircraft": None, "route": None, "ok": False})
                a.airports.ensure()                       # the airports list, downloaded the first time planes are looked up
                def coord(k):
                    try:
                        v = float(q.get(k, ""))
                        return v if -180 <= v <= 180 else None
                    except ValueError:
                        return None
                return self._json(PLANEINFO.get(q.get("icao", ""), q.get("callsign", ""), coord("lat"), coord("lon"),
                                                home=(a.cfg.get("lat"), a.cfg.get("lon")), chosen=q.get("chosen") == "1"))
            if route == "planes/trace":                   # the path flown so far, from the adsb.lol network
                if os.environ.get("NO_NET"):
                    return self._json({"points": [], "ok": False})
                return self._json(PLANEINFO.trace(q.get("icao", "")))
            if route == "planes/history":
                return self._json({"frames": list(e.adsb_hist), "home": [a.cfg["lat"], a.cfg["lon"]]})
            if route == "mqtt":
                return self._json({"status": a.mqtt.status, "sent": a.mqtt.sent})
            return self._err(404, "unknown request")
        # POST
        if route == "config":
            changed = a.cfg.update(body.get("changes") or {})
            if "region" in changed or "country" in changed:       # a country's own differences come with its location
                banks_mod.set_region(a.cfg["region"], a.cfg.get("country"))
                a.banks.set_region(a.cfg["region"], a.cfg.get("country"))
                e.emit("banks", banks=a.banks.banks)
                e.emit("region", region=regions_mod.public(a.cfg["region"], a.cfg.get("country")),
                       bandplan=[{"a": x, "b": y, "name": n, "mode": m} for x, y, n, m in banks_mod.BAND_PLAN])
            if "tz" in changed:
                apply_tz(a.cfg["tz"])
            if "mqtt" in changed:
                a.mqtt.reconfigure()
            if "rigctl" in changed:
                a.rig.apply()
            if changed:
                e.command({"cmd": "config", "changed": changed})
                a.pass_cache = {}
            pub = a.cfg.public()
            e.emit("config", config=pub)
            return self._json({"config": pub, "changed": sorted(changed)})
        if route == "mqtt/test":
            m = dict(a.cfg["mqtt"])
            saved = (str(m.get("host") or ""), str(m.get("port") or 1883))
            for k in ("host", "port", "user", "pass"):
                if body.get(k) not in (None, ""):
                    m[k] = body[k]
            # the saved password is only ever sent to the saved broker; testing another address needs its own password
            if (str(m.get("host") or ""), str(m.get("port") or 1883)) != saved and body.get("pass") in (None, ""):
                m["pass"] = ""
            if not m.get("host"):
                return self._json({"ok": False, "message": "Type the address of your MQTT broker first (often the Home Assistant computer)."})
            okc, msg = mqtt_mod.test_connection(m)
            return self._json({"ok": okc, "message": msg})
        if route == "lab":
            import lab as lab_mod
            clean, _ = lab_mod.validate(body.get("set") or {}, lab_mod.DEFAULTS if body.get("reset") else e.lab)
            e.command({"cmd": "lab", "set": body.get("set") or {}, "reset": bool(body.get("reset"))})
            return self._json({"ok": True, "lab": clean})
        if route == "prefs":
            p = body.get("prefs")
            if not isinstance(p, dict) or len(json.dumps(p)) > 60000:
                return self._json({"error": "bad preferences"}, 400)
            a.prefs = p
            save_prefs(a.cfg.path_for("ui.json"), p)
            e.emit("prefs", prefs=p)
            return self._json({"ok": True})
        if route == "banks":
            clean = a.banks.put(body)
            e.emit("banks", banks=a.banks.banks)
            return self._json({"bank": clean, "banks": a.banks.banks})      # the page updates from whichever arrives first
        if route == "sensors/set":                       # name a sensor, mark it yours, or hide it
            r = e.sstore.set(str(body.get("key", "")), name=body.get("name"), mine=body.get("mine"), hidden=body.get("hidden"))
            if not r:
                return self._err(404, "That sensor is not in the list any more.")
            e.sstore.save(force=True)
            e.emit("sensor", **{k: v for k, v in r.items() if isinstance(v, (str, int, float, bool))})
            return self._json({"sensor": r})
        if route == "sensors/forget":
            keys = body.get("keys") if isinstance(body.get("keys"), list) else [body.get("key")]
            gone = [k for k in keys[:600] if isinstance(k, str) and e.sstore.forget(k)]
            e.sstore.save(force=True)
            e.emit("sensors_forgot", keys=gone)
            return self._json({"forgot": gone})
        if route == "banks/delete":
            a.banks.delete(str(body.get("id", "")))
            e.emit("banks", banks=a.banks.banks)
            return self._json({"ok": True})
        if route == "favourites":
            favs = a.set_favourites(body.get("list") or [])
            e.emit("favourites", list=favs)
            return self._json({"list": favs})
        if route == "recordings/delete":
            name = os.path.basename(str(body.get("file", "")))
            p = os.path.join(a.cfg.path_for("recordings"), name)
            if name.lower().endswith((".wav", ".mp3")) and os.path.isfile(p):
                os.remove(p)
                if os.path.isfile(p + ".json"):
                    os.remove(p + ".json")
            return self._json({"files": a.recordings()})
        if route == "space/refresh":
            threading.Thread(target=_refresh_orbits, args=(True,), daemon=True).start()
            return self._json({"started": True})
        if route == "space/tle":
            n = a.space.add_tle_text(str(body.get("text", "")))
            a.pass_cache = {}
            if n and a.space.apply_auto():
                e.emit("schedule", schedule=a.space.schedule)
            e.emit("space_status", status="Added orbit data for %d satellite(s)." % n if n else "No usable orbit data found in that text.",
                   tle_age_days=a.space.tle_age_days())
            return self._json({"added": n})
        if route == "restore":
            n = a.restore(body)
            return self._json({"restored": n})
        if route == "decode":
            did = a.weather.submit(str(body.get("file", "")), force=bool(body.get("force")))
            return self._json({"id": did})
        if route == "decodes/delete":
            a.weather.delete(str(body.get("id", "")))
            return self._json({"ok": True})
        if route == "decodes/report":
            return self._json({"item": a.weather.rebuild_report(str(body.get("id", "")))})
        if route == "transcripts/delete":
            name = os.path.basename(str(body.get("file", "")))
            p = os.path.join(a.cfg.path_for("transcripts"), name)
            if name.endswith(".txt") and os.path.isfile(p):
                os.remove(p)
            return self._json({"files": a.transcripts()})
        if route == "timers/add":
            try:
                start = body.get("start")
                if body.get("start_in") is not None:                 # "start in N minutes" shortcut
                    start = time.time() + float(body["start_in"]) * 60
                item = e.timers.add(body.get("freq"), body.get("mode", "nfm"), start, body.get("duration"),
                                    body.get("label", ""), body.get("what", "sound"), body.get("repeat", "none"),
                                    body.get("bw"))
            except (ValueError, TypeError) as ex:
                return self._json({"error": str(ex)}, 400)
            e.emit("timers", list=e.timers.public())
            return self._json({"item": item, "list": e.timers.public()})
        if route == "timers/delete":
            tid = str(body.get("id", ""))
            sa = e.sched_audio
            if sa and sa.get("timer") == tid:
                e.command({"cmd": "rec_audio", "on": False})
            else:
                e.timers.delete(tid)
            e.emit("timers", list=e.timers.public())
            return self._json({"list": e.timers.public()})
        if route == "space/sync":
            threading.Thread(target=_sync_satellites, daemon=True).start()
            return self._json({"ok": True})
        if route == "space/auto":
            n = a.space.set_auto(str(body.get("sat", "")), float(body.get("min_el", 0)))
            a.pass_cache = {}
            e.emit("schedule", schedule=a.space.schedule)
            e.emit("space_auto", auto=a.space.auto)
            return self._json({"added": n, "auto": a.space.auto})
        if route == "space/custom":
            entry = a.space.add_custom(body.get("name", ""), body.get("norad"), body.get("freq"), body.get("mode", "nfm"),
                                       body.get("note", ""))
            a.pass_cache = {}
            threading.Thread(target=_refresh_orbits, args=(True,), daemon=True).start()
            e.emit("catalog", catalog=a.space.catalog)
            return self._json({"entry": entry})
        if route == "space/custom/delete":
            a.space.remove_custom(str(body.get("id", "")))
            a.pass_cache = {}
            e.emit("catalog", catalog=a.space.catalog)
            return self._json({"ok": True})
        if route == "space/schedule":
            kind = "audio" if body.get("kind") == "audio" else "iq"
            item = a.space.add_schedule(body["sat"], float(body["aos"]), float(body["los"]), float(body["freq"]),
                                        str(body.get("label", ""))[:40], kind, str(body.get("mode", "nfm"))[:6],
                                        float(body.get("bw", 16000)), body.get("max_el"))
            a.pass_cache = {}
            e.emit("schedule", schedule=a.space.schedule)
            return self._json({"item": item})
        if route == "space/unschedule":
            a.space.remove_schedule(str(body.get("id", "")))
            a.pass_cache = {}
            e.emit("schedule", schedule=a.space.schedule)
            return self._json({"ok": True})
        return self._err(404, "unknown request")

    # ---------------------------------------------------------------- WebSocket
    def serve_stream(self):
        """Live radio as an MP3 stream. An <audio> element plays this, which is what lets phones keep
        the sound going with the screen off or another app open (Web Audio is paused by the browser)."""
        if not shutil.which("ffmpeg"):
            return self._err(503, "Live streaming needs ffmpeg, which is not installed.")
        e = APP.eng
        kbps = audioq.MP3_KBPS[audioq.clamp_level(dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(self.path).query)).get("q", 3))]
        sink = e.add_sink()
        if sink is None:
            return self._err(429, "Too many listeners on the live stream.")
        proc = None
        try:
            proc = subprocess.Popen(
                ["ffmpeg", "-hide_banner", "-loglevel", "error", "-fflags", "nobuffer", "-flags", "low_delay", "-probesize", "32",
                 "-analyzeduration", "0", "-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "pipe:0",
                 "-codec:a", "libmp3lame", "-b:a", "%dk" % kbps] + (["-ar", "24000"] if kbps < 96 else []) + ["-write_xing", "0", "-flush_packets", "1", "-f", "mp3", "pipe:1"],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            tune_socket(self.connection)
            CH = 3840                                       # 20 ms of 48 kHz stereo 16-bit sound

            def feed():
                """Paces the sound into ffmpeg at exactly real time from a small buffer. The radio delivers audio in uneven
                bursts; sending those straight through (and padding gaps with silence) is what made phones stutter. A short
                buffer smooths the bursts out, and only a real shortage of sound becomes silence."""
                buf = bytearray()
                started = False
                t_start = time.monotonic()
                nxt = 0.0
                try:
                    while sink.alive and proc.poll() is None:
                        try:
                            while True:
                                b = sink.q.get_nowait()
                                if isinstance(b, bytes):
                                    buf += b
                        except queue.Empty:
                            pass
                        now = time.monotonic()
                        if not started:
                            if len(buf) >= 48000 * 4 * 0.35 or now - t_start > 1.2:
                                started, nxt = True, now
                            else:
                                time.sleep(0.01)
                                continue
                        if now < nxt:
                            time.sleep(min(0.005, nxt - now))
                            continue
                        if len(buf) > 48000 * 4 * 1.2:              # too far behind real time: drop the oldest so the delay stays short
                            del buf[:len(buf) - (48000 * 4 * 0.45 // 4) * 4]
                        if len(buf) >= CH:
                            chunk = bytes(buf[:CH])
                            del buf[:CH]
                        else:
                            chunk = bytes(CH)                       # a real shortage of sound: 20 ms of silence
                        proc.stdin.write(chunk)
                        proc.stdin.flush()
                        nxt += 0.02
                        if nxt < now - 0.25:
                            nxt = now
                except (OSError, ValueError):
                    pass
                sink.alive = False
                try:
                    proc.stdin.close()                          # lets ffmpeg finish, which ends the response below
                except Exception:
                    pass
            threading.Thread(target=feed, daemon=True).start()
            while sink.alive:
                chunk = proc.stdout.read1(4096) if hasattr(proc.stdout, "read1") else proc.stdout.read(4096)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except (OSError, ValueError):
            pass
        finally:
            e.remove_sink(sink)
            if proc is not None:
                try:
                    proc.kill()
                    proc.wait(timeout=3)
                except Exception:
                    pass

    def websocket(self):
        key = self.headers.get("Sec-WebSocket-Key")
        if not key or "websocket" not in self.headers.get("Upgrade", "").lower():
            return self._err(400, "WebSocket expected")
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        self.wfile.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                          "Sec-WebSocket-Accept: %s\r\n\r\n" % accept).encode())
        self.wfile.flush()
        self.close_connection = True
        sock = self.connection
        try:
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        except OSError:
            pass
        sock.settimeout(30)                                  # pages ping every 2-4 s; 30 s of silence means the device is gone
        tune_socket(sock)
        wlock = threading.Lock()
        e = APP.eng
        audio_only = "audio=1" in (urllib.parse.urlsplit(self.path).query or "")
        client = e.add_client(audio=audio_only)

        def send(op, payload):
            with wlock:
                sock.sendall(ws_frame(op, payload))

        shaper = audioq.Shaper(dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(self.path).query)).get("q", 5)) if audio_only else None
        if audio_only:
            def take(timeout):
                return shaper.frame(client.take(timeout=timeout))       # this listener's chosen quality
        else:
            def take(timeout):
                return client.q.get(timeout=timeout)

        def writer():
            while client.alive:
                try:
                    it = take(timeout=1.0)
                except Exception:
                    continue
                try:
                    if isinstance(it, str):
                        send(1, it.encode())
                    else:
                        send(2, it)
                except OSError:
                    break
            client.alive = False

        try:
            if audio_only:
                send(1, b'{"type":"hello_audio"}')
            else:
                send(1, json.dumps(APP.snapshot(), default=json_default, separators=(",", ":")).encode())
        except OSError:
            e.remove_client(client)
            return
        threading.Thread(target=writer, daemon=True).start()
        try:
            while client.alive:
                op, data = ws_read(self.rfile)
                if op == 8:
                    break
                if op == 9:
                    send(10, data)
                    continue
                if op in (1, 2):
                    try:
                        msg = json.loads(data.decode("utf-8"))
                    except ValueError:
                        continue
                    if isinstance(msg, dict) and msg.get("cmd") == "ping":
                        send(1, b'{"type":"pong"}')                    # answered here, at once: the page uses it to know the line is alive
                        continue
                    if audio_only:
                        if isinstance(msg, dict) and msg.get("cmd") == "quality":
                            shaper.set(msg.get("q"))
                        continue
                    if isinstance(msg, dict) and msg.get("cmd") in WS_COMMANDS:
                        if msg["cmd"] == "reset":
                            e.command({"cmd": "reset"})
                        elif msg["cmd"] == "audio_claim":
                            e.emit("audio_owner", id=str(msg.get("id", ""))[:40])      # tells every other page that this device now has the sound
                        else:
                            e.command(msg)
        except (EOFError, OSError, socket.timeout):
            pass
        finally:
            e.remove_client(client)
            try:
                send(8, b"")
            except Exception:
                pass


HOST_REFUSED = ("Skywave does not answer to this address. Open it by its IP address or local name, set ALLOWED_HOSTS to "
                "the names you use, or turn on sign-in (AUTH_USER and AUTH_PASS).")
LOCAL_SUFFIXES = (".local", ".lan", ".home", ".home.arpa", ".internal", ".localdomain")


def host_allowed(host):
    """Is this Host header a name a home network would use? IP addresses, localhost, single-word names, the usual local
    suffixes, this machine's own name and anything listed in ALLOWED_HOSTS ("*" allows every name)."""
    h = (host or "").strip().lower()
    if h.startswith("["):
        h = h[1:h.find("]")] if "]" in h else h[1:]
    elif h.count(":") == 1:
        h = h.split(":")[0]
    h = h.rstrip(".")
    extra = [x.strip().lower() for x in os.environ.get("ALLOWED_HOSTS", "").split(",") if x.strip()]
    if "*" in extra or h in extra:
        return True
    if not h:
        return False
    try:
        ipaddress.ip_address(h)
        return True
    except ValueError:
        pass
    me = socket.gethostname().lower()
    return h == "localhost" or "." not in h or h.endswith(LOCAL_SUFFIXES) or h in (me, me.split(".")[0])


def tune_socket(sock):
    """Notice a vanished device (phone asleep, wifi dropped, tab killed) within about 15 s instead of minutes, so it stops
    holding a listener slot and the radio's attention."""
    try:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        for name, val in (("TCP_KEEPIDLE", 10), ("TCP_KEEPINTVL", 5), ("TCP_KEEPCNT", 3), ("TCP_USER_TIMEOUT", 15000)):
            if hasattr(socket, name):
                sock.setsockopt(socket.IPPROTO_TCP, getattr(socket, name), val)
    except OSError:
        pass


PLANEINFO = None   # set at start-up (planeinfo.PlaneInfo)

def _country(cfg, hint=""):
    """The listener's country (two letters): from the saved location, else the region setting, else the browser's hint."""
    c = str(cfg.get("country") or "").upper() if hasattr(cfg, "get") else ""
    if len(c) == 2 and c.isalpha():
        return c
    c = art_mod.REGION_CC.get(cfg["region"], "")
    if c:
        return c
    h = str(hint or "").upper()
    return h if len(h) == 2 and h.isalpha() else ""

def _free_gb(path):
    try:
        st = os.statvfs(path)
        return round(st.f_bavail * st.f_frsize / 1e9, 1)
    except OSError:
        return None




def _refresh_orbits(force=False):
    try:
        st = APP.space.refresh(force)
    except Exception as e:
        st = "Could not download orbit data: %s" % e
    APP.pass_cache = {}
    try:
        if APP.space.apply_auto():
            APP.eng.emit("schedule", schedule=APP.space.schedule)
    except Exception:
        pass
    APP.add_log("info", st)
    APP.eng.emit("space_status", status=st, tle_age_days=APP.space.tle_age_days())


def _sync_satellites():
    """Ask the public satellite database (SatNOGS) which channels are really in use. Safe: see satsync.py."""
    try:
        APP.space.sync()
    except Exception as ex:
        APP.add_log("error", "Satellite database check failed: %s" % ex)
    st = APP.space.sync_state
    APP.add_log("info", st.get("msg") or "Satellite database check finished.")
    APP.pass_cache = {}
    APP.eng.emit("space_sync", sync=st, catalog=APP.space.catalog)


def _orbit_loop():
    time.sleep(6)
    while True:
        if APP.space.available() and not os.environ.get("NO_NET"):
            age = APP.space.tle_age_days()
            if age is None or age > 0.5:
                _refresh_orbits(False)
        if APP.cfg.get("daily_sync", True) and not os.environ.get("NO_NET"):
            hrs = APP.space.sync_age_hours()
            tried = APP.space.sync_state.get("tried") or 0
            if (hrs is None or hrs > 20) and time.time() - tried > 3 * 3600:     # at most every 3 h when it keeps failing
                _sync_satellites()
        try:
            if APP.space.apply_auto():
                APP.pass_cache = {}
                APP.eng.emit("schedule", schedule=APP.space.schedule)
        except Exception as ex:
            APP.add_log("error", "Auto-record planning failed: %s" % ex)
        time.sleep(3600)


def main():
    global APP
    # Python lets one thread run at a time. A thread busy with plain Python holds that lock for up to 5 ms at a stretch, and
    # the radio's thread gives it up on every numpy call, so it kept losing: switch more often so the radio gets back in.
    sys.setswitchinterval(0.001)
    APP = App()
    port = int(APP.cfg["port"])
    ThreadingHTTPServer.daemon_threads = True
    ThreadingHTTPServer.request_queue_size = 64
    ThreadingHTTPServer.allow_reuse_address = True

    class Srv(ThreadingHTTPServer):
        busy = threading.BoundedSemaphore(96)      # cap simultaneous connections so a flood cannot exhaust threads

        def process_request(self, request, client_address):
            if not self.busy.acquire(blocking=False):
                self.shutdown_request(request)
                return
            super().process_request(request, client_address)

        def process_request_thread(self, request, client_address):
            try:
                super().process_request_thread(request, client_address)
            finally:
                self.busy.release()
    srv = Srv(("0.0.0.0", port), Handler)
    APP.eng.start()
    threading.Thread(target=_orbit_loop, daemon=True).start()
    ip = "this-computer"
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
    except OSError:
        pass
    print("Skywave %s is running. Open  http://%s:%d  in a browser." % (VERSION, ip, port), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        APP.eng.stop()


if __name__ == "__main__":
    main()
