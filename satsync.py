"""satsync.py - once-a-day refresh of satellite facts from SatNOGS DB (a community database run by the Libre Space Foundation).

Safety design (why the data can't tell the app what to do):
  * Only one host is ever contacted (db.satnogs.org), over HTTPS, with a size limit and a timeout.
  * The reply is parsed as JSON data and then reduced to a few fields, each checked against a whitelist or a number
    range. Free text (a transmitter's description) is stripped to plain letters and digits, cut short, and is only
    ever shown on screen after HTML-escaping. It is never run, never used to build a command or a URL, and the app
    has no language model reading it.
  * A satellite's NORAD number we ask about comes from our own catalog, not from the reply.
"""
import json
import os
import re
import time
import urllib.parse
import urllib.request

HOST = "db.satnogs.org"
MAX_BYTES = 2_000_000
SERVICES = {"Amateur", "Meteorological", "Earth Exploration", "Space Research", "Fixed", "Mobile", "Unknown"}
STATUS = {"active", "inactive", "invalid"}
SAT_STATUS = {"alive", "dead", "future", "re-entered"}
MODE_MAP = {"FM": "nfm", "AFSK": "nfm", "SSTV": "nfm", "USB": "usb", "LSB": "lsb", "CW": "cw", "FSK": "digital",
            "GFSK": "digital", "GMSK": "digital", "BPSK": "digital", "QPSK": "digital", "OQPSK": "digital",
            "LRPT": "digital", "DSB": "nfm", "AM": "am"}


def _get_json(url, fetch=None):
    """Download and parse JSON from the one allowed host."""
    if urllib.parse.urlparse(url).hostname != HOST or not url.startswith("https://"):
        raise ValueError("blocked host")
    if fetch:
        return fetch(url)
    if os.environ.get("NO_NET"):
        raise OSError("outside requests are turned off (NO_NET)")
    req = urllib.request.Request(url, headers={"User-Agent": "skywave/1.0 (+satellite data refresh)", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        if urllib.parse.urlparse(r.geturl()).hostname != HOST:
            raise ValueError("redirected to another host")
        data = r.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise ValueError("reply too large")
    return json.loads(data.decode("utf-8", "replace"))


def clean_text(s, n=40):
    return re.sub(r"[^A-Za-z0-9 .,()/+&:-]", "", str(s or ""))[:n].strip()


def clean_transmitter(t):
    """Reduce one SatNOGS transmitter record to safe fields, or None if it is unusable."""
    if not isinstance(t, dict):
        return None
    f = t.get("downlink_low")
    if isinstance(f, bool) or not isinstance(f, (int, float)) or not 100e6 <= f <= 2.5e9:
        return None
    mode = re.sub(r"[^A-Za-z0-9]", "", str(t.get("mode") or ""))[:10].upper()
    status = t.get("status") if t.get("status") in STATUS else "unknown"
    service = t.get("service") if t.get("service") in SERVICES else ""
    return {"f": int(round(f)), "mode": mode, "our_mode": MODE_MAP.get(mode, ""), "alive": bool(t.get("alive")),
            "status": status, "service": service, "desc": clean_text(t.get("description")),
            "active": bool(t.get("alive")) and status == "active"}


def sync_one(norad, fetch=None):
    """Returns {"status": alive|dead|..., "tx": [clean transmitters]} for one NORAD number."""
    norad = int(norad)
    sats = _get_json("https://%s/api/satellites/?norad_cat_id=%d&format=json" % (HOST, norad), fetch)
    status = ""
    if isinstance(sats, list) and sats and isinstance(sats[0], dict):
        status = sats[0].get("status") if sats[0].get("status") in SAT_STATUS else ""
    txs = _get_json("https://%s/api/transmitters/?satellite__norad_cat_id=%d&format=json" % (HOST, norad), fetch)
    out = []
    for t in (txs if isinstance(txs, list) else [])[:80]:
        c = clean_transmitter(t)
        if c:
            out.append(c)
    return {"status": status, "tx": out[:30], "t": time.time()}


def annotate(freqs, info, tol=25e3):
    """Compare our known channels with what SatNOGS reports. Returns (freqs with a 'check' flag, suggested extras)."""
    tx = (info or {}).get("tx", [])
    out = []
    for fr in freqs:
        near = [t for t in tx if abs(t["f"] - fr["f"]) <= max(tol, fr.get("bw", 0) / 2)]
        check = "unlisted"
        if any(t["active"] for t in near):
            check = "active"
        elif near:
            check = "inactive"
        out.append(dict(fr, check=check if info else ""))
    extras = []
    for t in tx:
        if not t["active"] or any(abs(t["f"] - fr["f"]) <= max(tol, fr.get("bw", 0) / 2) for fr in freqs):
            continue
        digital = t["our_mode"] == "digital"
        extras.append({"label": "Reported active: %s" % (t["desc"] or t["mode"] or "transmitter"), "f": t["f"],
                       "mode": "nfm" if digital or not t["our_mode"] else t["our_mode"],
                       "bw": 150000 if digital else (2800 if t["our_mode"] in ("usb", "lsb") else 16000),
                       "kind": "digital" if digital and 130e6 <= t["f"] <= 140e6 else ("packet" if digital else "voice"),
                       "reported": True, "check": "active", **({"fs": 288000} if digital and 130e6 <= t["f"] <= 140e6 else {})})
    return out, extras[:4]
