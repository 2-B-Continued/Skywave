"""regions.py - what differs from country to country: short-range radio channels, steps, APRS frequency, units.

The default region is "intl" (international / not set). Everything here is a starting point built from public band
plans. Rules differ between countries and change over time, so check your national regulator before transmitting
anything; this program only listens.
"""
import functools

import countries


# ---------------------------------------------------------------------------------------------- channel plans
# Each plan function returns a list of {"f": Hz, "label": str, "mode": str, "bw": Hz} sorted by frequency.


def _ch(f, label, mode="nfm", bw=12500):
    return {"f": int(round(f)), "label": label, "mode": mode, "bw": bw}


# --- Australia: UHF CB, 80 channels, 12.5 kHz apart (ACMA class licence)
AU_CB_REPEATER_OUT = {n: n + 30 for n in list(range(1, 9)) + list(range(41, 49))}
AU_CB_REPEATER_IN = {v: k for k, v in AU_CB_REPEATER_OUT.items()}
AU_CB_SPECIAL = {5: "emergency (official)", 35: "emergency repeater input (official)", 9: "general", 10: "4WD, convoys, parks",
                 11: "calling channel", 18: "caravan / camper convoys", 22: "data only", 23: "data only",
                 29: "road channel", 30: "broadcasts", 40: "road safety (national)"}


def au_cb_freq(n):
    if 1 <= n <= 40:
        return round(476.400e6 + n * 25e3)
    if 41 <= n <= 80 and n not in (61, 62, 63):
        return round(476.4125e6 + (n - 40) * 25e3)
    return None


def au_cb_label(n):
    if n in AU_CB_REPEATER_OUT:
        s = "CH%d repeater out" % n
    elif n in AU_CB_REPEATER_IN:
        s = "CH%d repeater in (CH%d handsets)" % (n, AU_CB_REPEATER_IN[n])
    else:
        s = "CH%d" % n
    if n in AU_CB_SPECIAL:
        s += " " + AU_CB_SPECIAL[n]
    return s


def plan_au_uhf_cb(simplex_only=False):
    out = []
    for n in range(1, 81):
        f = au_cb_freq(n)
        if f is None or (simplex_only and (n in AU_CB_REPEATER_OUT or n in AU_CB_REPEATER_IN)):
            continue
        out.append(_ch(f, au_cb_label(n)))
    return sorted(out, key=lambda c: c["f"])


# --- Europe / UK / most of the world: PMR446, 16 analogue channels at 12.5 kHz
def plan_pmr446():
    return [_ch(446.00625e6 + (n - 1) * 12.5e3, "PMR446 channel %d" % n) for n in range(1, 17)]


# --- North America: FRS/GMRS, 22 channels
_FRS = [462.5625, 462.5875, 462.6125, 462.6375, 462.6625, 462.6875, 462.7125,          # 1-7
        467.5625, 467.5875, 467.6125, 467.6375, 467.6625, 467.6875, 467.7125,          # 8-14
        462.5500, 462.5750, 462.6000, 462.6250, 462.6500, 462.6750, 462.7000, 462.7250]  # 15-22


def plan_frs_gmrs():
    notes = {1: "popular", 3: "popular", 7: "popular", 9: "emergency (customary)", 20: "popular"}
    return sorted([_ch(f * 1e6, "FRS/GMRS channel %d%s" % (i + 1, (" " + notes[i + 1]) if (i + 1) in notes else ""))
                   for i, f in enumerate(_FRS)], key=lambda c: c["f"])


# --- 27 MHz Citizens' Band, 40 channels (AM, upper-sideband too). Needs HF reception (RTL-SDR V3/V4 or direct sampling).
_CB27 = [26.965, 26.975, 26.985, 27.005, 27.015, 27.025, 27.035, 27.055, 27.065, 27.075, 27.085, 27.105, 27.115, 27.125,
         27.135, 27.155, 27.165, 27.175, 27.185, 27.205, 27.215, 27.225, 27.255, 27.235, 27.245, 27.265, 27.275, 27.285,
         27.295, 27.305, 27.315, 27.325, 27.335, 27.345, 27.355, 27.365, 27.375, 27.385, 27.395, 27.405]


def plan_cb27():
    notes = {9: "emergency (customary)", 19: "trucker channel (North America)"}
    return sorted([_ch(f * 1e6, "CB channel %d%s" % (i + 1, (" " + notes[i + 1]) if (i + 1) in notes else ""), "am", 10000)
                   for i, f in enumerate(_CB27)], key=lambda c: c["f"])


