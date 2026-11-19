import numpy as np, sys, os
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import morse
FS = 48000
CODE = {v: k for k, v in morse.TABLE.items()}

def keyed(text, wpm, tone=700, snr_db=15, lead=1.6, tail=3.5, seed=1, jitter=0.0):
    rng = np.random.default_rng(seed)
    u = 1.2 / wpm; s = []
    def tone_(d): t = np.arange(int(d * FS)) / FS; env = np.minimum(1, np.minimum(t, d - t) / 0.004); return np.sin(2 * np.pi * tone * t) * env
    def sil(d): return np.zeros(int(d * FS))
    j = lambda: 1 + rng.uniform(-jitter, jitter)
    s.append(sil(lead))
    for w in text.split():
        for ch in w:
            for k, sym in enumerate(CODE[ch]):
                s.append(tone_(u * (1 if sym == "." else 3) * j()))
                if k < len(CODE[ch]) - 1: s.append(sil(u))
            s.append(sil(3 * u))
        s.append(sil(4 * u))
    s.append(sil(tail))
    x = np.concatenate(s); n = rng.normal(0, 10 ** (-snr_db / 20) / 1.0, len(x)) * 0.7
    return (x * 0.7 + n).astype(np.float32)

def run(x, chunk=480):
    d = morse.MorseDecoder(); out = []
    for i in range(0, len(x), chunk): out += d.process(x[i:i + chunk], now=i / FS)
    return out

ok = True
for text, wpm, tone, snr, jit in [("CQ CQ DE N0CALL", 18, 700, 15, 0.0), ("W1AW", 12, 600, 12, 0.1), ("TST", 8, 1020, 10, 0.05), ("TEST 73", 25, 800, 12, 0.08)]:
    r = run(keyed(text, wpm, tone, snr, jitter=jit))
    got = r[0]["text"] if r else None
    good = got == text and abs(r[0]["wpm"] - wpm) <= max(2, wpm * 0.2)
    print("%-16s %2d wpm tone %4d snr %2d ->" % (text, wpm, tone, snr), got, r[0]["wpm"] if r else "", "OK" if good else "FAIL")
    ok &= good
rng = np.random.default_rng(5)
noise = rng.normal(0, 0.3, FS * 20).astype(np.float32)
r = run(noise); print("white noise ->", r); ok &= not r
t = np.arange(FS * 12) / FS
r = run((np.sin(2 * np.pi * 700 * t) * 0.5).astype(np.float32)); print("steady tone ->", r); ok &= not r
# speech-like: modulated random bursts of varying pitch
sp = np.zeros(FS * 12, dtype=np.float32)
for i in range(60):
    a = int(rng.uniform(0, 11) * FS); d = int(rng.uniform(0.05, 0.4) * FS); f = rng.uniform(150, 2500)
    tt = np.arange(d) / FS; sp[a:a + d] += (np.sin(2 * np.pi * f * tt) * 0.3).astype(np.float32)[:len(sp[a:a + d])]
r = run(sp + rng.normal(0, 0.05, len(sp)).astype(np.float32)); print("speech-like ->", r); ok &= not r
print("relevant:", morse.relevant(14.05e6, "usb"), morse.relevant(100e6, "wfm"), morse.relevant(146.5e6, "nfm"), morse.relevant(7.1e6, "cw"), morse.relevant(113.0e6, "am"))
ok &= morse.relevant(14.05e6, "usb") and not morse.relevant(100e6, "wfm") and morse.relevant(146.5e6, "nfm") and morse.relevant(7.1e6, "cw") and morse.relevant(113e6, "am")
ok &= morse.relevant(8.5e6, "usb") and not morse.relevant(9.6e6, "am") and not morse.relevant(476.5e6, "nfm")   # HF utility yes; shortwave broadcasting and walkie-talkies no
print("decoder", "PASS" if ok else "FAIL")

# --- engine hook: audio in, caption item out (stubbed engine)
import types, engine, time as _t
items = []
stub = types.SimpleNamespace(cfg={"morse": True}, vfo=7.03e6, mode="cw", morse=morse.MorseDecoder(), _morse_f=None, morse_force=None, morse_on=False,
                             cap=types.SimpleNamespace(add_external=items.append))
x = keyed("CQ DE N0CALL", 15)
_t_real = _t.time
for i in range(0, len(x), 480): engine.Engine._morse_step(stub, x[i:i + 480], True)
print("engine hook ->", items[0]["text"] if items else None, items[0].get("kind") if items else "")
good = bool(items) and items[0]["text"] == "CQ DE N0CALL" and items[0]["kind"] == "morse"
stub2 = types.SimpleNamespace(cfg={"morse": True}, vfo=100e6, mode="wfm", morse=morse.MorseDecoder(), _morse_f=None, morse_force=None, morse_on=False, cap=types.SimpleNamespace(add_external=items.append))
n = len(items); engine.Engine._morse_step(stub2, x[:4800], True); good &= len(items) == n
print("engine hook", "PASS" if good else "FAIL"); sys.exit(0 if good and ok else 1)
