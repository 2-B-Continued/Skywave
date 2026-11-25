"""Aircraft details, routes and flown paths: parsed, merged, checked against where the plane is, kept, offline
handled, nothing odd passed on."""
import sys, os, json, gzip, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import planeinfo, airports
ok = True
def check(n, c, x=""):
    global ok; print(("PASS " if c else "FAIL ") + n, x if not c else ""); ok = ok and bool(c)
calls = []
AP = lambda n, i, c, city, cc, la, lo: {"name": n, "iata_code": i, "icao_code": c, "municipality": city, "country_iso_name": cc, "latitude": la, "longitude": lo}
QANTAS = {"name": "Qantas", "icao": "QFA", "iata": "QF", "country": "Australia", "country_iso": "AU", "callsign": "QANTAS"}
DB = {   # adsbdb: callsign -> flightroute
    "BAW455": {"callsign_iata": "BA455", "airline": {"name": "British Airways", "icao": "BAW", "iata": "BA", "country_iso": "GB"},
               "origin": AP("London Heathrow Airport", "LHR", "EGLL", "London", "GB", 51.47, -0.46),
               "destination": AP("Edinburgh Airport", "EDI", "EGPH", "Edinburgh", "GB", 55.95, -3.37)},
    # an old route for a Qantas flight number that now flies elsewhere
    "QFA595": {"callsign_iata": "QF595", "airline": QANTAS,
               "origin": AP("Brisbane Airport", "BNE", "YBBN", "Brisbane", "AU", -27.38, 153.12),
               "destination": AP("Cairns Airport", "CNS", "YBCS", "Cairns", "AU", -16.88, 145.75)},
    "QFA777": {"callsign_iata": "QF777", "airline": QANTAS,
               "origin": AP("Perth Airport", "PER", "YPPH", "Perth", "AU", -31.94, 115.97),
               "destination": AP("Darwin International Airport", "DRW", "YPDN", "Darwin", "AU", -12.41, 130.88)},
    "VOI123": {"callsign_iata": "Y4123", "airline": {"name": "Volaris", "icao": "VOI", "iata": "Y4", "country_iso": "MX"},
               "origin": AP("Mexico City International Airport", "MEX", "MMMX", "Mexico City", "MX", 19.44, -99.07),
               "destination": AP("Cancun International Airport", "CUN", "MMUN", "Cancun", "MX", 21.04, -86.87)},
    "XAMX7": {"callsign_iata": "AM7", "airline": {"name": "Aeromexico", "icao": "AMX", "iata": "AM", "country_iso": "MX"},
              "origin": AP("Mexico City International Airport", "MEX", "MMMX", "Mexico City", "MX", 19.44, -99.07),
              "destination": AP("Monterrey International Airport", "MTY", "MMMY", "Monterrey", "MX", 25.78, -100.11)},
}
SET = {"QFA1": [{"name": "Sydney Kingsford Smith International Airport", "iata": "SYD", "icao": "YSSY", "location": "Sydney", "countryiso2": "AU", "lat": -33.95, "lon": 151.18},
                {"name": "Singapore Changi Airport", "iata": "SIN", "icao": "WSSS", "location": "Singapore", "countryiso2": "SG", "lat": 1.36, "lon": 103.99},
                {"name": "London Heathrow Airport", "iata": "LHR", "icao": "EGLL", "location": "London", "countryiso2": "GB", "lat": 51.47, "lon": -0.46}],
       "JST500": [{"iata": "MEL", "icao": "YMML", "name": "Melbourne Airport", "location": "Melbourne", "countryiso2": "AU", "lat": -37.67, "lon": 144.84},
                  {"iata": "SYD", "icao": "YSSY", "name": "Sydney Airport", "location": "Sydney", "countryiso2": "AU", "lat": -33.95, "lon": 151.18}]}