# --- Japan: specified low-power radio (tokutei shou-denryoku), 20 simplex channels: 11 business + 9 leisure, 12.5 kHz
def plan_jp_lowpower():
    biz = [_ch(422.0500e6 + i * 12.5e3, "Low-power business channel %d" % (i + 1)) for i in range(11)]
    lei = [_ch(422.2000e6 + i * 12.5e3, "Low-power leisure channel %d" % (i + 1)) for i in range(9)]
    return biz + lei


# --- South Korea: licence-free personal radio, two blocks at 448 and 449 MHz, 12.5 kHz
def plan_kr_personal():
    a = [448.7375e6 + i * 12.5e3 for i in range(16)]
    b = [449.1375e6 + i * 12.5e3 for i in range(11)]
    return [_ch(f, "Personal radio channel %d" % (i + 1)) for i, f in enumerate(a + b)]


# --- China (also sold for Hong Kong and Indonesia): 409 MHz public walkie-talkies, 20 channels, 12.5 kHz
def plan_cn_409():
    return [_ch(409.7500e6 + i * 12.5e3, "409 MHz channel %d" % (i + 1)) for i in range(20)]


# --- Thailand: two 80-channel CB services, 245 MHz (red radios, the popular one) and 78 MHz (yellow radios), 12.5 kHz
def plan_th_cb245():
    return [_ch(245.0000e6 + i * 12.5e3, "CB 245 channel %d" % (i + 1)) for i in range(80)]


def plan_th_cb78():
    return [_ch(78.0000e6 + i * 12.5e3, "CB 78 channel %d" % (i + 1)) for i in range(80)]


# --- Philippines: Short Range Radio Service (SRRS), 325.0000-325.4875 MHz, 40 channels, 12.5 kHz
def plan_ph_srrs():
    return [_ch(325.0000e6 + i * 12.5e3, "SRRS channel %d" % (i + 1)) for i in range(40)]


# --- Russia and neighbours: LPD433, 69 channels from 433.075 to 434.775 MHz, 25 kHz apart
def plan_lpd433():
    return [_ch(433.075e6 + i * 25e3, "LPD channel %d" % (i + 1)) for i in range(69)]


# --- PMR446 where only the first 8 analogue channels are licence-free (Singapore, Malaysia)
def plan_pmr446_8():
    return plan_pmr446()[:8]


def plan_noaa_wx():
    return [_ch(f * 1e6, "NOAA Weather Radio %.3f" % f, "nfm", 16000) for f in (162.400, 162.425, 162.450, 162.475, 162.500, 162.525, 162.550)]


def plan_marine():
    keys = {6: "ship-to-ship safety", 9: "calling (recreational)", 13: "bridge-to-bridge", 16: "distress and calling",
            67: "", 68: "", 69: "", 72: "ship-to-ship", 73: "", 77: "ship-to-ship"}
    out = []
    for n, note in keys.items():
        f = 156.050e6 + (n - 1) * 50e3 if n <= 28 else 156.025e6 + (n - 60) * 50e3
        out.append(_ch(f, ("CH%d %s" % (n, note)).strip(), "nfm", 16000))
    return sorted(out, key=lambda c: c["f"])


# ---------------------------------------------------------------------------------------------- regions
EMERGENCY_NOTE = ("Many police, fire and ambulance networks are digital, trunked or encrypted, and an RTL-SDR cannot decode them. "
                  "Laws about listening to and recording radio differ by country: check yours.")

# fm: the FM broadcast band; am: (low, high, step); ham_2m / ham_70: the amateur bands; ham_call: the 2 m FM calling
# frequency where there is a well-known one; short: walkie-talkie plans (SHORT_PLANS); wx: NOAA-style weather radio;
# acars: which aircraft message channels (datalink.ACARS_CHANNELS); group: a broad part of the world.
_FM = (87.5e6, 108e6)
_AM9 = (531e3, 1602e3, 9e3)
_AM10 = (530e3, 1700e3, 10e3)
_AIR = [(121.5e6, "International emergency")]
_SEN433 = "433.92 MHz is the most common for home sensors."
_SEN_AS = "433.92 MHz is common in imported sensors; newer devices use 920 to 925 MHz."


