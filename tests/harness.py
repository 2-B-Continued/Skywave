"""Shared helpers for engine tests: build an Engine in simulator mode and collect what it sends."""
import json
import os
import struct
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import warnings
warnings.simplefilter("ignore")


def make_engine(sim=True, env=None):
    d = tempfile.mkdtemp(prefix="rtlst-")
    os.environ["DATA_DIR"] = d
    os.environ["SIM"] = "1" if sim else "0"
    for k, v in (env or {}).items():
        os.environ[k] = v
    import config, banks, space, engine
    cfg = config.Config()
    bs = banks.BankStore(cfg.path_for("banks.json"))
    sp = space.Space(cfg)
    eng = engine.Engine(cfg, bs, sp)
    eng.start()
    return eng, cfg, d


class Collector:
    """Drains a Client queue in the background and keeps a tally."""

    def __init__(self, eng):
        import threading
        self.eng = eng
        self.c = eng.add_client()
        self.a = eng.add_client(audio=True)      # sound travels on its own channel, like the page's sound socket
        self.events = []
        self.spectra = []
        self.audio_bytes = 0
        self.audio_rms = []
        self.stop = False
        self.t = threading.Thread(target=self.run, daemon=True)
        self.t.start()

    def run(self):
        import numpy as np
        import queue
        while not self.stop:
            try:
                it = self.a.take(timeout=0) if self.a.queued else self.c.q.get(timeout=0.05)
            except queue.Empty:
                continue
            if it is None:
                continue
            if isinstance(it, str):
                self.events.append(json.loads(it))
            elif it[0] == 1:
                hdr = struct.unpack(">BdIhh", it[:17])
                self.spectra.append((hdr, np.frombuffer(it[17:], dtype=np.uint8)))
            elif it[0] == 2:
                self.audio_bytes += len(it) - 1
                a = np.frombuffer(it[1:], dtype="<i2").astype(np.float32) / 32768
                self.audio_rms.append(float(np.sqrt(np.mean(a * a))) if len(a) else 0.0)

    def find(self, typ):
        return [e for e in self.events if e.get("type") == typ]

    def last_state(self):
        s = self.find("state")
        return s[-1] if s else None

    def wait_for(self, typ, timeout=10.0, pred=None):
        t0 = time.time()
        while time.time() - t0 < timeout:
            for e in self.find(typ):
                if pred is None or pred(e):
                    return e
            time.sleep(0.1)
        return None
