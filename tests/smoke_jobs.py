import sys, time, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import *
import numpy as np

eng, cfg, d = make_engine()
col = Collector(eng)
def banner(s): print("\n=== " + s)

banner("1. FM band sweep (find stations)")
eng.command({"cmd": "tune", "freq": 98.1e6, "mode": "wfm"})
time.sleep(1)
eng.command({"cmd": "sweep", "start": 87.5e6, "stop": 108.0e6, "mode": "wfm", "purpose": "find"})
e = col.wait_for("sweep", 40, lambda e: e.get("done"))
if e: print("done; peaks:", [(p["f"]/1e6, p["db"]) for p in e["peaks"]])
else: print("NO SWEEP RESULT; events:", [x["type"] for x in col.events][-10:], col.find("notice"))

banner("2. Seek up from 96.9")
eng.command({"cmd": "tune", "freq": 96.9e6, "mode": "wfm"}); time.sleep(1.5)
eng.command({"cmd": "seek", "dir": 1})
e = col.wait_for("seek_done", 40)
print("seek result", e, "vfo now", eng.vfo/1e6)

banner("3. Scanner: PMR446 bank for 25 s (simulated walkie-talkies bursting)")
n0 = len(col.events)
eng.command({"cmd": "scan", "action": "start", "bank": "pmr446"})
t0 = time.time()
hits = []
while time.time() - t0 < 25:
    time.sleep(0.5)
for e in col.events[n0:]:
    if e["type"] in ("scan_hit", "scan_end", "scan_started"):
        hits.append((e["type"], e.get("f") or e.get("name"), e.get("label"), e.get("snr") or e.get("dur")))
for h in hits[:14]: print(h)
st = col.last_state(); print("scan state", st.get("scan", {}).get("state"), "windows", st.get("scan", {}).get("windows"))
eng.command({"cmd": "scan", "action": "stop"}); time.sleep(0.6)

banner("4. APRS decode at 144.800 for 30 s")
eng.command({"cmd": "tune", "freq": 144.800e6, "mode": "nfm"})
eng.command({"cmd": "aprs", "on": True})
e = col.wait_for("aprs", 35)
print("APRS packet:", {k: e[k] for k in ("from", "lat", "lon", "comment") if k in e} if e else None)

banner("5. Airband sweep list (scanner windows) quick start/stop")
eng.command({"cmd": "scan", "action": "start", "bank": "airband"}); time.sleep(4)
st = col.last_state(); print("airband scan windows", st["scan"]["windows"], "channels", st["scan"]["channels"], "state", st["scan"]["state"])
eng.command({"cmd": "scan", "action": "stop"}); time.sleep(0.5)
eng.stop(); eng.join(5)
print("\nnotices:", [(n["level"], n["text"]) for n in col.find("notice")])
