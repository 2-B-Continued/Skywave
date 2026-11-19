#!/usr/bin/env python3
"""fake_rtl_tcp.py - speaks the rtl_tcp protocol using the built-in simulator.

Lets you test Skywave's real dongle code path without hardware:
    RTL_TCP_BIN="python3 fake_rtl_tcp.py" SIM=0 python3 server.py
Options: -a ADDR -p PORT -d INDEX -f FREQ -s RATE (same as rtl_tcp), plus
    --tuner N       tuner type in the header (5 = R820T, 6 = R828D / V4)
    --pll-fail      print "[R82XX] PLL not locked!" on every retune, like a faulty tuner
"""
import argparse
import socket
import struct
import sys
import threading

import sim


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-a", default="127.0.0.1")
    ap.add_argument("-p", type=int, default=1234)
    ap.add_argument("-d", type=int, default=0)
    ap.add_argument("-f", type=float, default=100e6)
    ap.add_argument("-s", type=int, default=2400000)
    ap.add_argument("-g", type=float, default=0)
    ap.add_argument("--tuner", type=int, default=5)
    ap.add_argument("--pll-fail", action="store_true")
    a = ap.parse_args()
    src = sim.SimSource(fs=a.s, freq=a.f)
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((a.a, a.p))
    srv.listen(1)
    names = {5: "Generic RTL2832U OEM", 6: "Blog V4"}
    print("Found 1 device(s):\n  0:  Realtek, RTL2838UHIDIR, SN: 00000001\n", file=sys.stderr)
    print("Using device 0: %s" % names.get(a.tuner, "Generic RTL2832U OEM"), file=sys.stderr)
    print("Found Rafael Micro %s tuner" % ("R828D" if a.tuner == 6 else "R820T"), file=sys.stderr)
    if a.tuner == 6:
        print("RTL-SDR Blog V4 Detected", file=sys.stderr)
    sys.stderr.flush()
    while True:
        conn, _ = srv.accept()
        conn.sendall(b"RTL0" + struct.pack(">II", a.tuner, 29))
        stop = threading.Event()

        def reader():
            buf = b""
            while not stop.is_set():
                try:
                    d = conn.recv(256)
                except OSError:
                    break
                if not d:
                    break
                buf += d
                while len(buf) >= 5:
                    cmd, param = struct.unpack(">BI", buf[:5])
                    buf = buf[5:]
                    if cmd == 0x01:
                        src.set_freq(param)
                        if a.pll_fail:
                            print("[R82XX] PLL not locked!", file=sys.stderr)
                            sys.stderr.flush()
                    elif cmd == 0x02:
                        src.set_sample_rate(param)
                    elif cmd == 0x04:
                        src.set_gain(param / 10.0)
                    elif cmd == 0x09:
                        src.set_direct(param)
            stop.set()
        threading.Thread(target=reader, daemon=True).start()
        try:
            while not stop.is_set():
                conn.sendall(src.read_samples(32768))
        except OSError:
            pass
        stop.set()
        conn.close()


if __name__ == "__main__":
    main()
