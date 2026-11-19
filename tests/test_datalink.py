"""Aircraft messages, pagers and weather balloons: the decoders on their own (clean, noisy, flipped), then end to end
through the engine against the simulator's transmitters."""
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import make_engine, Collector  # noqa: E402
import datalink as D  # noqa: E402

ok = True


def check(name, cond, extra=""):
    global ok
    print(("PASS " if cond else "FAIL ") + name, extra)
    ok = ok and bool(cond)


rng = np.random.default_rng(7)
FS = 48000


def fm(a, dev, noise):
    ph = np.cumsum(2 * np.pi * (500.0 + dev * a) / FS)
    return (np.exp(1j * ph) + noise * (rng.standard_normal(len(ph)) + 1j * rng.standard_normal(len(ph)))).astype(np.complex64)


def run(dec, z):
    out = []
    for i in range(0, len(z), 4800):
        out += dec.process(z[i:i + 4800])
    return out


# --- ACARS
msg = D.acars_message("G-EUPT", "H1", "POS N00000E00000,,033200", flight="BA0001")
a = np.concatenate([np.zeros(9600), D.acars_audio(msg), np.zeros(9600)]).astype(np.float32)
for inv in (1, -1):
    z = ((1 + 0.8 * inv * a) * np.exp(2j * np.pi * 150 * np.arange(len(a)) / FS)).astype(np.complex64)
    z += (0.08 * (rng.standard_normal(len(z)) + 1j * rng.standard_normal(len(z)))).astype(np.complex64)
    o = run(D.Acars(131.55e6), z)
    check("ACARS decodes (polarity %d)" % inv, len(o) == 1 and o[0]["reg"] == "G-EUPT" and o[0]["flight"] == "BA0001" and o[0]["label"] == "H1" and o[0]["checked"], str(o[:1]))
o = run(D.Acars(131.55e6), (0.3 * (rng.standard_normal(FS * 5) + 1j * rng.standard_normal(FS * 5))).astype(np.complex64))
check("ACARS stays quiet on noise", o == [], str(o))

# --- POCSAG
pages = [(1234567, 3, "FIRE CALL STN 12 RESPOND"), (200, 0, "0412555123")]
for baud in (512, 1200, 2400):
    o = run(D.Pocsag(148e6), fm(-D.nrz_audio(D.pocsag_bits(pages), baud), 4500, 0.1))
    got = [(m["addr"], m["kind"], m["text"]) for m in o]
    check("POCSAG %d baud" % baud, got == [(1234567, "alpha", "FIRE CALL STN 12 RESPOND"), (200, "numeric", "0412555123")], str(got))
cw = D.pocsag_codeword(0x12345)
check("POCSAG repairs one wrong bit", D._cw_fix(cw ^ (1 << 17)) == cw)
o = run(D.Pocsag(148e6), (0.3 * (rng.standard_normal(FS * 5) + 1j * rng.standard_normal(FS * 5))).astype(np.complex64))
check("POCSAG stays quiet on noise", o == [], str(o))

a1 = D.parse_flex("FLEX|2024-01-01 10:00:00|1600/2/K/A|07.120|001234567|ALN|Turn off the oven", 157e6)
a2 = D.parse_flex("FLEX: 2024-01-01 10:00:00 3200/4/C/A 07.120 [000123456] NUM 0412 555 123", 157e6)
check("FLEX lines from multimon-ng (both layouts)", a1 and a1["addr"] == 1234567 and a1["text"] == "Turn off the oven" and a2 and a2["addr"] == 123456 and a2["kind"] == "numeric" and a2["baud"] == 3200, str((a1, a2)))

# --- RS41
fr = D.rs41_frame("S1234567", 77, -34.00, 18.39, 12345.6, ve=12.0, vn=-5.0, vu=5.2)
r = D.rs41_parse(bytes(fr))
check("RS41 frame parses", r and r["serial"] == "S1234567" and abs(r["lat"] + 34.00) < 1e-5 and abs(r["alt"] - 12345.6) < 0.5 and abs(r["climb"] - 5.2) < 0.05, str(r))
bad = bytearray(fr)
bad[0x120] ^= 0xFF
r2 = D.rs41_parse(bytes(bad))
check("RS41 rejects a damaged position block", r2 is not None and "lat" not in r2)
a = np.concatenate([np.zeros(2400), D.nrz_audio([1, 0] * 100 + D.rs41_bits(fr), 4800), np.zeros(2400)])
for pol in (1, -1):
    o = run(D.Rs41(401.5e6), fm(pol * a, 2400, 0.12))
    check("RS41 over the air (polarity %d)" % pol, len(o) == 1 and o[0]["serial"] == "S1234567", str(o[:1]))
x, y, zz = D.geo_to_ecef(-33.95, 18.4, 1000.0)
la, lo, al = D.ecef_to_geo(x, y, zz)
check("ECEF round trip", abs(la + 33.95) < 1e-7 and abs(lo - 18.4) < 1e-7 and abs(al - 1000) < 0.01)
tr = D.SondeTracker()
home = (-33.92, 18.42, 30.0)
for i, (alt, vu) in enumerate([(20000, 5), (25000, 5), (24000, -15), (20000, -15)]):
    tr.add({"serial": "S1", "t": 1000 + i * 10, "freq": 401.5e6, "lat": -33.95, "lon": 18.5, "alt": alt, "climb": vu, "ve": 10.0, "vn": 0.0, "speed": 10, "heading": 90}, home)
s = tr.public()[0]
check("tracker spots the burst and estimates a landing", s["burst"] and s["land"] and s["land"]["lon"] > 18.5 and s["max_alt"] == 25000, str(s.get("land")))
check("GPX export", "<trkpt" in D.gpx(tr.sondes["S1"]))

# --- end to end through the engine and the simulator
eng, cfg, d = make_engine(env={"LAT": "-33.92", "LON": "18.42"})
col = Collector(eng)
time.sleep(1.0)
eng.command({"cmd": "tap", "name": "acars"})
e = col.wait_for("dl_msg", 25, lambda m: m.get("kind") == "acars")
check("engine: aircraft message from the simulator", e is not None and e.get("reg", "") in ("G-EUPT", "N512UA", "D-AIMA", "F-HPJA"), str(e)[:160])
eng.command({"cmd": "tap", "name": "pager", "freq": 148.6375e6})
e = col.wait_for("dl_msg", 30, lambda m: m.get("kind") == "pager")
check("engine: pager message from the simulator", e is not None and e.get("addr") in (1234567, 200, 77001), str(e)[:160])
eng.command({"cmd": "tap", "name": "sonde"})
e = col.wait_for("sondes", 45, lambda m: m.get("list"))
check("engine: balloon found by scanning 400-406 MHz", e is not None and e["list"][0]["serial"] == "S0123456" and e["list"][0].get("lat") is not None, str(e)[:200] if e else "")
eng.command({"cmd": "tap"})
st = None
time.sleep(1.0)
for ev in reversed(col.events):
    if ev.get("type") == "tap_state":
        st = ev
        break
check("tap stops cleanly", st is not None and st.get("name") is None)
eng.stop()
eng.join(5)
print("ALL PASS" if ok else "SOME FAILED")
sys.exit(0 if ok else 1)
