// Location picker: one search bar, results as one list, pick by tap or with the keyboard, the chosen place shown.
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs=require('fs'),os=require('os'),path=require('path');
(async()=>{ const d=fs.mkdtempSync(path.join(os.tmpdir(),'lp-')); let bad=0; const chk=(n,ok,x)=>{ if(!ok) bad++; console.log((ok?'ok   ':'FAIL ')+n, ok?'':JSON.stringify(x)); };
 const srv=spawn('python3',['-W','ignore','server.py'],{cwd:path.join(__dirname,'..'),env:{...process.env,SIM:'1',PORT:'18192',DATA_DIR:d,NO_NET:'1',SETUP_DONE:'1'}});
 await new Promise(r=>setTimeout(r,4000)); const b=await chromium.launch();
 const R=[{name:'Durham',area:'Durham County',admin:'North Carolina',postcode:'27701',country:'United States',cc:'US',lat:35.99,lon:-78.90,region:'us',tz:'America/New_York'},
  {name:'Bragtown',area:'Durham County',admin:'North Carolina',postcode:'27704',country:'United States',cc:'US',lat:36.04,lon:-78.88,region:'us',tz:'America/New_York'}];
 for (const w of [1280,390]) {
  const p=await (await b.newContext({viewport:{width:w,height:900},hasTouch:w<500})).newPage(); const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.route('**/api/geocode**', r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({results:R})}));
  await p.goto('http://127.0.0.1:18192/#settings'); await p.waitForTimeout(2500);
  const id=await p.evaluate(()=>document.querySelector('.locp input[type=search]').id.replace(/-q$/,''));
  await p.fill('#'+id+'-q','Durham'); await p.press('#'+id+'-q','Enter'); await p.waitForTimeout(600);
  const rows=await p.evaluate(id=>[...document.querySelectorAll('#'+id+'-res .locp-row')].map(r=>({w:Math.round(r.getBoundingClientRect().width),x:Math.round(r.getBoundingClientRect().left)})),id);
  chk(w+'px: results are one aligned list, full width rows', rows.length===2 && rows[0].w===rows[1].w && rows[0].x===rows[1].x, rows);
  await p.press('#'+id+'-q','ArrowDown'); await p.press('#'+id+'-q','ArrowDown'); await p.press('#'+id+'-q','Enter'); await p.waitForTimeout(400);
  const now=await p.evaluate(id=>({t:document.getElementById(id+'-picked').textContent, open:!document.getElementById(id+'-res').hidden}),id);
  chk(w+'px: arrow keys and Enter pick a place, list closes', /Bragtown/.test(now.t) && !now.open, now);
  const bar=await p.evaluate(id=>[...document.querySelectorAll('#'+id+'-q, #'+id+'-find, #'+id+'-gps')].map(e=>Math.round(e.getBoundingClientRect().height)),id);
  chk(w+'px: search field and buttons share one height', new Set(bar).size===1, bar);
  await p.click('#'+id+'-ui'); chk(w+'px: units switch', await p.evaluate(id=>document.getElementById(id+'-ui').getAttribute('aria-pressed')==='true',id));
  chk(w+'px: no page errors', !errs.length, errs.slice(0,3));
 }
 await b.close(); srv.kill(); console.log(bad?'SOME FAILED':'ALL PASS'); process.exit(bad?1:0); })();
