"""adsb.py - Mode S / ADS-B (1090 MHz) decoder, CPR position decoding, aircraft table,
plus an encoder/modulator used by the simulator and the tests.

The demodulator works on 8-bit IQ sampled at 2.0 MS/s centred on 1090 MHz
(1 microsecond = 2 samples). It looks for the 8 us preamble, slices 112 PPM bits and
accepts DF17/DF18 extended squitters whose 24-bit CRC checks out (no error correction).
"""
import math
import threading
import time

import numpy as np

ADSB_FS = 2000000
CHARSET = "#ABCDEFGHIJKLMNOPQRSTUVWXYZ#####_###############0123456789######"
_POLY = 0x1FFF409


# ------------------------------------------------------------------ CRC
def crc24(data):
    """Remainder of the bytes divided by the Mode S generator. 0 means a valid message."""
    crc = 0
    for byte in data:
        crc ^= byte << 16
        for _ in range(8):
            crc <<= 1
            if crc & 0x1000000:
                crc ^= _POLY
        crc &= 0xFFFFFF
    return crc


# ------------------------------------------------------------------ CPR
def _nl(lat):
    lat = abs(lat)
    if lat < 1e-9:
        return 59
    if abs(lat - 87.0) < 1e-9:
        return 2
    if lat > 87.0:
        return 1
    nz = 15.0
    a = 1 - math.cos(math.pi / (2 * nz))
    b = math.cos(math.pi / 180.0 * lat) ** 2
    return int(math.floor(2 * math.pi / math.acos(1 - a / b)))


def _mod(x, y):
    return x - y * math.floor(x / y)


def cpr_encode(lat, lon, odd):
    """17-bit CPR (lat, lon) for an airborne position frame."""
    i = 1 if odd else 0
    dlat = 360.0 / (59 if odd else 60)
    yz = math.floor(131072 * _mod(lat, dlat) / dlat + 0.5)
    rlat = dlat * (yz / 131072.0 + math.floor(lat / dlat))
    nl = _nl(rlat) - i
    dlon = 360.0 / max(nl, 1)
    xz = math.floor(131072 * _mod(lon, dlon) / dlon + 0.5)
    return int(yz) & 0x1FFFF, int(xz) & 0x1FFFF


def cpr_global(lat_e, lon_e, lat_o, lon_o, last_odd):
    """Decode a position from an even+odd pair (17-bit values). Returns (lat, lon) or None."""
    j = math.floor(59 * lat_e / 131072.0 - 60 * lat_o / 131072.0 + 0.5)
    rlat_e = (360.0 / 60) * (_mod(j, 60) + lat_e / 131072.0)
    rlat_o = (360.0 / 59) * (_mod(j, 59) + lat_o / 131072.0)
    if rlat_e >= 270:
        rlat_e -= 360
    if rlat_o >= 270:
        rlat_o -= 360
    if _nl(rlat_e) != _nl(rlat_o):
        return None
    if last_odd:
        ni = max(_nl(rlat_o) - 1, 1)
        m = math.floor((lon_e * (_nl(rlat_o) - 1) - lon_o * _nl(rlat_o)) / 131072.0 + 0.5)
        lon = (360.0 / ni) * (_mod(m, ni) + lon_o / 131072.0)
        lat = rlat_o
    else:
        ni = max(_nl(rlat_e), 1)
        m = math.floor((lon_e * (_nl(rlat_e) - 1) - lon_o * _nl(rlat_e)) / 131072.0 + 0.5)
        lon = (360.0 / ni) * (_mod(m, ni) + lon_e / 131072.0)
        lat = rlat_e
    if lon > 180:
        lon -= 360
    return lat, lon


def cpr_local(lat_ref, lon_ref, lat_c, lon_c, odd):
    """Decode a single frame relative to a reference position within ~180 NM."""
    dlat = 360.0 / (59 if odd else 60)
    j = math.floor(lat_ref / dlat) + math.floor(0.5 + _mod(lat_ref, dlat) / dlat - lat_c / 131072.0)
    lat = dlat * (j + lat_c / 131072.0)
    nl = _nl(lat) - (1 if odd else 0)
    dlon = 360.0 / max(nl, 1)
    m = math.floor(lon_ref / dlon) + math.floor(0.5 + _mod(lon_ref, dlon) / dlon - lon_c / 131072.0)
    lon = dlon * (m + lon_c / 131072.0)
    return lat, lon


# ------------------------------------------------------------------ message encode (sim / tests)
def _finish(df, ca, icao, me):
    head = bytes([(df << 3) | ca]) + icao.to_bytes(3, "big") + me
    pi = crc24(head)
    return head + pi.to_bytes(3, "big")


