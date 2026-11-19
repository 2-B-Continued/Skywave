# Contributing
- Run the tests before a pull request: `for t in tests/test_*.py; do python3 $t || break; done`
- Translations: every language file in `static/lang` is a first draft and corrections from native speakers are welcome.
  For a new language, copy `static/lang/en-template.json.txt` to `static/lang/<code>.json`, translate the values and
  put the language's own name in the `_meta` block.
- Countries: `countries.py` lists every country and the `regions.py` entry whose settings it shares. A country that
  differs on one or two settings gets them in that entry's `by_country`; one that differs a lot gets its own entry
  (FM and AM bands, ham bands, APRS frequency, walkie-talkie plans, sensor bands). Run `tests/test_regions.py`, and
  cite your national band plan or regulator in the pull request.
- Real-hardware reports (what worked, what did not, dongle model) are the most valuable contribution.
