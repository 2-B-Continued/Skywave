"""weather.py - turns a recorded weather-satellite pass into pictures and a PDF report.

The heavy lifting is done by two small open-source programs (installed in the Docker image):
  meteor_demod   radio recording  ->  soft symbols      (github.com/dbdexter-dev/meteor_demod)
  meteor_decode  soft symbols     ->  picture channels  (github.com/dbdexter-dev/meteor_decode)
This module runs them, tidies the pictures (contrast, rotate so north is up) and writes a PDF.

Only Meteor-M LRPT (137 MHz) is handled. The old NOAA APT satellites were switched off in 2025.
"""
import importlib.util
import json
import os
import queue
import re
import shutil
import subprocess
import threading
import time

import sys

try:
    from PIL import Image, ImageOps
except Exception:                                  # Pillow missing: the Library explains this
    Image = None

try:
    import sstv_pd
except Exception:
    sstv_pd = None

DEMOD = os.environ.get("METEOR_DEMOD_BIN", "meteor_demod")
DECODE = os.environ.get("METEOR_DECODE_BIN", "meteor_decode")

# Meteor-M MSU-MR imager channels, by APID (approximate wavelengths, from the published instrument description)
CHANNELS = {
    64: ("Channel 1", "Visible light (0.5-0.7 microns)", "Daytime clouds, land and sea. Black at night."),
    65: ("Channel 2", "Near-infrared (0.7-1.1 microns)", "Daytime clouds, with land and water contrasting strongly. Black at night."),
    66: ("Channel 3", "Short-wave infrared (1.6-1.8 microns)", "Separates ice and snow from cloud in daylight."),
    67: ("Channel 4", "Mid infrared (3.5-4.1 microns)", "Fog, low cloud and fires; works day and night."),
    68: ("Channel 5", "Thermal infrared (10.5-11.5 microns)", "Temperature of clouds and surface, day and night. Cold high cloud looks bright."),
    69: ("Channel 6", "Thermal infrared (11.5-12.5 microns)", "Similar to channel 5; used with it to judge cloud type."),
}

# (modulation, symbol rate, extra demodulator flags, extra decoder flags, plain-English label). The first one tried comes from the satellite.
# "-d" widens how far the carrier may be off-frequency: the default is only +-3.5 kHz, which Doppler shift (+-3 kHz) plus an
# uncalibrated dongle can exceed, and then the demodulator never locks at all.
WIDE = ["-d", "12000"]
ATTEMPTS = [
    ("oqpsk", 72000, [], [], "OQPSK 72k"),
    ("oqpsk", 72000, WIDE, [], "OQPSK 72k, wide carrier search"),
    ("qpsk", 72000, [], [], "QPSK 72k"),
    ("qpsk", 72000, WIDE, [], "QPSK 72k, wide carrier search"),
    ("qpsk", 80000, [], ["-i"], "QPSK 80k interleaved"),
    ("oqpsk", 80000, [], ["-i"], "OQPSK 80k interleaved"),
]


def available():
    return bool(shutil.which(DEMOD) and shutil.which(DECODE))


def _pct(text):
    m = re.findall(r"(\d{1,3}(?:\.\d+)?)\s*%", text)
    try:
        return float(m[-1]) if m else None
    except ValueError:
        return None