def encode_ident(icao, callsign, cat=3):
    cs = callsign.upper().ljust(8)[:8]
    v = (4 << 51) | (cat << 48)          # TC 4
    for i, ch in enumerate(cs):
        v |= (CHARSET.index(ch) if ch in CHARSET else 0) << (42 - 6 * i)
    return _finish(17, 5, icao, v.to_bytes(7, "big"))


def encode_position(icao, alt_ft, lat, lon, odd):
    n = int((alt_ft + 1000) // 25)
    ac = ((n & 0x7F0) << 1) | 0x10 | (n & 0x0F)
    clat, clon = cpr_encode(lat, lon, odd)
    v = (11 << 51) | (ac << 36) | ((1 if odd else 0) << 34) | (clat << 17) | clon   # TC 11, T=0
    return _finish(17, 5, icao, v.to_bytes(7, "big"))


def encode_velocity(icao, speed_kt, heading_deg, vrate_fpm):
    vew = speed_kt * math.sin(math.radians(heading_deg))
    vns = speed_kt * math.cos(math.radians(heading_deg))
    sew, sns = (1 if vew < 0 else 0), (1 if vns < 0 else 0)
    vr = int(abs(vrate_fpm) / 64) + 1
    svr = 1 if vrate_fpm < 0 else 0
    v = (19 << 51) | (1 << 48) | (sew << 42) | ((int(abs(vew)) + 1) << 32) | (sns << 31) | \
        ((int(abs(vns)) + 1) << 21) | (svr << 19) | (vr << 10)
    return _finish(17, 5, icao, v.to_bytes(7, "big"))


def modulate(frames, gap=40, amp=1.0, fs=ADSB_FS):
    """Frames -> magnitude waveform at 2 MS/s (preamble + PPM data), with `gap` samples between."""
    out = []
    for fr in frames:
        w = np.zeros(16 + 224 + gap, dtype=np.float32)
        for p in (0, 2, 7, 9):
            w[p] = amp
        bits = np.unpackbits(np.frombuffer(fr, dtype=np.uint8))
        for i, b in enumerate(bits):
            w[16 + 2 * i + (0 if b else 1)] = amp
        out.append(w)
    return np.concatenate(out) if out else np.zeros(0, dtype=np.float32)


# ------------------------------------------------------------------ demodulation
def demod(mag):
    """Find valid DF17/DF18 messages in a magnitude array. Returns list of (index, bytes)."""
    n = len(mag) - 240
    if n <= 0:
        return []
    m = mag
    c = ((m[0:n] > m[1:n + 1]) & (m[1:n + 1] < m[2:n + 2]) & (m[2:n + 2] > m[3:n + 3]) &
         (m[3:n + 3] < m[0:n]) & (m[4:n + 4] < m[0:n]) & (m[5:n + 5] < m[0:n]) & (m[6:n + 6] < m[0:n]) &
         (m[7:n + 7] > m[8:n + 8]) & (m[8:n + 8] < m[9:n + 9]) & (m[9:n + 9] > m[6:n + 6]))
    high = (m[0:n] + m[2:n + 2] + m[7:n + 7] + m[9:n + 9]) / 6.0
    c &= (m[4:n + 4] < high) & (m[5:n + 5] < high) & (m[11:n + 11] < high) & (m[12:n + 12] < high) & \
         (m[13:n + 13] < high) & (m[14:n + 14] < high)
    idx = np.nonzero(c)[0]
    if not len(idx):
        return []
    # cheap pre-filter on the 5 DF bits (17 or 18) before slicing the whole frame
    df = np.zeros(len(idx), dtype=np.int32)
    for k in range(5):
        p = idx + 16 + 2 * k
        df = (df << 1) | (m[p] > m[p + 1])
    keep = (df == 17) | (df == 18)
    idx = idx[keep]
    if not len(idx):
        return []
    pos = idx[:, None] + 16 + 2 * np.arange(112)[None, :]
    bits = (m[pos] > m[pos + 1]).astype(np.uint8)
    packed = np.packbits(bits, axis=1)
    out = []
    last_end = -1
    for i, row in zip(idx.tolist(), packed):
        if i < last_end:
            continue
        b = bytes(row.tolist())
        if crc24(b) == 0:
            out.append((i, b))
            last_end = i + 240
    return out


def iq_to_mag(raw):
    """uint8 interleaved IQ bytes -> float32 magnitude."""
    a = np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 127.5
    a = a.reshape(-1, 2)
    return np.hypot(a[:, 0], a[:, 1])


class Demodulator:
    """Chunked demodulator that carries a 239-sample tail between calls."""

    def __init__(self):
        self.tail = np.zeros(0, dtype=np.float32)
        self.count = 0

    def process(self, raw):
        mag = iq_to_mag(raw)
        buf = np.concatenate((self.tail, mag)) if len(self.tail) else mag
        msgs = [b for _, b in demod(buf)]
        self.tail = buf[max(0, len(buf) - 239):].copy()
        self.count += len(msgs)
        return msgs


# ------------------------------------------------------------------ aircraft table
def _distance_bearing(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    d = 2 * 6371.0 * math.asin(min(1, math.sqrt(a)))
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return d, (math.degrees(math.atan2(y, x)) + 360) % 360


# Address blocks that countries set aside for military aircraft, and callsign prefixes air forces use. A best guess:
# not every military aircraft broadcasts, and some use civil addresses.
MIL_BLOCKS = [(0xADF7C8, 0xAFFFFF), (0x7CF800, 0x7CFAFF), (0xC87F00, 0xC87FFF), (0x43C000, 0x43CFFF), (0xC20000, 0xC3FFFF),
              (0x3A8000, 0x3AFFFF), (0x3B0000, 0x3BFFFF), (0x3E8000, 0x3EBFFF), (0x3F4000, 0x3FBFFF)]
MIL_CALLS = ("RCH", "ASY", "KIWI", "CFC", "RRR", "CNV", "PAT", "NAVY", "ARMY", "EVAC", "SAM", "MAGMA", "DRAGN", "HAWK", "BOLT", "NOBLE", "TABOR", "HOMER", "WARD")


def military(icao, callsign=""):
    try:
        v = int(icao, 16)
    except (TypeError, ValueError):
        v = -1
    if any(a <= v <= b for a, b in MIL_BLOCKS):
        return True
    cs = (callsign or "").strip().upper()
    return bool(cs) and any(cs.startswith(p) and (len(cs) == len(p) or cs[len(p)].isdigit()) for p in MIL_CALLS)


class AircraftTable:
    def __init__(self, home_lat, home_lon, max_age=90.0):
        self.home = (home_lat, home_lon)
        self.max_age = max_age
        self.ac = {}
        self.lock = threading.Lock()
        self.total_msgs = 0
        self.first_msg = None
        self.max_range_km = 0.0
        self.cover = [0.0] * 36           # farthest position heard in each 10-degree direction, in km (kept across Clear)
        self.cover_dirty = False

    def set_home(self, lat, lon):
        self.home = (lat, lon)

    def clear(self):
        with self.lock:
            self.ac.clear()
            self.total_msgs = 0
            self.max_range_km = 0.0
            self.first_msg = None

    def update(self, msg, now=None):
        """msg: 14 raw bytes of a CRC-valid DF17/18. Returns the aircraft dict or None."""
        now = now or time.time()
        df = msg[0] >> 3
        if df not in (17, 18):
            return None
        icao = "%06X" % int.from_bytes(msg[1:4], "big")
        me = int.from_bytes(msg[4:11], "big")
        tc = me >> 51
        with self.lock:
            self.total_msgs += 1
            self.first_msg = self.first_msg or now
            a = self.ac.setdefault(icao, {"icao": icao, "callsign": "", "lat": None, "lon": None, "alt": None,
                                          "speed": None, "heading": None, "vrate": None, "msgs": 0,
                                          "first": now, "trail": [], "_e": None, "_o": None})
            a["msgs"] += 1
            a["seen"] = now
            if 1 <= tc <= 4:
                s = ""
                for i in range(8):
                    s += CHARSET[(me >> (42 - 6 * i)) & 0x3F]
                a["callsign"] = s.replace("#", "").replace("_", " ").strip()
                cat = (me >> 48) & 7
                a["cat"] = {4: {1: "Light aircraft", 2: "Small aircraft", 3: "Medium airliner", 4: "Large airliner",
                                5: "Heavy airliner", 6: "Fast jet", 7: "Helicopter"},
                            3: {1: "Glider", 2: "Balloon", 3: "Parachutist", 4: "Ultralight", 6: "Drone", 7: "Spacecraft"},
                            2: {1: "Ground vehicle", 3: "Ground vehicle"}}.get(tc, {}).get(cat, a.get("cat", ""))
            elif tc == 28 and ((me >> 48) & 7) == 1:
                # emergency / priority status message (rare: sent while an emergency is declared)
                a["emg"] = (me >> 45) & 7
                g = (me >> 32) & 0x1FFF
                h = 0
                for bit, out in ((0x1000, 0x0010), (0x0800, 0x1000), (0x0400, 0x0020), (0x0200, 0x2000), (0x0100, 0x0040),
                                 (0x0080, 0x4000), (0x0020, 0x0100), (0x0010, 0x0001), (0x0008, 0x0200), (0x0004, 0x0002),
                                 (0x0002, 0x0400), (0x0001, 0x0004)):
                    if g & bit:
                        h |= out
                a["squawk"] = "%d%d%d%d" % ((h >> 12) & 7, (h >> 8) & 7, (h >> 4) & 7, h & 7)
            elif 9 <= tc <= 18 or 20 <= tc <= 22:
                ac = (me >> 36) & 0xFFF
                if tc <= 18 and ac and (ac & 0x10):
                    n = ((ac & 0x0FE0) >> 1) | (ac & 0x000F)
                    a["alt"] = n * 25 - 1000
                odd = (me >> 34) & 1
                clat = (me >> 17) & 0x1FFFF
                clon = me & 0x1FFFF
                a["_o" if odd else "_e"] = (clat, clon, now)
                pos = None
                glob = guess = False
                e, o = a["_e"], a["_o"]
                if e and o and abs(e[2] - o[2]) <= 10:
                    pos = cpr_global(e[0], e[1], o[0], o[1], bool(odd))
                    glob = pos is not None
                if pos is None and a["lat"] is not None:
                    # single frame: decode relative to the last known position (valid within ~180 NM)
                    pos = cpr_local(a["lat"], a["lon"], clat, clon, bool(odd))
                if pos is None and a["lat"] is None and self.home:
                    # first sighting with only one frame: place it relative to the receiver so it shows on the map at once.
                    # Only trusted within 300 km, and replaced as soon as a proper even/odd pair arrives.
                    p2 = cpr_local(self.home[0], self.home[1], clat, clon, bool(odd))
                    if p2 and -90 <= p2[0] <= 90 and _distance_bearing(self.home[0], self.home[1], p2[0], p2[1])[0] <= 300:
                        pos, guess = p2, True
                if pos and -90 <= pos[0] <= 90:
                    if a["lat"] is not None and not (glob and a.get("_guess")) and _distance_bearing(a["lat"], a["lon"], pos[0], pos[1])[0] >= 40:
                        a["_bad"] = a.get("_bad", 0) + 1       # implausible jump; after 4 in a row, start over
                        if a["_bad"] >= 4:
                            a["lat"] = a["lon"] = None
                            a["_bad"] = 0
                    else:
                        a["_bad"] = 0
                        if glob:
                            a["_guess"] = False
                        elif guess:
                            a["_guess"] = True
                        a["lat"], a["lon"] = round(pos[0], 5), round(pos[1], 5)
                        if not a["trail"] or now - a["trail"][-1][2] > 4:
                            a["trail"].append((a["lat"], a["lon"], now, a["alt"]))
                            del a["trail"][:-60]
                        d, brg = _distance_bearing(self.home[0], self.home[1], a["lat"], a["lon"])
                        self.max_range_km = max(self.max_range_km, d)
                        if d < 600:
                            b = int(brg // 10) % 36
                            if d > self.cover[b]:
                                self.cover[b] = round(d, 1)
                                self.cover_dirty = True
            elif tc == 19:
                st = (me >> 48) & 7
                if st in (1, 2):
                    sew, vew = (me >> 42) & 1, (me >> 32) & 0x3FF
                    sns, vns = (me >> 31) & 1, (me >> 21) & 0x3FF
                    if vew and vns:
                        ve = (vew - 1) * (-1 if sew else 1)
                        vn = (vns - 1) * (-1 if sns else 1)
                        if st == 2:
                            ve, vn = ve * 4, vn * 4
                        a["speed"] = round(math.hypot(ve, vn))
                        a["heading"] = round((math.degrees(math.atan2(ve, vn)) + 360) % 360)
                    vr = (me >> 10) & 0x1FF
                    if vr:
                        a["vrate"] = (vr - 1) * 64 * (-1 if (me >> 19) & 1 else 1)
            return a

    def snapshot(self, now=None):
        now = now or time.time()
        out = []
        with self.lock:
            for k in [k for k, a in self.ac.items() if now - a["seen"] > self.max_age * 2]:
                del self.ac[k]
            for a in self.ac.values():
                if now - a["seen"] > self.max_age:
                    continue
                d = {k: a[k] for k in ("icao", "callsign", "lat", "lon", "alt", "speed", "heading", "vrate", "msgs")}
                d["cat"] = a.get("cat", "")
                d["squawk"] = a.get("squawk", "")
                d["emg"] = a.get("emg", 0)
                d["mil"] = military(a["icao"], a.get("callsign"))
                d["first"] = round(a.get("first", now))
                d["age"] = round(now - a["seen"], 1)
                if a["lat"] is not None:
                    dist, brg = _distance_bearing(self.home[0], self.home[1], a["lat"], a["lon"])
                    d["dist_km"], d["bearing"] = round(dist, 1), round(brg)
                d["trail"] = [(p[0], p[1], p[3] if len(p) > 3 else None) for p in a["trail"]]
                out.append(d)
        out.sort(key=lambda x: (x.get("dist_km") is None, x.get("dist_km") or 0))
        return out

    def stats(self):
        with self.lock:
            return {"messages": self.total_msgs, "max_range_km": round(self.max_range_km, 1)}