def _r(name, group, aprs, aprs_note, ism, sensor_note, short, ham_2m=(144e6, 146e6), ham_70=(430e6, 440e6), ham_call=None,
       fm=_FM, am=_AM9, fm_step=100e3, deemph_us=50, air=None, wx=False, units="metric", acars="default",
       by_country=None):
    return {"name": name, "group": group, "fm": fm, "fm_step": fm_step, "am": am, "am_step": am[2], "deemph_us": deemph_us,
            "aprs": aprs, "aprs_note": aprs_note, "ism": ism, "sensor_note": sensor_note, "short": short, "ham_2m": ham_2m,
            "ham_70": ham_70, "ham_call": ham_call, "air": air or _AIR, "wx": wx, "units": units, "acars": acars,
            "by_country": by_country or {}}


# One entry per set of countries that share their settings. Where a country in a set differs in a detail (an APRS
# frequency, a ham band edge), "by_country" holds just that difference; it is applied from the country of the saved
# location (config "country").
_PACIFIC_US = {"short": ["frs_gmrs", "cb27"], "am": _AM10, "am_step": _AM10[2], "deemph_us": 75}
_PACIFIC_FR = {"short": ["pmr446", "cb27"]}

REGIONS = {
    "intl": _r("Somewhere else / not sure", "", 144.800e6, "144.800 MHz in Europe and Africa; 144.390 MHz in the Americas",
               [433.92e6, 868.3e6], _SEN433, ["pmr446", "cb27"], ham_call=(145.500e6, "2 m FM calling (IARU Region 1)")),
    "au": _r("Oceania", "Oceania", 145.175e6, "145.175 MHz in Australia, 144.575 MHz in New Zealand",
             [433.92e6, 918e6], "433.92 MHz is the most common; some newer devices use 915 to 928 MHz.", ["au_uhf_cb"],
             ham_2m=(144e6, 148e6), ham_70=(420e6, 450e6), ham_call=(146.500e6, "2 m calling"), acars="AU",
             air=_AIR + [(123.45e6, "Air-to-air"), (126.7e6, "Local airfield (CTAF)")],
             by_country=dict({"NZ": {"aprs": 144.575e6, "ham_70": (430e6, 440e6)}},
                             **{c: _PACIFIC_US for c in ("FM", "MH", "PW")}, **{c: _PACIFIC_FR for c in ("NC", "PF", "WF")})),
    "us": _r("United States and Canada", "Americas", 144.390e6, "144.390 MHz in North America", [433.92e6, 315e6, 915e6],
             "433.92 and 915 MHz are most common; garage doors and car fobs use 315 MHz.", ["frs_gmrs", "cb27"],
             ham_2m=(144e6, 148e6), ham_70=(420e6, 450e6), ham_call=(146.520e6, "2 m national calling"), am=_AM10, fm_step=200e3,
             deemph_us=75, wx=True, units="imperial", acars="US",
             air=_AIR + [(122.75e6, "Air-to-air"), (122.8e6, "UNICOM (small airports)"), (122.9e6, "MULTICOM")],
             by_country={"CA": {"ham_70": (430e6, 450e6), "units": "metric"}, "BM": {"units": "metric", "wx": False},
                         "PM": {"units": "metric", "wx": False, "short": ["pmr446", "cb27"]}}),
    "latam": _r("Latin America and the Caribbean", "Americas", 144.390e6,
                "144.390 MHz in Mexico, Colombia and Chile; 145.570 MHz in Brazil; 144.930 MHz in Argentina and Uruguay",
                [433.92e6, 915e6, 315e6], "433.92 and 915 MHz are most common; car fobs often use 315 MHz.", ["cb27"],
                ham_2m=(144e6, 148e6), am=_AM10, deemph_us=75, acars="US",
                by_country={"BR": {"aprs": 145.570e6}, "AR": {"aprs": 144.930e6}, "UY": {"aprs": 144.930e6},
                            "MX": {"ham_70": (430e6, 450e6)}}),
    "eu": _r("Europe", "Europe", 144.800e6, "144.800 MHz across Europe", [433.92e6, 868.3e6],
             "433.92 and 868.3 MHz are the most common for home sensors.", ["pmr446", "cb27"],
             ham_call=(145.500e6, "2 m FM calling"), acars="EU"),
    "ru": _r("Russia and Central Asia", "Europe and Asia", 144.800e6, "144.800 MHz in Russia and Central Asia",
             [433.92e6, 868.8e6], "433.92 MHz is the most common; some newer devices use 868.7 to 869.2 MHz.", ["pmr446", "lpd433"],
             ham_call=(145.500e6, "2 m FM calling"), acars="EU"),
    "af": _r("Africa and Western Asia", "Africa and Western Asia", 144.800e6, "144.800 MHz in Africa and the Middle East",
             [433.92e6, 868.3e6], _SEN433, ["pmr446", "cb27"], ham_call=(145.500e6, "2 m FM calling"), acars="EU",
             by_country={"LR": {"units": "imperial"}}),
    "in": _r("Southern Asia", "Asia", 144.390e6, "144.390 MHz in India", [433.92e6, 865e6],
             "433.92 MHz is the most common; some newer devices use 865 to 867 MHz.", ["pmr446"]),
    "cn": _r("China, Hong Kong, Macao and Indonesia", "Asia", 144.640e6,
             "144.640 MHz in China, Hong Kong and Macao; 144.390 MHz in Indonesia",
             [433.92e6, 315e6, 920e6], "433.92 MHz is the most common; car fobs use 315 MHz; newer devices 920 to 925 MHz.",
             ["cn_409"], ham_2m=(144e6, 148e6), by_country={"ID": {"aprs": 144.390e6}}),
    "my": _r("Singapore, Malaysia and Brunei", "Asia", 144.390e6, "144.390 MHz in Singapore and Malaysia", [433.92e6, 920e6],
             _SEN_AS, ["pmr446_8", "cb27"], ham_2m=(144e6, 148e6), ham_call=(145.000e6, "2 m national calling")),
    "vn": _r("Vietnam, Cambodia, Laos, Myanmar and Timor-Leste", "Asia", 144.390e6,
             "no national APRS frequency is confirmed here; 144.390 MHz is tried first",
             [433.92e6, 920e6], _SEN_AS, [], by_country={"MM": {"units": "imperial"}}),
    "jp": _r("Japan", "Asia", 144.660e6, "144.660 MHz in Japan (9600-baud APRS uses 144.640)", [315e6, 920e6],
             "Car keys and many sensors use 315 MHz; newer devices use 920 to 928 MHz.", ["jp_lowpower"],
             ham_call=(145.000e6, "2 m FM calling"), fm=(76e6, 95e6), acars="JP"),
    "kr": _r("South Korea", "Asia", 144.390e6, "no national APRS frequency is confirmed for Korea; 144.390 MHz is tried first",
             [433.92e6, 920e6], "433.92 MHz is common in imported sensors; newer devices use 917 to 923.5 MHz.", ["kr_personal"],
             deemph_us=75),
    "tw": _r("Taiwan", "Asia", 144.640e6, "144.640 MHz in Taiwan", [433.92e6, 920e6], _SEN_AS, []),
    "th": _r("Thailand", "Asia", 144.390e6, "144.390 MHz in Thailand", [433.92e6, 920e6], _SEN_AS, ["th_cb245", "th_cb78"]),
    "ph": _r("Philippines", "Asia", 144.390e6, "144.390 MHz in the Philippines", [433.92e6, 920e6], _SEN_AS, ["ph_srrs"],
             ham_2m=(144e6, 148e6)),
}
# single-country ids, each belonging to a shared entry
ALIASES = {"nz": "au", "ca": "us", "uk": "eu", "za": "af", "mx": "latam", "br": "latam", "ar": "latam", "hk": "cn", "id": "cn",
           "sg": "my"}
