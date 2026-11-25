"""Domestic or international, and the usual terminal, at Australia's major airports."""
import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import terminals as T
ok = True
def check(n, c, x=""):
    global ok; print(("PASS " if c else "FAIL ") + n, x if not c else ""); ok = ok and bool(c)
AP = lambda iata, cc: {"iata": iata, "country": cc, "name": iata + " International Airport"}
def route(cs, a, b, ca="AU", cb="AU"):
    return T.annotate({"origin": AP(a, ca), "destination": AP(b, cb), "stops": []}, cs)

r = route("JST500", "BNE", "SYD")
check("Brisbane to Sydney on Jetstar is domestic", r["kind"] == "domestic", r)
check("from Brisbane domestic to Sydney T2", "terminal" not in r["origin"] and r["destination"]["terminal"] == "T2", r)
check("named for the domestic airports it uses", r["origin"]["name"] == "Brisbane Domestic Airport" and r["destination"]["name"] == "Sydney Domestic Airport", r)
r = route("QFA595", "SYD", "MEL")
check("Qantas domestic: Sydney T3 to Melbourne T1", r["kind"] == "domestic" and r["origin"]["terminal"] == "T3" and r["destination"]["terminal"] == "T1", r)
r = route("VOZ821", "MEL", "PER")
check("Virgin Australia: Melbourne T3 to Perth T1", r["origin"]["terminal"] == "T3" and r["destination"]["terminal"] == "T1", r)
r = route("RXA123", "SYD", "MEL")
check("Rex: departs Sydney T3, lands Melbourne T4", r["origin"]["terminal"] == "T3" and r["destination"]["terminal"] == "T4", r)
r = route("RXA124", "MEL", "SYD")
check("Rex: arrives Sydney T2 while T2 is rebuilt", r["destination"]["terminal"] == "T2", r)
r = route("QFA1", "SYD", "SIN", cb="SG")
check("Qantas international from T1", r["kind"] == "international" and r["origin"]["terminal"] == "T1" and "terminal" not in r["destination"], r)
check("named for the international airport", r["origin"]["name"] == "Sydney International Airport", r)
r = route("QFA81", "SYD", "PER")
check("a domestic leg of a Qantas international flight (QF1 to QF399) uses the international terminals", r["origin"]["terminal"] == "T1" and r["destination"]["terminal"] == "T3", r)
r = route("SIA231", "SIN", "SYD", ca="SG")
check("an overseas airline lands at Sydney T1", r["kind"] == "international" and r["destination"]["terminal"] == "T1", r)
r = route("QFA720", "PER", "CNS")
check("Qantas domestic at Perth T3/T4 and Cairns T2", r["origin"]["terminal"] == "T3/T4" and r["destination"]["terminal"] == "T2", r)
r = route("JST440", "OOL", "ADL")
check("a domestic leg of QF1 to QF399 is named for the international airport", route("QFA51", "BNE", "SYD")["origin"]["name"] == "Brisbane International Airport")
check("one-terminal airports keep one name", r["origin"]["name"] == "Gold Coast Airport", r)
check("one-terminal airports get no terminal", "terminal" not in r["origin"] and "terminal" not in r["destination"] and r["kind"] == "domestic", r)
r = T.annotate({"origin": {"icao": "YSSY", "country": "AU"}, "destination": None, "stops": []}, "QFA595")
check("takeoff airport only: the Qantas flight number still tells domestic from international", r["kind"] == "domestic" and r["origin"]["terminal"] == "T3", r)
r = T.annotate({"origin": {"icao": "YSSY", "country": "AU"}, "destination": None, "stops": []}, "VOZ1")
check("takeoff airport only, other airlines: not guessed", r["kind"] is None and "terminal" not in r["origin"], r)
print("ALL PASS" if ok else "SOME FAILED"); sys.exit(0 if ok else 1)
