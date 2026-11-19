"""sources.py - talking to the RTL-SDR dongle.

RtlTcpSource starts the standard `rtl_tcp` program (from the RTL-SDR Blog driver, which is what
makes the V4 work) and reads raw IQ from it over localhost, or connects to a remote rtl_tcp.
USB discovery reads /sys, so it needs no extra tools.
"""
import collections
try:
    import fcntl
    import termios
except ImportError:                 # not on Linux/macOS: backlog() then reports 0 and nothing is skipped
    fcntl = termios = None
import glob
import os
import shlex
import re
import socket
import struct
import subprocess
import threading
import time

TUNERS = {1: "E4000", 2: "FC0012", 3: "FC0013", 4: "FC2580", 5: "R820T/R820T2", 6: "R828D"}
RTL_IDS = {("0bda", "2832"), ("0bda", "2838"), ("0bda", "2831"), ("0bda", "2830"), ("0413", "6680"),
           ("0413", "6f0f"), ("0458", "707f"), ("0ccd", "00a9"), ("0ccd", "00b3"), ("0ccd", "00d3"),
           ("0ccd", "00d7"), ("185b", "0620"), ("185b", "0650"), ("1f4d", "b803"), ("1f4d", "c803"),
           ("1b80", "d393"), ("1b80", "d3a4"), ("1d19", "1101"), ("1d19", "1102"), ("1d19", "1103")}

CMD_FREQ, CMD_RATE, CMD_GAINMODE, CMD_GAIN, CMD_PPM = 0x01, 0x02, 0x03, 0x04, 0x05
CMD_AGC, CMD_DIRECT, CMD_OFFSET, CMD_BIAST = 0x08, 0x09, 0x0A, 0x0E


class SourceError(Exception):
    """Raised with a plain-language message that the UI can show as is."""


def usb_dongles():
    """RTL-SDR style USB devices visible in /sys/bus/usb/devices."""
    out = []
    for d in sorted(glob.glob("/sys/bus/usb/devices/*")):
        def rd(n):
            try:
                with open(os.path.join(d, n)) as f:
                    return f.read().strip()
            except OSError:
                return ""
        vid, pid = rd("idVendor").lower(), rd("idProduct").lower()
        if (vid, pid) in RTL_IDS:
            out.append({"vid": vid, "pid": pid, "manufacturer": rd("manufacturer"), "product": rd("product"),
                        "serial": rd("serial"), "speed": rd("speed"), "path": os.path.basename(d)})
    return out


def kernel_driver_loaded():
    """True if the Linux DVB-T driver for RTL dongles is loaded on the host (it can steal the dongle)."""
    try:
        with open("/proc/modules") as f:
            return any(l.startswith("dvb_usb_rtl28xxu ") for l in f)
    except OSError:
        return False


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def explain_failure(lines):
    """Turn rtl_tcp's stderr into a sentence a beginner can act on."""
    text = "\n".join(lines).lower()
    if "no supported devices" in text or "no rtl-sdr" in text or "no device" in text:
        return ("No radio dongle found. Check it is plugged in, try another USB port, and make sure the container "
                "can see USB devices (privileged mode and the /dev/bus/usb mount).")
    if "claim_interface" in text or "kernel driver is active" in text:
        return ("Another driver has taken the dongle. On the Docker host, the built-in TV-tuner driver (dvb_usb_rtl28xxu) is "
                "probably loaded. Unplug the dongle, stop any other app using it, then plug it back in.")
    if "usb_open error" in text or "permission" in text:
        return "The dongle was found but could not be opened. The container needs privileged mode and the /dev/bus/usb mount."
    if "failed to open" in text:
        return "The dongle could not be opened. Another app may be using it - stop it and try again."
    return "The radio could not be started. " + (lines[-1] if lines else "No details were reported.")