DEFAULT_REGION = "intl"

SHORT_PLANS = {
    "au_uhf_cb": {"id": "cb_uhf", "name": "UHF CB (80 channels)", "fn": lambda: plan_au_uhf_cb(False),
                  "note": ("Australian UHF CB (ACMA class licence), 77 channels. CH1-8 and CH41-48 are repeater OUTPUTS (what a repeater "
                           "re-broadcasts); CH31-38 and CH71-78 are the matching repeater INPUTS (handsets talking up to a repeater, "
                           "usually weak). Officially CH5/CH35 are emergency-only, CH11 is the calling channel and CH22/23 are data-only, "
                           "but in real life people chat on many of them. CH61-63 don't exist. Channels sit only 12.5 kHz apart, so a "
                           "loud neighbour can bleed onto the next one.")},
    "pmr446": {"id": "pmr446", "name": "PMR446 walkie-talkies (16 channels)", "fn": plan_pmr446,
               "note": "Licence-free walkie-talkies across Europe and many other countries. Short range, 12.5 kHz FM."},
    "frs_gmrs": {"id": "frs_gmrs", "name": "FRS / GMRS walkie-talkies (22 channels)", "fn": plan_frs_gmrs,
                 "note": "Family radio in the US and Canada. Channels 8-14 are very low power; 15-22 are shared with GMRS."},
    "pmr446_8": {"id": "pmr446_8", "name": "PMR446 walkie-talkies (8 channels)", "fn": plan_pmr446_8,
                 "note": "Licence-free analogue walkie-talkies, channels 1 to 8. Short range, 12.5 kHz FM."},
    "jp_lowpower": {"id": "jp_lowpower", "name": "Low-power walkie-talkies (20 channels)", "fn": plan_jp_lowpower,
                    "note": "Japan's licence-free specified low-power radios: 11 business and 9 leisure channels at 422 MHz, 10 mW."},
    "kr_personal": {"id": "kr_personal", "name": "Personal radio (448 and 449 MHz)", "fn": plan_kr_personal,
                    "note": "South Korea's licence-free walkie-talkies, in two blocks at 448.7 and 449.1 MHz."},
    "cn_409": {"id": "cn_409", "name": "409 MHz walkie-talkies (20 channels)", "fn": plan_cn_409,
               "note": "Public walkie-talkies at 409.750 to 409.9875 MHz, 12.5 kHz FM."},
    "th_cb245": {"id": "th_cb245", "name": "CB 245 MHz (80 channels)", "fn": plan_th_cb245,
                 "note": "Thailand's popular citizens' band, 245.0000 to 245.9875 MHz FM. The radios have red cases."},
    "th_cb78": {"id": "th_cb78", "name": "CB 78 MHz (80 channels)", "fn": plan_th_cb78,
                "note": "Thailand's VHF citizens' band, 78.0000 to 78.9875 MHz FM, used by trucks, buses and taxis."},
    "ph_srrs": {"id": "ph_srrs", "name": "SRRS walkie-talkies (40 channels)", "fn": plan_ph_srrs,
                "note": "The Philippines' Short Range Radio Service, 325.0000 to 325.4875 MHz FM."},
    "lpd433": {"id": "lpd433", "name": "LPD433 walkie-talkies (69 channels)", "fn": plan_lpd433,
               "note": "Licence-free low-power radios at 433.075 to 434.775 MHz, 25 kHz apart. Home sensors share this band."},
    "cb27": {"id": "cb27", "name": "27 MHz CB (40 channels)", "fn": plan_cb27,
             "note": "Citizens' Band at 27 MHz. Needs an RTL-SDR with HF reception (V3/V4 or direct sampling) and a long wire antenna."},
}


