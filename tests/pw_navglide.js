// The section bars: the active shape glides between tabs (desktop and phone), in every style, with no errors.
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs=require('fs'),os=require('os'),path=require('path');
(async()=>{ const d=fs.mkdtempSync(path.join(os.tmpdir(),'ng-')); let bad=0;
 const srv=spawn('python3',['-W','ignore','server.py'],{cwd:path.join(__dirname,'..'),env:{...process.env,SIM:'1',PORT:'18182',DATA_DIR:d,NO_NET:'1',SETUP_DONE:'1'}});
 await new Promise(r=>setTimeout(r,4000)); const b=await chromium.launch();
 for (const [vw,vh,bar] of [[1280,900,'#tabs'],[390,844,'#mnav']]) {
  const p=await (await b.newContext({viewport:{width:vw,height:vh},hasTouch:vw<500})).newPage(); const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  await p.goto('http://127.0.0.1:18182/#home'); await p.waitForTimeout(2500);
  for (const st of ['skywave','classic','lumen','bento','folio','terminal','brut']) {
    await p.evaluate(s=>{ document.documentElement.dataset.style=s; }, st); await p.waitForTimeout(400);
    await p.evaluate(()=>RS.go('home')); await p.waitForTimeout(900);
    const r=await p.evaluate(async bar=>{ RS.go('scanner'); await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      const xs=[]; for(let i=0;i<8;i++){ const g=document.querySelector(bar+' > .kx-ng'); xs.push(g?Math.round(parseFloat(getComputedStyle(g).left)+parseFloat(getComputedStyle(g).top)):null); await new Promise(r=>setTimeout(r,40)); }
      await new Promise(r=>setTimeout(r,500)); return { xs, left: document.querySelectorAll(bar+' > .kx-ng').length, hidden: document.querySelectorAll(bar+' .kx-ng-hide').length }; }, bar);
    const moving=r.xs.filter(x=>x!=null), mono=moving.every((x,i)=>!i||x>=moving[i-1]-1);
    const ok=moving.length>=3 && new Set(moving).size>=3 && mono && r.left===0 && r.hidden===0;
    if(!ok) bad++; console.log((ok?'PASS':'FAIL'), vw+'px', st, 'positions', moving.join(','), 'cleaned', r.left===0&&r.hidden===0);
  }
  if (vw>500) { await p.evaluate(()=>{document.documentElement.dataset.style='skywave'; RS.go('home');}); await p.waitForTimeout(600);
    const frames=[]; await p.evaluate(()=>RS.go('planes')); for(let i=0;i<4;i++){ frames.push(await p.locator('#tabs').screenshot()); await p.waitForTimeout(70); }
    frames.forEach((f,i)=>fs.writeFileSync('/tmp/ng'+i+'.png',f)); }
  if (errs.length) { bad++; console.log('FAIL errors', errs.slice(0,3)); }
 }
 await b.close(); srv.kill(); console.log(bad?'SOME FAILED':'ALL PASS'); process.exit(bad?1:0); })();
