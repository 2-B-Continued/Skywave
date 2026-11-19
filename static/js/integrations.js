/* Skywave - sending readings to Home Assistant (or anything else that speaks MQTT). A card in Settings, and a status
   line on the Sensors page. The broker password stays on the server: the page only learns whether one is set. */
(function () {
  'use strict';
  const RS = window.RS, $ = RS.$, esc = RS.esc;
  const S = RS.pages.settings; if (!S) return;
  let status = null;
  const card = () => `
    <div class="card" id="st-mqtt"><h3>Home Assistant ${RS.hint('Skywave can send everything the Sensors page picks up (temperatures, rain, wind, meters...) and any weather balloon it tracks to an MQTT broker. Home Assistant then shows each one as a sensor by itself, with no set-up per device. The Mosquitto add-on in Home Assistant is the usual broker.', 'mq')}</h3>
      <div class="sub">Send sensor readings and balloon positions over MQTT. They appear in Home Assistant by themselves.</div>
      <label class="check" style="margin-top:10px"><input type="checkbox" id="mq-on"><span>Send readings to an MQTT broker</span></label>
      <div class="mq-grid">
        <label class="field">Broker address<input id="mq-host" placeholder="for example homeassistant.local" autocomplete="off"></label>
        <label class="field">Port<input id="mq-port" inputmode="numeric" placeholder="1883"></label>
        <label class="field">User name<input id="mq-user" autocomplete="off"></label>
        <label class="field">Password<input id="mq-pass" type="password" autocomplete="new-password"></label>
      </div>
      <label class="check"><input type="checkbox" id="mq-disc" checked><span>Announce devices to Home Assistant automatically</span></label>
      <label class="field adv-only">Topic prefix<input id="mq-pre" placeholder="skywave"></label>
      <div class="row" style="margin-top:10px"><button class="btn" data-act="mq-test" type="button">Test the connection</button><button class="btn primary" data-act="mq-save" type="button">Save</button></div>
      <div class="small" id="mq-status" role="status" style="margin-top:8px"></div></div>`;
  const init = S.init;
  S.init = function () {
    if (init) init.apply(this, arguments);
    const host = $('#p-settings'), anchor = host.querySelector('#st-sound') || host.lastElementChild;
    const wrap = document.createElement('div'); wrap.innerHTML = card();
    (anchor && anchor.closest('.card') ? anchor.closest('.card') : anchor).after(wrap.firstElementChild);
    RS.on('hello', fill); RS.on('config', fill);
  };
  function fill() {
    const m = RS.cfg.mqtt || {};
    if (!$('#mq-on')) return;
    $('#mq-on').checked = !!m.on; $('#mq-host').value = m.host || ''; $('#mq-port').value = m.port || 1883; $('#mq-user').value = m.user || '';
    $('#mq-pass').placeholder = m.has_pass ? 'saved (type to change)' : ''; $('#mq-disc').checked = m.discovery !== false; $('#mq-pre').value = m.prefix || 'skywave';
    poll();
  }
  function form() {
    const v = { on: $('#mq-on').checked, host: $('#mq-host').value.trim(), port: parseInt($('#mq-port').value, 10) || 1883, user: $('#mq-user').value.trim(),
      discovery: $('#mq-disc').checked, prefix: $('#mq-pre').value.trim() || 'skywave' };
    if ($('#mq-pass').value) v.pass = $('#mq-pass').value;
    return v;
  }
  const say = (t, cls) => { const el = $('#mq-status'); if (el) { el.textContent = t; el.className = 'small ' + (cls || ''); } };
  RS.act['mq-test'] = async () => {
    const v = form(); say('Trying...');
    const r = await RS.api('mqtt/test', v); say(r ? r.message : 'No answer from Skywave.', r && r.ok ? 'good-t' : 'bad-t');
  };
  RS.act['mq-save'] = async () => {
    const v = form();
    if (v.on && !v.host) { say('Type the broker address first.', 'bad-t'); return; }
    const r = await RS.api('config', { changes: { mqtt: v } });
    if (r && r.config) { RS.cfg = r.config; $('#mq-pass').value = ''; RS.toast(v.on ? 'Saved. Connecting to the broker.' : 'Saved. Not sending to a broker.'); fill(); setTimeout(poll, 2500); }
  };
  async function poll() {
    const r = await fetch('/api/mqtt').then(x => x.json()).catch(() => null);
    status = r;
    const s = r && r.status;
    if ($('#mq-status') && !(RS.cfg.mqtt || {}).on) say('Off.');
    else if (s === 'connected') say('Connected. ' + r.sent + ' message' + (r.sent === 1 ? '' : 's') + ' sent so far.', 'good-t');
    else if (s && s !== 'off') say(s, 'bad-t');
    sensorsLine();
  }
  function sensorsLine() {
    const host = $('#p-sensors'); if (!host || !host.firstElementChild) return;
    let el = $('#se-mqtt');
    const on = (RS.cfg.mqtt || {}).on;
    if (!on) { if (el) el.remove(); return; }
    if (!el) { el = document.createElement('div'); el.id = 'se-mqtt'; el.className = 'small muted se-mqtt'; const head = host.querySelector('.page-head'); (head || host.firstElementChild).after(el); }
    const s = status && status.status;
    el.innerHTML = s === 'connected' ? 'Readings are going to Home Assistant (MQTT).' : 'Home Assistant link: ' + esc(s || 'connecting') + ' <button class="linkish" type="button" data-act="go" data-page="settings">Settings</button>';
  }
  RS.on('page', p => { if (p === 'sensors' || p === 'settings') poll(); });
})();
