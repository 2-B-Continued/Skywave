"""Timed recordings on any frequency + captions in the engine (simulator)."""
import sys, time, os
os.environ["CAPTION_FAKE"] = "1"
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from harness import *
import timers as T

eng, cfg, d = make_engine()
col = Collector(eng)
ok = True
def check(name, cond, extra=""):
    global ok
    print(("PASS " if cond else "FAIL ") + name, extra)
    ok = ok and bool(cond)

# store rules
ts = T.TimerStore(os.path.join(d, "t2.json"))
now = time.time()
for bad in (dict(freq=5e9, mode="nfm", start=now + 60, duration=60), dict(freq=146.5e6, mode="zzz", start=now + 60, duration=60),
            dict(freq=146.5e6, mode="nfm", start=now + 60, duration=1), dict(freq=146.5e6, mode="nfm", start=now - 9999, duration=60)):
    try:
        ts.add(**bad); check("bad timer rejected %s" % bad["mode"], False)
    except ValueError:
        check("bad timer rejected", True)
r = ts.add(146.5e6, "nfm", now + 3600, 600, "daily test", "text", "daily")
check("repeat advances", (T._next_start(r["start"], "daily", r["start"]) - r["start"]) in (86400, 86400 - 3600, 86400 + 3600))
wk = T._next_start(time.mktime((2026, 11, 6, 19, 0, 0, 0, 0, -1)), "weekdays", time.mktime((2026, 11, 6, 20, 0, 0, 0, 0, -1)))
check("weekdays skip the weekend", time.localtime(wk).tm_wday == 0, time.strftime("%a", time.localtime(wk)))

# run one through the engine: the simulator has a CB signal on PMR446 ch1 (446.00625) and ch7
eng.timers.items = []
eng.cfg.v["audio_format"] = "mp3"
eng.cfg.v["captions"] = True
it = eng.timers.add(446.00625e6, "nfm", time.time() + 1, 14, "PMR446 test", "both", "none")
t0 = time.time()
while time.time() - t0 < 8 and not eng.sched_audio: time.sleep(0.2)
check("timer starts by itself", eng.sched_audio is not None and eng.sched_audio.get("timer") == it["id"])
check("it is recording sound and captioning", eng.rec is not None and eng.cap.on and eng.cap.save)
t0 = time.time()
while time.time() - t0 < 20 and eng.sched_audio: time.sleep(0.3)
check("timer ends by itself and is removed", eng.sched_audio is None and eng.timers.public() == [])
check("captions put back to off", not eng.cap.on)
rec = [f for f in os.listdir(cfg.path_for("recordings"))]
check("an MP3 was saved", any(f.endswith(".mp3") for f in rec), rec)
tx = os.listdir(cfg.path_for("transcripts"))
check("a transcript was saved", any(f.endswith(".txt") for f in tx), tx)
if tx:
    txt = open(os.path.join(cfg.path_for("transcripts"), tx[0])).read()
    check("transcript content", "Speedbird" in txt and "446.006" in txt, txt[:200])

# timer on an FM station: text request is refused politely, no transcript
eng.timers.add(100.0e6, "wfm", time.time() + 1, 12, "fm", "text", "none")
before = set(os.listdir(cfg.path_for("transcripts")))
t0 = time.time()
while time.time() - t0 < 6 and not eng.sched_audio: time.sleep(0.2)
time.sleep(1)
check("no captions on a broadcast station", not eng.cap.allowed)
eng.command({"cmd": "rec_audio", "on": False}); time.sleep(2)
check("stopping a timer by hand ends it", eng.sched_audio is None and eng.timers.public() == [])
check("no transcript for FM", set(os.listdir(cfg.path_for("transcripts"))) == before)
print("ALL PASS" if ok else "SOME FAILED")
sys.exit(0 if ok else 1)
