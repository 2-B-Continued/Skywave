import os, sys, subprocess, time, socket, ssl, shutil, tempfile, urllib.request
if not shutil.which("openssl"):
    print("SKIP: no openssl"); sys.exit(0)
root = os.path.join(os.path.dirname(__file__), "..")
d = tempfile.mkdtemp()
env = dict(os.environ, SIM="1", HTTPS="1", PORT="18118", HTTPS_PORT="18119", DATA_DIR=d, NO_NET="1", SETUP_DONE="1")
srv = subprocess.Popen([sys.executable, "-W", "ignore", "server.py"], cwd=root, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
ok = True
def chk(n, c, x=""):
    global ok
    print("ok  " if c else "FAIL", n, x); ok = ok and bool(c)
try:
    for _ in range(80):
        try: socket.create_connection(("127.0.0.1", 18119), 0.3).close(); break
        except OSError: time.sleep(0.25)
    ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
    r = urllib.request.urlopen("https://127.0.0.1:18119/healthz", context=ctx, timeout=5); chk("https healthz", r.status == 200)
    h = urllib.request.urlopen("https://127.0.0.1:18119/", context=ctx, timeout=5).read(); chk("https page served", b"Skywave" in h)
    chk("http still works", urllib.request.urlopen("http://127.0.0.1:18118/healthz", timeout=5).status == 200)
    chk("key is private", oct(os.stat(os.path.join(d, "tls", "key.pem")).st_mode)[-3:] == "600")
    s = socket.create_connection(("127.0.0.1", 18119), 3); time.sleep(0.5); s.close()   # a client that never speaks TLS must not hurt
    chk("still alive after a silent client", urllib.request.urlopen("https://127.0.0.1:18119/healthz", context=ctx, timeout=5).status == 200)
finally:
    srv.kill(); print("PASS" if ok else "FAIL"); sys.exit(0 if ok else 1)
