/* actypes.js - plain names for ICAO aircraft type designators (ICAO Doc 8643), so the Planes page can say
   "Boeing 737-800" instead of "B738". Covers airliners, regional and business jets, common light aircraft and
   helicopters; anything else is shown by its designator. */
(function () {
  const T = {
    // Airbus
    A19N: 'Airbus A319neo', A20N: 'Airbus A320neo', A21N: 'Airbus A321neo', A318: 'Airbus A318', A319: 'Airbus A319', A320: 'Airbus A320',
    A321: 'Airbus A321', A306: 'Airbus A300-600', A30B: 'Airbus A300', A310: 'Airbus A310', A332: 'Airbus A330-200', A333: 'Airbus A330-300',
    A337: 'Airbus BelugaXL', A338: 'Airbus A330-800neo', A339: 'Airbus A330-900neo', A342: 'Airbus A340-200', A343: 'Airbus A340-300',
    A345: 'Airbus A340-500', A346: 'Airbus A340-600', A359: 'Airbus A350-900', A35K: 'Airbus A350-1000', A388: 'Airbus A380-800',
    A3ST: 'Airbus Beluga', BCS1: 'Airbus A220-100', BCS3: 'Airbus A220-300', A400: 'Airbus A400M Atlas', A124: 'Antonov An-124',
    // Boeing
    B712: 'Boeing 717', B722: 'Boeing 727-200', B732: 'Boeing 737-200', B733: 'Boeing 737-300', B734: 'Boeing 737-400', B735: 'Boeing 737-500',
    B736: 'Boeing 737-600', B737: 'Boeing 737-700', B738: 'Boeing 737-800', B739: 'Boeing 737-900', B37M: 'Boeing 737 MAX 7', B38M: 'Boeing 737 MAX 8',
    B39M: 'Boeing 737 MAX 9', B3XM: 'Boeing 737 MAX 10', B742: 'Boeing 747-200', B743: 'Boeing 747-300', B744: 'Boeing 747-400', B748: 'Boeing 747-8',
    B74S: 'Boeing 747SP', BLCF: 'Boeing 747 Dreamlifter', B752: 'Boeing 757-200', B753: 'Boeing 757-300', B762: 'Boeing 767-200',
    B763: 'Boeing 767-300', B764: 'Boeing 767-400', B772: 'Boeing 777-200', B77L: 'Boeing 777-200LR', B773: 'Boeing 777-300',
    B77W: 'Boeing 777-300ER', B778: 'Boeing 777-8', B779: 'Boeing 777-9', B788: 'Boeing 787-8', B789: 'Boeing 787-9', B78X: 'Boeing 787-10',
    MD11: 'McDonnell Douglas MD-11', MD82: 'McDonnell Douglas MD-82', MD83: 'McDonnell Douglas MD-83', MD88: 'McDonnell Douglas MD-88',
    MD90: 'McDonnell Douglas MD-90', DC10: 'McDonnell Douglas DC-10', DC93: 'McDonnell Douglas DC-9-30', DC87: 'Douglas DC-8-70',
    C17: 'Boeing C-17 Globemaster III', K35R: 'Boeing KC-135 Stratotanker', E3TF: 'Boeing E-3 Sentry', P8: 'Boeing P-8 Poseidon',
    KC46: 'Boeing KC-46 Pegasus', E737: 'Boeing E-7 Wedgetail',
    // Embraer, Bombardier, ATR, De Havilland, others
    E135: 'Embraer ERJ-135', E145: 'Embraer ERJ-145', E170: 'Embraer E170', E175: 'Embraer E175', E190: 'Embraer E190', E195: 'Embraer E195',
    E290: 'Embraer E190-E2', E295: 'Embraer E195-E2', E75L: 'Embraer E175', E75S: 'Embraer E175', E35L: 'Embraer Legacy 600',
    E50P: 'Embraer Phenom 100', E55P: 'Embraer Phenom 300', E545: 'Embraer Legacy 450', E550: 'Embraer Praetor 600', E120: 'Embraer Brasilia',
    C390: 'Embraer C-390 Millennium', CRJ1: 'Bombardier CRJ100', CRJ2: 'Bombardier CRJ200', CRJ7: 'Bombardier CRJ700', CRJ9: 'Bombardier CRJ900',
    CRJX: 'Bombardier CRJ1000', CL30: 'Bombardier Challenger 300', CL35: 'Bombardier Challenger 350', CL60: 'Bombardier Challenger 600',
    GL5T: 'Bombardier Global 5000', GLEX: 'Bombardier Global Express', GL7T: 'Bombardier Global 7500', LJ35: 'Learjet 35', LJ45: 'Learjet 45',
    LJ60: 'Learjet 60', LJ75: 'Learjet 75', DH8A: 'De Havilland Dash 8-100', DH8B: 'De Havilland Dash 8-200', DH8C: 'De Havilland Dash 8-300',
    DH8D: 'De Havilland Dash 8-400', DHC6: 'De Havilland Twin Otter', DHC2: 'De Havilland Beaver', DHC3: 'De Havilland Otter',
    AT43: 'ATR 42-300', AT45: 'ATR 42-500', AT46: 'ATR 42-600', AT72: 'ATR 72', AT75: 'ATR 72-500', AT76: 'ATR 72-600',
    SF34: 'Saab 340', SB20: 'Saab 2000', F70: 'Fokker 70', F100: 'Fokker 100', F50: 'Fokker 50', RJ85: 'Avro RJ85', RJ1H: 'Avro RJ100',
    B461: 'BAe 146-100', B462: 'BAe 146-200', B463: 'BAe 146-300', JS41: 'BAe Jetstream 41', JS32: 'BAe Jetstream 32',
    SU95: 'Sukhoi Superjet 100', A148: 'Antonov An-148', AN26: 'Antonov An-26', AN12: 'Antonov An-12', IL76: 'Ilyushin Il-76',
    C919: 'COMAC C919', AJ27: 'COMAC ARJ21', MA60: 'Xian MA60', D328: 'Dornier 328', J328: 'Dornier 328JET', L410: 'Let L-410 Turbolet',
    BE20: 'Beechcraft King Air 200', BE30: 'Beechcraft King Air 300', B350: 'Beechcraft King Air 350', BE9L: 'Beechcraft King Air 90',
    BE40: 'Beechcraft Beechjet 400', BE58: 'Beechcraft Baron 58', BE36: 'Beechcraft Bonanza A36', BE35: 'Beechcraft Bonanza', B190: 'Beechcraft 1900',
    PC12: 'Pilatus PC-12', PC24: 'Pilatus PC-24', PC6T: 'Pilatus PC-6 Porter', PC21: 'Pilatus PC-21', PC9: 'Pilatus PC-9',
    C130: 'Lockheed C-130 Hercules', C30J: 'Lockheed Martin C-130J Super Hercules', C5M: 'Lockheed C-5M Super Galaxy', P3: 'Lockheed P-3 Orion',
    F35: 'Lockheed Martin F-35 Lightning II', F16: 'General Dynamics F-16', F18: 'Boeing F/A-18 Hornet', F18S: 'Boeing F/A-18 Super Hornet',
    EUFI: 'Eurofighter Typhoon', HAWK: 'BAE Systems Hawk',
    // business jets
    GLF4: 'Gulfstream IV', GLF5: 'Gulfstream V', GLF6: 'Gulfstream G650', GA5C: 'Gulfstream G500', GA6C: 'Gulfstream G600', GA7C: 'Gulfstream G700',
    G280: 'Gulfstream G280', G150: 'Gulfstream G150', FA7X: 'Dassault Falcon 7X', FA8X: 'Dassault Falcon 8X', F900: 'Dassault Falcon 900',
    F2TH: 'Dassault Falcon 2000', FA50: 'Dassault Falcon 50', FA6X: 'Dassault Falcon 6X', C25A: 'Cessna Citation CJ2', C25B: 'Cessna Citation CJ3',
    C25C: 'Cessna Citation CJ4', C525: 'Cessna CitationJet', C510: 'Cessna Citation Mustang', C560: 'Cessna Citation V', C56X: 'Cessna Citation Excel',
    C680: 'Cessna Citation Sovereign', C68A: 'Cessna Citation Latitude', C700: 'Cessna Citation Longitude', C750: 'Cessna Citation X',
    H25B: 'Hawker 800', HA4T: 'Hawker 4000', SF50: 'Cirrus Vision Jet', HDJT: 'HondaJet', PRM1: 'Beechcraft Premier I',
    // light aircraft
    C150: 'Cessna 150', C152: 'Cessna 152', C162: 'Cessna 162 Skycatcher', C172: 'Cessna 172 Skyhawk', C177: 'Cessna 177 Cardinal',
    C182: 'Cessna 182 Skylane', C206: 'Cessna 206 Stationair', C208: 'Cessna 208 Caravan', C210: 'Cessna 210 Centurion', C310: 'Cessna 310',
    C340: 'Cessna 340', C414: 'Cessna 414', C421: 'Cessna 421', P28A: 'Piper Cherokee', P28B: 'Piper Cherokee Dakota', P28R: 'Piper Arrow',
    P32R: 'Piper Saratoga', PA31: 'Piper Navajo', PA34: 'Piper Seneca', PA44: 'Piper Seminole', PA46: 'Piper Malibu', PA18: 'Piper Super Cub',
    SR20: 'Cirrus SR20', SR22: 'Cirrus SR22', S22T: 'Cirrus SR22T', DA40: 'Diamond DA40 Star', DA42: 'Diamond DA42 Twin Star', DA62: 'Diamond DA62',
    DA20: 'Diamond DA20 Katana', M20P: 'Mooney M20', TBM7: 'Daher TBM 700', TBM8: 'Daher TBM 850', TBM9: 'Daher TBM 900', AA5: 'Grumman Tiger',
    GA8: 'GippsAero GA8 Airvan', AC11: 'Rockwell Commander 112', RV7: "Van's RV-7", RV8: "Van's RV-8", RV10: "Van's RV-10", RV12: "Van's RV-12",
    P92: 'Tecnam P92', P208: 'Tecnam P2008', P06T: 'Tecnam P2006T', EV97: 'Evektor EuroStar', C42: 'Comco Ikarus C42',
    // helicopters
    EC35: 'Airbus H135', EC45: 'Airbus H145', EC30: 'Airbus H130', EC55: 'Airbus H155', EC75: 'Airbus H175', EC25: 'Airbus H225',
    AS50: 'Airbus AS350 Ecureuil', AS55: 'Airbus AS355 Ecureuil 2', AS65: 'Airbus AS365 Dauphin', H160: 'Airbus H160', NH90: 'NHIndustries NH90',
    A109: 'Leonardo AW109', A119: 'Leonardo AW119', A139: 'Leonardo AW139', A169: 'Leonardo AW169', A189: 'Leonardo AW189',
    B06: 'Bell 206 JetRanger', B407: 'Bell 407', B412: 'Bell 412', B429: 'Bell 429', B505: 'Bell 505', B212: 'Bell 212', B47G: 'Bell 47',
    R22: 'Robinson R22', R44: 'Robinson R44', R66: 'Robinson R66', S76: 'Sikorsky S-76', S92: 'Sikorsky S-92', H60: 'Sikorsky Black Hawk',
    CH47: 'Boeing CH-47 Chinook', MI8: 'Mil Mi-8', EXPL: 'MD Helicopters Explorer', H500: 'MD Helicopters MD 500',
  };
  RS.acType = code => T[String(code || '').toUpperCase()] || '';
})();
