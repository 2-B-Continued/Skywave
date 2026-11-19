"""captions.py - live captions and plain-text transcripts for spoken radio channels.

How it works
  * The engine feeds this module the demodulated audio (48 kHz) plus whether a signal is present.
  * A segmenter cuts the audio into transmissions (one press of a push-to-talk button = one segment).
  * Each segment is resampled to 16 kHz and handed to a speech-to-text backend on a background thread, so the
    radio never stalls. The result appears a second or two after the person stops talking.
  * Broadcast entertainment (FM/AM radio, shortwave broadcasters, digital radio) is never captioned.

The backend is faster-whisper (an offline model, downloaded once). If it is not installed, captions say so
instead of failing. Setting CAPTION_FAKE=1 swaps in a stand-in that is used by the tests.
"""
import collections
import os
import queue
import re
import threading
import time

import numpy as np
from scipy import signal

import banks as banks_mod

# Band names (from banks.BAND_PLAN) that are entertainment broadcasts: never captioned.
BROADCAST_BANDS = {"FM radio", "AM radio", "49 m shortwave", "31 m shortwave", "Digital radio / TV"}
HALLUCINATIONS = {"thank you", "thank you.", "thanks for watching", "thanks for watching!", "you", "bye", "bye.",
                  "thank you for watching", "thank you for watching.", "subtitles by the amara.org community",
                  "the end", "the end.", "okay.", "uh", "um", "hmm", "mm-hmm"}


def caption_allowed(freq, mode):
    """True if live captions may run on this tuning. Spoken-communication bands yes, entertainment broadcasts no."""
    if mode == "wfm":
        return False
    name, _ = banks_mod.band_for(freq)
    return name not in BROADCAST_BANDS


def clean_text(text):
    """Tidy a transcription and reject the stock phrases speech models invent from pure noise."""
    t = re.sub(r"\s+", " ", (text or "")).strip()
    if not t or t.lower() in HALLUCINATIONS:
        return ""
    words = t.split()
    # a word repeated many times in a row is the classic noise artefact
    run = 1
    for i in range(1, len(words)):
        run = run + 1 if words[i].lower() == words[i - 1].lower() else 1
        if run >= 5:
            return ""
    if len(words) >= 2 and len(set(w.lower() for w in words)) == 1 and len(words) > 3:
        return ""
    return t


def lower_priority():
    """Speech-to-text is the lowest priority job on the machine: the radio and the sound come first, always."""
    try:
        os.setpriority(os.PRIO_PROCESS, threading.get_native_id(), 15)
    except Exception:
        pass


