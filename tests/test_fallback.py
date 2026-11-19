"""If the sensor decoder can't start right after plane tracking, listening must still work (sample rate reset)."""
import sys, time, os, shutil
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import *
eng, cfg, d = make_engine(); col = Collector(eng)
ok = True
def check(n, c, extra=""):
    global ok; print(("PASS " if c else "FAIL ") + n, extra); ok = ok and bool(c)
eng.command({"cmd": "job", "name": "adsb"}); time.sleep(2)
eng.command({"cmd": "job", "name": "ism"}); time.sleep(3)
eng.command({"cmd": "job", "name": "listen"}); eng.command({"cmd": "tune", "freq": 446.00625e6}); time.sleep(3)
check("listening works afterwards", eng.job == "listen" and eng.fs == int(cfg["sample_rate"]) and not eng.error, (eng.job, eng.fs, eng.error))
errs = [e for e in col.events if e.get("type") == "notice" and e.get("level") == "error" and "sample rate" in e.get("text", "")] if hasattr(col, "events") else []
check("no sample-rate errors", not errs, errs)
print("ALL PASS" if ok else "SOME FAILED"); sys.exit(0 if ok else 1)
