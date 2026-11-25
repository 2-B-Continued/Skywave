"""Inputs that must be refused: decode ids that leave their folder, scanner ranges that never end, unknown modes, the
saved MQTT password following a new broker address, active (SVG) cover art, and Host names a home network does not use."""
import os, sys, tempfile, shutil
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
os.environ["NO_NET"] = "1"
ok = True


def chk(name, cond, extra=""):
    global ok
    print("ok  " if cond else "FAIL", name, extra)
    ok = ok and bool(cond)


d = tempfile.mkdtemp()
os.environ["DATA_DIR"] = d
try:
    import config, banks, weather, art, server

    # ---- decode ids stay inside the decoded folder
    cfg = config.Config()
    dec = weather.Decoder(cfg, lambda *a, **k: None)
    open(os.path.join(d, "keep.json"), "w").write("{}")
    os.makedirs(os.path.join(dec.root, "x1"))
    for bad in ("..", "", ".", "../x1", "x1/.."):
        try:
            dec.delete(bad); chk("delete refuses %r" % bad, False)
        except ValueError:
            chk("delete refuses %r" % bad, True)
    chk("data folder still there", os.path.isfile(os.path.join(d, "keep.json")))
    chk("file_path refuses ..", dec.file_path("..", "keep.json") is None)
    dec.delete("x1")
    chk("a real decode is deleted", not os.path.exists(os.path.join(dec.root, "x1")))

    # ---- scanner ranges must end, and modes are known ones
    bs = banks.BankStore(os.path.join(d, "banks.json"), cfg["region"], cfg.get("country"))
    for step in (0, -25000, 1, float("inf")):
        try:
            bs.put({"id": "r", "ranges": [{"start": 1.46e8, "stop": 1.47e8, "step": step}]}); chk("step %r refused" % step, False)
        except ValueError:
            chk("step %r refused" % step, True)
    try:
        bs.put({"id": "big", "ranges": [{"start": 2.5e7, "stop": 1.7e9, "step": 100}]}); chk("huge range refused", False)
    except ValueError:
        chk("huge range refused", True)
    b = bs.put({"id": "ok", "ranges": [{"start": 1.46e8, "stop": 1.461e8, "step": 25000, "mode": 'nfm" onfocus="x'}]})
    chk("range mode cleaned", b["ranges"][0]["mode"] == "nfm", b["ranges"][0]["mode"])
    chk("range expands", len(banks.BankStore.expand(b)) == 5)
    chk("old bad range is skipped, not looped", banks.BankStore.expand({"ranges": [{"start": 1e8, "stop": 1e8, "step": 0, "mode": "am", "bw": 1}]}) == [])

    # ---- the saved MQTT password belongs to the saved broker
    cfg.update({"mqtt": {"host": "10.0.0.5", "user": "ha", "pass": "secret"}})
    cfg.update({"mqtt": {"host": "10.0.0.5", "on": True}})
    chk("same broker keeps its password", cfg["mqtt"]["pass"] == "secret")
    cfg.update({"mqtt": {"host": "203.0.113.9"}})
    chk("new broker address drops the old password", cfg["mqtt"]["pass"] == "")

    # ---- cover art: plain pictures only
    svg = (b"<svg xmlns='http://www.w3.org/2000/svg'><script>1</script>" + b" " * 600 + b"</svg>", "image/svg+xml")
    png = (b"\x89PNG" + b"0" * 900, "image/png")
    u = "https://is1-ssl.mzstatic.com/image/a.jpg"
    chk("svg cover refused", art._keep(u, {}, lambda *a: svg) is None)
    chk("png cover kept", art._keep(u, {}, lambda *a: png) is not None)

    # ---- Host names (DNS rebinding) when sign-in is off
    for h, want in (("192.168.1.20:8073", True), ("[::1]:8073", True), ("localhost:8073", True), ("skywave", True),
                    ("radio.local", True), ("radio.home.arpa:8073", True), ("rebind.example:8073", False), ("", False)):
        chk("host %r %s" % (h, "allowed" if want else "refused"), server.host_allowed(h) == want)
finally:
    shutil.rmtree(d, ignore_errors=True)
print("ALL PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
