import sys, time, os, stat
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import *
import numpy as np

# a stand-in for rtl_433 that prints a few JSON sensor lines
fake433 = "/tmp/fake_rtl_433.py"
open(fake433, "w").write('''#!/usr/bin/env python3
import sys, time, json
for i in range(6):
    print(json.dumps({"time": "2026-10-18 10:00:0%d" % i, "model": "Acurite-Tower", "id": 1234, "channel": "A",
                      "temperature_C": 21.5 + i * 0.1, "humidity": 55, "battery_ok": 1}), flush=True)
    print(json.dumps({"time": "2026-10-18 10:00:0%d" % i, "model": "LaCrosse-TX141THBv2", "id": 77, "temperature_C": 14.2,
                      "humidity": 71, "battery_ok": 1}), flush=True)
    time.sleep(0.4)
time.sleep(30)
''')
os.chmod(fake433, 0o755)
os.environ["RTL433_BIN"] = "python3 " + fake433

eng, cfg, d = make_engine()
col = Collector(eng)
def banner(s): print("\n=== " + s)

banner("1. FM sweep (refined peaks)")
eng.command({"cmd": "tune", "freq": 98.1e6, "mode": "wfm"}); time.sleep(1)
eng.command({"cmd": "sweep", "start": 87.5e6, "stop": 108.0e6, "mode": "wfm", "purpose": "find"})
e = col.wait_for("sweep", 40, lambda e: e.get("done"))
print("peaks:", [(round(p["f"]/1e6, 2), p["db"]) for p in e["peaks"]], "(sim stations: 88.1 96.9 100.0 104.1 106.5)")

banner("2. ADS-B plane tracking (simulated aircraft) 12 s")
eng.command({"cmd": "job", "name": "adsb"})
time.sleep(12)
ac = col.find("aircraft")
if ac:
    last = ac[-1]
    print("aircraft in last update:", len(last["list"]), "stats", last["stats"])
    for a in last["list"][:5]:
        print("  ", a["icao"], repr(a["callsign"]), "alt", a["alt"], "spd", a["speed"], "hdg", a["heading"], "pos", a.get("lat"), a.get("lon"), "dist", a.get("dist_km"))
else:
    print("NO AIRCRAFT EVENTS", col.find("notice"), eng.error)
st = col.last_state(); print("job", st["job"], "fs", st["fs"], "center", st["center"]/1e6)

banner("3. Back to listen, then health check")
eng.command({"cmd": "tune", "freq": 100.0e6, "mode": "wfm"}); time.sleep(2)
st = col.last_state(); print("job", st["job"], "center", st["center"]/1e6)
eng.command({"cmd": "job", "name": "health"})
e = col.wait_for("health_done", 40)
if e:
    r = e["report"]; print("verdict:", r["verdict"], "| level", r["level"]); print("details", r["details"]); print("results", len(r["results"]))
else:
    print("NO HEALTH RESULT", col.find("health_progress")[-1:], col.find("notice"))

banner("4. Sensors via fake rtl_433")
eng.command({"cmd": "job", "name": "ism", "params": {"freq": 433.92e6}})
time.sleep(5)
s = col.find("sensor")
print("sensor events:", len(s)); [print("  ", x["model"], x.get("id"), x.get("temperature_C"), x.get("humidity")) for x in s[-3:]]
eng.command({"cmd": "tune", "freq": 100.0e6, "mode": "wfm"}); time.sleep(2)
print("after leaving sensors: job", col.last_state()["job"])

banner("5. Baseband record 4 s + audio record")
eng.command({"cmd": "job", "name": "record", "params": {"freq": 137.9e6, "seconds": 4, "label": "Meteor"}})
e = col.wait_for("record_done", 20)
print("record_done", e, [ (f, os.path.getsize(os.path.join(d, "recordings", f))) for f in os.listdir(os.path.join(d, "recordings"))])
eng.command({"cmd": "tune", "freq": 100.0e6, "mode": "wfm"}); time.sleep(1.5)
eng.command({"cmd": "rec_audio", "on": True}); time.sleep(3); eng.command({"cmd": "rec_audio", "on": False}); time.sleep(0.6)
print("files:", [(f, os.path.getsize(os.path.join(d, "recordings", f))) for f in sorted(os.listdir(os.path.join(d, "recordings")))])
eng.stop(); eng.join(5)
print("\nnotices:", [(n["level"], n["text"]) for n in col.find("notice")])