VRS = {"QFA595": {"callsign": "QFA595", "airport_codes": "YSSY-YMML"}}
HEX = {"JST500": {"flight": "JST500", "route": "YSSY-YMML"}}
TRACES = {   # address -> first point of the network's track: [secs, lat, lon, altitude]
    "7c6db5": [[0, -33.9, 151.1, "ground", 10, 0, 0], [60, -33.8, 151.0, 2000, 180, 300, 0],
               [7200, -20.0, 140.0, 38000, 480, 300, 2], [7260, -19.9, 139.9, 38000, 480, 300, 0], [7320, -19.8, 139.8, None, 480, 300, 0]],
    "7c7777": [[0, -33.946, 151.177, "ground", 10, 0, 2], [300, -34.5, 150.5, 20000, 400, 230, 0]],
    "7c8888": [[0, -33.946, 151.177, "ground", 10, 0, 2], [300, -34.0, 150.9, 9000, 300, 250, 0]],
}
def fake(url, body=None):
    calls.append((url, body))
    if url.endswith("/aircraft/400c99"):
        return 200, json.dumps({"response": {"aircraft": {"type": "A320-232", "icao_type": "A320", "manufacturer": "Airbus", "registration": "G-EUPT",
            "registered_owner": "British Airways", "registered_owner_country_name": "United Kingdom", "registered_owner_country_iso_name": "GB",
            "url_photo": "https://airport-data.com/images/aircraft/000/1.jpg", "url_photo_thumbnail": "javascript:alert(1)"}}}).encode()
    if "/callsign/" in url:
        cs = url.rsplit("/", 1)[1]
        return (200, json.dumps({"response": {"flightroute": dict(DB[cs], callsign=cs)}}).encode()) if cs in DB else (404, b'{"response":"unknown callsign"}')
    if url.endswith("/routeset"):
        cs = body["planes"][0]["callsign"]
        if "adsb.im" in url and cs == "QFA1":
            return 500, b""                       # the first service is down: the stand-in answers
        return 200, json.dumps([{"callsign": cs, "_airports": SET.get(cs, []), "plausible": [True]}]).encode()
    if "vrs-standing-data" in url:
        cs = url.rsplit("/", 1)[1][:-5]
        return (200, json.dumps(VRS[cs]).encode()) if cs in VRS else (404, b"")
    if "hexdb.io" in url:
        cs = url.rsplit("/", 1)[1]
        return (200, json.dumps(HEX[cs]).encode()) if cs in HEX else (404, b"")
    if url.endswith("/hex/7c6db5"):
        return 200, json.dumps({"ac": [{"hex": "7c6db5", "r": "VH-OQA", "t": "A388", "desc": "AIRBUS A-380-800", "ownOp": "Qantas", "year": "2008"}]}).encode()
    for k, tr in TRACES.items():
        if "trace_full_" + k in url:
            return 200, gzip.compress(json.dumps({"icao": k, "timestamp": 1000, "trace": tr}).encode())
    return 404, json.dumps({"response": "unknown aircraft"}).encode()

d = tempfile.mkdtemp()
AIR = airports.Airports(os.path.join(d, "airports.json"), offline=True)
AIR._index([["YSSY", "SYD", "Sydney Kingsford Smith Airport", "Sydney", "AU", -33.9461, 151.1772, 4],
            ["YSBK", "BWU", "Sydney Bankstown Airport", "Sydney", "AU", -33.9244, 150.9883, 3],
            ["YMML", "MEL", "Melbourne Airport", "Melbourne", "AU", -37.6733, 144.8433, 4],
            ["YBBN", "BNE", "Brisbane Airport", "Brisbane", "AU", -27.3842, 153.1175, 4]], 1)
p = os.path.join(d, "pi.json"); pi = planeinfo.PlaneInfo(p, AIR)

r = pi.get("400C99", "BAW455 ", 52.0, -1.0, fetch=fake)
check("registration, model and owner", r["aircraft"]["registration"] == "G-EUPT" and r["aircraft"]["icao_type"] == "A320", r)
check("route from adsbdb when it is the only source", r["route"]["origin"]["iata"] == "LHR" and r["route"]["destination"]["city"] == "Edinburgh" and r["route"]["source"] == "adsbdb", r["route"])
check("flight number and airline", r["route"]["flight"] == "BA455" and r["route"]["airline"] == "British Airways" and "airline_callsign" not in r["route"], r["route"])
check("only https photo links passed on", r["aircraft"]["url_photo"].startswith("https://") and r["aircraft"]["url_photo_thumbnail"] is None)
n = len(calls); pi.get("400c99", "BAW455", 52.0, -1.0, fetch=fake); check("kept: no second request", len(calls) == n)
pi.save(force=True); pi2 = planeinfo.PlaneInfo(p, AIR)
check("kept on disk", pi2.get("400c99", "BAW455", 52.0, -1.0, fetch=fake)["aircraft"]["registration"] == "G-EUPT" and len(calls) == n)

r = pi.get("7c6db5", "QFA1", -20, 140, fetch=fake)
check("routeset: stops kept, the stand-in service used when the first is down", r["route"]["origin"]["iata"] == "SYD" and r["route"]["destination"]["iata"] == "LHR"
      and r["route"]["stops"][0]["iata"] == "SIN" and r["route"]["source"] == "adsb.lol", r["route"])
check("the routeset was sent the plane's position", any(b and b["planes"][0] == {"callsign": "QFA1", "lat": -20, "lng": 140} for u, b in calls))
check("model from the network when adsbdb has no record", r["aircraft"]["icao_type"] == "A388" and r["aircraft"]["registration"] == "VH-OQA", r["aircraft"])

