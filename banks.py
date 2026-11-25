"""banks.py - scanner banks (frequency lists) and the band plan used for labels."""
import json

import regions

# (start Hz, stop Hz, name, default mode). Used to label the spectrum and to pick a sensible mode.
# Approximate; check your national regulator's band plan for authoritative limits. Region-specific lines (ham 2 m,
# walkie-talkie bands, ...) are added by set_region().
BAND_PLAN = [
    (1.8e6, 2.0e6, "160 m ham", "lsb"),
    (3.5e6, 3.9e6, "80 m ham", "lsb"),
    (5.9e6, 6.2e6, "49 m shortwave", "am"),
    (7.0e6, 7.3e6, "40 m ham", "lsb"),
    (9.4e6, 9.9e6, "31 m shortwave", "am"),
    (14.0e6, 14.35e6, "20 m ham", "usb"),
    (28.0e6, 29.7e6, "10 m ham", "usb"),
    (50.0e6, 54.0e6, "6 m ham", "nfm"),
    (108.0e6, 118.0e6, "Aviation navigation", "am"),
    (118.0e6, 137.0e6, "Airband", "am"),
    (137.0e6, 138.0e6, "Weather satellites", "nfm"),
    (156.0e6, 162.6e6, "Marine VHF", "nfm"),
    (174.0e6, 230.0e6, "Digital radio / TV", "wfm"),
    (400.0e6, 420.0e6, "Government / services", "nfm"),
    (806.0e6, 821.0e6, "Mobile (digital)", "nfm"),
    (1090.0e6 - 1e6, 1090.0e6 + 1e6, "Plane transponders", "am"),
]


_BASE_PLAN = list(BAND_PLAN)
REGION, COUNTRY = regions.DEFAULT_REGION, ""


def set_region(region_id, country=""):
    """Rebuild the band plan for a region (in place, so everything holding BAND_PLAN sees the change)."""
    global REGION, COUNTRY
    REGION, COUNTRY = regions.canon(region_id), str(country or "").upper()
    plan = _BASE_PLAN + [(a, b, n, m) for a, b, n, m in regions.band_extras(REGION, country)]
    if "cb27" in regions.get(REGION, COUNTRY)["short"]:
        plan.append((26.965e6, 27.405e6, "27 MHz CB", "am"))
    plan.sort(key=lambda x: x[0])
    BAND_PLAN[:] = plan


set_region(REGION)


def band_for(f):
    for a, b, name, mode in BAND_PLAN:
        if a <= f <= b:
            return name, mode
    return None, "nfm"


def default_banks(region_id=regions.DEFAULT_REGION, country=""):
    r = regions.get(region_id, country)
    air = [{"f": int(f), "label": lab, "mode": "am", "bw": 12000} for f, lab in r["air"]]
    out = regions.short_banks(region_id, country)
    out += [
        {"id": "marine", "name": "Marine radio (main channels)", "builtin": True, "thr": 8, "hang": 2.0,
         "note": "Ship and coast radio. Channel 16 is the distress and calling channel.", "channels": regions.plan_marine()},
        {"id": "air_key", "name": "Aviation: key frequencies", "builtin": True, "thr": 8, "hang": 3.0,
         "note": "Emergency, air-to-air and local-airfield frequencies. Add your nearest tower, ATIS and approach frequencies as your own list.",
         "channels": air},
        {"id": "airband", "name": "Aviation: sweep everything (118-137 MHz)", "builtin": True, "thr": 9, "hang": 2.5,
         "note": "Steps through every 25 kHz channel in the civil airband. Slower than a short list, but finds what is active near you.",
         "ranges": [{"start": 118.0e6, "stop": 137.0e6, "step": 25e3, "mode": "am", "bw": 12000, "label": "Air"}]},
        {"id": "ham_vhf", "name": "Amateur radio: 2 m calling and APRS", "builtin": True, "thr": 8, "hang": 3.0,
         "note": "Starter list. Verify against your national band plan and add your local repeaters as your own list.",
         "channels": [
             {"f": int(r["aprs"]), "label": "APRS", "mode": "nfm", "bw": 16000}] +
            ([{"f": int(r["ham_call"][0]), "label": r["ham_call"][1], "mode": "nfm", "bw": 16000}] if r["ham_call"] else []) + [
             {"f": 145800000, "label": "Space station voice", "mode": "nfm", "bw": 16000},
             {"f": 145825000, "label": "Space station APRS", "mode": "nfm", "bw": 16000}]},
        {"id": "services", "name": "My services list (add your own)", "builtin": False,
         "thr": 8, "hang": 3.0,
         "note": ("Empty on purpose. Most emergency services use digital, trunked or encrypted radio that an RTL-SDR cannot "
                  "decode. If you find analogue channels you are allowed to monitor, add them here."),
         "channels": []},
    ]
    return out


