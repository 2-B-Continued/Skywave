"""Domestic or international, and which terminal, for flights at Australia's major airports.

ADS-B and the route sources say which airports a flight joins, not which terminal it uses. At airports with separate
terminals the terminal follows the airline and whether the flight is domestic or international, as the airports and
airlines publish it (checked November 2026):

- Sydney: T1 international; T2 Virgin Australia, Jetstar and most other domestic airlines; T3 Qantas and QantasLink.
  While T2 is rebuilt, Rex departs from T3 and arrives at T2.
- Melbourne: T1 Qantas domestic; T2 international; T3 Virgin Australia; T4 Jetstar, Rex and other domestic airlines.
- Brisbane: separate domestic and international airports. Cairns: T1 international, T2 domestic.
- Perth: T1 international and Virgin Australia domestic; T2 Jetstar and regional airlines; T3 and T4 every Qantas
  flight, international (T3) and domestic.
- Qantas flights numbered QF1 to QF399 are international flights and use the international terminal, even on a
  domestic leg; QF400 and above are domestic.

Gold Coast, Adelaide, Canberra, Darwin and Hobart use one terminal for everything, so no terminal is given.

Where the domestic and international terminals are separate buildings (Sydney, Melbourne, Brisbane and Cairns), the
end of the route is named for the one the flight uses ("Brisbane Domestic Airport", "Sydney International Airport"),
as the airlines name them. When it isn't known which, the airport's own name is used."""

QANTAS = ("QFA", "QLK", "NWK", "QJE")          # Qantas, QantasLink and the regional airlines that fly as QantasLink
VIRGIN = ("VOZ", "VAU")
JETSTAR = ("JST",)
REX = ("RXA",)

# airport (IATA) -> its usual name, and its terminals
AIRPORTS = {
    "SYD": "Sydney Kingsford Smith Airport", "MEL": "Melbourne Airport", "BNE": "Brisbane Airport", "PER": "Perth Airport",
    "CNS": "Cairns Airport", "ADL": "Adelaide Airport", "OOL": "Gold Coast Airport", "CBR": "Canberra Airport",
    "DRW": "Darwin International Airport", "HBA": "Hobart Airport",
}
# airports whose domestic and international terminals are separate: (domestic name, international name)
SPLIT = {
    "SYD": ("Sydney Domestic Airport", "Sydney International Airport"),
    "MEL": ("Melbourne Domestic Airport", "Melbourne International Airport"),
    "BNE": ("Brisbane Domestic Airport", "Brisbane International Airport"),
    "CNS": ("Cairns Domestic Airport", "Cairns International Airport"),
}
ICAO = {"YSSY": "SYD", "YMML": "MEL", "YBBN": "BNE", "YPPH": "PER", "YBCS": "CNS", "YPAD": "ADL", "YBCG": "OOL",
        "YSCB": "CBR", "YPDN": "DRW", "YMHB": "HBA"}


def qantas_number(cs):
    """The flight number of a Qantas group callsign ("QFA595" -> 595), or None."""
    if cs[:3] in QANTAS and cs[3:].isdigit():
        return int(cs[3:])
    return None


def flight_kind(route):
    """"domestic" when every airport on the route is in one country, "international" when not, None if unknown."""
    pts = [route.get("origin")] + list(route.get("stops") or []) + [route.get("destination")]
    cc = [str((p or {}).get("country") or "").upper()[:2] for p in pts]
    if not route.get("origin") or not route.get("destination") or not all(cc):
        return None
    return "domestic" if len(set(cc)) == 1 else "international"


def terminal(code, cs, international, arriving):
    """The terminal the flight usually uses at this airport, or None (one terminal, or not known)."""
    a = ICAO.get(str(code or "").upper(), str(code or "").upper())
    al = cs[:3]
    q = qantas_number(cs)
    if q is not None and 1 <= q <= 399:
        international = True
    if a == "SYD":
        if international:
            return "T1"
        if al in QANTAS:
            return "T3"
        if al in REX:
            return "T2" if arriving else "T3"
        return "T2"
    if a == "MEL":
        if international:
            return "T2"
        return "T1" if al in QANTAS else "T3" if al in VIRGIN else "T4"
    if a == "CNS":
        return "T1" if international else "T2"
    # Brisbane's two terminals have no numbers: the airport's name (Domestic or International) already says which
    if a == "PER":
        if al in QANTAS:
            return "T3" if international else "T3/T4"
        if international or al in VIRGIN:
            return "T1"
        return "T2"
    return None


def annotate(route, cs):
    """Adds to a route: kind ("domestic" or "international"), and for each end its usual name and terminal."""
    if not isinstance(route, dict) or not route.get("origin"):
        return route
    kind = flight_kind(route)
    q = qantas_number(cs)
    if kind is None and q is not None:
        kind = "international" if q <= 399 else "domestic"
    route["kind"] = kind
    intl = kind == "international"
    for key, arriving in (("origin", False), ("destination", True)):
        ap = route.get(key)
        if not isinstance(ap, dict):
            continue
        code = ap.get("iata") or ICAO.get(str(ap.get("icao") or "").upper())
        if code in AIRPORTS:
            ap["name"] = AIRPORTS[code]
        if code in SPLIT and (kind or q is not None):
            # a Qantas QF1 to QF399 flight uses the international terminal even on a domestic leg
            ap["name"] = SPLIT[code][1 if intl or (q is not None and q <= 399) else 0]
        t = terminal(ap.get("icao") or code, cs, intl, arriving) if kind or q is not None else None
        if t:
            ap["terminal"] = t
    return route