class RtlTcpSource:
    kind = "RTL-SDR"
    sim = False

    def __init__(self, fs=2400000, freq=100e6, gain_db=28.0, gain_auto=False, ppm=0, device=0,
                 remote=None, rtl_tcp_cmd=None, bias_t=False, hf_direct=0):
        self.fs, self.freq = int(fs), float(freq)
        self.gain = gain_db
        self.name = "RTL-SDR dongle"
        self.tuner = ""
        self.tuner_type = 0
        self.v4 = False
        self.proc = None
        self.sock = None
        self.stderr = collections.deque(maxlen=300)
        self._pll = 0
        self._lock = threading.Lock()
        self._closed = False
        self.device = device
        self.info_lines = []
        cmd = rtl_tcp_cmd or os.environ.get("RTL_TCP_BIN", "rtl_tcp")
        if remote:
            host, _, port = remote.partition(":")
            addr = (host, int(port or 1234))
        else:
            port = free_port()
            addr = ("127.0.0.1", port)
            argv = shlex.split(cmd) + ["-a", "127.0.0.1", "-p", str(port), "-d", str(device),
                                       "-f", str(int(freq)), "-s", str(self.fs)]
            try:
                self.proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                             stdin=subprocess.DEVNULL, bufsize=0)
            except FileNotFoundError:
                raise SourceError("The radio program (rtl_tcp) is not installed in this container.")
            threading.Thread(target=self._pump, args=(self.proc.stderr,), daemon=True).start()
            threading.Thread(target=self._pump, args=(self.proc.stdout,), daemon=True).start()
        self._connect(addr, remote is not None)
        self._parse_stderr()
        # apply initial settings
        self.set_sample_rate(self.fs)
        self.set_ppm(ppm)
        self.set_direct(hf_direct)
        self.set_agc(False)
        if gain_auto:
            self.set_gain(None)
        else:
            self.set_gain(gain_db)
        if bias_t:
            self.set_bias_tee(True)
        self.set_freq(freq)

    # ---------------------------------------------------------------- process / socket plumbing
    def _pump(self, pipe):
        buf = b""
        while True:
            try:
                d = pipe.read(256)
            except Exception:
                return
            if not d:
                return
            buf += d
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                s = line.decode("utf-8", "replace").strip()
                if not s:
                    continue
                if "PLL not locked" in s:
                    with self._lock:
                        self._pll += 1
                self.stderr.append(s)

    def _connect(self, addr, remote):
        deadline = time.time() + (6.0 if not remote else 4.0)
        err = None
        while time.time() < deadline:
            if self.proc and self.proc.poll() is not None:
                time.sleep(0.15)
                raise SourceError(explain_failure(list(self.stderr)))
            try:
                s = socket.create_connection(addr, timeout=2.0)
                s.settimeout(5.0)
                hdr = b""
                while len(hdr) < 12:
                    d = s.recv(12 - len(hdr))
                    if not d:
                        raise OSError("closed")
                    hdr += d
                if hdr[:4] != b"RTL0":
                    raise SourceError("That address is not an rtl_tcp server.")
                self.tuner_type, self.gain_count = struct.unpack(">II", hdr[4:12])
                self.sock = s
                s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
                try:
                    s.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4 << 20)
                except OSError:
                    pass
                return
            except SourceError:
                raise
            except OSError as e:
                err = e
                time.sleep(0.03)                 # rtl_tcp opens its port the moment the dongle is ready: check often
        if self.proc and self.proc.poll() is not None:
            raise SourceError(explain_failure(list(self.stderr)))
        raise SourceError("Could not connect to the radio (%s). %s" % (err, explain_failure(list(self.stderr)) if self.stderr else ""))

    def _parse_stderr(self):
        # rtl_tcp has normally printed which dongle it found by the time it accepts a connection; wait briefly only if not
        t = time.time() + 0.2
        while time.time() < t and not any(l.startswith("Using device") or "Found" in l for l in self.stderr):
            time.sleep(0.01)
        self.tuner = TUNERS.get(self.tuner_type, "unknown tuner")
        txt = "\n".join(self.stderr)
        # V4 family: the V4 (R828D tuner) and the V4 Lite, "V4L" (R828S tuner). Both have the built-in HF upconverter
        # and no direct-sampling path, so they must never be put into direct-sampling mode for short-wave.
        self.v4 = self.tuner_type == 6 or bool(re.search(r"Blog V4|V4L|R828S|R828D", txt))
        for line in self.stderr:
            if line.startswith("Found") or "Using device" in line or "Blog V" in line or "Generic" in line:
                self.info_lines.append(line)
        # product name from "Using device 0: Generic RTL2832U OEM"
        for line in self.stderr:
            if line.startswith("Using device"):
                self.name = line.split(":", 1)[-1].strip()
        if self.v4:
            self.name = "RTL-SDR Blog V4L" if re.search(r"V4L|R828S", txt) else "RTL-SDR Blog V4"

    # ---------------------------------------------------------------- control
    def _cmd(self, cmd, param):
        try:
            self.sock.sendall(struct.pack(">BI", cmd, int(param) & 0xFFFFFFFF))
        except OSError:
            raise SourceError("The connection to the radio was lost.")

    def set_freq(self, hz):
        self.freq = float(hz)
        self._cmd(CMD_FREQ, int(round(hz)))

    def set_sample_rate(self, fs):
        self.fs = int(fs)
        self._cmd(CMD_RATE, self.fs)

    def set_gain(self, db):
        if db is None:
            self._cmd(CMD_GAINMODE, 0)
        else:
            self.gain = float(db)
            self._cmd(CMD_GAINMODE, 1)
            self._cmd(CMD_GAIN, int(round(db * 10)))

    def set_agc(self, on):
        self._cmd(CMD_AGC, 1 if on else 0)

    def set_ppm(self, ppm):
        self._cmd(CMD_PPM, int(ppm))

    def set_direct(self, mode):
        self._cmd(CMD_DIRECT, int(mode))

    def set_bias_tee(self, on):
        self._cmd(CMD_BIAST, 1 if on else 0)

    def set_offset_tuning(self, on):
        self._cmd(CMD_OFFSET, 1 if on else 0)

    def take_pll_count(self):
        with self._lock:
            n, self._pll = self._pll, 0
        return n

    @property
    def pll_total_lines(self):
        return sum(1 for l in self.stderr if "PLL not locked" in l)

    # ---------------------------------------------------------------- data
    def backlog(self):
        """Bytes already waiting on the socket: sound we have not processed yet, i.e. how far behind live we are."""
        try:
            return struct.unpack("i", fcntl.ioctl(self.sock.fileno(), termios.FIONREAD, b"\0\0\0\0"))[0]
        except (OSError, ValueError, AttributeError):
            return 0

    def skip(self, nbytes):
        """Throw away nbytes of waiting samples (kept to whole IQ pairs), to jump back to live."""
        nbytes -= nbytes % 2
        try:
            self.sock.setblocking(False)
            while nbytes > 0:
                k = len(self.sock.recv(min(nbytes, 1 << 20)))
                if k <= 0:
                    break
                nbytes -= k
        except (BlockingIOError, OSError):
            pass
        finally:
            try:
                self.sock.settimeout(5.0)
            except OSError:
                pass
        return nbytes % 2 == 0

    def read_samples(self, n):
        """Exactly n complex samples (2n bytes). Raises SourceError if the stream stops."""
        need = 2 * n
        buf = bytearray(need)
        mv = memoryview(buf)
        got = 0
        while got < need:
            try:
                k = self.sock.recv_into(mv[got:], need - got)
            except socket.timeout:
                raise SourceError("The radio stopped sending data. Try unplugging and replugging the dongle.")
            except OSError:
                raise SourceError("The connection to the radio was lost.")
            if k == 0:
                raise SourceError(explain_failure(list(self.stderr)) if self.stderr else "The radio disconnected.")
            got += k
        return bytes(buf)

    def alive(self):
        return not self._closed and (self.proc is None or self.proc.poll() is None)

    def close(self):
        self._closed = True
        try:
            if self.sock:
                self.sock.close()
        except OSError:
            pass
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(3)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(2)
        # give the USB device a moment to be released before anything else opens it
        time.sleep(0.3)


