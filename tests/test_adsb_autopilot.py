"""Tests for decoding autopilot targets (type code 29) and airspeed (type code 19, subtype 3)."""
import os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import adsb
ok = True
def chk(n, c, x=""):
    global ok; print("ok  " if c else "FAIL", n, x); ok &= bool(c)

t = adsb.AircraftTable(51.5, -0.1)
t.update(adsb.encode_position(0x4CA123, 24000, 51.6, -0.3, 0), now=100.0)
t.update(adsb.encode_target_state(0x4CA123, sel_alt_ft=36000, fms=True, baro_hpa=1013.6, sel_hdg=275, modes=("ap", "vnav", "lnav", "tcas")), now=100.5)
t.update(adsb.encode_airspeed(0x4CA123, 290, 270, vrate_fpm=1500), now=101.0)
a = {x["icao"]: x for x in t.snapshot(now=101.5)}["4CA123"]
chk("selected altitude", a.get("sel_alt") == 36000, a.get("sel_alt"))
chk("altitude comes from the flight management system", a.get("sel_src") == "fms", a.get("sel_src"))
chk("pressure setting to 0.8 hPa", a.get("baro") is not None and abs(a["baro"] - 1013.6) <= 0.8, a.get("baro"))
chk("selected heading to 1 degree", a.get("sel_hdg") is not None and abs(a["sel_hdg"] - 275) <= 1, a.get("sel_hdg"))
chk("modes", set(a.get("ap") or []) >= {"ap", "vnav", "lnav"}, a.get("ap"))
chk("collision avoidance on", a.get("tcas") is True, a.get("tcas"))
chk("indicated airspeed", a.get("ias") == 290, a.get("ias"))
chk("nose heading", a.get("hdg_mag") is not None and abs(a["hdg_mag"] - 270) <= 1, a.get("hdg_mag"))

b = {x["icao"]: x for x in t.snapshot(now=200.0)}.get("4CA123") or {}
chk("targets are dropped once they go stale", b.get("sel_alt") is None, b.get("sel_alt"))

print("ALL PASS" if ok else "SOME FAILED"); sys.exit(0 if ok else 1)
