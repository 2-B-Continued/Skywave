/* audio-net.js - a Web Worker that fetches live sound from Skywave and hands it straight to the audio thread.

   It has its own WebSocket (/ws?audio=1) that carries nothing but sound, and passes each frame over a MessagePort directly to
   the AudioWorklet player. The page's main thread is never in between, so animations, maps or a busy page cannot delay the
   sound. The connection looks after itself: a 4 s limit on connecting, a ping every 2 s answered by the server, and a fresh
   connection (after 0.25 s, growing to at most 3 s) whenever it goes quiet or drops. */
'use strict';
let ws = null, port = null, url = '', q = 5, want = false, timer = 0, backoff = 250, lastRx = 0, frames = 0, bytes = 0, opens = 0, up = false;

function post(o) { try { self.postMessage(o); } catch (e) { } }

function open() {
  clearTimeout(timer);
  if (!want || ws) return;
  let s;
  try { s = new WebSocket(url); } catch (e) { retry(); return; }
  ws = s; s.binaryType = 'arraybuffer';
  const limit = setTimeout(() => { if (s.readyState !== 1) { try { s.close(); } catch (e) { } } }, 4000);
  s.onopen = () => { clearTimeout(limit); backoff = 250; lastRx = Date.now(); up = true; opens++; try { s.send(JSON.stringify({ cmd: 'quality', q })); } catch (e) { } post({ t: 'net', up: true, opens }); };
  s.onmessage = ev => {
    lastRx = Date.now();
    const b = ev.data;
    if (typeof b === 'string' || !b.byteLength) return;
    const t = new Uint8Array(b, 0, 1)[0];
    if (t === 2 || t === 3 || t === 4) { frames++; bytes += b.byteLength; (port || self).postMessage({ t: 'pcm', b, s: t === 3 }, [b]); }   // no port: the page plays it (plain http)
  };
  s.onclose = () => {
    clearTimeout(limit);
    if (ws === s) ws = null;
    if (up) { up = false; post({ t: 'net', up: false }); }
    if (want) retry();
  };
  s.onerror = () => { try { s.close(); } catch (e) { } };
}
function retry() { clearTimeout(timer); timer = setTimeout(open, backoff); backoff = Math.min(3000, backoff * 1.7); }
function close() { want = false; clearTimeout(timer); if (ws) { const s = ws; ws = null; try { s.close(); } catch (e) { } } up = false; }

setInterval(() => {
  if (!ws || ws.readyState !== 1) return;
  try { ws.send('{"cmd":"ping"}'); } catch (e) { }
  if (Date.now() - lastRx > 6000) { try { ws.close(); } catch (e) { } }      // no sound and no answer: the link is dead
}, 2000);
setInterval(() => { if (want) { post({ t: 'rate', frames, bytes, up }); bytes = 0; } }, 1000);

self.onmessage = e => {
  const d = e.data || {};
  if (d.t === 'port') port = d.port;
  else if (d.t === 'quality') { q = d.q; if (ws && ws.readyState === 1) { try { ws.send(JSON.stringify({ cmd: 'quality', q })); } catch (e) { } } }
  else if (d.t === 'start') { url = d.url; if (d.q) q = d.q; want = true; if (!ws) { backoff = 250; open(); } }
  else if (d.t === 'stop') close();
  else if (d.t === 'kick') { if (ws) { try { ws.close(); } catch (e) { } } else if (want) { backoff = 250; open(); } }   // the page came back: check now
};
