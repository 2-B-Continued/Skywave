"""The airports list: reading the OurAirports file, codes, the nearest airport, keeping it on disk, offline."""
import sys, os, json, tempfile
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import airports
ok = True
def check(n, c, x=""):
    global ok; print(("PASS " if c else "FAIL ") + n, x if not c else ""); ok = ok and bool(c)

HEAD = "id,ident,type,name,latitude_deg,longitude_deg,elevation_ft,continent,iso_country,iso_region,municipality,scheduled_service,icao_code,iata_code,gps_code,local_code,home_link,wikipedia_link,keywords\n"
ROWS = ['1,YSSY,large_airport,"Sydney Kingsford Smith International Airport",-33.9461,151.177,21,OC,AU,AU-NSW,Sydney,yes,YSSY,SYD,YSSY,,,,',
        '2,YSBK,medium_airport,"Sydney Bankstown Airport",-33.9244,150.988,29,OC,AU,AU-NSW,Sydney,yes,YSBK,BWU,YSBK,,,,',
        '3,YXXX,small_airport,"A farm strip",-33.95,151.18,10,OC,AU,AU-NSW,Nowhere,no,,,YXXX,,,,',
        '4,AU-0001,heliport,"A helipad",-33.94,151.17,10,OC,AU,AU-NSW,Sydney,no,,,,,,,',
        '5,YMML,large_airport,"Melbourne International Airport",-37.6733,144.843,434,OC,AU,AU-VIC,Melbourne,yes,YMML,MEL,YMML,,,,']
text = HEAD + "\n".join(ROWS * 1)
rows = airports.parse_csv(text)
check("airports with flights kept, strips and helipads left out", sorted(r[0] for r in rows) == ["YMML", "YSBK", "YSSY"], rows)

d = tempfile.mkdtemp(); path = os.path.join(d, "airports.json")
many = HEAD + "\n".join(ROWS + ['%d,X%03d,medium_airport,"Field %d",%f,%f,0,OC,AU,AU-NSW,Town,yes,X%03d,,X%03d,,,,' % (10 + i, i, i, -10 - i * 0.01, 120 + i * 0.01, i, i) for i in range(1100)])
a = airports.Airports(path, download=lambda: many)
check("nothing before the list arrives", a.by_code("SYD") is None and a.nearest(-33.95, 151.18) is None)
check("downloaded", a.refresh(now=1000.0) and os.path.exists(path))
check("by code, three or four letters", a.by_code("syd")["name"].startswith("Sydney Kingsford") and a.by_code("YMML")["iata"] == "MEL")
n = a.nearest(-33.94, 151.17, 8)
check("the nearest airport", n and n["iata"] == "SYD" and n["km"] < 2, n)
check("none when nothing is close", a.nearest(-35.5, 149.0, 8) is None)
check("not downloaded again while fresh", a.refresh(now=1000.0 + 86400) is False)
b = airports.Airports(path, download=lambda: (_ for _ in ()).throw(AssertionError("downloaded")))
check("kept on disk", b.by_code("SYD") and b.refresh(now=1000.0 + 86400) is False)
c = airports.Airports(os.path.join(d, "x.json"), download=lambda: HEAD + ROWS[0])
check("a broken or tiny download is not used", c.refresh(now=5.0) is False and c.by_code("SYD") is None)
e = airports.Airports(os.path.join(d, "y.json"), offline=True, download=lambda: many)
check("offline: never downloads", e.refresh() is False and e.by_code("SYD") is None)
print("ALL PASS" if ok else "SOME FAILED"); sys.exit(0 if ok else 1)
