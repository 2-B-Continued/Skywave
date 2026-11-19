"""Every region's data is consistent: frequencies sit inside their bands, plans have no duplicates, the start
frequency is inside the FM band, and the band plan, scanner lists and simulator build for each one."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
import banks  # noqa: E402
import countries  # noqa: E402
import regions  # noqa: E402
import sim  # noqa: E402

fails = []


def check(name, ok, info=""):
    print(("ok   " if ok else "FAIL ") + name + ("" if ok else "  " + str(info)))
    if not ok:
        fails.append(name)


for rid, r in regions.REGIONS.items():
    for cc, o in r["by_country"].items():
        check(rid + ": " + cc + "'s differences are real settings", set(o) <= set(r), sorted(set(o) - set(r)))
        check(rid + ": " + cc + " belongs to this entry", countries.region_of(cc) == rid, countries.region_of(cc))
    p = regions.public(rid)
    json.dumps(p)
    lo2, hi2 = r["ham_2m"]
    check(rid + ": APRS inside its 2 m band", lo2 <= r["aprs"] <= hi2, r["aprs"])
    if r["ham_call"]:
        check(rid + ": calling frequency inside its 2 m band", lo2 <= r["ham_call"][0] <= hi2, r["ham_call"])
    f0 = regions.fm_default(rid)
    check(rid + ": start frequency inside the FM band", r["fm"][0] <= f0 <= r["fm"][1], f0)
    check(rid + ": AM raster is 9 or 10 kHz", r["am"][2] in (9e3, 10e3), r["am"])
    w = p["walkie"]
    for key in r["short"]:
        chans = regions.SHORT_PLANS[key]["fn"]()
        fs = [c["f"] for c in chans]
        check(rid + ": " + key + " has no duplicate channels", len(fs) == len(set(fs)))
        if w and key == r["short"][0] and key in regions.WALKIE:
            check(rid + ": " + key + " channels inside the walkie-talkie button's range", all(w["lo"] <= f <= w["hi"] for f in fs),
                  [f for f in fs if not w["lo"] <= f <= w["hi"]][:3])
    banks.set_region(rid)
    names = [b[2] for b in banks.BAND_PLAN]
    check(rid + ": band plan has FM and AM", "FM radio" in names and "AM radio" in names, names)
    st = sim.default_stations(0.0, 0.0, rid)
    fm = [s.freq for s in st if getattr(s, "kind", "") == "wfm"]
    check(rid + ": simulated FM stations inside the band", fm and all(r["fm"][0] <= f <= r["fm"][1] for f in fm), fm)
    check(rid + ": at least one country shares it", len(countries.MEMBERS.get(rid, [])) > 0)

check("Japan's FM band is 76 to 95 MHz", regions.get("jp")["fm"] == (76e6, 95e6))
check("Japan starts inside its band", regions.fm_default("jp") == 85.5e6)
check("the Americas tune AM in 10 kHz steps", all(regions.get(k)["am"][2] == 10e3 for k in ("us", "latam")))
check("75 us de-emphasis in the Americas and South Korea only",
      sorted(k for k, v in regions.REGIONS.items() if v["deemph_us"] == 75) == ["kr", "latam", "us"])
check("each country's own APRS frequency within a shared entry",
      regions.get("au", "NZ")["aprs"] == 144.575e6 and regions.get("au", "AU")["aprs"] == 145.175e6
      and regions.get("latam", "BR")["aprs"] == 145.570e6 and regions.get("cn", "ID")["aprs"] == 144.390e6)
check("every country and territory belongs to exactly one entry", len(countries.REGION_OF) == len(countries.NAMES) == 250
      and all(r in regions.REGIONS for r in countries.REGION_OF.values()))
check("the picker lists every country once", sorted(c[0] for e in regions.picker() for c in e["countries"]) == sorted(countries.NAMES))
check("US-associated Pacific islands follow American settings inside Oceania",
      regions.get("au", "PW")["am"][2] == 10e3 and regions.get("au", "PW")["deemph_us"] == 75 and regions.walkie("au", "PW")["name"] != "UHF CB")
check("Russia and Central Asia have LPD433 channels", any(b["id"] == "lpd433" for b in regions.short_banks("ru")))
check("Liberia and Myanmar default to imperial units", regions.get("af", "LR")["units"] == "imperial" and regions.get("vn", "MM")["units"] == "imperial")
check("single-country ids map onto their shared entry", regions.canon("nz") == "au" and regions.canon("uk") == "eu"
      and regions.canon("ca") == "us" and regions.canon("br") == "latam" and regions.canon("sg") == "my" and regions.canon("za") == "af")
check("countries map to their entry", countries.region_of("NZ") == "au" and countries.region_of("CL") == "latam"
      and countries.region_of("HK") == "cn" and countries.region_of("GB") == "eu" and countries.region_of("ZA") == "af"
      and countries.region_of("KZ") == "ru" and countries.region_of("PK") == "in" and countries.region_of("fj") == "au")
check("Australia and New Zealand have UHF CB, Europe PMR446", regions.walkie("au")["name"] == "UHF CB" and regions.walkie("eu")["name"] == "PMR446")
check("Thailand's walkie-talkie button is CB 245", regions.walkie("th")["name"] == "CB 245")
check("no walkie-talkie button where none is confirmed", regions.walkie("tw") is None and regions.walkie("vn") is None)
check("an unknown region falls back to international", regions.public("zz")["id"] == "intl")
banks.set_region("intl")
print("ALL PASS" if not fails else "FAILED: " + ", ".join(fails))
sys.exit(1 if fails else 0)
