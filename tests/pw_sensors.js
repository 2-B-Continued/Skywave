// Sensors page: status strip, Nearby list (cars kept apart), Mine / Hide / Show, naming (kept by the server), band hopping,
// and the spectrum survey on Explore. Uses tests/bin/fake_rtl433.py as the decoder.
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs=require('fs'),os=require('os'),path=require('path');
(async()=>{ const d=fs.mkdtempSync(path.join(os.tmpdir(),'sen-')); let bad=0; const chk=(n,ok,x)=>{ if(!ok) bad++; console.log((ok?'ok   ':'FAIL ')+n, ok?'':JSON.stringify(x)); };
 const srv=spawn('python3',['-W','ignore','server.py'],{cwd:path.join(__dirname,'..'),env:{...process.env,SIM:'1',PORT:'18194',DATA_DIR:d,NO_NET:'1',SETUP_DONE:'1',RTL433_BIN:'python3 '+path.join(__dirname,'bin','fake_rtl433.py'),FAKE433_FAST:'1'}});
 await new Promise(r=>setTimeout(r,4000)); const b=await chromium.launch();
 const p=await (await b.newContext({viewport:{width:1280,height:950}})).newPage(); const errs=[]; p.on('pageerror',e=>errs.push(e.message));
 await p.goto('http://127.0.0.1:18194/#sensors'); await p.waitForTimeout(6000);
 chk('status strip says what it listens on', /Listening on 433\.92 MHz/.test(await p.textContent('#se-st')), await p.textContent('#se-st'));
 const rows=await p.evaluate(()=>[...document.querySelectorAll('#se-list .sen-row-t b')].map(b=>b.textContent));
 chk('Nearby lists the sensors ('+rows.length+')', rows.length>=4, rows);
 chk('passing cars are kept out of the list', !rows.some(r=>/Toyota/.test(r)) && /Passing cars: \d+/.test(await p.textContent('#se-cars-t')));
 chk('a hint explains Mine while none are yours', await p.evaluate(()=>!!document.querySelector('#se-mine .sen-hint')));
 // Mine
 await p.click('#se-list .sen-row:has-text("Nexus") [data-act="se-mine"]'); await p.waitForTimeout(800);
 chk('Mine moves it to Your sensors as a card', await p.evaluate(()=>[...document.querySelectorAll('#se-mine .sen-card')].some(c=>/Nexus/.test(c.textContent)) && ![...document.querySelectorAll('#se-list .sen-row')].some(r=>/Nexus/.test(r.textContent))));
 // name it in its sheet
 await p.click('#se-mine .sen-card'); await p.waitForTimeout(700);
 await p.fill('#se-name','Bedroom'); await p.press('#se-name','Enter'); await p.waitForTimeout(800);
 await p.keyboard.press('Escape'); await p.waitForTimeout(400);
 // hide one
 await p.click('#se-list .sen-row:has-text("Prologue") .sen-row-b'); await p.waitForTimeout(600);
 await p.click('.sen-modal [data-act="se-hide"]'); await p.waitForTimeout(800);
 chk('Hide folds it under Hidden', await p.evaluate(()=>!document.getElementById('se-hid').hidden && /Hidden: 1/.test(document.getElementById('se-hid-t').textContent) && ![...document.querySelectorAll('#se-list .sen-row')].some(r=>/Prologue/.test(r.textContent))));
 // the server kept all of it
 await p.reload(); await p.waitForTimeout(4000);
 chk('name, Mine and Hidden are kept by the server', await p.evaluate(()=>[...document.querySelectorAll('#se-mine .sen-card b')].some(b=>b.textContent==='Bedroom') && /Hidden: 1/.test(document.getElementById('se-hid-t').textContent)));
 await p.click('#se-hid summary'); await p.waitForTimeout(400); await p.click('#se-hid-l [data-act="se-unhide"]'); await p.waitForTimeout(800);
 chk('Show brings it back', await p.evaluate(()=>[...document.querySelectorAll('#se-list .sen-row')].some(r=>/Prologue/.test(r.textContent))));
 // search and type
 await p.fill('#se-q','efergy'); await p.waitForTimeout(300);
 chk('search narrows the list', await p.evaluate(()=>{ const r=[...document.querySelectorAll('#se-list .sen-row')]; return r.length===1 && /Efergy/.test(r[0].textContent); }));
 await p.fill('#se-q',''); await p.selectOption('#se-kind','weather'); await p.waitForTimeout(300);
 chk('type filter', await p.evaluate(()=>[...document.querySelectorAll('#se-list .sen-row')].every(r=>/Weather/.test(r.textContent))));
 await p.selectOption('#se-kind','');
 // band: hop between two
 await p.click('[data-act="se-band"]'); await p.waitForTimeout(500);
 await p.click('[data-act="se-band-pick"][data-id="433-868"]'); await p.waitForTimeout(3500);
 chk('band picker: hops between two bands', /433\.92 and 868\.3 MHz/.test(await p.textContent('#se-st')), await p.textContent('#se-st'));
 // the sheet shows readings
 await p.click('#se-mine .sen-card'); await p.waitForTimeout(700);
 chk('sheet shows readings and details', await p.evaluate(()=>document.querySelectorAll('.sen-kv > div').length>=2 && /Messages/.test(document.querySelector('.sen-meta:not(.rdp-kv)').textContent)));
 await p.keyboard.press('Escape');
 // survey on Explore
 await p.evaluate(()=>RS.go('explore')); await p.waitForTimeout(800);
 chk('the spectrum survey is on Explore', await p.evaluate(()=>!!document.querySelector('#p-explore #sv-card #sv-go')));
 chk('and gone from Sensors', await p.evaluate(()=>!document.querySelector('#p-sensors #sv-card')));
 chk('no page errors', !errs.length, errs.slice(0,3));
 await b.close(); srv.kill(); console.log(bad?'SOME FAILED':'ALL PASS'); process.exit(bad?1:0); })();
