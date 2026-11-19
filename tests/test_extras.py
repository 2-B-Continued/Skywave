"""Tests for: satellite auto-record rules, scheduled sound recording, plane coverage, FM-pilot calibration job."""
import sys, time, os, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import *
import numpy as np

eng, cfg, d = make_engine()
col = Collector(eng)
sp = eng.space
ok = True
def check(name, cond, extra=""):
    global ok
    print(("PASS " if cond else "FAIL ") + name, extra)
    ok = ok and bool(cond)

# --- orbit data for ISS and Meteor-M2-4 (epoch near now so passes exist)
tle = """ISS
1 25544U 98067A   26306.51782528  .00002182  00000-0  11606-4 0  2927
2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537
METEOR-M2 4
1 59051U 24039A   26306.50000000  .00000100  00000-0  60000-4 0  9990
2 59051  98.6000 100.0000 0005000  90.0000 270.0000 14.22000000 10000
"""
check("tle added", sp.add_tle_text(tle) == 2)
n = sp.set_auto("meteor-m2-4", 30)
iq = [s for s in sp.schedule if s["sat"] == "meteor-m2-4"]
check("auto-record schedules weather passes as raw data", n > 0 and all(s["kind"] == "iq" and s["max_el"] >= 30 for s in iq), "%d items" % len(iq))
n2 = sp.set_auto("iss", 30)
au = [s for s in sp.schedule if s["sat"] == "iss"]
check("auto-record schedules ISS as sound", all(s["kind"] == "audio" for s in au), "%d items" % len(au))
ov = any(a["start"] < b["end"] and b["start"] < a["end"] for i, a in enumerate(sp.schedule) for b in sp.schedule[i + 1:])
check("no overlapping schedule items (one dongle)", not ov)
check("applying again adds nothing", sp.apply_auto() == 0)
sp.set_auto("iss", 0); sp.set_auto("meteor-m2-4", 0)
check("auto rules off", not sp.auto)
check("custom satellite", sp.add_custom("AO-91", 43017, 145.96e6, "nfm")["id"] == "c43017" and sp.item("c43017") is not None)
check("heading works", sp.heading("meteor-m2-4", time.time()) in ("north", "south"))

# --- scheduled sound recording of a pass
now = time.time()
sp.schedule = []
sp.add_schedule("iss", now + 22, now + 40, 145.8e6, "ISS test", "audio", "nfm", 16000, 55.0)   # start = aos-20 -> starts ~now+2
t0 = time.time()
while time.time() - t0 < 6 and not eng.sched_audio:
    time.sleep(0.3)
check("scheduled sound recording starts", eng.sched_audio is not None)
time.sleep(2)
check("it is recording and following Doppler", eng.rec is not None and eng.doppler is not None)
eng.sched_audio["end"] = time.time() + 1
time.sleep(3.5)
check("it stops by itself", eng.sched_audio is None and eng.rec is None)
files = [f for f in os.listdir(cfg.path_for("recordings")) if f.endswith((".wav", ".mp3"))]
check("a sound file was saved", len(files) == 1, files)

# --- raw recording writes a sidecar and fires the hook
done = []
eng.on_record_done = lambda p, m: done.append((p, m))
eng.command({"cmd": "job", "name": "record", "params": {"freq": 137.1e6, "seconds": 2, "label": "meteor-m2-4", "sat": "meteor-m2-4"}})
t0 = time.time()
while time.time() - t0 < 12 and not done:
    time.sleep(0.3)
check("raw recording finished with hook", bool(done))
if done:
    p, m = done[0]
    check("sidecar written with decode hint", os.path.isfile(p + ".json") and m.get("decode") == "lrpt" and m.get("sat_name"), str(m.get("decode")))

# --- manual stop must not restart the same pass (sound, then raw)
now = time.time()
sp.schedule = []
sp.add_schedule("iss", now + 22, now + 400, 145.8e6, "ISS stop test", "audio", "nfm", 16000, 55.0)
t0 = time.time()
while time.time() - t0 < 6 and not eng.sched_audio:
    time.sleep(0.3)
check("pass sound recording started again", eng.sched_audio is not None)
eng.command({"cmd": "rec_audio", "on": False}); time.sleep(4)
check("manual stop of sound recording sticks", eng.sched_audio is None and eng.rec is None)
now = time.time()
sp.schedule = []
sp.add_schedule("meteor-m2-4", now + 22, now + 400, 137.1e6, "Meteor stop test", "iq", "nfm", 150000, 60.0)
t0 = time.time()
while time.time() - t0 < 6 and eng.job != "record":
    time.sleep(0.3)
check("pass raw recording started", eng.job == "record")
eng.command({"cmd": "job", "name": "listen"}); time.sleep(4)
check("manual stop of raw recording sticks", eng.job == "listen")
sp.schedule = []

# --- plane coverage
time.sleep(2); eng.command({"cmd": "job", "name": "adsb"}); time.sleep(1); print("JOB", eng.job)
t0 = time.time()
while time.time() - t0 < 25 and not any(eng.table.cover):
    time.sleep(0.5)
cov = eng.table.cover; print("DBG", eng.job, eng.error, len(eng.table.ac), eng.cfg["lat"], eng.cfg["lon"])
check("plane coverage fills in", sum(1 for x in cov if x > 0) >= 1, str([round(x) for x in cov if x][:6]))
eng._save_cover(time.time())
check("coverage saved", os.path.isfile(cfg.path_for("coverage.json")))
eng.command({"cmd": "job", "name": "listen"}); time.sleep(1.5)
eng.command({"cmd": "reset_cover"}); time.sleep(0.8)
check("coverage reset", sum(eng.table.cover) == 0)

# --- calibration job (sim has no real FM pilot -> a clean 'no result'; then force a fake pilot to test the success path)
eng.command({"cmd": "job", "name": "calibrate", "params": {"stations": [98.1e6, 100.1e6]}})
e = col.wait_for("calibrate_done", 30)
check("calibration finishes without a pilot", e is not None and e["ok"] is False and e["stations"], e and e["text"][:60])
import dsp
orig = dsp.fm_pilot
dsp.fm_pilot = lambda iq, fs, off: (18999.5, 60.0)
eng.command({"cmd": "job", "name": "calibrate", "params": {"stations": [98.1e6, 100.1e6, 104.9e6]}})
e = col.wait_for("calibrate_done", 30, lambda x: x.get("ok"))
dsp.fm_pilot = orig
check("calibration success path", e is not None and e["ok"] and abs(e["residual"] - 26.3) < 1.0 and e["suggested"] == cfg["ppm"] + round(26.3), e and e["text"])
eng.stop() if hasattr(eng, "stop") else None
print("ALL PASS" if ok else "SOME FAILED")
sys.exit(0 if ok else 1)