MODES = ("nfm", "am", "wfm", "usb", "lsb", "cw")   # demodulators a scanner list may ask for
MAX_CHANNELS = 20000

class BankStore:
    def __init__(self, path, region_id=regions.DEFAULT_REGION, country=""):
        self.path = path
        self.region = (region_id, country)
        self.banks = default_banks(region_id, country)
        self._load_saved()

    def set_region(self, region_id, country=""):
        """Switch the built-in lists to another country's channel plans, keeping everything the user made."""
        if (region_id, country) == self.region:
            return
        mine = [b for b in self.banks if not b.get("builtin")]
        self.region = (region_id, country)
        self.banks = default_banks(region_id, country)
        by_id = {b["id"]: b for b in mine}
        for i, b in enumerate(self.banks):
            if b["id"] in by_id and not b.get("builtin"):
                self.banks[i] = by_id[b["id"]]
        ids = {x["id"] for x in self.banks}
        self.banks += [b for b in mine if b["id"] not in ids]

    def _load_saved(self):
        path = self.path
        try:
            with open(path) as f:
                saved = json.load(f)
            by_id = {b["id"]: b for b in saved}
            for i, b in enumerate(self.banks):
                if b["id"] in by_id and not b.get("builtin"):
                    self.banks[i] = by_id[b["id"]]
            ids = {x["id"] for x in self.banks}
            for b in saved:
                if b["id"] not in ids:
                    self.banks.append(b)
        except (OSError, ValueError):
            pass

    def save(self):
        try:
            with open(self.path, "w") as f:
                json.dump([b for b in self.banks if not b.get("builtin")], f, indent=1)
        except OSError:
            pass

    def get(self, bid):
        for b in self.banks:
            if b["id"] == bid:
                return b
        return None

    def put(self, bank):
        if not isinstance(bank, dict) or not bank.get("id"):
            raise ValueError("bad list")
        existing = self.get(bank["id"])
        if existing and existing.get("builtin"):
            raise ValueError("built-in lists can't be changed; make a copy instead")
        clean = {"id": str(bank["id"])[:40], "name": str(bank.get("name", bank["id"]))[:60], "builtin": False,
                 "note": str(bank.get("note", ""))[:600], "thr": float(bank.get("thr", 8)),
                 "hang": float(bank.get("hang", 2)), "channels": [], "ranges": []}
        for c in bank.get("channels", []):
            mode = c.get("mode", "nfm")
            clean["channels"].append({"f": int(float(c["f"])), "label": str(c.get("label", ""))[:40],
                                      "mode": mode if mode in MODES else "nfm",
                                      "bw": float(c.get("bw", 12500))})
        total = len(clean["channels"])
        for r in bank.get("ranges", []):
            # a range must be finite, run upwards in real steps and stay a sensible size: a zero, negative or tiny step
            # would make expand() loop forever on the radio thread and in every browser
            start, stop, step = float(r["start"]), float(r["stop"]), float(r["step"])
            if not (0 < start <= stop <= 2e9 and 100 <= step <= 1e8):
                raise ValueError("a range needs a start below its end and a step of at least 100 Hz")
            total += int((stop - start) // step) + 1
            if total > MAX_CHANNELS:
                raise ValueError("a list can hold at most %d channels" % MAX_CHANNELS)
            mode = r.get("mode", "nfm")
            clean["ranges"].append({"start": start, "stop": stop, "step": step,
                                    "mode": mode if mode in MODES else "nfm", "bw": float(r.get("bw", 12500)),
                                    "label": str(r.get("label", ""))[:20]})
        for i, b in enumerate(self.banks):
            if b["id"] == clean["id"]:
                self.banks[i] = clean
                break
        else:
            self.banks.append(clean)
        self.save()
        return clean

    def delete(self, bid):
        self.banks = [b for b in self.banks if not (b["id"] == bid and not b.get("builtin"))]
        self.save()

    @staticmethod
    def expand(bank):
        chans = [dict(c) for c in bank.get("channels", [])]
        for r in bank.get("ranges", []):
            f = r["start"]
            if not r["step"] > 0:                    # lists saved before ranges were checked
                continue
            while f <= r["stop"] + 1 and len(chans) < MAX_CHANNELS:
                chans.append({"f": round(f), "label": "%s %.3f" % (r.get("label", ""), f / 1e6),
                              "mode": r["mode"], "bw": r["bw"]})
                f += r["step"]
        chans.sort(key=lambda c: c["f"])
        return chans


def label_for(f):
    """Short human label for a frequency: a named short-range channel (e.g. 'PMR446 channel 1'), else the band name."""
    for c in regions.channel_labels(REGION, COUNTRY):
        if abs(c["f"] - f) <= c["tol"]:
            return c["label"]
    return band_for(f)[0] or ""