class FileSource:
    """Plays back a recorded baseband (IQ) file as if it were a live radio: 8-bit unsigned stereo WAV or raw .cu8/.iq.
    Runs in real time and loops. The centre frequency cannot be changed, only the tuner inside the recording."""
    sim = False
    kind = "IQ file"
    tuner = "File playback"
    v4 = False
    fixed = True

    def __init__(self, path, fs, freq, loop=True):
        self.path, self.fs, self.freq, self.loop = path, int(fs), float(freq), loop
        self.name = "File: " + os.path.basename(path)
        self.stderr_lines = []
        self.f = open(path, "rb")
        head = self.f.read(44)
        self.data0 = 0
        if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
            ch, rate, bits = struct.unpack("<H", head[22:24])[0], struct.unpack("<I", head[24:28])[0], struct.unpack("<H", head[34:36])[0]
            if ch != 2 or bits != 8:
                raise SourceError("Only 8-bit stereo (I/Q) WAV baseband files can be played back.")
            self.fs, self.data0 = rate, 44
        self.f.seek(self.data0)
        self.t0 = time.perf_counter()
        self.sent = 0
        self._closed = False

    def set_freq(self, hz): pass
    def set_gain(self, db): pass
    def set_agc(self, on): pass
    def set_ppm(self, ppm): pass
    def set_direct(self, mode): pass
    def set_bias_tee(self, on): pass
    def set_offset_tuning(self, on): pass
    def set_sample_rate(self, fs): pass
    def take_pll_count(self): return 0
    def alive(self): return not self._closed

    def read_samples(self, n):
        need = 2 * n
        out = bytearray()
        while len(out) < need:
            b = self.f.read(need - len(out))
            if not b:
                if not self.loop:
                    raise SourceError("End of the recording.")
                self.f.seek(self.data0)
                if self.f.tell() == self.data0 and not self.f.read(2):
                    raise SourceError("That recording file is empty.")
                self.f.seek(self.data0)
                continue
            out += b
        self.sent += n
        due = self.t0 + self.sent / self.fs               # keep real-time pace
        dt = due - time.perf_counter()
        if dt > 0:
            time.sleep(min(dt, 0.5))
        return bytes(out)

    def close(self):
        self._closed = True
        try:
            self.f.close()
        except Exception:
            pass


