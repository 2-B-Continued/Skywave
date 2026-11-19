/* titlecase.js - titles, tab names, chips and button labels start every word with a capital ("FM radio" -> "FM Radio").
   Only the first letter of each word changes, so acronyms and existing capitals stay as they are. Sentences are left alone. */
(function () {
  'use strict';
  const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'vs', 'with']);
  const SEL = 'h1,h2,h3,h4,summary,.chip,[role=tab],[data-tab],.tile b,.card-head h3,button.btn,.badge,.tab-label,label.field>:first-child';
  function fix(t) {
    const s = t.trim();
    if (!s || s.length > 60 || /[.!?]\s*$/.test(s) || s.split(/\s+/).length > 7) return t;
    let first = true;
    return t.replace(/(^|[\s(\/-])([a-z])([A-Za-z'+]*)/g, (m, pre, c, rest, off, str) => {
      const word = c + rest, prev = str.slice(0, off + pre.length);
      const wasFirst = first; first = false;
      if (/\d\s*$/.test(prev)) return m;                         // "2 m", "70 cm": a unit, not a word
      if (!wasFirst && SMALL.has(word)) return m;
      return pre + c.toUpperCase() + rest;
    });
  }
  function el(e) {
    if (!e || e.nodeType !== 1 || e.closest('input,textarea,select,script,style,[data-keep-case]')) return;
    for (const n of e.childNodes) {
      if (n.nodeType !== 3) continue;
      const v = fix(n.nodeValue); if (v !== n.nodeValue) n.nodeValue = v;
    }
  }
  function sweep(root) {
    if (!root || root.nodeType !== 1) return;
    if (root.matches && root.matches(SEL)) el(root);
    root.querySelectorAll && root.querySelectorAll(SEL).forEach(el);
  }
  RS.titleCase = fix;
  if (RS.bandName) { const bn = RS.bandName; RS.bandName = f => { const r = bn(f); return r ? fix(r) : r; }; }   // band names come from the server's band plan
  let pend = [];
  const mo = new MutationObserver(ms => {
    // fixed before the browser paints, so text never shows for a frame in the wrong case
    pend = pend.concat(ms);
    { const list = pend; pend = []; list.forEach(m => { if (m.type === 'characterData') el(m.target.parentNode); else m.addedNodes.forEach(n => sweep(n.nodeType === 3 ? n.parentNode : n)); }); }
  });
  const go = () => { sweep(document.body); mo.observe(document.body, { childList: true, subtree: true, characterData: true }); };
  if (document.body) go(); else document.addEventListener('DOMContentLoaded', go);
})();
