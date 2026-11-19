"""Air watch: alternates between plane tracking and listening, highlights who is being talked to."""
import sys, time, os
os.environ["CAPTION_FAKE"] = "1"
os.environ["CAPTION_FAKE_TEXT"] = "Speedbird four three one cleared to land"
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import *
eng, cfg, d = make_engine()
col = Collector(eng)
ok = True
def check(name, cond, extra=""):
    global ok
    print(("PASS " if cond else "FAIL ") + name, extra)
    ok = ok and bool(cond)

eng.command({"cmd": "airwatch", "on": True, "freqs": [126.7e6, 5e9, 120.5e6], "adsb_s": 10, "listen_s": 8})
time.sleep(1.5)
check("starts on plane tracking", eng.job == "adsb" and eng.air and eng.air["phase"] == "adsb")
check("bad frequency dropped", eng.air["freqs"] == [126.7e6, 120.5e6])
check("state tells the page", eng.state()["air"]["phase"] == "adsb")
t0 = time.time()
while time.time() - t0 < 16 and eng.job != "listen": time.sleep(0.3)
check("switches to listening on the air channel", eng.job == "listen" and abs(eng.vfo - 126.7e6) < 1 and eng.mode == "am", (eng.job, eng.vfo, eng.mode))
check("captions switched on while listening", eng.cap.on)
check("aircraft still reported while listening", any(e.get("type") == "aircraft" for e in col.events[-40:]) if hasattr(col, "events") else True)
t0 = time.time()
while time.time() - t0 < 14 and eng.job != "adsb": time.sleep(0.3)
check("goes back to tracking planes", eng.job == "adsb")
t0 = time.time()
while time.time() - t0 < 26 and not (eng.job == "listen" and abs(eng.vfo - 120.5e6) < 1): time.sleep(0.3)
check("next listen window uses the next channel", eng.job == "listen" and abs(eng.vfo - 120.5e6) < 1)
# who is being talked to
now = time.time()
with eng.table.lock:
    eng.table.ac["400B01"] = {"icao": "400B01", "callsign": "BAW431", "lat": None, "lon": None, "alt": None, "speed": None,
                              "heading": None, "vrate": None, "msgs": 5, "first": now, "trail": [], "_e": None, "_o": None, "seen": now}
    eng.table.ac["7C6B02"] = {"icao": "7C6B02", "callsign": "JST520", "lat": None, "lon": None, "alt": None, "speed": None,
                              "heading": None, "vrate": None, "msgs": 5, "first": now, "trail": [], "_e": None, "_o": None, "seen": now}
m = eng._match_planes("Speedbird four three one, descend to three thousand")
check("caption matches the right plane", m == [{"icao": "400B01", "callsign": "BAW431"}], m)
check("nobody matched for other talk", eng._match_planes("Easy 999 hold position") == [])
# user action ends it
eng.command({"cmd": "job", "name": "listen"}); time.sleep(0.5)
check("choosing something else ends air watch", eng.air is None and eng.state()["air"] is None)
print("ALL PASS" if ok else "SOME FAILED")
sys.exit(0 if ok else 1)
