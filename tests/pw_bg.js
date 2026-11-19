// Phone, switching apps: the MP3 stream takes over (and only then the live player fades), a pause by the phone while
// out of sight does not stop the sound, and coming back hands over to the live player again. Runs on the network
// address (plain http), where the page player is used, as on a phone at home.
for (const k of ['HTTP_PROXY','HTTPS_PROXY','http_proxy','https_proxy']) delete process.env[k];
const { chromium } = require('playwright'); const { spawn } = require('child_process'); const fs=require('fs'),os=require('os'),path=require('path');
(async()=>{ const d=fs.mkdtempSync(path.join(os.tmpdir(),'bg-')); let bad=0; const chk=(n,ok,x)=>{ if(!ok) bad++; console.log((ok?'ok   ':'FAIL ')+n, ok?'':JSON.stringify(x)); };
 const host=process.env.HOST||'192.0.2.2';
 const srv=spawn('python3',['-W','ignore','server.py'],{cwd:path.join(__dirname,'..'),env:{...process.env,SIM:'1',PORT:'18191',DATA_DIR:d,NO_NET:'1',SETUP_DONE:'1',HOST:'0.0.0.0'}});
 await new Promise(r=>setTimeout(r,4000)); const b=await chromium.launch({args:['--autoplay-policy=no-user-gesture-required','--no-proxy-server']});
 const p=await (await b.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true})).newPage(); const errs=[]; p.on('pageerror',e=>errs.push(e.message));
 await p.addInitScript(()=>{ let hid=false; Object.defineProperty(document,'hidden',{get:()=>hid}); Object.defineProperty(document,'visibilityState',{get:()=>hid?'hidden':'visible'});
   window.__vis=h=>{ hid=h; document.dispatchEvent(new Event('visibilitychange')); }; });
 await p.goto('http://'+host+':18191/#radio'); await p.waitForTimeout(2500);
 await p.tap('#sb-play'); await p.waitForTimeout(3000);
 const s0=await p.evaluate(()=>({engine:RS.audio.engine, bg:RS.audio.bgOn(), el:!!RS.audio.el, muted:RS.audio.el&&RS.audio.el.muted, playing:RS.audio.el&&!RS.audio.el.paused}));
 chk('page player on plain http, with the stream ready and muted', s0.engine==='page' && s0.bg && s0.el && s0.muted && s0.playing, s0);
 // switch apps
 await p.evaluate(()=>window.__vis(true)); await p.waitForTimeout(2500);
 const s1=await p.evaluate(()=>({muted:RS.audio.el.muted, paused:RS.audio.el.paused, gain:RS.audio.gain?RS.audio.gain.gain.value:null, on:RS.audio.on}));
 chk('out of sight: the stream is heard and the live player faded', !s1.muted && !s1.paused && s1.on && (s1.gain===null || s1.gain<0.05), s1);
 // the phone pauses the stream (an interruption): it must carry on, not stop
 await p.evaluate(()=>{ RS.audio.el._oursUntil=0; RS.audio.el.pause(); }); await p.waitForTimeout(2500);
 const s2=await p.evaluate(()=>({on:RS.audio.on, paused:RS.audio.el.paused, state:RS.audio.state}));
 chk('a pause by the phone while away does not stop the sound', s2.on && !s2.paused, s2);
 // a stalled stand-in is restarted at the live edge when leaving
 await p.evaluate(()=>window.__vis(false)); await p.waitForTimeout(1500);
 const s3=await p.evaluate(()=>({muted:RS.audio.el.muted, gain:RS.audio.gain?RS.audio.gain.gain.value:null, on:RS.audio.on}));
 chk('back again: live player heard, stream muted and ready', s3.on && s3.muted && (s3.gain===null || s3.gain>0.3), s3);
 await p.evaluate(()=>{ RS.audio.el._oursUntil=Date.now()+2000; RS.audio.el.pause(); }); await p.waitForTimeout(300);
 await p.evaluate(()=>window.__vis(true)); await p.waitForTimeout(3000);
 const s4=await p.evaluate(()=>({muted:RS.audio.el.muted, paused:RS.audio.el.paused, on:RS.audio.on}));
 chk('a stalled stand-in is restarted when leaving', s4.on && !s4.muted && !s4.paused, s4);
 // the lock screen's pause still stops
 await p.evaluate(()=>{ navigator.mediaSession && RS.audio.stop(); }); await p.waitForTimeout(500);
 chk('stopping still stops', await p.evaluate(()=>!RS.audio.on));
 chk('no page errors', !errs.length, errs.slice(0,3));
 // ---- iPhone: plays through the media player from the start, so leaving the app changes nothing
 const ip=await (await b.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'})).newPage();
 const e3=[]; ip.on('pageerror',e=>e3.push(e.message));
 await ip.addInitScript(()=>{ let hid=false; Object.defineProperty(document,'hidden',{get:()=>hid}); Object.defineProperty(document,'visibilityState',{get:()=>hid?'hidden':'visible'}); window.__vis=h=>{ hid=h; document.dispatchEvent(new Event('visibilitychange')); }; });
 await ip.goto('http://'+host+':18191/#radio'); await ip.waitForTimeout(2500);
 await ip.tap('#sb-play'); await ip.waitForTimeout(3000);
 const i0=await ip.evaluate(()=>({ios:RS.audio.ios, mode:RS.audio.mode, muted:RS.audio.el&&RS.audio.el.muted, playing:RS.audio.el&&!RS.audio.el.paused}));
 chk('iPhone: plays through the media player, heard from the start', i0.ios && i0.mode==='stream' && !i0.muted && i0.playing, i0);
 await ip.evaluate(()=>window.__vis(true)); await ip.waitForTimeout(1500);
 const i1=await ip.evaluate(()=>({on:RS.audio.on, muted:RS.audio.el.muted, playing:!RS.audio.el.paused}));
 chk('iPhone: leaving the app changes nothing', i1.on && !i1.muted && i1.playing, i1);
 await ip.evaluate(()=>window.__vis(false));
 // Safari reports its buffer oddly on a live stream; a jump there stalls it for good. Imitate that and make sure
 // the page never seeks or changes speed on Safari, and the sound keeps moving.
 const i2=await ip.evaluate(()=>new Promise(res=>{ const el=RS.audio.el, P=HTMLMediaElement.prototype;
   const ct=Object.getOwnPropertyDescriptor(P,'currentTime'), pr=Object.getOwnPropertyDescriptor(P,'playbackRate'), sd=Object.getOwnPropertyDescriptor(P,'src');
   let seeks=0, rates=0, srcs=0;
   Object.defineProperty(el,'buffered',{configurable:true,get(){ const t=ct.get.call(this); return {length:1,start:()=>0,end:()=>t+25}; }});
   Object.defineProperty(el,'currentTime',{configurable:true,get(){ return ct.get.call(this); }, set(v){ seeks++; }});
   Object.defineProperty(el,'playbackRate',{configurable:true,get(){ return pr.get.call(this); }, set(v){ if(v!==1) rates++; pr.set.call(this,v); }});
   Object.defineProperty(el,'src',{configurable:true,get(){ return sd.get.call(this); }, set(v){ srcs++; sd.set.call(this,v); }});
   const t0=ct.get.call(el); setTimeout(()=>res({safari:RS.audio.safari, seeks, rates, srcs, moved:ct.get.call(el)-t0, playing:!el.paused}),8000); }));
 chk('Safari: never seeks or changes speed on the live stream, and it keeps playing ('+i2.moved.toFixed(1)+' s in 8 s)', i2.safari && i2.seeks===0 && i2.rates===0 && i2.srcs===0 && i2.moved>5 && i2.playing, i2);
 await ip.evaluate(()=>RS.store.set('bgaudio', false)); await ip.evaluate(()=>{ RS.audio.stop(true); RS.audio.start(); }); await ip.waitForTimeout(2500);
 chk('iPhone with background play off: the live player (lowest delay)', await ip.evaluate(()=>RS.audio.mode==='live'));
 chk('iPhone: no page errors', !e3.length, e3.slice(0,3));
 await b.close(); srv.kill(); console.log(bad?'SOME FAILED':'ALL PASS'); process.exit(bad?1:0); })();
