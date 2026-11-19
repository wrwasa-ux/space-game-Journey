'use strict';
// سيرفر "رحلة إلى الفضاء" أونلاين — بدون أي مكتبات خارجية. التشغيل: node server.js
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const PORT=+process.env.PORT||3000,DIR=__dirname;
const MIME={'.html':'text/html; charset=utf-8','.json':'application/json','.png':'image/png','.js':'text/javascript'};
const HIDE=new Set(['server.js','package.json']);
const srv=http.createServer((req,res)=>{
  let p;try{p=decodeURIComponent(req.url.split('?')[0])}catch(e){p='/'}
  if(p==='/health'){res.end('ok');return}
  if(p==='/')p='/index.html';
  const f=path.join(DIR,path.normalize(p)),ext=path.extname(f);
  if(!f.startsWith(DIR+path.sep)||HIDE.has(path.basename(f))||!MIME[ext]){res.writeHead(404);res.end('404');return}
  fs.readFile(f,(e,b)=>{
    if(e){res.writeHead(404);res.end('404');return}
    res.writeHead(200,{'Content-Type':MIME[ext],'Cache-Control':(ext==='.html'||p==='/sw.js')?'no-cache':'public, max-age=3600'});
    res.end(b);
  });
});

/* ---------- WebSocket (يدوي، نصوص فقط) ---------- */
const GUID='258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const clients=new Set(),queue={coop:null,vs:null},rooms=new Map();
const RT=new Set(['s','b','k','fin','dead','u','e','en','eb','wd','wn']); // رسائل تُمرَّر للاعب الآخر فقط
const CH='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const names=new Map();
const nm=v=>String(v||'').replace(/[\u0000-\u001f<>]/g,'').trim().slice(0,14);
let nid=1;

