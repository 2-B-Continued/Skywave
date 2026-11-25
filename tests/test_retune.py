"""Retuning: old sound waiting for a listener is dropped at the new-station mark, the old settling time is replaced,
and samples from the old frequency waiting on the radio connection are skipped rather than waited out."""
import sys, os, json, tempfile, queue
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import engine, config
ok = True
def check(n, c, x=""):
    global ok; print(("PASS " if c else "FAIL ") + n, x if not c else ""); ok = ok and bool(c)

c = engine.AudioClient()
for _ in range(5):
    c.put(b"\x02" + b"\x00" * 1920)
c.put(engine.NEW_STATION)
c.put(b"\x02" + b"\x01" * 1920)
got = []
while True:
    try:
        got.append(c.take(timeout=0.01))
    except queue.Empty:
        break
check("old sound queued for a listener is dropped at the mark", got[0] == engine.NEW_STATION and len(got) == 2 and got[1][1:2] == b"\x01", [g[:2] for g in got])

d = tempfile.mkdtemp()
p = os.path.join(d, "config.json")
json.dump({"settle_s": 0.25}, open(p, "w"))
os.environ.pop("SETTLE_S", None)
os.environ["DATA_DIR"] = d
cfg = config.Config()
check("the old saved settling time becomes the new default", cfg["settle_s"] == config.DEFAULTS["settle_s"] < 0.1, cfg["settle_s"])

class Src:
    fixed = False
    def __init__(self): self.skipped = None; self.freq = None
    def set_freq(self, hz): self.freq = hz
    def backlog(self): return 123456
    def skip(self, n): self.skipped = n; return True
class E:
    cfg = {"settle_s": 0.05, "hf_mode": "off"}
    def _apply_hf(self): pass
    def _fail(self, m): raise AssertionError(m)
e = E(); e.src = Src()
engine.Engine._retune(e, 98.5e6)
check("samples from the old frequency are skipped at once", e.src.skipped == 123456 and e.src.freq == 98.5e6)
print("ALL PASS" if ok else "SOME FAILED"); sys.exit(0 if ok else 1)
