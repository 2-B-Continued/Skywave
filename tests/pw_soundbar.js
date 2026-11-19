// Sound bar: one label on the Start sound button after real presses (with the ripple layer present), and a level bar that moves smoothly.
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs=require('fs'),os=require('os'),path=require('path');
for (const k of ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy']) delete process.env[k];   // reach the network address directly
(async()=>{ const d=fs.mkdtempSync(path.join(os.tmpdir(),'sb-')); let bad=0; const chk=(n,ok,x)=>{ if(!ok) bad++; console.log((ok?'ok   ':'FAIL ')+n, ok?'':JSON.stringify(x)); };
 const srv=spawn('python3',['-W','ignore','server.py'],{cwd:path.join(__dirname,'..'),env:{...process.env,SIM:'1',PORT:'18184',DATA_DIR:d,NO_NET:'1',SETUP_DONE:'1'}});
 await new Promise(r=>setTimeout(r,4000)); const b=await chromium.launch({args:['--autoplay-policy=no-user-gesture-required','--no-proxy-server']});
 const host=process.env.HOST||'192.0.2.2';
 const p=await (await b.newContext({viewport:{width:1440,height:900}})).newPage();
 await p.goto('http://'+host+':18184/#radio'); await p.waitForTimeout(2500);
 for (let i=0;i<3;i++){ await p.click('#sb-play'); await p.waitForTimeout(1500); }   // on, off, on
 const lab=await p.evaluate(()=>{ const b=document.getElementById('sb-play'); const texts=[...b.querySelectorAll('span')].map(s=>s.className+':'+s.textContent.trim()).filter(x=>!/:$/.test(x)); return { texts, rw: !!b.querySelector('.kx-rw'), shown: b.innerText.trim() }; });
 chk('one label after pressing (ripple layer present: '+lab.rw+')', lab.texts.length===1 && /Sound On/i.test(lab.shown) && !/Start/i.test(lab.shown), lab);
 const m=await p.evaluate(()=>new Promise(res=>{ const el=document.getElementById('sb-meter'), v=[]; const t0=performance.now();
   (function f(){ const tr=el.style.transform; const x=tr?parseFloat(tr.match(/-?[\d.]+/)[0])+100:0; v.push(x); if(performance.now()-t0<4000) requestAnimationFrame(f); else res(v); })(); }));
 let jumps=0, rev=0; for(let i=2;i<m.length;i++){ if(Math.abs(m[i]-m[i-1])>25) jumps++; if((m[i]-m[i-1])*(m[i-1]-m[i-2])<0) rev++; }
 const avg=m.reduce((a,b)=>a+b,0)/m.length;
 chk('level bar moves ('+avg.toFixed(0)+'% average)', avg>3, avg);
 chk('no big frame-to-frame jumps ('+jumps+')', jumps<=2, jumps);
 chk('no constant up-down sawing ('+(rev/4).toFixed(0)+' reversals a second)', rev/4 < 20, rev/4);
 chk('width stays fixed (moved by transform only)', await p.evaluate(()=>document.getElementById('sb-meter').style.width==='100%'), null);
 await b.close(); srv.kill(); console.log(bad?'SOME FAILED':'ALL PASS'); process.exit(bad?1:0); })();