class WhisperBackend:
    name = "faster-whisper"

    def __init__(self, model, root):
        from faster_whisper import WhisperModel            # raises ImportError when not installed
        self.model_name = model
        lower_priority()                                    # threads the model starts inherit this
        self.model = WhisperModel(model, device="cpu", compute_type="int8", download_root=root,
                                  cpu_threads=max(1, min(4, (os.cpu_count() or 4) // 2)))     # leave cores free for the radio

    def transcribe(self, audio16k, partial=False):
        segs, _info = self.model.transcribe(
            audio16k, language="en", beam_size=1, temperature=0.0, vad_filter=False,
            condition_on_previous_text=False, no_speech_threshold=0.6, log_prob_threshold=-1.0,
            initial_prompt="Two-way radio chatter: walkie-talkies, aircraft, marine and amateur radio.")
        out = []
        for s in segs:
            if getattr(s, "no_speech_prob", 0) > 0.7 or getattr(s, "avg_logprob", 0) < -1.2:
                continue
            out.append(s.text)
        return " ".join(out)


class FakeBackend:
    """Test stand-in: pretends every 'transmission' says a fixed phrase, chosen by its length."""
    name = "fake"

    def __init__(self, *a):
        self.phrases = os.environ.get("CAPTION_FAKE_TEXT", "Speedbird four three one cleared to land runway three four").split("|")
        self.n = 0

    def transcribe(self, audio16k, partial=False):
        if partial:                                    # a live guess: the first few words of what the next full phrase will be
            return " ".join(self.phrases[self.n % len(self.phrases)].split()[:3])
        self.n += 1
        return self.phrases[(self.n - 1) % len(self.phrases)]


GAP_S = 0.7            # silence that ends a transmission
SEG_MAX_S = 7.0        # a segment never grows past this: it is cut at the quietest point, so people talking over each other still caption live
INTERIM_S = 0.9        # how often the words so far are shown, while someone is still talking


class Captioner:
    def __init__(self, cfg, emit):
        self.cfg = cfg
        self.emit = emit
        self.on = False
        self.save = False
        self.allowed = True
        self.backend = None
        self.reason = ""
        self.loading = False
        self.q = queue.Queue(maxsize=6)
        self.log = collections.deque(maxlen=60)
        self.busy = False
        self._buf = []               # audio chunks of the current transmission (float32, 48 kHz)
        self._buf_n = 0
        self._open = False
        self._last_voice = 0.0
        self._seg_t0 = 0.0
        self._seg_id = 0             # numbers each stretch of speech; a live line and its final version share one number
        self._last_interim = 0.0
        self._done_id = 0            # highest id that has been finalised
        self._ctx = {}
        self._tfile = None
        self._tpath = ""
        self._tctx = {}
        self.dropped = 0
        self.match = None            # optional hook: text -> list of tracked aircraft being addressed
        self.lock = threading.Lock()
        self.worker = threading.Thread(target=self._work, daemon=True)
        self.worker.start()

    # ------------------------------------------------------------ status
    def status(self):
        fake = bool(os.environ.get("CAPTION_FAKE"))
        if self.backend:
            return {"available": True, "engine": self.backend.name, "loading": False, "reason": ""}
        if fake:
            return {"available": True, "engine": "fake", "loading": False, "reason": ""}
        try:
            import importlib.util
            ok = importlib.util.find_spec("faster_whisper") is not None
        except Exception:
            ok = False
        return {"available": ok, "engine": "faster-whisper" if ok else "", "loading": self.loading,
                "reason": self.reason or ("" if ok else "faster-whisper is not installed")}

    def public(self):
        s = self.status()
        return {"on": self.on, "save": self.save, "allowed": self.allowed, "busy": self.busy, "dropped": self.dropped,
                "available": s["available"], "engine": s["engine"], "loading": s["loading"], "reason": s["reason"],
                "file": os.path.basename(self._tpath) if self._tfile else ""}

    # ------------------------------------------------------------ control
    def set_on(self, on, save=None):
        with self.lock:
            self.on = bool(on)
            if save is not None:
                self.save = bool(save)
            if not self.on:
                self._flush(force=True)
                self._close_file()
        if self.on:
            self._ensure_backend()
        self.emit("captions", **self.public())

    def set_context(self, freq, mode, label=""):
        """Called whenever the radio is tuned: decides whether captions may run, and closes the open transcript."""
        self.allowed = caption_allowed(freq, mode)
        ctx = {"f": float(freq), "mode": mode, "label": label}
        if self._ctx.get("f") != ctx["f"]:
            self._flush(force=True)
            if self._tfile and (self.save or True):
                self._close_file()
        self._ctx = ctx

    def _ensure_backend(self):
        if self.backend or self.loading:
            return
        if os.environ.get("CAPTION_FAKE"):
            self.backend = FakeBackend()
            return
        self.loading = True

        def load():
            try:
                root = os.path.join(self.cfg["data_dir"], "models")
                os.makedirs(root, exist_ok=True)
                self.backend = WhisperBackend(self.cfg.get("caption_model", "base.en"), root)
                self.reason = ""
            except ImportError:
                self.reason = "faster-whisper is not installed"
            except Exception as e:                           # model download failed, out of memory, ...
                self.reason = "could not load the caption model: %s" % str(e)[:120]
            self.loading = False
            self.emit("captions", **self.public())
        threading.Thread(target=load, daemon=True).start()

    # ------------------------------------------------------------ audio in
    def feed(self, audio, snr, thr):
        """audio: float32 chunk at 48 kHz. snr: signal-to-noise in dB at the tuned channel."""
        if not (self.on and self.allowed):
            if self._open:
                self._flush(force=True)
            return
        now = time.monotonic()
        voice = snr > max(thr, 6.0)
        if voice:
            self._last_voice = now
            if not self._open:
                self._start_segment(now)
        if not self._open:
            return
        self._buf.append(audio)
        self._buf_n += len(audio)
        if (now - self._last_voice) > GAP_S:
            self._flush(force=False)
        elif self._buf_n > 48000 * SEG_MAX_S:
            self._split_quiet(now)
        elif now - self._last_interim > INTERIM_S and self._buf_n >= 48000 * 0.6:
            self._interim(now)

    def _start_segment(self, now):
        self._open = True
        self._seg_id += 1
        self._seg_t0 = time.time()
        self._buf, self._buf_n = [], 0
        self._last_interim = now

    def _prep(self, a):
        a16 = signal.resample_poly(a, 1, 3).astype(np.float32)
        pk = float(np.max(np.abs(a16))) or 1.0
        return a16 / max(pk, 1e-3) * 0.8

    def _submit(self, a, t0, sid, final):
        try:
            self.q.put_nowait((a, t0, dict(self._ctx), len(a) / 48000.0, sid, final))
        except queue.Full:
            if final:
                self.dropped += 1                              # the computer can't keep up: skip rather than lag

    def _interim(self, now):
        """Live captioning: show the words so far, without waiting for the speaker to stop. Only when the worker is free,
        so it never makes the final captions late."""
        self._last_interim = now
        if self.busy or not self.q.empty():
            return
        self._submit(np.concatenate(self._buf), self._seg_t0, self._seg_id, False)

    def _split_quiet(self, now):
        """No gap for a long time (several people, or a busy channel): finish this part at the quietest moment in the last couple
        of seconds, so words are not chopped in half, and carry straight on with the rest."""
        a = np.concatenate(self._buf)
        w = 4800                                                   # 0.1 s windows
        lo = max(0, len(a) - 48000 * 3)
        n = (len(a) - lo) // w
        cut = len(a)
        if n >= 4:
            e = [float(np.mean(a[lo + i * w: lo + (i + 1) * w] ** 2)) for i in range(n - 1)]    # never cut in the very last window
            cut = lo + (int(np.argmin(e)) + 1) * w
        first, rest = a[:cut], a[cut:]
        t0, sid = self._seg_t0, self._seg_id
        self._submit(first, t0, sid, True)
        self._done_id = max(self._done_id, sid)
        self._seg_id += 1
        self._seg_t0 = time.time() - len(rest) / 48000.0
        self._buf, self._buf_n = ([rest], len(rest)) if len(rest) else ([], 0)
        self._last_interim = now

    def _flush(self, force):
        if not self._buf:
            self._open = False
            return
        a = np.concatenate(self._buf)
        t0, sid = self._seg_t0, self._seg_id
        self._buf, self._buf_n, self._open = [], 0, False
        self._done_id = max(self._done_id, sid)
        if len(a) < 48000 * 0.7:                              # shorter than 0.7 s: a click or squelch tail
            self.emit("caption_drop", id=sid)
            return
        self._submit(a, t0, sid, True)

    # ------------------------------------------------------------ worker
    def _work(self):
        lower_priority()
        while True:
            a48, t0, ctx, dur, sid, final = self.q.get()
            if not final and sid <= self._done_id:               # a live guess for something already finished: stale
                continue
            if self.backend is None:
                for _ in range(100):
                    if self.backend or not self.on:
                        break
                    time.sleep(0.2)
            if self.backend is None:
                continue
            self.busy = True
            try:
                text = clean_text(self.backend.transcribe(self._prep(a48), partial=not final))     # resampling happens here, off the radio's thread
            except Exception as e:
                text = ""
                self.reason = "caption error: %s" % str(e)[:100]
            self.busy = False
            if not final and sid <= self._done_id:               # finished while it was being worked out
                continue
            if not text:
                if final:
                    self.emit("caption_drop", id=sid)             # remove the live line: nothing was actually said
                continue
            item = {"t": t0, "f": ctx.get("f"), "mode": ctx.get("mode"), "label": ctx.get("label", ""), "text": text,
                    "dur": round(dur, 1), "id": sid, "partial": not final}
            if not final:
                self.emit("caption", **item)
                continue
            if self.match:
                try:
                    item["planes"] = self.match(text)
                except Exception:
                    item["planes"] = []
            self.log.append(item)
            self.emit("caption", **item)
            if self.save:
                self._append(item)

    def add_external(self, item):
        """Text that did not come from speech-to-text (Morse). Shown in the same strip and saved like a caption."""
        self.log.append(item)
        self.emit("caption", **item)
        if self.save and self.on:
            self._append(item)

    # ------------------------------------------------------------ transcript files
    def _append(self, item):
        try:
            if self._tfile is None or self._tctx.get("f") != item["f"]:
                self._close_file()
                f = (item["f"] or 0) / 1e6
                name = "%s_%.4fMHz.txt" % (time.strftime("%Y%m%d-%H%M%S", time.localtime(item["t"])), f)
                self._tpath = os.path.join(self.cfg.path_for("transcripts"), name)
                self._tfile = open(self._tpath, "a", encoding="utf-8")
                self._tctx = {"f": item["f"]}
                self._tfile.write("Skywave transcript\nChannel: %.4f MHz%s\nStarted: %s\n"
                                  "Automatic speech-to-text from radio audio: expect mistakes. Personal use only.\n\n" % (
                                      f, (" (%s)" % item["label"]) if item.get("label") else "",
                                      time.strftime("%Y-%m-%d %H:%M:%S %Z", time.localtime(item["t"]))))
            self._tfile.write("[%s] %s\n" % (time.strftime("%H:%M:%S", time.localtime(item["t"])), item["text"]))
            self._tfile.flush()
        except OSError:
            pass

    def _close_file(self):
        if self._tfile:
            try:
                self._tfile.close()
            except OSError:
                pass
        self._tfile = None
        self._tctx = {}
        # drop empty transcripts (header only)
        try:
            if self._tpath and os.path.getsize(self._tpath) < 40:
                os.remove(self._tpath)
        except OSError:
            pass


# ---------------------------------------------------------------- callsign matching (used by the Planes page)
NUMWORDS = {"zero": "0", "oh": "0", "one": "1", "two": "2", "three": "3", "tree": "3", "four": "4", "fower": "4",
            "five": "5", "fife": "5", "six": "6", "seven": "7", "eight": "8", "nine": "9", "niner": "9"}
NATO = {w: w[0].upper() for w in ("alpha alfa bravo charlie delta echo foxtrot golf hotel india juliet juliett kilo lima mike "
                                    "november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu").split()}
NATO["x-ray"] = "X"
# ICAO airline prefix -> radio telephony names (common carriers worldwide)
TELEPHONY = {
    "AAL": ["american"], "ACA": ["air canada"], "AFR": ["airfrans", "air france"], "AIC": ["air india"], "ANA": ["all nippon"],
    "ANZ": ["new zealand"], "ASA": ["alaska"], "BAW": ["speedbird"], "CCA": ["air china"], "CES": ["china eastern"],
    "CPA": ["cathay"], "CSN": ["china southern"], "DAL": ["delta"], "DLH": ["lufthansa"], "EIN": ["shamrock"], "ETD": ["etihad"],
    "ETH": ["ethiopian"], "EZY": ["easy"], "FDX": ["fedex"], "FJI": ["fiji"], "IBE": ["iberia"], "JAL": ["japan air"],
    "JBU": ["jetblue"], "JST": ["jetstar"], "KAL": ["korean air"], "KLM": ["klm"], "MAS": ["malaysian"], "QFA": ["qantas"],
    "QTR": ["qatari"], "RXA": ["rex"], "RYR": ["ryanair"], "SIA": ["singapore"], "SWA": ["southwest"], "SWR": ["swiss"],
    "THA": ["thai"], "THY": ["turkish"], "UAE": ["emirates"], "UAL": ["united"], "VIR": ["virgin"], "VOZ": ["velocity"],
    "WJA": ["westjet"], "WZZ": ["wizz air"],
}


def tokens(text):
    """Lower-case words with spoken digits and phonetic letters folded into plain digits/letters."""
    out = []
    for w in re.findall(r"[a-z0-9\-']+", (text or "").lower()):
        out.append(w)
    return out


def _fold(words):
    """Return (digits_runs, letters_run) views: spoken numbers -> digits, phonetic letters -> letters."""
    seq = []
    for w in words:
        if w in NUMWORDS:
            seq.append(("d", NUMWORDS[w]))
        elif w.isdigit():
            seq.append(("d", w))
        elif w in NATO:
            seq.append(("l", NATO[w]))
        else:
            seq.append(("w", w))
    return seq


def match_callsigns(text, callsigns):
    """Which tracked callsigns (e.g. 'BAW123', 'GABCD') are being spoken in this caption. Returns a list of callsigns."""
    words = tokens(text)
    seq = _fold(words)
    found = []
    # 1. airline telephony followed by the flight number
    for cs in callsigns:
        m = re.match(r"^([A-Z]{3})(\d{1,4})[A-Z]?$", cs or "")
        if m:
            pre, num = m.group(1), m.group(2)
            names = TELEPHONY.get(pre, []) + [pre.lower()]
            for nm in names:
                for i, (_, w) in enumerate(seq):
                    if w == nm.split()[0] and " ".join(x for _, x in seq[i:i + len(nm.split())]) == nm:
                        j = i + len(nm.split())
                        digits = ""
                        while j < len(seq) and seq[j][0] == "d" and len(digits) < 4:
                            digits += seq[j][1]
                            j += 1
                        if digits == num or (len(digits) >= 2 and num.endswith(digits) and len(digits) >= len(num) - 1):
                            found.append(cs)
                            break
                if cs in found:
                    break
            continue
        # 2. registrations made only of letters (country prefix + 3 or 4 letters, e.g. G-ABCD, VH-ABC, ZK-ABC): spoken
        #    phonetically ("golf alpha bravo charlie delta"), written with a dash, or shortened to the last three letters
        m = re.match(r"^([A-Z]{1,2})([A-Z]{3,4})$", cs or "")
        if m:
            letters = "".join(x for k, x in seq if k == "l")
            raw = re.sub(r"[^a-z]", "", (text or "").lower())
            tail = m.group(0)[-3:]
            if m.group(0).lower() in raw or m.group(0) in letters or letters == tail or letters.endswith(m.group(0)):
                found.append(cs)
    return found