class Converter:
    """Puts an up/down-converter (an HF upconverter, a satellite LNB...) between the app and the dongle. Everything above
    this layer keeps using the real frequency on the air; only the dongle is tuned to the converter's output.
    `below`: only go through the converter for frequencies under this (0 = always), so an upconverter with a bypass
    switch still works for VHF/UHF. `invert`: high-side converters mirror the spectrum."""

    def __init__(self, src, lo, invert=False, below=0.0):
        self._src, self.lo, self.invert, self.below = src, float(lo), bool(invert), float(below)
        self._f = None

    def _active(self, f):
        return self.lo and (not self.below or f < self.below)

    def hw(self, f):
        if not self._active(f):
            return f
        # lo is the shift added on the way to the dongle: +125 MHz for an HF upconverter, -9750 MHz for a satellite LNB.
        # A high-side converter (local oscillator above the signal) gives |lo| - f, mirrored.
        return (abs(self.lo) - f) if self.invert else (f + self.lo)

    def set_freq(self, hz):
        self._f = float(hz)
        return self._src.set_freq(self.hw(self._f))

    def read_samples(self, n):
        raw = self._src.read_samples(n)
        if self.invert and self._f is not None and self._active(self._f):
            b = bytearray(raw)
            b[1::2] = bytes(255 - x for x in b[1::2])          # conjugate (flip Q) so the spectrum reads the right way round
            return bytes(b)
        return raw

    @property
    def freq(self):
        return self._f if self._f is not None else getattr(self._src, "freq", 0.0)

    def __getattr__(self, k):
        return getattr(self._src, k)
