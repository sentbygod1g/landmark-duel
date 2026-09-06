const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, 'public');
const MAX_HP = 5000;
const NORMAL_ROUNDS = 25;
const ROUND_MS = 60000;
const rooms = new Map();

// Public KartaView 360 sequence. No API key is required for public imagery.
const KARTAVIEW_SEQUENCES = [6187609];
const FALLBACK_PANO = {
  id: '1623585577', sequenceId: '6187609', sequenceIndex: 695,
  lat: -6.193911, lng: 106.849350, heading: 150.16,
  url: 'https://storage13.openstreetcam.org/files/photo/2022/10/6/wrapped_proc/6187609_626b8_633f5d392b4be.jpg'
};

const mime = {
  '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.js':'application/javascript; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon'
};
function send(ws,obj){ if(ws && ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function broadcast(room,obj){ room.players.forEach(p=>send(p.ws,obj)); }
function clean(v){ return String(v||'Играч').replace(/[<>]/g,'').trim().slice(0,28)||'Играч'; }
function roomCode(){ const c='ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s=''; do{s='';for(let i=0;i<6;i++)s+=c[Math.floor(Math.random()*c.length)];}while(rooms.has(s));return s; }
function shuffle(a){ const x=[...a]; for(let i=x.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[x[i],x[j]]=[x[j],x[i]];}return x; }
function hav(a,b){ const R=6371,toR=x=>x*Math.PI/180,dLat=toR(b.lat-a.lat),dLng=toR(b.lng-a.lng),la1=toR(a.lat),la2=toR(b.lat); const h=Math.sin(dLat/2)**2+Math.cos(la1)*Math.cos(la2)*Math.sin(dLng/2)**2; return 2*R*Math.asin(Math.sqrt(h)); }
function geoScore(km){ return Math.max(0,Math.round(5000*Math.exp(-km/1800))); }
function publicPlayer(p){return {id:p.id,name:p.name,hp:p.hp,connected:!!(p.ws&&p.ws.readyState===WebSocket.OPEN),locked:!!p.guess,bot:!!p.bot};}
function sendState(room){broadcast(room,{type:'room_state',code:room.code,hostId:room.hostId,phase:room.phase,players:room.players.map(publicPlayer)});}
function normalizedPhoto(p){
  const fov=Number(p.fieldOfView||0), projection=String(p.projection||'').toUpperCase();
  let url=p.fileurlProc||'';
  if(!url && p.fileurl) url=String(p.fileurl).replace('[[sizeprefix]]','wrapped_proc');
  return {id:String(p.id||''),sequenceId:String(p.sequenceId||p.sequence?.id||''),sequenceIndex:Number(p.sequenceIndex||0),lat:Number(p.lat),lng:Number(p.lng),heading:Number(p.heading||0),url,projection,fov};
}
async function fetchJson(url){ const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(),10000); try{const r=await fetch(url,{headers:{'User-Agent':'LandmarkDuel/20.1'},signal:ctrl.signal}); if(!r.ok)throw new Error('HTTP '+r.status); return await r.json();} finally{clearTimeout(t);} }
async function loadKartaPage(){
  const seq=KARTAVIEW_SEQUENCES[Math.floor(Math.random()*KARTAVIEW_SEQUENCES.length)];
  const page=1+Math.floor(Math.random()*16);
  const url=`https://api.openstreetcam.org/2.0/photo/?sequenceId=${seq}&page=${page}&itemsPerPage=150`;
  try{
    const d=await fetchJson(url); const raw=d?.result?.data||[];
    const photos=raw.map(normalizedPhoto).filter(p=>p.url&&Number.isFinite(p.lat)&&Number.isFinite(p.lng)&&(p.projection==='SPHERE'||p.fov>=300));
    if(photos.length>=3)return photos;
  }catch(e){ console.error('KartaView API:',e.message); }
  return [FALLBACK_PANO];
}
function makePlayer(ws,name,bot=false){return {id:crypto.randomUUID(),name:clean(name),hp:MAX_HP,ws,bot,guess:null,lockedAt:null,viewIndex:0};}
function attach(ws,room,p){p.ws=ws;ws.roomCode=room.code;ws.playerId=p.id;}
function currentTarget(room){return room.photos[room.startIndex]||FALLBACK_PANO;}
function panoProxyUrl(raw){ return '/api/pano?url='+encodeURIComponent(String(raw||'')); }
function safePhoto(p){return {url:panoProxyUrl(p.url),heading:p.heading||0,canBack:true,canForward:true,provider:'KartaView'};}
async function beginRound(room){
  clearTimeout(room.timer); clearTimeout(room.advanceTimer);
  room.phase='loading'; room.players.forEach(p=>{p.guess=null;p.lockedAt=null;p.viewIndex=0;}); sendState(room);
  room.photos=await loadKartaPage(); room.startIndex=room.photos.length>4?2+Math.floor(Math.random()*(room.photos.length-4)):0;
  room.players.forEach(p=>p.viewIndex=room.startIndex);
  room.phase='guess'; room.deadline=Date.now()+ROUND_MS;
  const t=currentTarget(room);
  broadcast(room,{type:'round_start',roundNo:room.roundNo,total:NORMAL_ROUNDS,suddenDeath:room.suddenDeath,deadline:room.deadline,photo:safePhoto(t),players:room.players.map(publicPlayer)});
  sendState(room);
  room.timer=setTimeout(()=>reveal(room,true),ROUND_MS+100);
  if(room.demo){
    const bot=room.players.find(p=>p.bot); if(bot){
      const delay=7000+Math.floor(Math.random()*9000);
      setTimeout(()=>{if(room.phase!=='guess'||bot.guess)return;const spread=0.15+Math.random()*4;bot.guess={lat:t.lat+(Math.random()-.5)*spread,lng:t.lng+(Math.random()-.5)*spread};bot.lockedAt=Date.now();broadcast(room,{type:'player_locked',playerId:bot.id});if(room.players.every(x=>x.guess))reveal(room,false);},delay);
    }
  }
}
function calcDamage(a,b){ if(a.score===b.score)return {damage:0,attackerId:null}; const win=a.score>b.score?a:b, lose=win===a?b:a; const raw=Math.max(120,Math.min(1200,Math.round((win.score-lose.score)/3.5))); return {damage:raw,attackerId:win.id}; }
function reveal(room,timeout){
  if(room.phase!=='guess')return; clearTimeout(room.timer); room.phase='reveal'; const target=currentTarget(room);
  const results=room.players.map(p=>{if(!p.guess)return{id:p.id,name:p.name,guess:null,distanceKm:null,score:0};const distanceKm=hav(p.guess,target);return{id:p.id,name:p.name,guess:p.guess,distanceKm,score:geoScore(distanceKm)};});
  const dmg=calcDamage(results[0],results[1]); if(dmg.attackerId){const victim=room.players.find(p=>p.id!==dmg.attackerId);dmg.damage=Math.min(dmg.damage,victim.hp);victim.hp=Math.max(0,victim.hp-dmg.damage);}
  broadcast(room,{type:'round_result',roundNo:room.roundNo,timeout,target:{lat:target.lat,lng:target.lng},results,damage:dmg.damage,attackerId:dmg.attackerId,players:room.players.map(publicPlayer)}); sendState(room);
  const dead=room.players.find(p=>p.hp<=0); if(dead){return setTimeout(()=>endMatch(room,room.players.find(p=>p.id!==dead.id)?.id,'KO'),6500);}
  room.advanceTimer=setTimeout(()=>advance(room),8000);
}
function advance(room){ if(room.phase!=='reveal')return; if(room.roundNo>=NORMAL_ROUNDS){ if(room.players[0].hp!==room.players[1].hp){const w=room.players[0].hp>room.players[1].hp?room.players[0]:room.players[1];return endMatch(room,w.id,'HP');} room.suddenDeath=true; }
  room.roundNo++; beginRound(room).catch(e=>broadcast(room,{type:'error',message:e.message}));
}
function endMatch(room,winnerId,reason){room.phase='ended';clearTimeout(room.timer);clearTimeout(room.advanceTimer);const w=room.players.find(p=>p.id===winnerId);broadcast(room,{type:'match_end',winnerId,winnerName:w?.name||'',reason,players:room.players.map(publicPlayer)});sendState(room);}
function handle(ws,msg){
  let d;try{d=JSON.parse(msg.toString())}catch{return;}
  if(d.type==='create_room'||d.type==='create_demo'){
    if(ws.roomCode)return; const p=makePlayer(ws,d.name),code=roomCode(); const room={code,hostId:p.id,players:[p],phase:'lobby',roundNo:1,suddenDeath:false,photos:[],startIndex:0,deadline:0,timer:null,advanceTimer:null,demo:d.type==='create_demo'}; rooms.set(code,room);attach(ws,room,p);
    if(room.demo){const bot=makePlayer(null,'Geo Bot',true);room.players.push(bot);} send(ws,{type:'joined',playerId:p.id,code,host:true});sendState(room); if(room.demo)beginRound(room).catch(e=>send(ws,{type:'error',message:e.message})); return;
  }
  if(d.type==='join_room'){
    const room=rooms.get(String(d.code||'').toUpperCase()); if(!room||room.phase!=='lobby'||room.players.length>=2)return send(ws,{type:'error',message:'Стаята не е налична.'}); const p=makePlayer(ws,d.name);room.players.push(p);attach(ws,room,p);send(ws,{type:'joined',playerId:p.id,code:room.code,host:false});sendState(room);return;
  }
  const room=rooms.get(ws.roomCode); if(!room)return;
  if(d.type==='start_match'){if(ws.playerId!==room.hostId||room.players.length!==2)return;room.players.forEach(p=>p.hp=MAX_HP);room.roundNo=1;room.suddenDeath=false;return beginRound(room).catch(e=>broadcast(room,{type:'error',message:e.message}));}
  if(d.type==='move'){
    if(room.phase!=='guess')return;const p=room.players.find(x=>x.id===ws.playerId);if(!p)return;const delta=d.delta<0?-1:1;let ni=Math.max(0,Math.min(room.photos.length-1,p.viewIndex+delta));p.viewIndex=ni;return send(ws,{type:'street_photo',photo:safePhoto(room.photos[ni])});
  }
  if(d.type==='guess'){
    if(room.phase!=='guess')return;const p=room.players.find(x=>x.id===ws.playerId);if(!p||p.guess)return;const lat=Number(d.lat),lng=Number(d.lng);if(!Number.isFinite(lat)||!Number.isFinite(lng)||lat<-90||lat>90||lng<-180||lng>180)return;p.guess={lat,lng};p.lockedAt=Date.now();broadcast(room,{type:'player_locked',playerId:p.id});if(room.players.every(x=>x.guess))reveal(room,false);return;
  }
}

const server=http.createServer(async (req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/api/health'||url.pathname==='/health'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify({ok:true,mode:'geo-duel-v20.1-render',provider:'KartaView + OpenStreetMap',apiKeyRequired:false}));}
  if(url.pathname==='/api/pano'){
    try{
      const raw=String(url.searchParams.get('url')||'');
      const u=new URL(raw);
      const host=u.hostname.toLowerCase();
      if(!(host.endsWith('openstreetcam.org')||host.endsWith('kartaview.org'))) throw new Error('blocked host');
      const ctrl=new AbortController(); const t=setTimeout(()=>ctrl.abort(),15000);
      const r=await fetch(u,{headers:{'User-Agent':'LandmarkDuel/20.1'},signal:ctrl.signal}); clearTimeout(t);
      if(!r.ok)throw new Error('image HTTP '+r.status);
      const buf=Buffer.from(await r.arrayBuffer());
      res.writeHead(200,{'Content-Type':r.headers.get('content-type')||'image/jpeg','Cache-Control':'public, max-age=3600'});
      return res.end(buf);
    }catch(e){res.writeHead(502,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});return res.end('Panorama unavailable');}
  }
  let file=url.pathname==='/'?path.join(PUBLIC,'index.html'):path.join(PUBLIC,url.pathname.replace(/^\//,''));
  if(!file.startsWith(PUBLIC))return res.writeHead(403).end(); fs.stat(file,(err,st)=>{if(err||!st.isFile()){res.writeHead(404);return res.end('Not found');}res.writeHead(200,{'Content-Type':mime[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});fs.createReadStream(file).pipe(res);});
});
const wss=new WebSocketServer({server,path:'/ws'});wss.on('connection',ws=>{ws.on('message',m=>handle(ws,m));ws.on('close',()=>{const room=rooms.get(ws.roomCode);const p=room?.players.find(x=>x.id===ws.playerId);if(p){p.ws=null;sendState(room);}});});
server.listen(PORT,()=>console.log(`Landmark Duel V20.1 running: http://localhost:${PORT}`));
