"""Terminals at any airport, from OpenStreetMap's terminals and gates and where the plane stood."""
import sys, os, json, tempfile, gzip
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import airportmap, planeinfo, airports
ok = True
def check(n, c, x=""):
    global ok; print(("PASS " if c else "FAIL ") + n, x if not c else ""); ok = ok and bool(c)

L = airportmap.terminal_label
check("terminal names", L({"ref": "1"}) == "T1" and L({"name": "Terminal 2"}) == "T2" and L({"name": "Terminal B"}) == "Terminal B"
      and L({"ref": "T3"}) == "T3" and L({"name": "Domestic Terminal"}) == "Domestic Terminal", [L({"ref": "1"}), L({"name": "Terminal 2"}), L({"name": "Terminal B"})])
check("domestic or international from the name", airportmap.kind_of("Domestic Terminal") == "domestic" and airportmap.kind_of("International Terminal") == "international" and airportmap.kind_of("T1") is None)

# a made-up airport at (10, 20): T1 to the west with gate 5, a Domestic Terminal to the east with no gates mapped
LAT, LON = 10.0, 20.0
dx = lambda m: m / (111320.0 * 0.98481)      # metres east -> degrees of longitude at 10 N
dy = lambda m: m / 110540.0
box = lambda x0, x1, y0, y1: [{"lat": LAT + dy(y), "lon": LON + dx(x)} for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0))]
OSM = {"elements": [
    {"type": "way", "tags": {"aeroway": "terminal", "name": "Terminal 1"}, "geometry": box(-900, -600, -100, 100)},
    {"type": "relation", "tags": {"aeroway": "terminal", "name": "Domestic Terminal"}, "members": [{"role": "outer", "geometry": box(600, 900, -100, 100)}]},
    {"type": "node", "tags": {"aeroway": "gate", "ref": "5"}, "lat": LAT + dy(150), "lon": LON + dx(-750)}]}
asked = []
import re
def fake(url, body):
    asked.append(body)
    la, lo = map(float, re.search(r"around:\d+,([-\d.]+),([-\d.]+)", body).groups())
    moved = json.loads(json.dumps(OSM).replace('"lat": ', '"lat": ').replace('"lon": ', '"lon": '))
    def mv(o):
        if isinstance(o, dict):
            if "lat" in o and "lon" in o:
                o["lat"] += la - LAT; o["lon"] += lo - LON
            for v in o.values(): mv(v)
        elif isinstance(o, list):
            for v in o: mv(v)
    mv(moved)
    return 200, json.dumps(moved).encode()
d = tempfile.mkdtemp()
maps = airportmap.AirportMaps(d, fetch=fake)
ap = {"icao": "XXXX", "iata": "XXX", "lat": LAT, "lon": LON}
m = maps.get(ap, wait=True)
check("the airport's terminals and gates", m and len(m["terminals"]) == 2 and len(m["gates"]) == 1, m and (len(m["terminals"]), len(m["gates"])))
check("only the airport's position is sent", asked and "around:4500,10.0,20.0" in asked[0] and "aeroway" in asked[0])
stand = (LAT + dy(165), LON + dx(-745))
taxi = (LAT + dy(900), LON + dx(0))
r = maps.locate(m, [taxi, stand])
check("parked at gate 5: Terminal 1, gate 5", r and r["terminal"] == "T1" and r["gate"] == "5", r)
r = maps.locate(m, [(LAT + dy(220), LON + dx(750))])
check("beside a terminal with no gates mapped: that terminal", r and r["terminal"] == "Domestic Terminal" and r["kind"] == "domestic", r)
check("out on a taxiway: none", maps.locate(m, [taxi]) is None)
n = len(asked); maps2 = airportmap.AirportMaps(d, fetch=fake)
check("the map is kept on disk", maps2.get(ap) and len(asked) == n)
maps.remember("XXXX", "ABC", "domestic", "T1"); check("one sighting is not yet usual", maps.usual("XXXX", "ABC", "domestic") is None)
maps.remember("XXXX", "ABC", "domestic", "T1"); check("two make it usual", maps.usual("XXXX", "ABC", "domestic") == "T1")
check("remembered on disk", airportmap.AirportMaps(d, fetch=fake).usual("XXXX", "ABC", "domestic") == "T1")

# through the plane lookup: the track shows where the plane stood before takeoff and after landing
AIR = airports.Airports(os.path.join(d, "a.json"), offline=True)
AIR._index([["XXXX", "XXX", "Test Field", "Testville", "ZZ", LAT, LON, 4], ["YYYY", "YYY", "Other Field", "Otherton", "ZZ", LAT + 2, LON + 2, 4]], 1)
pi = planeinfo.PlaneInfo(os.path.join(d, "pi.json"), AIR, maps)
TR = {"icao": "abc123", "timestamp": 1000, "trace": [
    [0, stand[0], stand[1], "ground", 0, 0, 2], [600, stand[0], stand[1], "ground", 0, 0, 0], [700, taxi[0], taxi[1], "ground", 15, 0, 0],
    [900, LAT + 0.1, LON + 0.1, 3000, 200, 45, 0], [3000, LAT + 1.9, LON + 1.9, 2000, 180, 45, 0],
    [3400, LAT + 2 + dy(165), LON + 2 + dx(-745), "ground", 0, 0, 0]]}
def pf(url, body=None):
    if "trace_full_abc123" in url:
        return 200, gzip.compress(json.dumps(TR).encode())
    if "/callsign/" in url:
        return 200, json.dumps({"response": {"flightroute": {"callsign": "ABC12", "callsign_iata": "AB12", "airline": {"name": "Alpha", "icao": "ABC", "iata": "AB"},
            "origin": {"name": "Test Field", "iata_code": "XXX", "icao_code": "XXXX", "municipality": "Testville", "country_iso_name": "ZZ", "latitude": LAT, "longitude": LON},
            "destination": {"name": "Other Field", "iata_code": "YYY", "icao_code": "YYYY", "municipality": "Otherton", "country_iso_name": "ZZ", "latitude": LAT + 2, "longitude": LON + 2}}}}).encode()
    return 404, b"{}"
OSM2 = json.loads(json.dumps(OSM))
r = pi.get("abc123", "ABC12", LAT + 1.9, LON + 1.9, fetch=pf)["route"]
check("departure terminal and gate from where it was parked", r["origin"].get("terminal") == "T1" and r["origin"].get("gate") == "5" and r["origin"].get("terminal_seen"), r["origin"])
maps.get({"icao": "YYYY", "lat": LAT + 2, "lon": LON + 2}, wait=True)
pi.tr.clear()
r = pi.get("abc123", "ABC12", LAT + 1.9, LON + 1.9, fetch=pf)["route"]
check("arrival terminal from where it parked", r["destination"].get("terminal") == "T1" and r["destination"].get("terminal_seen"), r["destination"])
r = pi.get("abc999", "ABC12", LAT + 1.9, LON + 1.9, fetch=pf, chosen=False)["route"]
check("another flight of the airline: the usual terminal, not marked seen", r["origin"].get("terminal") == "T1" and not r["origin"].get("terminal_seen"), r["origin"])
off = airportmap.AirportMaps(tempfile.mkdtemp(), offline=True, fetch=lambda *a: (_ for _ in ()).throw(AssertionError("asked")))
check("offline: never asks", off.get(ap) is None)
print("ALL PASS" if ok else "SOME FAILED"); sys.exit(0 if ok else 1)
