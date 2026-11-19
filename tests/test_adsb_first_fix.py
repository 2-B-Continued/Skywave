import os, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import adsb
ok = True
def chk(n, c, x=""):
    global ok; print("ok  " if c else "FAIL", n, x); ok &= bool(c)
home = (-33.92, 18.42)
t = adsb.AircraftTable(*home)
la, lo = -33.27, 17.6                                   # ~100 km from home
f = adsb.encode_position(0xABC123, 30000, la, lo, 0)
t.update(f, now=100.0)
snap = {a["icao"]: a for a in t.snapshot(now=101.0)}
a = snap.get("ABC123")
chk("one frame gives a position straight away", a and a["lat"] is not None, a and (a["lat"], a["lon"]))
chk("position is right to ~1 km", a and abs(a["lat"] - la) < 0.02 and abs(a["lon"] - lo) < 0.02)
# the proper even/odd pair then replaces it, even if the first guess was off
f2 = adsb.encode_position(0xABC123, 30000, la, lo, 1)
t.update(f2, now=102.0)
a = {x["icao"]: x for x in t.snapshot(now=103.0)}["ABC123"]
chk("pair confirms position", abs(a["lat"] - la) < 0.001 and abs(a["lon"] - lo) < 0.001, (a["lat"], a["lon"]))
# an aircraft far outside range is not placed from one frame
t2 = adsb.AircraftTable(*home)
# a single frame repeats every few degrees, so the far point is chosen so its repeat near home is also beyond 300 km
far = adsb.encode_position(0xDEF456, 35000, 12.0, 100.0, 0)
t2.update(far, now=10.0)
b = {x["icao"]: x for x in t2.snapshot(now=11.0)}.get("DEF456")
chk("far-away aircraft not guessed", b is None or b["lat"] is None, b and b["lat"])
print("PASS" if ok else "FAIL"); sys.exit(0 if ok else 1)
