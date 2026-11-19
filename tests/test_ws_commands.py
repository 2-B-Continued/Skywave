"""Every command the web page sends over the WebSocket must be on the server's allowed list (an unlisted one is dropped
without a word, which is how the Morse switch and the gain finder once broke)."""
import os, re, sys
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
srv = open(os.path.join(root, "server.py")).read()
allowed = eval(re.search(r"WS_COMMANDS = (\{.*?\})", srv, re.S).group(1))
sent = set()
for f in os.listdir(os.path.join(root, "static", "js")):
    if f.endswith(".js") and f != "audio-net.js":     # the sound socket has its own small command set (quality)
        sent |= set(re.findall(r"cmd: '([a-z_]+)'", open(os.path.join(root, "static", "js", f)).read()))
missing = sorted(c for c in sent if c not in allowed)
print("PASS every page command is allowed" if not missing else "FAIL not allowed: %s" % missing)
print("ALL PASS" if not missing else "SOME FAILED")
sys.exit(1 if missing else 0)
