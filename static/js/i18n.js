/* i18n.js - interface language and unit helpers.
 *
 * Translations live in static/lang/<code>.json as { "English text": "translated text", ... } plus a "_meta" block
 * with the language's own name. Any text on the page that exactly matches an English key is swapped in place, so
 * adding a language never needs a code change: copy en-template.json, translate the values, save it as <code>.json.
 */
(function () {
  'use strict';
  const RS = window.RS;
  RS.lang = 'en'; RS.dict = {};
  RS.t = s => RS.dict[s] || s;
  const orig = new WeakMap(), last = new WeakMap(), SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, CODE: 1, PRE: 1 };
  const ATTRS = ['title', 'placeholder', 'aria-label'];

  function doText(n) {
    const p = n.parentNode; if (!p || SKIP[p.nodeName]) return;
    const cur = n.nodeValue; let o = orig.get(n);
    if (o === undefined || (cur !== o && cur !== last.get(n))) { o = cur; orig.set(n, o); }
    const key = o.trim(), tv = key && RS.dict[key];
    const out = tv ? o.replace(key, tv) : o;
    if (out !== cur) { last.set(n, out); n.nodeValue = out; }
  }
  function doAttrs(el) {
    for (const a of ATTRS) {
      if (!el.hasAttribute || !el.hasAttribute(a)) continue;
      const k = 'data-en-' + a; if (!el.hasAttribute(k)) el.setAttribute(k, el.getAttribute(a));
      const en = el.getAttribute(k), tv = RS.dict[en.trim()];
      const out = tv || en; if (el.getAttribute(a) !== out) el.setAttribute(a, out);
    }
  }
  function walk(root) {
    if (root.nodeType === 3) { doText(root); return; }
    if (root.nodeType !== 1) return;
    doAttrs(root);
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) doText(n);
    root.querySelectorAll('[title],[placeholder],[aria-label]').forEach(doAttrs);
  }
  let obs = null;
  function watch() {
    if (obs) return;
    obs = new MutationObserver(ms => { for (const m of ms) { if (m.type === 'characterData') doText(m.target); else m.addedNodes.forEach(walk); } });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  RS.setLang = async (code, remember) => {
    code = code || 'en';
    let d = {};
    if (code !== 'en') {
      try { const r = await fetch('/lang/' + encodeURIComponent(code) + '.json'); if (r.ok) d = await r.json(); else code = 'en'; } catch (e) { code = 'en'; }
    }
    RS.dict = d; RS.lang = code; document.documentElement.lang = code;
    if (remember) RS.store.set('lang', code);
    watch(); walk(document.body); RS.fire('lang', code);
  };
  // The closest interface language to the browser's own list: an exact match (pt-BR), the script Chinese is written in
  // (zh-TW, zh-HK and zh-MO read Traditional; other Chinese, Simplified), then the language alone (de-AT -> de).
  RS.browserLang = () => {
    const have = new Set((RS.langs || []).map(l => l.code));
    for (const tag of navigator.languages || [navigator.language || 'en']) {
      const t = String(tag), base = t.split('-')[0].toLowerCase();
      if (have.has(t)) return t;
      if (base === 'zh') { const c = /-(TW|HK|MO|Hant)/i.test(t) ? 'zh-Hant' : 'zh-Hans'; if (have.has(c)) return c; }
      if (base === 'nb' || base === 'nn' || base === 'no') { if (have.has('nb')) return 'nb'; }
      if (base === 'tl' && have.has('fil')) return 'fil';
      if (have.has(base)) return base;
    }
    return 'en';
  };
  RS.on('hello', () => { RS.setLang(RS.store.get('lang', null) || (RS.cfg && RS.cfg.lang) || 'en'); });

  // ---------------------------------------------------------------- units
  RS.imperial = () => (RS.cfg && RS.cfg.units) === 'imperial';
  RS.fmtDist = km => km == null ? '' : RS.imperial() ? (km * 0.621371).toFixed(km < 16 ? 1 : 0) + ' mi' : (km < 10 ? km.toFixed(1) : Math.round(km)) + ' km';
  RS.speed = kmh => kmh == null ? '' : RS.imperial() ? Math.round(kmh * 0.621371) + ' mph' : Math.round(kmh) + ' km/h';
  RS.temp = c => c == null ? '' : RS.imperial() ? (c * 1.8 + 32).toFixed(1) + ' °F' : c.toFixed(1) + ' °C';
})();
