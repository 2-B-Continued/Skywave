import os, sys, time, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
os.environ["CAPTION_FAKE"] = "1"
import numpy as np
import captions as C

fails = []
def check(n, ok, extra=""):
    print(("PASS " if ok else "FAIL ") + n, extra if not ok else "")
    if not ok: fails.append(n)

# which bands are allowed
check("FM broadcast not captioned", not C.caption_allowed(100.0e6, "wfm"))
check("AM broadcast not captioned", not C.caption_allowed(1269e3, "am"))
check("shortwave broadcast not captioned", not C.caption_allowed(9.5e6, "am"))
check("walkie-talkie captioned", C.caption_allowed(446.00625e6, "nfm"))
check("airband captioned", C.caption_allowed(126.7e6, "am"))
check("marine captioned", C.caption_allowed(156.8e6, "nfm"))
check("2 m ham captioned", C.caption_allowed(146.5e6, "nfm"))

# text cleaning
check("hallucination removed", C.clean_text("Thank you.") == "")
check("repeats removed", C.clean_text("la la la la la la") == "")
check("normal text kept", C.clean_text("  Speedbird  431 cleared ") == "Speedbird 431 cleared")

# callsign matching
cs = ["BAW431", "EZY520", "UAL888", "GABCD", "RYR64"]
check("telephony words", C.match_callsigns("Speedbird four three one cleared to land", cs) == ["BAW431"])
check("digits", C.match_callsigns("Easy 520 contact tower", cs) == ["EZY520"])
check("wrong number no match", C.match_callsigns("Speedbird four three two", cs) == [])
check("ryanair", C.match_callsigns("Ryanair six four descend", cs) == ["RYR64"])
check("phonetic registration", C.match_callsigns("Golf Alpha Bravo Charlie Delta turn left", cs) == ["GABCD"])
check("registration with a dash", C.match_callsigns("G-ABCD call tower", cs) == ["GABCD"])
check("last three letters", C.match_callsigns("Bravo Charlie Delta hold short", cs) == ["GABCD"])

# segmenter -> worker -> events
class Cfg(dict):
    def path_for(self, n): return os.path.join(self["data_dir"], n)
d = tempfile.mkdtemp(); os.makedirs(os.path.join(d, "transcripts"))
cfg = Cfg(data_dir=d, caption_model="base.en")
ev = []
cap = C.Captioner(cfg, lambda typ, **k: ev.append((typ, k)))
cap.set_context(446.00625e6, "nfm", "PMR446 channel 1")
cap.set_on(True, save=True)
tone = (np.random.randn(4800) * 0.2).astype(np.float32)
for i in range(30):            # 3 s of "voice"
    cap.feed(tone, 20.0, 8.0)
for i in range(20):            # 2 s of nothing
    cap.feed(tone * 0, 0.0, 8.0); time.sleep(0.06)
t0 = time.time()
while time.time() - t0 < 5 and not any(e[0] == "caption" and not e[1].get("partial") for e in ev): time.sleep(0.1)
caps = [e[1] for e in ev if e[0] == "caption" and not e[1].get("partial")]
check("a caption is produced after the transmission", len(caps) == 1 and "Speedbird" in caps[0]["text"], caps)
check("caption knows the channel", caps and caps[0]["label"] == "PMR446 channel 1")
cap.set_on(False)
files = os.listdir(os.path.join(d, "transcripts"))
check("transcript text file written", len(files) == 1 and files[0].endswith(".txt"), files)
txt = open(os.path.join(d, "transcripts", files[0])).read() if files else ""
check("transcript has the line", "Speedbird four three one" in txt and "446.006" in txt, txt)
# disallowed band: nothing happens
ev.clear(); cap.set_context(100.0e6, "wfm", "FM"); cap.set_on(True)
for i in range(30): cap.feed(tone, 20.0, 8.0)
for i in range(20): cap.feed(tone * 0, 0.0, 8.0)
time.sleep(1)
check("no caption on FM radio", not any(e[0] == "caption" for e in ev))

# ---- live captioning: people talk with no gap between them. Words must appear while they talk and the text must come in pieces, not one dump.
ev.clear(); os.environ["CAPTION_FAKE_TEXT"] = "alpha bravo charlie delta echo foxtrot|golf hotel india juliet kilo lima"
cap.backend.phrases = os.environ["CAPTION_FAKE_TEXT"].split("|"); cap.backend.n = 0
cap.set_context(446.00625e6, "nfm", "PMR446 channel 1"); cap.set_on(True)
chunk = (np.random.randn(4800) * 0.2).astype(np.float32); t0 = time.time(); first_live = None
for i in range(110):           # 11 s of continuous voice, never a gap
    cap.feed(chunk, 20.0, 8.0); time.sleep(0.1)
    if first_live is None and any(e[0] == "caption" for e in ev): first_live = time.time() - t0
time.sleep(1.0)
live = [e[1] for e in ev if e[0] == "caption" and e[1].get("partial")]
fin = [e[1] for e in ev if e[0] == "caption" and not e[1].get("partial")]
check("words appear while still talking (first live text within 3 s)", first_live is not None and first_live < 3.0, first_live)
check("live guesses are sent", len(live) >= 3, len(live))
check("a finished caption arrived before the speech stopped (cut at 7 s, not after a gap)", len(fin) >= 1, len(fin))
ids = {x["id"] for x in live}
check("live lines share an id with their finished line", all(any(f["id"] == i for f in fin) for i in ids if i < max(ids)), (sorted(ids), [f["id"] for f in fin]))
for i in range(15): cap.feed(chunk * 0, 0.0, 8.0); time.sleep(0.06)
time.sleep(1.5)
fin2 = [e[1] for e in ev if e[0] == "caption" and not e[1].get("partial")]
check("the rest is captioned once the gap comes", len(fin2) >= 2 and fin2[-1]["id"] > fin2[0]["id"], [f["id"] for f in fin2])
check("no line longer than the cap (no giant dump)", all(f["dur"] <= 7.5 for f in fin2), [f["dur"] for f in fin2])

print("ALL PASS" if not fails else "SOME FAILED: %s" % fails)
sys.exit(1 if fails else 0)
