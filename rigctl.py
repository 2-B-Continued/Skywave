"""rigctl.py - remote control over TCP, speaking the same small text protocol as Gqrx (a subset of Hamlib's rigctld).

Programs that can drive Gqrx can drive Skywave: Gpredict (Doppler correction for satellites), rig-remote (bookmarks and
scanning), loggers and your own scripts. One command per line; answers are values or "RPRT 0" (done) / "RPRT 1" (failed).

  f / F <Hz>            read / set the frequency
  m / M <mode> <Hz>     read / set the mode and passband (AM AMS FM WFM WFM_ST USB LSB CW CWR RAW)
  l STRENGTH            signal level at the tuned frequency (dBFS)
  l SQL / L SQL <dB>    squelch (dB above the noise; 0 = open)
  u RECORD / U RECORD 0|1   sound recording
  AOS / LOS             start / stop recording (what Gpredict sends at the start and end of a pass)
  \\dump_state, v, s, _, q   compatibility answers
"""
import ipaddress
import socket
import socketserver
import threading

MODES = {"AM": "am", "AMS": "am", "FM": "nfm", "WFM": "wfm", "WFM_ST": "wfm", "WFM_ST_OIRT": "wfm", "USB": "usb", "LSB": "lsb",
         "CW": "cw", "CWU": "cw", "CWL": "cw", "CWR": "cw", "RAW": "raw", "DSB": "dsb"}
BACK = {"am": "AM", "nfm": "FM", "wfm": "WFM_ST", "usb": "USB", "lsb": "LSB", "cw": "CW", "raw": "RAW", "dsb": "AM"}
DUMP = ("0\n2\n2\n150000.000000 1500000000.000000 0x900af -1 -1 0x10 000003 0x3\n0 0 0 0 0 0 0\n0 0 0 0 0 0 0\n"
        "0x900af -1\n0x900af -1\n0 0\n0 0\n0\n0\n0\n0\n0x0\n0x0\n0x0\n0x0\n0x0\n0\n")


def allowed(addr, allow):
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return False
    for part in (allow or "127.0.0.1").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            if ip in ipaddress.ip_network(part, strict=False):
                return True
        except ValueError:
            continue
    return False


