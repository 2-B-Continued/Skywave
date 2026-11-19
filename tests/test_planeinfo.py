"""Aircraft details and routes from adsbdb: parsed, kept, offline handled, nothing odd passed on."""
import sys, os, json, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import planeinfo
ok = True
def check(n, c, x=""):
    global ok; print(("PASS " if c else "FAIL ") + n, x); ok = ok and bool(c)
calls = []
def fake(url):
    calls.append(url)
    if "400c99" in url:
        return 200, json.dumps({"response": {"aircraft": {"type": "A320-232", "icao_type": "A320", "manufacturer": "Airbus", "registration": "G-EUPT",
            "registered_owner": "British Airways", "registered_owner_country_name": "United Kingdom", "registered_owner_country_iso_name": "GB",
            "url_photo": "https://airport-data.com/images/aircraft/000/1.jpg", "url_photo_thumbnail": "javascript:alert(1)"},
            "flightroute": {"callsign": "BAW455", "airline": {"name": "British Airways", "country": "United Kingdom"},
            "origin": {"name": "London Heathrow Airport", "iata_code": "LHR", "icao_code": "EGLL", "municipality": "London", "country_name": "United Kingdom"},
            "destination": {"name": "Edinburgh Airport", "iata_code": "EDI", "icao_code": "EGPH", "municipality": "Edinburgh", "country_name": "United Kingdom"}}}}).encode()
    return 404, json.dumps({"response": "unknown aircraft"}).encode()
p = os.path.join(tempfile.mkdtemp(), "pi.json"); pi = planeinfo.PlaneInfo(p)
r = pi.get("400C99", "BAW455 ", fake)
check("registration, type and owner", r["aircraft"]["registration"] == "G-EUPT" and r["aircraft"]["icao_type"] == "A320", r)
check("route with airport names", r["route"]["origin"]["iata_code"] == "LHR" and r["route"]["destination"]["municipality"] == "Edinburgh")
check("one request for both, callsign cleaned", len(calls) == 1 and calls[0].endswith("/400c99?callsign=BAW455"), calls)
check("only https photo links passed on", r["aircraft"]["url_photo"].startswith("https://") and r["aircraft"]["url_photo_thumbnail"] is None)
pi.get("400c99", "BAW455", fake); check("kept: no second request", len(calls) == 1)
pi.save(force=True); pi2 = planeinfo.PlaneInfo(p)
check("kept on disk", pi2.get("400c99", "BAW455", fake)["aircraft"]["registration"] == "G-EUPT" and len(calls) == 1)
r = pi.get("abcdef", "", fake); check("unknown aircraft: none, and remembered", r["aircraft"] is None and r["ok"] and len(calls) == 2)
def down(url): raise OSError("offline")
r = pi.get("123456", "XYZ1", down); check("offline: says so", not r["ok"] and r["aircraft"] is None)
check("bad address: no request", pi.get("../etc", "", fake)["aircraft"] is None and len(calls) == 2)
print("ALL PASS" if ok else "SOME FAILED"); sys.exit(0 if ok else 1)
