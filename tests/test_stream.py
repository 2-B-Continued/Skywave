import os, subprocess, sys, tempfile, time, socket
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
d = tempfile.mkdtemp(prefix="rtlst-stream-")
env = dict(os.environ, SIM="1", PORT="18095", DATA_DIR=d, NO_NET="1", SETUP_DONE="1")
p = subprocess.Popen([sys.executable, "-W", "ignore", "server.py"], cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
ok = True
try:
    for _ in range(40):
        try: socket.create_connection(("127.0.0.1", 18095), 0.5).close(); break
        except OSError: time.sleep(0.5)
    socks = []
    def open_stream():
        s = socket.create_connection(("127.0.0.1", 18095)); s.settimeout(6)
        s.sendall(b"GET /stream.mp3 HTTP/1.1\r\nHost: x\r\n\r\n"); return s
    s = open_stream(); buf = b""; t0 = time.time()
    while time.time() - t0 < 5 and len(buf) < 20000:
        try: c = s.recv(8192)
        except socket.timeout: break
        if not c: break
        buf += c
    head, _, body = buf.partition(b"\r\n\r\n")
    print("status:", head.split(b"\r\n")[0], "| ctype audio/mpeg:", b"audio/mpeg" in head, "| mp3 bytes:", len(body))
    ok &= b"200" in head.split(b"\r\n")[0] and b"audio/mpeg" in head and len(body) > 4000
    ok &= (b"\xff\xfb" in body[:4000] or b"\xff\xf3" in body[:4000] or b"ID3" in body[:10] or b"\xff\xfa" in body[:4000])
    # listener cap: 4 sinks max
    others = [open_stream() for _ in range(4)]
    time.sleep(1.0)
    last = others[-1]; r = b""
    try: r = last.recv(300)
    except Exception: pass
    print("5th listener (replaces the oldest):", r.split(b"\r\n")[0])
    ok &= b"200" in r                         # a full house no longer turns the newest device away: it replaces the oldest listener
    s.close()
    for o in others: o.close()
    time.sleep(1.0)
    s2 = open_stream(); r = s2.recv(300); print("after close:", r.split(b"\r\n")[0]); ok &= b"200" in r
finally:
    p.terminate(); out = p.communicate(timeout=10)[0].decode()
    if "Traceback" in out: print(out[-800:]); ok = False
print("PASS" if ok else "FAIL"); sys.exit(0 if ok else 1)
