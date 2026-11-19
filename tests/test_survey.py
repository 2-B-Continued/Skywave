"""Survey: repeated sweeps build a ranked list of signals; lock-on (watch) streams a zoomed spectrum; leaving returns to listening."""
import sys, time, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import *
eng, cfg, d = make_engine(); col = Collector(eng)
ok = True
def check(n, c, extra=""):
    global ok; print(("PASS " if c else "FAIL ") + n, extra); ok = ok and bool(c)
eng.command({"cmd": "sweep", "start": 86e6, "stop": 92e6, "mode": "nfm", "thr": 8, "purpose": "survey"})
t = time.time()
while time.time() - t < 90 and len([e for e in col.events if e.get("type") == "survey"]) < 2:
    time.sleep(0.5)
sv = [e for e in col.events if e.get("type") == "survey"]
check("survey passes published", len(sv) >= 2, len(sv))
check("progress events", any(e.get("type") == "survey_progress" for e in col.events))
sig = sv[-1]["signals"] if sv else []
check("signals found", len(sig) > 0, sig[:3])
check("repeat sightings counted", any(s["hits"] >= 2 for s in sig), [(s["f"], s["hits"], s["passes"]) for s in sig[:4]])
check("job still sweep", eng.job == "sweep")
if sig:
    f = sig[0]["f"]
    eng.command({"cmd": "sweep", "start": f - 1, "stop": f + 1, "mode": "nfm", "purpose": "watch"})
    time.sleep(4)
    w = [e for e in col.events if e.get("type") == "watch"]
    check("watch events", len(w) >= 3, len(w))
    check("watch has history", w and len(w[-1]["hist"]) >= 3)
eng.command({"cmd": "job", "name": "listen"}); time.sleep(1.5)
check("back to listen", eng.job == "listen" and eng.sweep is None, eng.job)
print("ALL PASS" if ok else "SOME FAILED"); sys.exit(0 if ok else 1)
