// Planes page: status, list (filters, search), map, chosen plane (route, registration, photo, Follow, Show only this),
// the past hour, the receiver card, air traffic, and arriving from Home. The aircraft lookup is stood in for (no internet).
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs=require('fs'),os=require('os'),path=require('path');
(async()=>{ const d=fs.mkdtempSync(path.join(os.tmpdir(),'pls-')); let bad=0; const chk=(n,ok,x)=>{ if(!ok) bad++; console.log((ok?'ok   ':'FAIL ')+n, ok?'':JSON.stringify(x)); };
 const srv=spawn('python3',['-W','ignore','server.py'],{cwd:path.join(__dirname,'..'),env:{...process.env,SIM:'1',PORT:'18199',DATA_DIR:d,NO_NET:'1',SETUP_DONE:'1'}});
 await new Promise(r=>setTimeout(r,4000)); const b=await chromium.launch();
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==','base64');
 for (const [w,h,n] of [[1440,1000,'desktop'],[390,844,'phone']]) {
  const p=await (await b.newContext({viewport:{width:w,height:h},hasTouch:w<500})).newPage(); const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  let asked=0;
  await p.route('**/api/planes/info**', r=>{ asked++; const u=new URL(r.request().url()); r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,
    aircraft:{registration:'G-EUPT',type:'A320-232',icao_type:'A320',manufacturer:'Airbus',registered_owner:'British Airways',registered_owner_country_name:'United Kingdom',url_photo:'https://airport-data.com/images/aircraft/000/1.jpg'},
    route:{callsign:u.searchParams.get('callsign'),airline:'British Airways',origin:{iata_code:'LHR',municipality:'London'},destination:{iata_code:'JFK',municipality:'New York'}}})}); });
  await p.route('https://airport-data.com/**', r=>r.fulfill({status:200,contentType:'image/png',body:png}));
  await p.goto('http://127.0.0.1:18199/#planes'); await p.waitForTimeout(9000);
  const st=await p.textContent('#pl-st');
  chk(n+': status says how many aircraft ("'+st+'")', /\d+ aircraft/.test(st));
  const rows=await p.evaluate(()=>document.querySelectorAll('#pl-rows .pl-row').length), hits=await p.evaluate(()=>RS.pages.planes.map.hit.filter(h=>Number.isFinite(h.x)).length);
  chk(n+': list and map ('+rows+' rows, '+hits+' on the map)', rows>=3 && hits>=3);
  chk(n+': rows get type and route, a few at a time', await p.evaluate(()=>/LHR to JFK/.test(document.getElementById('pl-rows').textContent)) && asked<=8, asked);
  await p.click('[data-pl-f="low"]'); await p.waitForTimeout(400);
  chk(n+': Low filter', await p.evaluate(()=>[...document.querySelectorAll('#pl-rows .pl-row')].every(r=>{ const a=RS.pages.planes.list.find(x=>x.icao===r.dataset.id); return a.alt!=null && a.alt<10000; })));
  await p.click('[data-pl-f="all"]');
  const first=await p.evaluate(()=>RS.pages.planes.list.find(a=>a.callsign).callsign);
  await p.fill('#pl-q', first.slice(0,6)); await p.waitForTimeout(400);
  chk(n+': search by flight', await p.evaluate(f=>{ const r=[...document.querySelectorAll('#pl-rows .pl-row')]; return r.length>=1 && r.every(x=>x.textContent.includes(f.slice(0,6))); }, first));
  await p.fill('#pl-q','');
  await p.click('#pl-rows .pl-row'); await p.waitForTimeout(1500);
  const dv=await p.evaluate(()=>{ const d=document.getElementById('pl-dv'); return { shown:!d.hidden, route:/LHR/.test(d.textContent)&&/JFK/.test(d.textContent), reg:/G-EUPT/.test(d.textContent), photo:!!d.querySelector('.pl-photo img') && d.querySelector('.pl-photo img').naturalWidth>0, list:document.getElementById('pl-lv').hidden }; });
  chk(n+': picking a plane shows route, registration and photo', dv.shown && dv.route && dv.reg && dv.photo && dv.list, dv);
  const before=await p.evaluate(()=>[RS.pages.planes.map.lat,RS.pages.planes.map.lon]);
  await p.evaluate(()=>{ const m=RS.pages.planes.map; m.setView(m.lat+1, m.lon+1); }); await p.click('[data-act="pl-follow"]'); await p.waitForTimeout(1500);
  const after=await p.evaluate(()=>{ const P=RS.pages.planes, a=P.list.find(x=>x.icao===P.sel); return [Math.abs(P.map.lat-a.lat)+Math.abs(P.map.lon-a.lon)]; });
  chk(n+': Follow keeps the plane in the middle', after[0]<0.05, after);
  await p.click('[data-act="pl-iso"]'); chk(n+': Show only this', await p.evaluate(()=>RS.pages.planes.isolate===true));
  await p.click('[data-act="pl-back"]'); await p.waitForTimeout(300);
  chk(n+': back to the list', await p.evaluate(()=>!document.getElementById('pl-lv').hidden && document.getElementById('pl-dv').hidden && !RS.pages.planes.sel));
  // receiver and air traffic
  chk(n+': receiver card with tiles and charts', await p.evaluate(()=>document.querySelectorAll('#pl-stats > div').length===4 && !!document.getElementById('pl-hour') && !!document.getElementById('pl-cover')));
  chk(n+': air traffic panel', await p.evaluate(()=>!!document.querySelector('#pl-air #air-go')));
  if (n==='desktop') {
    await p.waitForTimeout(16000);
    await p.click('[data-act="pl-rp"]'); await p.waitForTimeout(1200);
    chk('the past hour plays on the map', await p.evaluate(()=>!!RS.pages.planes.replay && !document.getElementById('pl-rp-ctl').hidden && /Replaying/.test(document.getElementById('pl-st').textContent)));
    await p.click('[data-act="pl-rp-live"]'); await p.waitForTimeout(600);
    chk('Live goes back to now', await p.evaluate(()=>!RS.pages.planes.replay && document.getElementById('pl-rp-ctl').hidden));
    // from Home: the chosen plane opens
    const id=await p.evaluate(()=>RS.pages.planes.list.find(a=>a.lat!=null).icao);
    await p.evaluate(()=>RS.go('home')); await p.waitForTimeout(800);
    await p.evaluate(id=>RS.act['ho-plane']({dataset:{id}}), id); await p.waitForTimeout(1500);
    chk('from Home: the plane opens on Planes', await p.evaluate(id=>RS.page==='planes' && RS.pages.planes.sel===id && !document.getElementById('pl-dv').hidden, id));
  }
  chk(n+': no page errors', !errs.length, errs.slice(0,3));
 }
 await b.close(); srv.kill(); console.log(bad?'SOME FAILED':'ALL PASS'); process.exit(bad?1:0); })();