class Server:
    def __init__(self, eng, cfg, log=None):
        self.eng, self.cfg, self.log = eng, cfg, log or (lambda *a: None)
        self.srv = None
        self.clients = 0
        self.err = ""

    def apply(self):
        """Start, stop or move the server to match the settings."""
        r = self.cfg.get("rigctl") or {}
        self.stop()
        if not r.get("on"):
            self.err = ""
            return
        outer = self

        class H(socketserver.StreamRequestHandler):
            def handle(self):
                if not allowed(self.client_address[0], (outer.cfg.get("rigctl") or {}).get("allow")):
                    outer.log("warn", "Remote control: refused a connection from %s (not in the allowed list)." % self.client_address[0])
                    return
                outer.clients += 1
                try:
                    for raw in self.rfile:
                        line = raw.decode("ascii", "replace").strip()
                        if not line:
                            continue
                        out = outer.do(line)
                        if out is None:
                            break
                        self.wfile.write(out.encode())
                except (OSError, ValueError):
                    pass
                finally:
                    outer.clients -= 1

        class S(socketserver.ThreadingTCPServer):
            allow_reuse_address = True
            daemon_threads = True
        try:
            self.srv = S(("0.0.0.0", int(r.get("port", 7356))), H)
        except OSError as e:
            self.err = "Could not open port %s: %s" % (r.get("port"), e)
            self.log("error", "Remote control: " + self.err)
            return
        self.err = ""
        threading.Thread(target=self.srv.serve_forever, daemon=True, name="rigctl").start()
        self.log("info", "Remote control (Gqrx compatible) listening on port %s." % r.get("port"))

    def stop(self):
        if self.srv:
            try:
                self.srv.shutdown()
                self.srv.server_close()
            except OSError:
                pass
        self.srv = None

    def public(self):
        r = self.cfg.get("rigctl") or {}
        return {"on": bool(self.srv), "port": r.get("port"), "clients": self.clients, "error": self.err}

    # ---- the protocol
    def do(self, line):
        e = self.eng
        st = e.state()
        parts = line.split()
        c = parts[0]
        a = parts[1:]
        if c in ("q", "Q", "c"):
            return None
        if c in ("f", "\\get_freq"):
            return "%d\n" % round(st["vfo"])
        if c in ("F", "\\set_freq") and a:
            try:
                f = float(a[0])
            except ValueError:
                return "RPRT 1\n"
            if not 1e3 < f < 7e9:
                return "RPRT 1\n"
            e.command({"cmd": "tune", "freq": f})
            return "RPRT 0\n"
        if c in ("m", "\\get_mode"):
            mode = BACK.get(st["mode"], "FM")
            if st["mode"] == "am" and e.lab.get("am_det", "env") != "env":
                mode = "AMS"
            return "%s\n%d\n" % (mode, round(st["bw"]))
        if c in ("M", "\\set_mode") and a:
            m = MODES.get(a[0].upper())
            if not m:
                return "RPRT 1\n"
            cmd = {"cmd": "mode", "mode": m}
            try:
                if len(a) > 1 and float(a[1]) > 0:
                    cmd["bw"] = float(a[1])
            except ValueError:
                pass
            e.command(cmd)
            if a[0].upper() in ("AM", "AMS"):
                e.command({"cmd": "lab", "set": {"am_det": "sam" if a[0].upper() == "AMS" else "env"}})
            return "RPRT 0\n"
        if c in ("l", "\\get_level") and a:
            k = a[0].upper()
            if k == "STRENGTH":
                return "%.1f\n" % (e.level if e.level is not None else -120.0)
            if k == "SQL":
                return "%.1f\n" % st["squelch"]
            return "RPRT 1\n"
        if c in ("L", "\\set_level") and len(a) > 1 and a[0].upper() == "SQL":
            try:
                e.command({"cmd": "squelch", "db": max(0.0, float(a[1]))})
            except ValueError:
                return "RPRT 1\n"
            return "RPRT 0\n"
        if c in ("u", "\\get_func") and a and a[0].upper() == "RECORD":
            return "%d\n" % (1 if st["rec"] else 0)
        if c in ("U", "\\set_func") and len(a) > 1 and a[0].upper() == "RECORD":
            e.command({"cmd": "rec_audio", "on": a[1] == "1"})
            return "RPRT 0\n"
        if c == "AOS":
            e.command({"cmd": "rec_audio", "on": True})
            return "RPRT 0\n"
        if c == "LOS":
            e.command({"cmd": "rec_audio", "on": False})
            return "RPRT 0\n"
        if c == "\\dump_state":
            return DUMP
        if c in ("v", "\\get_vfo"):
            return "VFOA\n"
        if c in ("V", "\\set_vfo", "\\set_powerstat", "\\chk_vfo") and c != "\\chk_vfo":
            return "RPRT 0\n"
        if c == "\\chk_vfo":
            return "0\n"
        if c in ("s", "\\get_split_vfo"):
            return "0\nVFOA\n"
        if c == "\\get_powerstat":
            return "1\n"
        if c in ("_", "\\get_info"):
            return "Skywave\n"
        return "RPRT 1\n"


def client(port, *lines, host="127.0.0.1"):
    """Tiny client for tests and scripts: send lines, return the replies."""
    s = socket.create_connection((host, port), 3)
    out = []
    f = s.makefile("rwb")
    for ln in lines:
        f.write((ln + "\n").encode())
        f.flush()
        out.append(f.readline().decode().strip())
        if ln.split()[0] == "m":
            out[-1] += " " + f.readline().decode().strip()
    s.close()
    return out