def canon(region_id):
    """The entry a region id belongs to (a single-country id maps to its shared entry); unknown ids fall back to international."""
    rid = ALIASES.get(region_id, region_id)
    return rid if rid in REGIONS else DEFAULT_REGION


def get(region_id, country=""):
    """A region's settings, with the differences of one country in it applied (country: two letters, from the location)."""
    r = REGIONS[canon(region_id)]
    o = r["by_country"].get(str(country or "").upper())
    return dict(r, **o) if o else r


def short_banks(region_id, country=""):
    r = get(region_id, country)
    out = []
    for key in r["short"]:
        p = SHORT_PLANS[key]
        out.append({"id": p["id"], "name": p["name"], "note": p["note"], "builtin": True, "thr": 8, "hang": 2.0,
                    "channels": p["fn"]()})
        if key == "au_uhf_cb":
            out.append({"id": "cb_uhf_simplex", "name": "UHF CB: chat channels only (no repeaters)", "builtin": True,
                        "thr": 8, "hang": 2.0, "note": "The simplex channels people use car-to-car. Skips repeater outputs and inputs so scans are faster.",
                        "channels": plan_au_uhf_cb(True)})
    if r["wx"]:
        out.append({"id": "wx_noaa", "name": "NOAA Weather Radio", "builtin": True, "thr": 8, "hang": 3.0,
                    "note": "Continuous weather broadcasts, 7 channels.", "channels": plan_noaa_wx()})
    return out