function frame(op,d){
  let h;
  if(d.length<126)h=Buffer.from([0x80|op,d.length]);
  else{h=Buffer.alloc(4);h[0]=0x80|op;h[1]=126;h.writeUInt16BE(d.length,2)}
  return Buffer.concat([h,d]);
}
function send(c,o){if(!c.alive)return;try{c.s.write(frame(1,Buffer.from(JSON.stringify(o))))}catch(e){}}
function kill(c){
  if(!c.alive)return;c.alive=false;clients.delete(c);leave(c);
  if(c.name&&names.get(c.name.toLowerCase())===c)names.delete(c.name.toLowerCase());
  for(const o of clients)if(o.inv&&o.inv.to===c){o.inv=null;send(o,{t:'err',e:'اللاعب غادر'})}
  try{c.s.end()}catch(e){}try{c.s.destroy()}catch(e){}
}
function leave(c){
  if(c.inv){send(c.inv.to,{t:'invx',from:c.name});c.inv=null}
  for(const m in queue)if(queue[m]===c)queue[m]=null;
  const r=c.room;if(!r)return;
  c.room=null;if(r.code)rooms.delete(r.code);
  const o=r.a===c?r.b:r.a;
  if(o&&o.room===r){o.room=null;send(o,{t:'left'})}
}
const dfOf=v=>{v=+v;return [.7,1,1.4,2].includes(v)?v:1};
const lvOf=v=>[Math.max(0,Math.min(49,(v&&v[0])|0)),Math.max(1,Math.min(10,((v&&v[1])|0)||1))];
function mkCode(){let c;do{c='';for(let i=0;i<4;i++)c+=CH[crypto.randomInt(CH.length)]}while(rooms.has(c));return c}
function begin(r){ // غرفة انتظار: المضيف (a) يختار الصعوبة والضيف (b) يضغط جاهز
  if(r.code){rooms.delete(r.code)}
  r.a.inv=null;r.lobby=1;r.rb=0;
  send(r.a,{t:'lobby',m:r.m,lv:r.lv,df:r.df,side:0,op:r.b.name||'لاعب'});
  send(r.b,{t:'lobby',m:r.m,lv:r.lv,df:r.df,side:1,op:r.a.name||'لاعب'});
}
function launch(r){
  r.lobby=0;
  send(r.a,{t:'start',m:r.m,lv:r.lv,df:r.df,side:0,op:r.b.name||'لاعب'});
  send(r.b,{t:'start',m:r.m,lv:r.lv,df:r.df,side:1,op:r.a.name||'لاعب'});
}
function onMsg(c,d){
  const now=Date.now();if(now-c.t>1000){c.t=now;c.n=0}if(++c.n>150)return;
  switch(d.t){
    case 'pub':{
      leave(c);const m=d.m==='vs'?'vs':'coop',q=queue[m];
      if(q&&q.alive&&q!==c&&!q.room){queue[m]=null;const r={code:'',m,lv:q.lv,df:q.df,a:q,b:c};q.room=c.room=r;begin(r)}
      else{c.lv=lvOf(d.lv);c.df=dfOf(d.df);queue[m]=c;send(c,{t:'wait'})}
      break}
    case 'new':{
      leave(c);const code=mkCode(),r={code,m:d.m==='vs'?'vs':'coop',lv:lvOf(d.lv),df:dfOf(d.df),a:c,b:null};
      rooms.set(code,r);c.room=r;send(c,{t:'wait',c:code});break}
    case 'join':{
      leave(c);const r=rooms.get(String(d.c||'').toUpperCase());
      if(!r||r.b||!r.a.alive){send(c,{t:'err',e:'الغرفة غير موجودة أو ممتلئة'});break}
      r.b=c;c.room=r;begin(r);break}
    case 'name':{
      const n=nm(d.n);if(n.length<2){send(c,{t:'err',e:'الاسم قصير',c:'name'});break}
      const k=n.toLowerCase(),o=names.get(k);
      if(o&&o!==c){if(o.room){send(c,{t:'err',e:'الاسم مستخدم الآن',c:'name'});break}kill(o)}
      if(c.name&&c.name.toLowerCase()!==k)names.delete(c.name.toLowerCase());
      c.name=n;names.set(k,c);send(c,{t:'named',n});break}
    case 'inv':{
      leave(c);const o=names.get(nm(d.to).toLowerCase());
      if(!o||!o.alive||o===c){send(c,{t:'err',e:'ما لقيت لاعب بهذا الاسم متصل'});break}
      if(o.room){send(c,{t:'err',e:o.name+' داخل مباراة الحين'});break}
      c.inv={to:o,m:d.m==='vs'?'vs':'coop',lv:lvOf(d.lv),df:dfOf(d.df)};
      send(o,{t:'inv',from:c.name,m:c.inv.m});send(c,{t:'wait',w:o.name});break}
    case 'acc':{
      const s=names.get(nm(d.from).toLowerCase());
      if(!s||!s.alive||!s.inv||s.inv.to!==c||c.room||s.room){send(c,{t:'err',e:'الدعوة انتهت'});break}
      leave(c);const iv=s.inv;s.inv=null;
      const r={code:'',m:iv.m,lv:iv.lv,df:iv.df,a:s,b:c};s.room=c.room=r;begin(r);break}
    case 'dec':{
      const s=names.get(nm(d.from).toLowerCase());
      if(s&&s.inv&&s.inv.to===c){s.inv=null;send(s,{t:'err',e:(c.name||'اللاعب')+' رفض الدعوة'})}break}
    case 'df':{const r=c.room;if(!r||!r.lobby||r.a!==c||!r.b)break;r.df=dfOf(d.v);r.rb=0;send(r.b,{t:'df',v:r.df});send(r.a,{t:'rdy',v:0});break}
    case 'rdy':{const r=c.room;if(!r||!r.lobby||r.b!==c)break;r.rb=d.v?1:0;send(r.a,{t:'rdy',v:r.rb});break}
    case 'go':{const r=c.room;if(!r||!r.lobby||r.a!==c||!r.b||!r.rb)break;launch(r);break}
    case 'leave':leave(c);break;
    default:{
      const r=c.room;if(!r||!r.b||r.lobby||!RT.has(d.t))return;
      const o=r.a===c?r.b:r.a;if(o.alive)send(o,d)}
  }
}
function parse(c){
  for(;;){
    const b=c.buf;if(b.length<2)return;
    const op=b[0]&15,fin=b[0]>>7,mask=b[1]>>7;let len=b[1]&127,o=2;
    if(len===126){if(b.length<4)return;len=b.readUInt16BE(2);o=4}else if(len===127)return kill(c);
    if(!mask||!fin||op===0||len>4096)return kill(c);
    if(b.length<o+4+len)return;
    const mk=b.subarray(o,o+4),pl=Buffer.alloc(len);
    for(let i=0;i<len;i++)pl[i]=b[o+4+i]^mk[i&3];
    c.buf=b.subarray(o+4+len);c.last=Date.now();
    if(op===8){try{c.s.write(frame(8,Buffer.alloc(0)))}catch(e){}return kill(c)}
    if(op===9){try{c.s.write(frame(10,pl))}catch(e){}continue}
    if(op===1){let d;try{d=JSON.parse(pl.toString('utf8'))}catch(e){continue}if(d&&typeof d==='object')onMsg(c,d)}
  }
}
srv.on('upgrade',(req,s)=>{
  const k=req.headers['sec-websocket-key'];
  if(!k||clients.size>2000){s.destroy();return}
  s.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+crypto.createHash('sha1').update(k+GUID).digest('base64')+'\r\n\r\n');
  const c={s,id:nid++,buf:Buffer.alloc(0),room:null,alive:true,n:0,t:Date.now(),last:Date.now(),lv:[0,1],name:'',inv:null};
  clients.add(c);s.setNoDelay(true);
  s.on('data',d=>{c.buf=Buffer.concat([c.buf,d]);if(c.buf.length>16384)return kill(c);parse(c)});
  s.on('close',()=>kill(c));s.on('error',()=>kill(c));
});
setInterval(()=>{const now=Date.now();for(const c of clients){if(now-c.last>70000)kill(c);else try{c.s.write(frame(9,Buffer.alloc(0)))}catch(e){}}},25000);
srv.listen(PORT,()=>console.log('Space online server on :'+PORT));
