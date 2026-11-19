// Cover art "Open in" card, the song text not repeated under the station name, and the remembered-gain line.
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs=require('fs'),os=require('os'),path=require('path');
(async()=>{ const d=fs.mkdtempSync(path.join(os.tmpdir(),'oi-')); let bad=0; const chk=(n,ok,x)=>{ if(!ok) bad++; console.log((ok?'ok   ':'FAIL ')+n, ok?'':JSON.stringify(x)); };
 const srv=spawn('python3',['-W','ignore','server.py'],{cwd:path.join(__dirname,'..'),env:{...process.env,SIM:'1',PORT:'18189',DATA_DIR:d,NO_NET:'1',SETUP_DONE:'1'}});
 await new Promise(r=>setTimeout(r,4000)); const b=await chromium.launch();
 const ctx=await b.newContext({viewport:{width:1280,height:900},locale:'en-GB'}); const p=await ctx.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(e.message));
 let asked=''; let fail=false;
 await p.route('**/api/artlinks**', r=>{ asked=r.request().url(); if(fail) return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({links:[],ok:false,country:'GB'})});
   r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,country:'GB',links:[{service:'appleMusic',name:'Apple Music',url:'https://music.apple.com/x',kind:'song'},{service:'spotify',name:'Spotify',url:'https://open.spotify.com/search/x',kind:'search'},{service:'youtubeMusic',name:'YouTube Music',url:'https://music.youtube.com/search?q=x',kind:'search'}]})}); });
 await p.route('**/api/svcicon/spotify', r=>r.fulfill({status:200,contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==','base64')}));
 await p.route('**/api/svcicon/appleMusic', r=>r.fulfill({status:404,body:'no'}));
 await p.goto('http://127.0.0.1:18189/#radio'); await p.waitForTimeout(2500);
 // a cover as if it had been found (the sandbox has no internet)
 await p.evaluate(()=>{ const png='data:image/svg+xml;utf8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="#c63"/></svg>');
   RS.art.cur={url:png,title:'Holding Out For A Hero',artist:'Bonnie Tyler',album:'Footloose',rt:'x',track:1440818839}; RS.art.paint(); });
 await p.waitForTimeout(600);
 chk('cover is a button', await p.evaluate(()=>{ const a=document.querySelector('#rd-np .np-art'); return a.getAttribute('role')==='button' && a.tabIndex===0; }));
 await p.click('#rd-np .np-art'); await p.waitForTimeout(900);
 const names=await p.evaluate(()=>[...document.querySelectorAll('.ol-row .ol-n')].map(s=>s.textContent));
 chk('card lists the services, sorted by name', JSON.stringify(names)===JSON.stringify(['Apple Music','Spotify','YouTube Music']), names);
 chk('asked for this song in the listener\'s country', /track=1440818839/.test(asked) && /cc=GB/.test(asked) && /artist=Bonnie/.test(asked) && /title=Holding/.test(asked), asked);
 chk('search rows are marked as searches', await p.evaluate(()=>{ const r=[...document.querySelectorAll('.ol-row')]; return !r[0].querySelector('.ol-k') && /Search/.test(r[1].querySelector('.ol-k').textContent); }));
 chk('service icons shown, initial when an icon is missing', await p.evaluate(()=>{ const r=[...document.querySelectorAll('.ol-row')]; return r[0].querySelector('.ol-ic img')===null && r[0].querySelector('.ol-ic').dataset.l==='A' && !!r[1].querySelector('.ol-ic img') && r[1].querySelector('.ol-ic img').naturalWidth>0; }));
 chk('links open in a new tab, safely', await p.evaluate(()=>[...document.querySelectorAll('.ol-row')].every(a=>a.target==='_blank' && /noopener/.test(a.rel))));
 chk('says which open the song and which search', /Apple Music opens the song itself, checked for (the )?United Kingdom/.test(await p.textContent('#ol-note')), await p.textContent('#ol-note'));
 await p.keyboard.press('Escape'); await p.waitForTimeout(500);
 fail=true; await p.click('#rd-np .np-art'); await p.waitForTimeout(900);
 chk('offline: says so and offers Try again', await p.evaluate(()=>!!document.querySelector('.ol [data-act="art-open"]')));
 await p.keyboard.press('Escape'); await p.waitForTimeout(500);
 // the song line under the station name shows the recognised song once (title and artist), not the raw RadioText as well
 const sub=await p.evaluate(()=>{ RS.st.rds={ps:'WAVE FM',rt:'NOW: Holding Out For A Hero - Bonnie Tyler',pty:10,pty_name:'Pop music'}; RS.pages.radio.state(); return document.getElementById('rd-song').textContent; });
 chk('song shown once under the station name', (sub.match(/Holding/g)||[]).length===1 && !/NOW:/.test(sub), sub);
 // remembered gain line
 chk('remembered gain is shown with Forget', await p.evaluate(()=>{ RS.st.job='listen'; RS.st.gmem={f:100.0e6,gain:29.7,checked:Date.now()/1000}; RS.fire('state'); const g=document.getElementById('rd-gm'); return g && !g.hidden && /29\.7 dB/.test(g.textContent) && !!g.querySelector('[data-act="sg-forget"]'); }));
 chk('no page errors', !errs.length, errs.slice(0,3));
 await b.close(); srv.kill(); console.log(bad?'SOME FAILED':'ALL PASS'); process.exit(bad?1:0); })();
