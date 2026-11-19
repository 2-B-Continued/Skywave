// Every button: after presses (ripple layers present) and the app's own updates, no label text ever lands in the ripple layer.
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs=require('fs'),os=require('os'),path=require('path');
(async()=>{ const d=fs.mkdtempSync(path.join(os.tmpdir(),'rs-'));
 const srv=spawn('python3',['-W','ignore','server.py'],{cwd:path.join(__dirname,'..'),env:{...process.env,SIM:'1',PORT:'18185',DATA_DIR:d,NO_NET:'1',SETUP_DONE:'1'}});
 await new Promise(r=>setTimeout(r,4000)); const b=await chromium.launch(); const p=await (await b.newContext({viewport:{width:1440,height:900}})).newPage(); p.on('console',m=>{ if(/^RIP/.test(m.text())) console.log(m.text()); });
 await p.addInitScript(()=>{localStorage.setItem('rs.adv','true');});
 await p.goto('http://127.0.0.1:18185/#home'); await p.waitForTimeout(2500);
 const all=new Set();
 for (const pg of ['home','radio','scanner','planes','ships','space','ham','sensors','sondes','messages','explore','library','lab','settings']) {
   console.log('PAGE',pg); await p.evaluate(x=>RS.go(x),pg); await p.waitForTimeout(900);
   await p.evaluate(async()=>{ const L=[...document.querySelectorAll('.page.on button, .page.on .btn, .page.on .chip, .soundbar button')].filter(e=>e.getBoundingClientRect().width).slice(0,40); for(const el of L){ console.log('RIP '+(el.id||el.className)+' '+el.textContent.trim().slice(0,18)); const r=el.getBoundingClientRect(); el.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:r.left+5,clientY:r.top+5,button:0})); await new Promise(r=>setTimeout(r,25)); } });
   // toggle the common two-state controls the way a press would
   await p.evaluate(()=>{ ['#rd-star','#hm-star','#rd-morse'].forEach(s=>{ const e=document.querySelector(s); if(e&&e.offsetWidth) e.click(); }); });
   await p.waitForTimeout(2500);
   const r=await p.evaluate(()=>[...document.querySelectorAll('.kx-rw')].filter(w=>w.textContent.trim()).map(w=>{ const b=w.parentElement; return (b.id||b.className)+' :: ripple layer holds "'+w.textContent.trim()+'", button shows "'+b.innerText.replace(/\s+/g,' ').trim()+'"'; }));
   r.forEach(x=>all.add(pg+' | '+x));
   await p.evaluate(()=>{ ['#rd-star','#hm-star','#rd-morse'].forEach(s=>{ const e=document.querySelector(s); if(e&&e.offsetWidth) e.click(); }); });
 }
 console.log([...all].join('\n')||'PASS no label ever lands in the ripple layer'); if(all.size) console.log('FAIL'); await b.close(); srv.kill(); })();