# a reused flight number: adsbdb still has an old route, the standing data has today's, given as airport codes
r = pi.get("7c1111", "QFA595", -34.6, 150.0, fetch=fake)["route"]
check("an out-of-date route is passed over for one that fits", r and r["origin"]["iata"] == "SYD" and r["destination"]["iata"] == "MEL" and r["source"] == "VRS standing data", r)
check("airport codes are filled in from the airports list", r and r["destination"]["name"] == "Melbourne Domestic Airport" and r["destination"]["lat"] == -37.6733, r)
check("the airline and flight number still shown, from the airline's code", r and r["airline"] == "Qantas" and r["flight"] == "QF595", r)

# two sources disagree on direction: the takeoff airport settles it
r = pi.get("7c7777", "JST500", -34.5, 150.5, fetch=fake)["route"]
check("sources that disagree are settled by where the plane took off", r and r["origin"]["iata"] == "SYD" and r["destination"]["iata"] == "MEL" and r["source"] == "hexdb.io", r)

# no route on record fits, but the plane's track shows where it took off
r = pi.get("7c8888", "QFA777", -34.0, 150.9, fetch=fake)["route"]
check("no route fits: the takeoff airport is shown on its own", r and r["origin"]["iata"] == "SYD" and r["destination"] is None and r["source"] == "track", r)
check("with the airline and flight number", r and r["airline"] == "Qantas" and r["flight"] == "QF777", r)
check("the takeoff airport is kept", pi.takeoff("7c8888", "QFA777", fetch=lambda *a: (_ for _ in ()).throw(AssertionError("asked again")))["iata"] == "SYD")

# a callsign is not unique worldwide: a route on the far side of the world is never shown here
r = pi.get("7c1234", "VOI123", -33.9, 151.2, fetch=fake)["route"]
check("a route nowhere near the plane is hidden", r and not r.get("origin") and r.get("mismatch"), r)
check("the airline is kept when the callsign carries its code", r.get("airline") == "Volaris" and r.get("flight") == "Y4123", r)
r = pi.get("7c1235", "VOI123", fetch=fake, home=(-33.87, 151.21))["route"]
check("before the plane has a position, the receiver's position is used", r and not r.get("origin"), r)
r = pi.get("0d0123", "VOI123", 20.5, -93.0, fetch=fake)["route"]
check("the same route is shown for a plane on it", r["origin"]["iata"] == "MEX" and r["flight"] == "Y4123", r)
r = pi.get("7c5555", "XAMX7", -33.9, 151.2, fetch=fake)["route"]
check("a faraway record's airline is dropped when the callsign isn't that airline's code", r and r.get("mismatch") and not r.get("airline"), r)

# a multi-stop route cut to start where the plane took off
raw = {"set": pi._record({"_airports": SET["QFA1"]}, "adsb.im")}
r, _ = pi._compose(raw, "QFA1", (10.0, 80.0), None, {"iata": "SIN", "icao": "WSSS", "lat": 1.36, "lon": 103.99})
check("a multi-stop route starts at the stop it took off from", r and r["origin"]["iata"] == "SIN" and r["destination"]["iata"] == "LHR" and r["stops"] == [], r)

t = pi.trace("7C6DB5", fetch=fake)
check("trace: only the latest leg, gzip unpacked", t["ok"] and len(t["points"]) == 3 and t["points"][0] == [8200, -20.0, 140.0, 38000], t)
check("trace: missing altitude passed as none", t["points"][-1][3] is None)
n = len(calls); pi.trace("7c6db5", fetch=fake); check("trace kept for a minute", len(calls) == n)
r = pi.get("abcdef", "", fetch=fake); check("unknown aircraft: none, and remembered", r["aircraft"] is None and r["ok"])
def down(url, body=None): raise OSError("offline")
r = pi.get("123456", "XYZ1", fetch=down); check("offline: says so", not r["ok"] and r["aircraft"] is None)
check("offline trace: says so", pi.trace("123456", fetch=down)["ok"] is False)
n = len(calls); check("bad address: no request", pi.get("../etc", "", fetch=fake)["aircraft"] is None and pi.trace("../etc", fetch=fake)["points"] == [] and len(calls) == n)
check("a long route still fits a plane well off the straight line", planeinfo.route_fits(
    {"origin": {"lat": 51.47, "lon": -0.46}, "destination": {"lat": 40.64, "lon": -73.78}}, (48.0, -40.0)) is True)
check("distance to a route leg", abs(planeinfo._leg_km((0, 10), (0, 0), (0, 20))) < 1 and abs(planeinfo._leg_km((0, 30), (0, 0), (0, 20)) - 1112) < 5)
open(p, "w").write(json.dumps({"ac": {"400c99": [0, {"registration": "OLD"}]}, "rt": {}}))
check("an older cache file is not used", planeinfo.PlaneInfo(p).ac == {})
print("ALL PASS" if ok else "SOME FAILED"); sys.exit(0 if ok else 1)