@functools.lru_cache(maxsize=16)
def channel_labels(region_id, country=""):
    """Every named short-range channel for the region: used to show 'CH5 ...' on the big frequency readout."""
    out = []
    for key in get(region_id, country)["short"]:
        out += [{"f": c["f"], "label": c["label"], "tol": 5000 if c["bw"] <= 12500 else 6000} for c in SHORT_PLANS[key]["fn"]()]
    return out


def band_extras(region_id, country=""):
    """Band plan lines that depend on the region."""
    r = get(region_id, country)
    out = [(r["am"][0], r["am"][1] + r["am"][2], "AM radio", "am"), (r["fm"][0], r["fm"][1], "FM radio", "wfm"),
           (r["ham_2m"][0], r["ham_2m"][1], "2 m ham", "nfm"), (r["ham_70"][0], r["ham_70"][1], "70 cm ham", "nfm")]
    for key in r["short"]:
        if key == "au_uhf_cb":
            out.append((476.4e6, 477.5e6, "UHF CB", "nfm"))
        elif key in WALKIE:
            name, lo, hi, _ = WALKIE[key]
            out.append((lo, hi, name + " walkie-talkies" if "CB" not in name else name, "nfm"))
    if r["wx"]:
        out.append((162.4e6, 162.56e6, "NOAA Weather Radio", "nfm"))
    return out


# the walkie-talkie band the Radio page offers as a button: the first short-range plan of the region that has one
WALKIE = {"au_uhf_cb": ("UHF CB", 476.4e6, 477.5e6, 500e3), "pmr446": ("PMR446", 446.0e6, 446.2e6, 250e3),
          "pmr446_8": ("PMR446", 446.0e6, 446.1e6, 150e3), "frs_gmrs": ("FRS / GMRS", 462.5e6, 467.75e6, 1e6),
          "jp_lowpower": ("Low-power radio", 422.04e6, 422.31e6, 300e3), "kr_personal": ("Personal radio", 448.73e6, 449.27e6, 600e3),
          "cn_409": ("409 MHz", 409.74e6, 410.0e6, 300e3), "th_cb245": ("CB 245", 245.0e6, 246.0e6, 1e6),
          "ph_srrs": ("SRRS", 325.0e6, 325.5e6, 500e3)}


def walkie(region_id, country=""):
    for key in get(region_id, country)["short"]:
        if key in WALKIE:
            name, lo, hi, span = WALKIE[key]
            return {"name": name, "lo": lo, "hi": hi, "mode": "nfm", "span": span}
    return None


@functools.lru_cache(maxsize=1)
def picker():
    """Every entry with the countries that share it, for the country picker: per country its English name (the page
    shows the name in the reader's language when the browser can), units and FM de-emphasis."""
    out = []
    for rid, v in REGIONS.items():
        ccs = sorted(countries.MEMBERS.get(rid, []), key=lambda c: countries.NAMES[c])
        out.append({"id": rid, "name": v["name"], "label": countries.LABEL.get(rid) or ccs,
                    "countries": [[c, countries.NAMES[c], get(rid, c)["units"], get(rid, c)["deemph_us"]] for c in ccs]})
    return out


def public(region_id, country=""):
    r = get(region_id, country)
    rid = canon(region_id)
    r_cc = str(country or "").upper()
    return {"id": rid, "name": r["name"], "fm": list(r["fm"]), "fm_step": r["fm_step"], "am": list(r["am"]), "am_step": r["am_step"],
            "deemph_us": r["deemph_us"], "aprs": r["aprs"], "aprs_note": r["aprs_note"], "ism": r["ism"], "sensor_note": r["sensor_note"],
            "units": r["units"], "ham_2m": list(r["ham_2m"]), "ham_70": list(r["ham_70"]),
            "ham_call": list(r["ham_call"]) if r["ham_call"] else None, "emergency_note": EMERGENCY_NOTE, "labels": channel_labels(rid, r_cc),
            "air": [[f, n] for f, n in r.get("air", [])], "walkie": walkie(rid, r_cc), "wx": r["wx"],
            "country": r_cc,
            "list": picker(), "areas": countries.AREAS}


def fm_default(region_id, country=""):
    """A sensible first frequency: 100.0 MHz where the FM band reaches it, otherwise the middle of the band."""
    lo, hi = get(region_id, country)["fm"]
    return 100.0e6 if lo <= 100.0e6 <= hi else round((lo + hi) / 2 / 1e6, 1) * 1e6