def _run(cmd, on_progress, timeout, cancel, full=None):
    """Run a program, passing percent-complete to on_progress. Returns (exit code, last text)."""
    p = subprocess.Popen(["nice", "-n", "10"] + cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    tail = b""
    t0 = time.time()
    try:
        while True:
            chunk = p.stdout.read1(4096) if hasattr(p.stdout, "read1") else p.stdout.read(4096)
            if not chunk:
                break
            tail = (tail + chunk)[-1500:]
            if full is not None and sum(map(len, full)) < 400000:
                full.append(chunk.decode("utf-8", "replace"))
            v = _pct(tail.decode("utf-8", "replace"))
            if v is not None:
                on_progress(min(v, 100.0))
            if cancel.is_set() or time.time() - t0 > timeout:
                p.kill()
                break
    finally:
        try:
            p.wait(timeout=10)
        except Exception:
            p.kill()
    return p.returncode, tail.decode("utf-8", "replace")


class Decoder:
    def __init__(self, cfg, emit, space=None):
        self.cfg = cfg
        self.emit = emit
        self.space = space
        self.root = cfg.path_for("decoded")
        os.makedirs(self.root, exist_ok=True)
        self.q = queue.Queue()
        self.jobs = {}                 # id -> live status for jobs not yet finished
        self.lock = threading.Lock()
        self.cancel = threading.Event()
        threading.Thread(target=self._worker, daemon=True).start()

    # ------------------------------------------------------------------ public
    def status(self):
        return {"available": available() and Image is not None, "sstv": sstv_pd is not None and Image is not None,
                "missing": ([] if shutil.which(DEMOD) else ["meteor_demod"]) +
                           ([] if shutil.which(DECODE) else ["meteor_decode"]) + ([] if Image else ["Pillow"])}

    def submit(self, rec_name, force=False):
        rec_name = os.path.basename(rec_name)
        path = self.cfg.path_for("recordings", rec_name)
        if not os.path.isfile(path) or not rec_name.lower().endswith(".wav"):
            raise ValueError("That recording could not be found.")
        did = rec_name[:-4]
        with self.lock:
            if did in self.jobs:
                return did
            self.jobs[did] = {"id": did, "state": "queued", "text": "Waiting for its turn...", "pct": 0, "rec": rec_name}
        self.q.put((did, path, force))
        self._announce(did)
        return did

    def list(self):
        out = []
        try:
            names = os.listdir(self.root)
        except OSError:
            names = []
        with self.lock:
            live = dict(self.jobs)
        for n in names:
            if n in live:
                continue
            try:
                with open(os.path.join(self.root, n, "result.json")) as f:
                    out.append(json.load(f))
            except (OSError, ValueError):
                pass
        out.extend(live.values())
        out.sort(key=lambda r: -(r.get("t0") or r.get("created") or 0))
        return out

    def _dir(self, did):
        """The folder of one decode. An id is a single plain name: never empty, never "." or "..", which would
        otherwise point at the decoded folder itself or the whole data folder above it."""
        did = str(did or "")
        d = os.path.join(self.root, did)
        root = os.path.realpath(self.root)
        if (did in ("", ".", "..") or os.path.basename(did) != did or "\\" in did or "\x00" in did
                or os.path.dirname(os.path.realpath(d)) != root):
            raise ValueError("No such decode.")
        return d

    def delete(self, did):
        d = self._dir(did)
        did = os.path.basename(d)
        with self.lock:
            if did in self.jobs:
                raise ValueError("That one is still being worked on.")
        shutil.rmtree(d, ignore_errors=True)

    def file_path(self, did, name):
        try:
            p = os.path.join(self._dir(did), os.path.basename(name))
        except ValueError:
            return None
        return p if os.path.isfile(p) else None

    def rebuild_report(self, did):
        d = self._dir(did)
        with open(os.path.join(d, "result.json")) as f:
            res = json.load(f)
        res["report"] = self._make_sstv_pdf(d, res) if res.get("kind") == "sstv" else self._make_pdf(d, res)
        self._save(d, res)
        return res

    # ------------------------------------------------------------------ internals
    def _announce(self, did):
        with self.lock:
            j = dict(self.jobs.get(did, {}))
        if j:
            self.emit("decode_progress", **{k: v for k, v in j.items() if isinstance(v, (str, int, float, bool))})

    def _set(self, did, **kw):
        with self.lock:
            if did in self.jobs:
                self.jobs[did].update(kw)
        self._announce(did)

    def _worker(self):
        while True:
            did, path, force = self.q.get()
            try:
                res = self._process(did, path, force)
            except Exception as e:                      # never let one bad file stop the queue
                res = {"id": did, "ok": False, "error": "Something went wrong while decoding: %s" % e,
                       "rec": os.path.basename(path), "created": time.time(), "images": []}
                try:
                    self._save(os.path.join(self.root, did), res)
                except OSError:
                    pass
            with self.lock:
                self.jobs.pop(did, None)
            self.emit("decode_done", id=did, ok=bool(res.get("ok")), error=res.get("error", ""))

    def _save(self, d, res):
        os.makedirs(d, exist_ok=True)
        tmp = os.path.join(d, "result.json.tmp")
        with open(tmp, "w") as f:
            json.dump(res, f)
        os.replace(tmp, os.path.join(d, "result.json"))

    def _meta(self, path):
        try:
            with open(path + ".json") as f:
                m = json.load(f)
        except (OSError, ValueError):
            m = {}
        name = os.path.basename(path)
        mm = re.match(r"(\d{8})-(\d{6})_([\d.]+)MHz_(.*)_iq\.wav$", name)
        if mm:
            try:
                m.setdefault("t0", time.mktime(time.strptime(mm.group(1) + mm.group(2), "%Y%m%d%H%M%S")))
            except ValueError:
                pass
            m.setdefault("freq", float(mm.group(3)) * 1e6)
            m.setdefault("label", mm.group(4))
        m.setdefault("fs", 1024000)
        return m

    @staticmethod
    def _why_not(sig, diag):
        """A plain-English reason that says which step failed, so the fix is the right one."""
        lvl = (sig or {}).get("level")
        locked = [x for x in diag if (x.get("locked_pct") or 0) >= 5]
        if lvl == "none":
            return ("The satellite's signal could not be detected in this recording, so there was nothing to turn into a picture. "
                    "The moving dot on the Space page is calculated from orbit data, so it does not prove the satellite was heard. "
                    "Put the antenna outdoors or at a window with a clear view of the sky, vertical and fully extended, "
                    "and try a pass above 40 degrees. If your antenna is fine, try the other 137 MHz channel.")
        if not locked:
            return ("A little energy was seen on the satellite's frequency, but the demodulator could not lock onto it, so the signal is too weak "
                    "or too noisy. A picture needs about 5 dB or more above the noise. Try a higher pass, a better antenna position, "
                    "or a different tuner gain (Space page, 'Tuner gain for satellite recordings'). A band-pass filter for 137 MHz "
                    "helps a lot where FM broadcast stations are strong.")
        return ("The demodulator locked onto a signal but no picture frames could be rebuilt. The signal was probably too weak or broke up "
                "during the pass. Try a higher pass, and check the satellite was sending pictures on this channel (try the other 137 MHz channel).")

    def _process(self, did, path, force):
        if not path.endswith("_iq.wav"):
            return self._process_sstv(did, path)
        meta = self._meta(path)
        d = os.path.join(self.root, did)
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d)
        if not available() or Image is None:
            raise RuntimeError("The picture decoder isn't installed in this container. Rebuild the project from the latest files.")
        sat = self.space.item(meta.get("sat", "")) if (self.space and meta.get("sat")) else None
        if not force and not (meta.get("decode") == "lrpt" or (sat and sat.get("decode") == "lrpt")):
            if not (130e6 <= float(meta.get("freq", 0)) <= 140e6):
                raise RuntimeError("Only Meteor weather satellite recordings (around 137 MHz) can be turned into pictures.")
        mod_hint = meta.get("mod") or (sat or {}).get("mod") or "oqpsk"
        order = sorted(ATTEMPTS, key=lambda a: 0 if (a[0] == mod_hint and a[1] == 72000 and not a[2]) else 1)
        sigrep = meta.get("signal") or {}
        if sigrep.get("level") == "none" and not force:           # nothing was heard: do not spend minutes decoding noise
            order = order[:2]
        size = os.path.getsize(path)
        secs = max(1, (size - 44) / (meta["fs"] * 2.0))
        sym = os.path.join(d, "symbols.s")
        best = None
        notes = []
        diag = []
        for n, (mod, rate, dflags, xflags, label) in enumerate(order):
            base = 100.0 * n / len(order)
            span = 100.0 / len(order)
            self._set(did, state="working", text="Cleaning up the radio signal (method %d of %d: %s)..." % (n + 1, len(order), label), pct=base)
            dout = []
            code, out = _run([DEMOD, "-B", "-R", "100"] + dflags + ["-m", mod, "-r", str(rate), "-o", sym, path],
                             lambda v: self._set(did, pct=base + span * 0.4 * v / 100.0), 600 + 6 * secs, self.cancel, dout)
            full = "".join(dout)
            locks = re.findall(r"Carrier:\s*([+-]?\d+(?:\.\d+)?) Hz.*?Locked: (Yes|No)", full)
            lock_pct = round(100.0 * sum(1 for _, l in locks if l == "Yes") / len(locks)) if locks else None
            car = [float(c) for c, l in locks if l == "Yes"]
            rec = {"label": label, "locked_pct": lock_pct, "carrier_hz": round(sum(car) / len(car)) if car else None}
            diag.append(rec)
            if not os.path.isfile(sym) or os.path.getsize(sym) < 200000:
                notes.append("%s: no usable signal" % label)
                continue
            if lock_pct is not None and lock_pct < 5:
                notes.append("%s: the demodulator never locked onto a carrier" % label)
                continue
            self._set(did, text="Rebuilding the picture (method %d of %d: %s)..." % (n + 1, len(order), label), pct=base + span * 0.4)
            outdir = os.path.join(d, "raw")
            shutil.rmtree(outdir, ignore_errors=True)
            os.makedirs(outdir)
            xout = []
            code, out = _run([DECODE, "-B", "-s", "-t"] + xflags + ["-o", os.path.join(outdir, "pass.png"), sym],
                             lambda v: self._set(did, pct=base + span * (0.4 + 0.6 * v / 100.0)), 300 + 3 * secs, self.cancel, xout)
            pics = self._collect(outdir)
            rs = re.findall(r"rs\(sum\):\s*(-?\d+)", out)
            mp = re.search(r"MPDUs received:\s*(\d+)", "".join(xout))
            rec["mpdus"] = int(mp.group(1)) if mp else None
            if pics:
                best = {"label": label, "mod": mod, "rate": rate, "pics": pics, "rs": int(rs[-1]) if rs else None,
                        "outdir": outdir}
                break
            notes.append("%s: locked, but no picture frames could be rebuilt" % label)
        try:
            os.remove(sym)
        except OSError:
            pass
        res = {"id": did, "rec": os.path.basename(path), "created": time.time(), "t0": meta.get("t0"), "t1": meta.get("t1"),
               "freq": meta.get("freq"), "sat": meta.get("sat", ""), "sat_name": meta.get("sat_name") or (sat or {}).get("name", ""),
               "norad": meta.get("norad"), "max_el": meta.get("max_el"), "lat": meta.get("lat"), "lon": meta.get("lon"),
               "seconds": round(secs), "attempts": notes, "diag": diag, "signal": sigrep or None, "images": []}
        if not best:
            res.update(ok=False, error=self._why_not(sigrep, diag))
            self._save(d, res)
            return res
        self._set(did, text="Tidying the pictures and making the PDF...", pct=95)
        flip = False
        if meta.get("sat") and self.space and meta.get("t0"):
            mid = (meta["t0"] + (meta.get("t1") or meta["t0"] + secs)) / 2
            flip = self.space.heading(meta["sat"], mid) == "north"
        res["rotated"] = flip
        res["method"] = best["label"]
        res["rs_errors"] = best["rs"]
        for path_png, w, h in best["pics"]:
            name = os.path.basename(path_png)
            m = re.search(r"_(\d{2})\.png$", name)
            apid = int(m.group(1)) if m else None
            comp = apid is None
            im = Image.open(path_png).convert("RGB")
            if flip:
                im = im.rotate(180)
            if not comp:
                g = ImageOps.autocontrast(im.convert("L"), cutoff=1)
                im = g.convert("RGB")
            else:
                im = ImageOps.autocontrast(im, cutoff=1)
            fn = ("composite" if comp else "ch%d" % apid) + ".jpg"
            im.save(os.path.join(d, fn), quality=90)
            th = im.copy()
            th.thumbnail((360, 360))
            th.save(os.path.join(d, fn.replace(".jpg", "_t.jpg")), quality=80)
            info = CHANNELS.get(apid, ("Colour picture" if comp else "APID %s" % apid, "", ""))
            res["images"].append({"file": fn, "thumb": fn.replace(".jpg", "_t.jpg"), "apid": apid, "composite": comp,
                                  "w": im.width, "h": im.height, "title": info[0] if not comp else "Colour picture",
                                  "band": info[1], "about": info[2] if not comp else "Several channels combined into one picture."})
        res["images"].sort(key=lambda i: (not i["composite"], i["apid"] or 0))
        shutil.rmtree(best["outdir"], ignore_errors=True)
        res["ok"] = True
        try:
            res["report"] = self._make_pdf(d, res)
        except Exception as e:
            res["report"] = ""
            res["error"] = "Pictures were made, but the PDF failed: %s" % e
        self._save(d, res)
        return res

    def _process_sstv(self, did, path):
        """Slow-scan TV: look for pictures in a sound recording (e.g. the space station's picture events)."""
        d = os.path.join(self.root, did)
        shutil.rmtree(d, ignore_errors=True)
        os.makedirs(d)
        res = {"id": did, "kind": "sstv", "rec": os.path.basename(path), "created": time.time(),
               "t0": os.path.getmtime(path), "sat_name": "Slow-scan TV picture", "images": [], "seconds": 0}
        self._set(did, state="working", text="Listening for a picture in the recording...", pct=5)
        if sstv_pd is None or Image is None:
            raise RuntimeError("The picture decoder is not installed in this container. Rebuild the project from the latest files.")
        found = sstv_pd.decode_all(path, lambda v: self._set(did, pct=5 + 0.9 * v))
        if not found and importlib.util.find_spec("sstv"):             # other modes (Robot, Martin, Scottie) via the optional package
            out = os.path.join(d, "alt.png")
            code, txt = _run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), "sstv_helper.py"), path, out],
                             lambda v: None, 300, self.cancel)
            if os.path.isfile(out):
                m = re.search(r"MODE (\S+)", txt)
                found = [{"mode": m.group(1) if m else "SSTV", "image": Image.open(out).convert("RGB"), "lines": 0, "height": 0, "start_s": 0}]
        if not found:
            res.update(ok=False, error="No slow-scan TV picture was found in this recording. The space station sends pictures only during special events (listen for announcements on amsat.org or ariss.org), and the signal must be strong and clear for the whole 2 minutes.")
            self._save(d, res)
            return res
        for n, f in enumerate(found, 1):
            im = f["image"]
            fn = "picture%d.jpg" % n
            im.save(os.path.join(d, fn), quality=92)
            th = im.copy()
            th.thumbnail((360, 360))
            th.save(os.path.join(d, "picture%d_t.jpg" % n), quality=80)
            partial = f["height"] and f["lines"] < f["height"] * 0.9
            res["images"].append({"file": fn, "thumb": "picture%d_t.jpg" % n, "apid": None, "composite": True, "w": im.width, "h": im.height,
                                  "title": "Picture %d (%s)" % (n, f["mode"]), "mode": f["mode"], "band": "",
                                  "about": "Only part of the picture was received." if partial else "Complete picture."})
        res["ok"] = True
        try:
            res["report"] = self._make_sstv_pdf(d, res)
        except Exception as e:
            res["report"] = ""
            res["error"] = "The pictures were made, but the PDF failed: %s" % e
        self._save(d, res)
        return res

    def _make_sstv_pdf(self, d, res):
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
        from reportlab.lib.units import mm
        from reportlab.platypus import Image as RLImage, PageBreak, Paragraph, SimpleDocTemplate, Spacer
        ss = getSampleStyleSheet()
        h1 = ParagraphStyle("h1", parent=ss["Title"], fontSize=22, leading=26, alignment=0)
        body = ParagraphStyle("b", parent=ss["BodyText"], fontSize=10, leading=14)
        small = ParagraphStyle("s", parent=body, fontSize=8.5, textColor=colors.HexColor("#555555"))
        W, H = A4
        story = [Paragraph("Slow-scan TV pictures", h1),
                 Paragraph("Received %s from the recording %s. %d picture%s found." % (
                     time.strftime("%A %d %B %Y, %H:%M %Z", time.localtime(res["t0"])), res["rec"], len(res["images"]),
                     "" if len(res["images"]) == 1 else "s"), body), Spacer(1, 8)]
        for n, im in enumerate(res["images"]):
            if n:
                story.append(PageBreak())
            fw, fh = W - 30 * mm, H - 90 * mm
            w, h = fw, fw * im["h"] / im["w"]
            if h > fh:
                h, w = fh, fh * im["w"] / im["h"]
            story += [Paragraph("<b>%s</b>" % im["title"], body), Spacer(1, 4), RLImage(os.path.join(d, im["file"]), width=w, height=h),
                      Paragraph(im["about"], small)]
        story += [Spacer(1, 10), Paragraph("Slow-scan TV sends a still picture as a sequence of audio tones. Pictures from the space station arrive in "
                                           "special events organised by ARISS. Made by Skywave on %s." % time.strftime("%d %B %Y"), small)]
        out = os.path.join(d, "report.pdf")
        SimpleDocTemplate(out, pagesize=A4, leftMargin=15 * mm, rightMargin=15 * mm, topMargin=15 * mm, bottomMargin=15 * mm,
                          title="Slow-scan TV pictures", author="Skywave").build(story)
        return "report.pdf"

    def _collect(self, outdir):
        pics = []
        for n in sorted(os.listdir(outdir)):
            if not n.lower().endswith(".png"):
                continue
            p = os.path.join(outdir, n)
            try:
                with Image.open(p) as im:
                    w, h = im.size
            except Exception:
                continue
            if h >= 16:
                pics.append((p, w, h))
        return pics

    # ------------------------------------------------------------------ PDF
    def _make_pdf(self, d, res):
        from reportlab.lib import colors
        from reportlab.lib.pagesizes import A4
        from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
        from reportlab.lib.units import mm
        from reportlab.platypus import (Image as RLImage, KeepTogether, PageBreak, Paragraph, SimpleDocTemplate,
                                        Spacer, Table, TableStyle)

        ss = getSampleStyleSheet()
        h1 = ParagraphStyle("h1", parent=ss["Title"], fontSize=22, leading=26, alignment=0, spaceAfter=4)
        h2 = ParagraphStyle("h2", parent=ss["Heading2"], fontSize=14, spaceBefore=10, spaceAfter=4)
        body = ParagraphStyle("b", parent=ss["BodyText"], fontSize=10, leading=14)
        small = ParagraphStyle("s", parent=body, fontSize=8.5, leading=11, textColor=colors.HexColor("#555555"))
        cap = ParagraphStyle("c", parent=body, fontSize=8.5, leading=11)

        def when(t):
            return time.strftime("%A %d %B %Y, %H:%M:%S %Z", time.localtime(t)) if t else "unknown"

        name = res.get("sat_name") or res.get("sat") or "Weather satellite"
        t0, t1 = res.get("t0"), res.get("t1")
        rows = [["Satellite", name + (" (NORAD %s)" % res["norad"] if res.get("norad") else "")],
                ["Pass started", when(t0)],
                ["Pass ended", when(t1) if t1 else "about %d minutes later" % round((res.get("seconds") or 0) / 60.0)],
                ["Frequency", "%.4f MHz" % (res["freq"] / 1e6) if res.get("freq") else "unknown"],
                ["Highest point in the sky", "%.0f degrees above the horizon" % res["max_el"] if res.get("max_el") else "not recorded"],
                ["Receiver location", "%.3f, %.3f" % (res["lat"], res["lon"]) if res.get("lat") is not None else "not recorded"],
                ["Recording length", "%d minutes %d seconds" % divmod(int(res.get("seconds") or 0), 60)],
                ["Decoded with", "%s%s" % (res.get("method", ""), "" if res.get("rs_errors") is None else
                                          " (%d error-corrections, fewer is cleaner)" % max(res["rs_errors"], 0))],
                ["Picture orientation", "Turned upside down so north is at the top (satellite was heading north)." if res.get("rotated")
                 else "As received: north is at the top (satellite was heading south)."]]
        story = [Paragraph("Weather satellite pass", h1), Paragraph("<b>%s</b> &middot; %s" % (name, when(t0)), body),
                 Spacer(1, 8)]
        tb = Table([[Paragraph("<b>%s</b>" % a, cap), Paragraph(b, cap)] for a, b in rows], colWidths=[48 * mm, 122 * mm])
        tb.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.3, colors.HexColor("#c9d1d4")),
                                ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#eef2f3")),
                                ("VALIGN", (0, 0), (-1, -1), "TOP")]))
        story += [tb, Spacer(1, 8)]

        comp = next((i for i in res["images"] if i["composite"]), None)
        W, H = A4
        fw, fh = W - 30 * mm, H - 55 * mm
        if comp:
            story.append(Paragraph("The picture", h2))
            story.append(Paragraph("The channels the satellite sent were combined into one picture. In daylight it looks like a "
                                   "normal view from above: white is cloud, dark blue-green is sea. At night only the infrared channels "
                                   "carry information, so a colour picture can look dark or odd; use the single channels below.", body))
            im = Image.open(os.path.join(d, comp["file"]))
            seg_h = int(im.width * fh / fw)               # slice tall pictures so each piece fills a page
            n = max(1, -(-im.height // seg_h))
            for k in range(n):
                part = im.crop((0, k * seg_h, im.width, min(im.height, (k + 1) * seg_h)))
                pf = os.path.join(d, "_part%d.jpg" % k)
                part.save(pf, quality=88)
                story.append(PageBreak() if k else Spacer(1, 6))
                ph = fw * part.height / part.width
                story.append(RLImage(pf, width=fw, height=ph))
                if n > 1:
                    story.append(Paragraph("Part %d of %d, in the order the satellite scanned (top = first)." % (k + 1, n), small))
        chans = [i for i in res["images"] if not i["composite"]]
        if chans:
            story += [PageBreak(), Paragraph("Single channels", h2),
                      Paragraph("Each channel is a separate black-and-white picture taken in a different kind of light. "
                                "They are stretched to use the full range from black to white.", body), Spacer(1, 6)]
            cell_w, cell_h = 56 * mm, 150 * mm
            cells = []
            for c in chans:
                ar = c["h"] / float(c["w"])
                w = cell_w
                h = w * ar
                if h > cell_h:
                    h, w = cell_h, cell_h / ar
                cells.append([RLImage(os.path.join(d, c["file"]), width=w, height=h),
                              Paragraph("<b>%s</b><br/>%s<br/>%s" % (c["title"], c["band"], c["about"]), cap)])
            for k in range(0, len(cells), 3):
                row = cells[k:k + 3]
                t = Table([[x[0] for x in row] + [""] * (3 - len(row)), [x[1] for x in row] + [""] * (3 - len(row))],
                          colWidths=[cell_w + 3 * mm] * 3)
                t.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
                story += [KeepTogether([t]), Spacer(1, 8)]
        story += [Paragraph("Reading these pictures", h2),
                  Paragraph("&bull; Images are not corrected for the curve of the Earth, so the edges look stretched.<br/>"
                            "&bull; Black bands or gaps mean the signal was lost for a moment (low in the sky, or something in the way).<br/>"
                            "&bull; Bright white in the thermal channels is cold, so high cloud tops; darker means warmer ground or sea.<br/>"
                            "&bull; Meteor satellites pass over at roughly the same local time each day, so the lighting is similar from pass to pass.", body),
                  Spacer(1, 10),
                  Paragraph("Made by Skywave on %s from the recording %s." % (time.strftime("%d %B %Y, %H:%M"), res.get("rec", "")), small)]

        def footer(canv, doc):
            canv.saveState()
            canv.setFont("Helvetica", 8)
            canv.setFillColor(colors.HexColor("#777777"))
            canv.drawString(15 * mm, 8 * mm, "Skywave - %s" % name)
            canv.drawRightString(W - 15 * mm, 8 * mm, "Page %d" % doc.page)
            canv.restoreState()

        out = os.path.join(d, "report.pdf")
        doc = SimpleDocTemplate(out, pagesize=A4, leftMargin=15 * mm, rightMargin=15 * mm, topMargin=15 * mm,
                                bottomMargin=18 * mm, title="Weather satellite pass - %s" % name, author="Skywave")
        doc.build(story, onFirstPage=footer, onLaterPages=footer)
        for n in os.listdir(d):
            if n.startswith("_part"):
                os.remove(os.path.join(d, n))
        return "report.pdf"
