const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');
const { EdgeTTS } = require('node-edge-tts');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, 'public');
const QUESTIONS = JSON.parse(fs.readFileSync(path.join(__dirname,'questions.json'),'utf8'));
const MAX_HP = 5000;
const MATCH_QUESTIONS = Math.min(25, QUESTIONS.length);
const VOICE = 'bg-BG-KalinaNeural';
const rooms = new Map();
let publicBaseUrl = String(process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/,'');

// Twitch app registered by the user.
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || 'cc5te66gm5qmewa3pz1cfuqhcfx28i';
const TWITCH_SCOPES = ['openid','user:read:chat','user:write:chat'];
const TWITCH_SECRET_FILE = path.join(__dirname,'twitch_secret.txt');
const TWITCH_SESSION_FILE = path.join(__dirname,'twitch_broadcaster_v17_5.json');
const oauthStates = new Map();
const browserTwitchSessions = new Map();
let twitchSession = null;
let twitchEventSocket = null;
let twitchReconnectTimer = null;
let twitchChatReady = false;
let twitchLastError = '';

const mime = {
  '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8',
  '.js':'application/javascript; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.ico':'image/x-icon'
};

const tts = new EdgeTTS({
  voice: VOICE, lang: 'bg-BG', outputFormat: 'audio-24khz-96kbitrate-mono-mp3',
  rate: '-4%', pitch: '+0Hz', volume: '+0%', timeout: 20000
});

function cleanName(v){
  const s=String(v||'Играч').replace(/[<>]/g,'').trim().slice(0,28);
  return s || 'Играч';
}
function shuffle(a){
  const x=[...a];
  for(let i=x.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [x[i],x[j]]=[x[j],x[i]]; }
  return x;
}
function roomCode(){
  const chars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for(let tries=0;tries<100;tries++){
    let code=''; for(let i=0;i<6;i++) code+=chars[Math.floor(Math.random()*chars.length)];
    if(!rooms.has(code)) return code;
  }
  return crypto.randomBytes(4).toString('hex').toUpperCase().slice(0,6);
}
function multiplier(roundNo){ if(roundNo>=21)return 2; if(roundNo>=16)return 1.5; if(roundNo>=11)return 1.25; return 1; }
function calcDamage(roundNo, remainingMs){
  const seconds=Math.max(0,Math.min(60,remainingMs/1000));
  return Math.round((350 + Math.round((seconds/60)*250)) * multiplier(roundNo));
}
function nextSuddenDeathQuestion(room){
  // The normal 25-question pool is exhausted here, so Sudden Death starts World Cycle #2.
  if(!Array.isArray(room.suddenPool) || room.suddenIndex>=room.suddenPool.length){
    room.suddenPool=shuffle(QUESTIONS);
    room.suddenIndex=0;
  }
  return room.suddenPool[room.suddenIndex++];
}
function send(ws,obj){ if(ws && ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify(obj)); }
function broadcast(room,obj){ room.players.forEach(p=>send(p.ws,obj)); }
function broadcastAll(obj){ wss.clients.forEach(ws=>send(ws,obj)); }
function playerPublic(p){ return {id:p.id,name:p.name,avatar:p.avatar||'',country:p.country||'',hp:Math.max(0,Math.round(p.hp)),connected:!!(p.ws&&p.ws.readyState===WebSocket.OPEN)}; }
function sendRoomState(room){
  broadcast(room,{type:'room_state',code:room.code,hostId:room.hostId,phase:room.phase,players:room.players.map(playerPublic)});
}
function fail(ws,message){ send(ws,{type:'error',message}); }
function cleanupRoom(room){ if(room.roundTimer)clearTimeout(room.roundTimer); if(room.advanceTimer)clearTimeout(room.advanceTimer); rooms.delete(room.code); }
function cleanCountry(v){ const s=String(v||'').replace(/[<>]/g,'').trim().slice(0,40); return s||'Не е зададена'; }
function twitchForWs(ws){ return browserTwitchSessions.get(ws.browserSessionId)||null; }
function createPlayer(ws,name,country){
  const tw=twitchForWs(ws);
  return {id:crypto.randomUUID(),resumeToken:crypto.randomBytes(24).toString('hex'),ws,name:cleanName(tw?.user?.display_name||name),avatar:tw?.user?.profile_image_url||'',country:cleanCountry(country),hp:MAX_HP,answer:null,lockedAt:null,voiceDone:false,resultVoiceDone:false,fiftyUsed:false,friendUsed:false,disconnectTimer:null};
}
function attach(ws,room,p){
  if(p.disconnectTimer){clearTimeout(p.disconnectTimer);p.disconnectTimer=null;}
  if(p.ws&&p.ws!==ws&&p.ws.readyState===WebSocket.OPEN){try{p.ws.close(4001,'Reconnected elsewhere');}catch{}}
  p.ws=ws; ws.roomCode=room.code; ws.playerId=p.id;
}
function schedulePlayerCleanup(room,p){
  if(p.disconnectTimer)clearTimeout(p.disconnectTimer);
  p.disconnectTimer=setTimeout(()=>{
    const liveRoom=rooms.get(room.code); if(!liveRoom)return;
    const live=liveRoom.players.find(x=>x.id===p.id); if(!live||live.ws)return;
    if(liveRoom.phase==='lobby'){
      liveRoom.players=liveRoom.players.filter(x=>x.id!==live.id);
      if(liveRoom.players.length===0)return cleanupRoom(liveRoom);
      if(liveRoom.hostId===live.id)liveRoom.hostId=liveRoom.players[0].id;
      sendRoomState(liveRoom);
    }else{ cleanupRoom(liveRoom); }
  },120000);
}
function syncRoomToPlayer(room,p){
  send(p.ws,{type:'joined',playerId:p.id,code:room.code,host:p.id===room.hostId,resumed:true,resumeToken:p.resumeToken});
  send(p.ws,{type:'room_state',code:room.code,hostId:room.hostId,phase:room.phase,players:room.players.map(playerPublic)});
  if(room.lastQuestionPayload&&['voice','answer','reveal'].includes(room.phase))send(p.ws,room.lastQuestionPayload);
  if(room.phase==='answer'&&room.deadline)send(p.ws,{type:'timer_start',deadline:room.deadline});
  if(room.phase==='reveal'&&room.lastResultPayload)send(p.ws,room.lastResultPayload);
  if(room.phase==='ended'&&room.lastMatchEndPayload)send(p.ws,room.lastMatchEndPayload);
}

function currentQuestion(room){ return room.suddenDeath ? room.suddenQuestion : room.pool[room.roundIndex]; }
function publicQuestion(q){ return {id:q.id,name:q.name,question:q.question,answers:q.answers,image:`/api/landmark-image/${encodeURIComponent(q.id)}`}; }
function resetPlayerRound(p){ p.answer=null;p.lockedAt=null;p.voiceDone=false;p.resultVoiceDone=false; }
function startMatch(room){
  if(room.players.length!==2 || room.phase!=='lobby') return;
  room.pool=shuffle(QUESTIONS).slice(0,MATCH_QUESTIONS); room.roundIndex=0; room.suddenDeath=false; room.suddenRound=0; room.suddenPool=[]; room.suddenIndex=0; room.suddenQuestion=null;
  room.players.forEach(p=>{p.hp=MAX_HP;p.fiftyUsed=false;p.friendUsed=false;}); beginRound(room);
}
function beginRound(room){
  if(room.roundTimer)clearTimeout(room.roundTimer); if(room.advanceTimer)clearTimeout(room.advanceTimer);
  room.phase='voice';room.deadline=0;room.players.forEach(resetPlayerRound);
  const q=currentQuestion(room);
  const displayRound=room.suddenDeath?MATCH_QUESTIONS+room.suddenRound:room.roundIndex+1;
  room.lastQuestionPayload={type:'round_question',roundNo:displayRound,total:MATCH_QUESTIONS,multiplier:multiplier(displayRound),suddenDeath:!!room.suddenDeath,suddenRound:room.suddenRound||0,question:publicQuestion(q),players:room.players.map(playerPublic)};
  room.lastResultPayload=null;
  broadcast(room,room.lastQuestionPayload);
  sendRoomState(room);
}
function maybeStartTimer(room){
  if(room.phase!=='voice'||room.players.length!==2||!room.players.every(p=>p.voiceDone))return;
  room.phase='answer';room.deadline=Date.now()+60000;
  broadcast(room,{type:'timer_start',deadline:room.deadline});sendRoomState(room);
  room.roundTimer=setTimeout(()=>revealRound(room,true),60050);
}
function revealRound(room,timeout=false){
  if(room.phase!=='answer')return;room.phase='reveal';
  if(room.roundTimer){clearTimeout(room.roundTimer);room.roundTimer=null;}
  const q=currentQuestion(room),roundNo=room.suddenDeath?MATCH_QUESTIONS+room.suddenRound:room.roundIndex+1;
  const hpBefore=new Map(room.players.map(p=>[p.id,p.hp]));
  const results=room.players.map(p=>{
    const answered=Number.isInteger(p.answer),correct=answered&&p.answer===q.correct;
    const remaining=p.lockedAt?Math.max(0,room.deadline-p.lockedAt):0;
    const rawDamage=correct?calcDamage(roundNo,remaining):0;
    const opponent=room.players.find(x=>x.id!==p.id);
    const actualDamage=correct?Math.min(rawDamage,hpBefore.get(opponent.id)):0;
    return {id:p.id,name:p.name,answered,correct,damage:actualDamage,rawDamage,lockedAt:p.lockedAt||null,remainingMs:remaining};
  });
  // Damage is simultaneous: both hits are calculated from the HP snapshot before the reveal.
  const hpAfter=new Map(hpBefore);
  for(const r of results){ if(!r.correct)continue; const opponent=room.players.find(p=>p.id!==r.id); hpAfter.set(opponent.id,Math.max(0,hpBefore.get(opponent.id)-r.damage)); }
  for(const p of room.players)p.hp=hpAfter.get(p.id);
  room.lastResultPayload={type:'round_result',roundNo,suddenDeath:!!room.suddenDeath,suddenRound:room.suddenRound||0,correctIndex:q.correct,correctAnswer:q.answers[q.correct],timeout,results,players:room.players.map(playerPublic)};
  broadcast(room,room.lastResultPayload);
  sendRoomState(room);room.advanceTimer=setTimeout(()=>advanceAfterResult(room),15000);
}
function decideDoubleKoWinner(room){
  const r=room.lastResultPayload?.results||[];
  const correct=r.filter(x=>x.correct&&x.lockedAt);
  if(correct.length===2 && correct[0].lockedAt!==correct[1].lockedAt){
    return correct[0].lockedAt<correct[1].lockedAt?correct[0].id:correct[1].id;
  }
  if(correct.length===2 && correct[0].rawDamage!==correct[1].rawDamage){
    return correct[0].rawDamage>correct[1].rawDamage?correct[0].id:correct[1].id;
  }
  return null;
}
function startSuddenDeath(room){
  room.suddenDeath=true; room.suddenRound=(room.suddenRound||0)+1; room.suddenQuestion=nextSuddenDeathQuestion(room); beginRound(room);
}
function advanceAfterResult(room){
  if(room.phase!=='reveal')return;if(room.advanceTimer){clearTimeout(room.advanceTimer);room.advanceTimer=null;}
  const dead=room.players.filter(p=>p.hp<=0);
  if(dead.length===1)return endMatch(room,room.players.find(p=>p.hp>0)?.id||null,'KO');
  if(dead.length===2){
    const winnerId=decideDoubleKoWinner(room);
    if(winnerId)return endMatch(room,winnerId,'DOUBLE_KO_SPEED');
    // Exact simultaneous double KO: restore 1 HP each and decide it with Sudden Death.
    room.players.forEach(p=>p.hp=1); return startSuddenDeath(room);
  }
  if(room.suddenDeath){
    if(room.players[0].hp!==room.players[1].hp){
      const winnerId=room.players[0].hp>room.players[1].hp?room.players[0].id:room.players[1].id;
      return endMatch(room,winnerId,'SUDDEN_DEATH');
    }
    return startSuddenDeath(room);
  }
  const last=room.roundIndex>=MATCH_QUESTIONS-1;
  if(last){
    if(room.players[0].hp!==room.players[1].hp){
      const winnerId=room.players[0].hp>room.players[1].hp?room.players[0].id:room.players[1].id;
      return endMatch(room,winnerId,'HP');
    }
    return startSuddenDeath(room);
  }
  room.roundIndex++;beginRound(room);
}
function maybeAdvanceAfterVoice(room){ if(room.phase==='reveal'&&room.players.every(p=>p.resultVoiceDone))advanceAfterResult(room); }
function endMatch(room,winnerId=null,reason='HP'){
  room.phase='ended';if(room.roundTimer)clearTimeout(room.roundTimer);if(room.advanceTimer)clearTimeout(room.advanceTimer);
  if(!winnerId){if(room.players[0].hp>room.players[1].hp)winnerId=room.players[0].id;else if(room.players[1].hp>room.players[0].hp)winnerId=room.players[1].id;}
  const winner=winnerId?room.players.find(p=>p.id===winnerId):null;
  room.lastMatchEndPayload={type:'match_end',winnerId,winnerName:winner?winner.name:null,reason,players:room.players.map(playerPublic),roundsPlayed:room.suddenDeath?MATCH_QUESTIONS+room.suddenRound:room.roundIndex+1};
  broadcast(room,room.lastMatchEndPayload);sendRoomState(room);
}

function handleMessage(ws,msg){
  let data;try{data=JSON.parse(msg.toString())}catch{return fail(ws,'Невалидно съобщение.');}
  if(data.type==='create_room'){
    if(ws.roomCode)return fail(ws,'Вече си в стая.');
    const code=roomCode(),p=createPlayer(ws,roomNameForWs(ws,data.name),data.country);const room={code,hostId:p.id,players:[p],phase:'lobby',pool:[],roundIndex:0,suddenDeath:false,suddenRound:0,suddenPool:[],suddenIndex:0,suddenQuestion:null,deadline:0,roundTimer:null,advanceTimer:null,lastQuestionPayload:null,lastResultPayload:null,lastMatchEndPayload:null};
    rooms.set(code,room);attach(ws,room,p);send(ws,{type:'joined',playerId:p.id,code,host:true,resumeToken:p.resumeToken});sendRoomState(room);return;
  }
  if(data.type==='join_room'){
    if(ws.roomCode)return fail(ws,'Вече си в стая.');const code=String(data.code||'').trim().toUpperCase(),room=rooms.get(code);
    if(!room)return fail(ws,'Тази стая не съществува.');if(room.phase!=='lobby')return fail(ws,'Мачът вече е започнал.');if(room.players.length>=2)return fail(ws,'Стаята вече е пълна.');
    const p=createPlayer(ws,roomNameForWs(ws,data.name),data.country);room.players.push(p);attach(ws,room,p);send(ws,{type:'joined',playerId:p.id,code,host:false,resumeToken:p.resumeToken});sendRoomState(room);return;
  }
  if(data.type==='resume_room'){
    if(ws.roomCode)return;
    const code=String(data.code||'').trim().toUpperCase(),token=String(data.resumeToken||'');const room=rooms.get(code);
    if(!room)return fail(ws,'Стаята вече не съществува.');
    const p=room.players.find(x=>x.resumeToken===token);if(!p)return fail(ws,'Сесията за тази стая е изтекла.');
    attach(ws,room,p);
    const t=browserTwitchSessions.get(ws.browserSessionId);if(t?.user?.display_name)p.name=cleanName(t.user.display_name);if(t?.user?.profile_image_url)p.avatar=t.user.profile_image_url;if(data.country)p.country=cleanCountry(data.country);
    syncRoomToPlayer(room,p);broadcast(room,{type:'player_reconnected',playerId:p.id,name:p.name});sendRoomState(room);return;
  }
  const room=rooms.get(ws.roomCode);if(!room)return fail(ws,'Не си в стая.');const p=room.players.find(x=>x.id===ws.playerId);if(!p)return fail(ws,'Играчът не е намерен.');
  if(data.type==='start_match'){if(p.id!==room.hostId)return fail(ws,'Само host-ът стартира мача.');if(room.players.length!==2)return fail(ws,'Трябват точно двама играчи.');if(!room.players.every(x=>x.ws&&x.ws.readyState===WebSocket.OPEN))return fail(ws,'Изчакай и двамата играчи да са свързани.');return startMatch(room);}
  if(data.type==='voice_done'){if(room.phase!=='voice')return;p.voiceDone=true;return maybeStartTimer(room);}
  if(data.type==='submit_answer'){
    if(room.phase!=='answer')return fail(ws,'В момента не се приемат отговори.');if(Number.isInteger(p.answer))return;
    const idx=Number(data.index);if(!Number.isInteger(idx)||idx<0||idx>3)return fail(ws,'Невалиден отговор.');if(Date.now()>room.deadline+1000)return;
    p.answer=idx;p.lockedAt=Date.now();broadcast(room,{type:'player_locked',playerId:p.id});if(room.players.every(x=>Number.isInteger(x.answer)))revealRound(room,false);return;
  }
  if(data.type==='use_joker'){
    if(room.phase!=='answer')return fail(ws,'Жокерът може да се използва само докато избираш.');if(Number.isInteger(p.answer))return fail(ws,'Вече си заключил отговор.');const q=currentQuestion(room);
    if(data.kind==='fifty'){if(p.fiftyUsed)return fail(ws,'50/50 вече е използван.');p.fiftyUsed=true;const wrong=[0,1,2,3].filter(i=>i!==q.correct);return send(ws,{type:'joker_result',kind:'fifty',removed:shuffle(wrong).slice(0,2)});}
    if(data.kind==='friend'){if(p.friendUsed)return fail(ws,'Помощта вече е използвана.');p.friendUsed=true;return send(ws,{type:'joker_result',kind:'friend',correctIndex:q.correct,correctAnswer:q.answers[q.correct]});}
    return;
  }
  if(data.type==='result_voice_done'){if(room.phase!=='reveal')return;p.resultVoiceDone=true;return maybeAdvanceAfterVoice(room);}
}

function parseCookies(req){
  const out={}; for(const part of String(req.headers.cookie||'').split(';')){const i=part.indexOf('=');if(i<0)continue;out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim());} return out;
}
function ensureBrowserSession(req,res){
  let sid=parseCookies(req).ldsid;
  if(!sid||!/^[a-f0-9]{48}$/.test(sid)){sid=crypto.randomBytes(24).toString('hex');if(res)res.setHeader('Set-Cookie',`ldsid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);}
  return sid;
}

const httpGameClients=new Map();
function makeHttpGameClient(sid){
  const c={id:crypto.randomUUID(),browserSessionId:sid,readyState:WebSocket.OPEN,queue:[],lastSeen:Date.now(),roomCode:null,playerId:null};
  c.send=(raw)=>{try{c.queue.push(JSON.parse(raw));}catch{}};
  c.close=()=>{disconnectGameConnection(c);httpGameClients.delete(c.id);};
  httpGameClients.set(c.id,c);
  send(c,{type:'hello',version:'V17.8-GAMEPLAY-MEDIA-FIX',twitch:browserSessionStatus(sid)});
  return c;
}
function disconnectGameConnection(conn){
  const room=rooms.get(conn.roomCode);if(!room)return;const p=room.players.find(x=>x.id===conn.playerId);if(!p||p.ws!==conn)return;
  p.ws=null;broadcast(room,{type:'opponent_disconnected',playerId:p.id,name:p.name,graceMs:120000});sendRoomState(room);schedulePlayerCleanup(room,p);
}
setInterval(()=>{
  const now=Date.now();for(const [id,c] of httpGameClients){if(now-c.lastSeen>30000){disconnectGameConnection(c);httpGameClients.delete(id);}}
},5000).unref();
function browserSessionStatus(sid){
  const s=browserTwitchSessions.get(sid);
  return {configured:!!readTwitchSecret(),connected:!!s,user:s?{id:s.user.id,login:s.user.login,display_name:s.user.display_name,profile_image_url:s.user.profile_image_url}:null,chatReady:!!(s&&twitchSession&&s.user.id===twitchSession.user.id&&twitchChatReady),lastError:(s&&twitchSession&&s.user.id===twitchSession.user.id)?twitchLastError:''};
}
function roomNameForWs(ws,fallback){const s=browserTwitchSessions.get(ws.browserSessionId);return s?.user?.display_name||fallback;}
// ---------------- TWITCH ----------------
function readTwitchSecret(){
  const envSecret=String(process.env.TWITCH_CLIENT_SECRET||'').trim();
  if(envSecret)return envSecret;
  try{return fs.readFileSync(TWITCH_SECRET_FILE,'utf8').trim();}catch{return '';}
}

function loadTwitchSession(){
  try{const x=JSON.parse(fs.readFileSync(TWITCH_SESSION_FILE,'utf8'));if(x&&x.access_token&&x.user)twitchSession=x;}catch{}
}
function saveTwitchSession(){
  if(!twitchSession)return;
  fs.writeFileSync(TWITCH_SESSION_FILE,JSON.stringify(twitchSession,null,2),'utf8');
}
function clearTwitchSession(){
  twitchSession=null;twitchChatReady=false;twitchLastError='';
  try{fs.unlinkSync(TWITCH_SESSION_FILE);}catch{}
  if(twitchEventSocket){try{twitchEventSocket.close();}catch{}twitchEventSocket=null;}
}
async function httpJson(url,opts={}){
  const r=await fetch(url,opts);const text=await r.text();let data={};try{data=JSON.parse(text)}catch{data={raw:text}}
  if(!r.ok){const e=new Error(data.message||data.error||`HTTP ${r.status}`);e.status=r.status;e.data=data;throw e;}return data;
}
async function refreshTwitchTokenIfNeeded(){
  if(!twitchSession)return false;
  if((twitchSession.expires_at||0)>Date.now()+120000)return true;
  const secret=readTwitchSecret();if(!secret||!twitchSession.refresh_token)return false;
  const body=new URLSearchParams({grant_type:'refresh_token',refresh_token:twitchSession.refresh_token,client_id:TWITCH_CLIENT_ID,client_secret:secret});
  const t=await httpJson('https://id.twitch.tv/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
  twitchSession.access_token=t.access_token;twitchSession.refresh_token=t.refresh_token||twitchSession.refresh_token;twitchSession.expires_at=Date.now()+Number(t.expires_in||3600)*1000;saveTwitchSession();return true;
}
async function twitchHelix(url,opts={}){
  if(!twitchSession)throw new Error('Twitch не е свързан.');await refreshTwitchTokenIfNeeded();
  const headers={...(opts.headers||{}),'Authorization':`Bearer ${twitchSession.access_token}`,'Client-Id':TWITCH_CLIENT_ID};
  return httpJson(url,{...opts,headers});
}
async function fetchTwitchUser(accessToken){
  const d=await httpJson('https://api.twitch.tv/helix/users',{headers:{'Authorization':`Bearer ${accessToken}`,'Client-Id':TWITCH_CLIENT_ID}});
  if(!d.data||!d.data[0])throw new Error('Twitch профилът не беше намерен.');return d.data[0];
}
function twitchPublicStatus(){
  return {configured:!!readTwitchSecret(),connected:!!twitchSession,user:twitchSession?{id:twitchSession.user.id,login:twitchSession.user.login,display_name:twitchSession.user.display_name,profile_image_url:twitchSession.user.profile_image_url}:null,chatReady:twitchChatReady,lastError:twitchLastError};
}
async function createChatSubscription(sessionId){
  if(!twitchSession)return;
  await twitchHelix('https://api.twitch.tv/helix/eventsub/subscriptions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'channel.chat.message',version:'1',condition:{broadcaster_user_id:twitchSession.user.id,user_id:twitchSession.user.id},transport:{method:'websocket',session_id:sessionId}})});
  twitchChatReady=true;twitchLastError='';broadcastAll({type:'twitch_status',status:twitchPublicStatus()});
  console.log(`TWITCH CHAT READY: ${twitchSession.user.display_name}`);
}
async function sendTwitchChat(message){
  if(!twitchSession)return false;
  try{
    await twitchHelix('https://api.twitch.tv/helix/chat/messages',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({broadcaster_id:twitchSession.user.id,sender_id:twitchSession.user.id,message:String(message).slice(0,500)})});
    return true;
  }catch(err){console.error('TWITCH CHAT SEND ERROR:',err.message);return false;}
}
function handleTwitchChatEvent(ev){
  const chatter=ev.chatter_user_name||ev.chatter_user_login||'viewer';const text=ev.message?.text||'';
  broadcastAll({type:'twitch_chat_message',chatter,text});
  const m=text.trim().match(/^!duel\s+@?([A-Za-z0-9_]{1,25})\b/i);
  if(m){
    const target=m[1];
    broadcastAll({type:'twitch_duel_command',challenger:chatter,target,text});
    sendTwitchChat(`⚔️ ${chatter} предизвика @${target} в Landmark Duel!`).catch(()=>{});
    console.log(`TWITCH !DUEL: ${chatter} -> ${target}`);
  }
}
function scheduleTwitchReconnect(){
  if(twitchReconnectTimer)clearTimeout(twitchReconnectTimer);
  twitchChatReady=false;broadcastAll({type:'twitch_status',status:twitchPublicStatus()});
  twitchReconnectTimer=setTimeout(()=>startTwitchEventSub(),5000);
}
function startTwitchEventSub(url='wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=30',isReconnect=false){
  if(!twitchSession)return;
  if(twitchEventSocket&&[WebSocket.OPEN,WebSocket.CONNECTING].includes(twitchEventSocket.readyState))return;
  const sock=new WebSocket(url);twitchEventSocket=sock;
  sock.on('message',async raw=>{
    let d;try{d=JSON.parse(raw.toString())}catch{return;}
    const type=d.metadata?.message_type;
    if(type==='session_welcome'){
      try{if(!isReconnect)await createChatSubscription(d.payload.session.id);else{twitchChatReady=true;broadcastAll({type:'twitch_status',status:twitchPublicStatus()});}}
      catch(err){twitchChatReady=false;twitchLastError=String(err.message||err);console.error('TWITCH EVENTSUB SUBSCRIBE ERROR:',twitchLastError);broadcastAll({type:'twitch_status',status:twitchPublicStatus()});}
    }else if(type==='notification'&&d.metadata?.subscription_type==='channel.chat.message'){
      handleTwitchChatEvent(d.payload.event||{});
    }else if(type==='session_reconnect'&&d.payload?.session?.reconnect_url){
      const reconnectUrl=d.payload.session.reconnect_url;
      twitchEventSocket=null;try{sock.close();}catch{};startTwitchEventSub(reconnectUrl,true);
    }else if(type==='revocation'){
      twitchChatReady=false;twitchLastError='Twitch EventSub subscription беше отменен.';broadcastAll({type:'twitch_status',status:twitchPublicStatus()});
    }
  });
  sock.on('error',err=>{twitchLastError=String(err.message||err);console.error('TWITCH EVENTSUB ERROR:',twitchLastError);});
  sock.on('close',()=>{const wasCurrent=twitchEventSocket===sock;if(wasCurrent)twitchEventSocket=null;if(wasCurrent&&twitchSession)scheduleTwitchReconnect();});
}
loadTwitchSession();


const IMAGE_CACHE_DIR=path.join(__dirname,'image-cache');
try{fs.mkdirSync(IMAGE_CACHE_DIR,{recursive:true});}catch{}
const IMAGE_SEARCH={
  LM_0001:'Taj Mahal',LM_0002:'Eiffel Tower',LM_0003:'Statue of Liberty',LM_0004:'Colosseum Rome',LM_0005:'Petra Jordan',
  LM_0006:'Machu Picchu',LM_0007:'Christ the Redeemer Rio de Janeiro',LM_0008:'Sydney Opera House',LM_0009:'Burj Khalifa',LM_0010:'Big Ben London',
  LM_0011:'Sagrada Familia Barcelona',LM_0012:'Acropolis Athens Parthenon',LM_0013:'Giza Pyramids',LM_0014:'Great Wall of China',LM_0015:'Angkor Wat',
  LM_0016:'Kiyomizu-dera Kyoto',LM_0017:'Neuschwanstein Castle',LM_0018:'Mont Saint-Michel',LM_0019:'Chichen Itza',LM_0020:'Moai Easter Island',
  LM_0021:'Golden Gate Bridge San Francisco',LM_0022:'CN Tower Toronto',LM_0023:'Hagia Sophia Istanbul',LM_0024:'Himeji Castle',LM_0025:'Alhambra Granada'
};
function imageCachePath(id){return path.join(IMAGE_CACHE_DIR,String(id).replace(/[^A-Za-z0-9_-]/g,'')+'.img');}
function imageMetaPath(id){return imageCachePath(id)+'.json';}
async function fetchImageBytes(url){
  const r=await fetch(url,{redirect:'follow',headers:{'User-Agent':'LandmarkDuel/17.8 (educational game; Wikimedia image cache)','Accept':'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'}});
  if(!r.ok)throw new Error(`image HTTP ${r.status}`);
  const ct=String(r.headers.get('content-type')||'');
  if(!ct.startsWith('image/'))throw new Error(`not image: ${ct}`);
  const buf=Buffer.from(await r.arrayBuffer());
  if(buf.length<1500)throw new Error('image too small');
  return {buf,contentType:ct.split(';')[0]||'image/jpeg'};
}
async function resolveCommonsFallback(q){
  const search=IMAGE_SEARCH[q.id]||q.name;
  const api='https://commons.wikimedia.org/w/api.php?'+new URLSearchParams({action:'query',format:'json',generator:'search',gsrnamespace:'6',gsrsearch:search,gsrlimit:'6',prop:'imageinfo',iiprop:'url|mime',iiurlwidth:'1600',origin:'*'});
  const r=await fetch(api,{headers:{'User-Agent':'LandmarkDuel/17.8 (educational game)'}});if(!r.ok)throw new Error(`commons API ${r.status}`);
  const d=await r.json();const pages=Object.values(d?.query?.pages||{});
  for(const pg of pages){const ii=pg?.imageinfo?.[0];const u=ii?.thumburl||ii?.url;if(u&&String(ii?.mime||'').startsWith('image/'))return u;}
  throw new Error('no Commons fallback image');
}
async function getLandmarkImage(q){
  const cache=imageCachePath(q.id),meta=imageMetaPath(q.id);
  try{const [buf,m]=await Promise.all([fs.promises.readFile(cache),fs.promises.readFile(meta,'utf8')]);const info=JSON.parse(m);if(buf.length>1500)return {buf,contentType:info.contentType||'image/jpeg',cached:true};}catch{}
  let lastErr=null;
  const candidates=[q.image];
  try{candidates.push(await resolveCommonsFallback(q));}catch(e){lastErr=e;}
  for(const u of candidates.filter(Boolean)){
    try{const got=await fetchImageBytes(u);await fs.promises.writeFile(cache,got.buf);await fs.promises.writeFile(meta,JSON.stringify({contentType:got.contentType,source:u,updatedAt:new Date().toISOString()}));return {...got,cached:false};}catch(e){lastErr=e;}
  }
  // One more fresh Commons search in case the original filename disappeared.
  try{const u=await resolveCommonsFallback(q);const got=await fetchImageBytes(u);await fs.promises.writeFile(cache,got.buf);await fs.promises.writeFile(meta,JSON.stringify({contentType:got.contentType,source:u,updatedAt:new Date().toISOString()}));return {...got,cached:false};}catch(e){lastErr=e;}
  throw lastErr||new Error('image unavailable');
}

async function synthesize(text){
  const tmp=path.join(os.tmpdir(),`landmark-duel-${crypto.randomUUID()}.mp3`);
  try{await tts.ttsPromise(text,tmp);return await fs.promises.readFile(tmp);}finally{fs.promises.unlink(tmp).catch(()=>{});}
}
function json(res,status,obj){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(obj));}
function redirect(res,url){res.writeHead(302,{Location:url,'Cache-Control':'no-store'});res.end();}
function safeReturnUrl(v,baseOrigin){
  const fallback=`${baseOrigin||publicBaseUrl||'http://localhost:3000'}/`;
  try{const u=new URL(String(v||''),fallback);if(!['http:','https:'].includes(u.protocol)||u.origin!==(baseOrigin||u.origin))return fallback;return u.toString();}catch{return fallback;}
}

function oauthOriginForRequest(req){
  // Hosted deployments use Render's permanent public origin for OAuth callbacks.
  if(publicBaseUrl) return publicBaseUrl;
  const host=String(req.headers.host||'localhost:3000');
  const forwarded=String(req.headers['x-forwarded-proto']||'').split(',')[0].trim();
  const proto=forwarded==='https'?'https':'http';
  return `${proto}://${host}`;
}
function twitchRedirectForRequest(req){ return `${oauthOriginForRequest(req)}/auth/twitch/callback`; }

const server=http.createServer(async(req,res)=>{
  const parsed=new URL(req.url,`http://${req.headers.host||'localhost'}`);const route=parsed.pathname;
  if(route.startsWith('/api/landmark-image/')&&req.method==='GET'){
    const id=decodeURIComponent(route.slice('/api/landmark-image/'.length));const q=QUESTIONS.find(x=>x.id===id);
    if(!q){res.writeHead(404,{'Content-Type':'text/plain; charset=utf-8'});return res.end('Unknown landmark');}
    try{const got=await getLandmarkImage(q);res.writeHead(200,{'Content-Type':got.contentType,'Cache-Control':'public, max-age=86400','X-Landmark-Cache':got.cached?'HIT':'MISS'});return res.end(got.buf);}
    catch(err){console.error('LANDMARK IMAGE ERROR',id,err.message);const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="100%" height="100%" fill="#10131d"/><text x="50%" y="46%" fill="#fff" font-size="54" text-anchor="middle">${String(q.name).replace(/[&<>]/g,'')}</text><text x="50%" y="56%" fill="#ffcc66" font-size="32" text-anchor="middle">Снимката се презарежда от Wikimedia</text></svg>`;res.writeHead(503,{'Content-Type':'image/svg+xml; charset=utf-8','Cache-Control':'no-store'});return res.end(svg);}
  }
  if(route==='/health'){res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});return res.end('landmark-duel-v17-twitch-ok');}
  if(route==='/api/public-url'&&req.method==='GET')return json(res,200,{publicUrl:publicBaseUrl});
  if(route==='/api/game/connect'&&req.method==='POST'){
    const sid=ensureBrowserSession(req,res);const c=makeHttpGameClient(sid);return json(res,200,{clientId:c.id});
  }
  if(route==='/api/game/send'&&req.method==='POST'){
    try{let body='';for await(const chunk of req){body+=chunk;if(body.length>50000)throw new Error('Body too large');}const data=JSON.parse(body||'{}');const c=httpGameClients.get(String(data.clientId||''));if(!c)return json(res,410,{error:'expired'});c.lastSeen=Date.now();handleMessage(c,JSON.stringify(data.message||{}));return json(res,200,{ok:true});}catch(err){return json(res,400,{error:'bad request'});}
  }
  if(route==='/api/game/poll'&&req.method==='GET'){
    const c=httpGameClients.get(String(parsed.searchParams.get('clientId')||''));if(!c)return json(res,410,{error:'expired'});c.lastSeen=Date.now();const messages=c.queue.splice(0,100);return json(res,200,{messages});
  }
  if(route==='/api/tts/status')return json(res,200,{configured:true,provider:'Microsoft Edge online TTS',voice:VOICE});
  if(route==='/api/twitch/status'){const sid=ensureBrowserSession(req,res);return json(res,200,browserSessionStatus(sid));}
  if(route==='/api/twitch/logout'&&req.method==='POST'){const sid=ensureBrowserSession(req,res);const old=browserTwitchSessions.get(sid);browserTwitchSessions.delete(sid);if(old&&twitchSession&&old.user.id===twitchSession.user.id)clearTwitchSession();return json(res,200,{ok:true});}
  if(route==='/auth/twitch/start'){
    const secret=readTwitchSecret();if(!secret)return json(res,500,{error:'Липсва TWITCH_CLIENT_SECRET. Добави го в Render Environment и направи redeploy.'});
    const sid=ensureBrowserSession(req,res);const state=crypto.randomBytes(24).toString('hex');const oauthOrigin=oauthOriginForRequest(req);const returnUrl=safeReturnUrl(parsed.searchParams.get('return'),oauthOrigin);
    const redirectUri=twitchRedirectForRequest(req);
    oauthStates.set(state,{created:Date.now(),returnUrl,redirectUri,sid});setTimeout(()=>oauthStates.delete(state),10*60*1000);
    console.log(`TWITCH OAUTH REDIRECT: ${redirectUri}`);
    const q=new URLSearchParams({response_type:'code',client_id:TWITCH_CLIENT_ID,redirect_uri:redirectUri,scope:TWITCH_SCOPES.join(' '),state,force_verify:'true'});
    return redirect(res,`https://id.twitch.tv/oauth2/authorize?${q.toString()}`);
  }
  if(route==='/auth/twitch/callback'){
    const code=parsed.searchParams.get('code'),state=parsed.searchParams.get('state'),oauthError=parsed.searchParams.get('error');const saved=oauthStates.get(state);oauthStates.delete(state);
    if(oauthError)return json(res,400,{error:`Twitch OAuth: ${oauthError}`});if(!code||!saved)return json(res,400,{error:'Невалиден или изтекъл Twitch OAuth state. Опитай CONNECT TWITCH отново.'});
    try{
      const secret=readTwitchSecret();const body=new URLSearchParams({client_id:TWITCH_CLIENT_ID,client_secret:secret,code,grant_type:'authorization_code',redirect_uri:saved.redirectUri});
      const tok=await httpJson('https://id.twitch.tv/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});const user=await fetchTwitchUser(tok.access_token);
      const playerSession={access_token:tok.access_token,refresh_token:tok.refresh_token,expires_at:Date.now()+Number(tok.expires_in||3600)*1000,scope:tok.scope||TWITCH_SCOPES,user};
      browserTwitchSessions.set(saved.sid,playerSession);
      // The first Twitch login on this server owns broadcaster chat/EventSub. A second player's login never overwrites it.
      if(!twitchSession){twitchSession={...playerSession};saveTwitchSession();twitchLastError='';twitchChatReady=false;if(twitchEventSocket){try{twitchEventSocket.close();}catch{}twitchEventSocket=null;}startTwitchEventSub();}
      const back=new URL(saved.returnUrl);back.searchParams.set('twitch','connected');return redirect(res,back.toString());
    }catch(err){console.error('TWITCH OAUTH ERROR:',err.message||err);return json(res,500,{error:'Twitch login не успя.',detail:String(err.message||err)});}
  }
  if(route==='/api/tts'&&req.method==='POST'){
    try{let body='';for await(const chunk of req){body+=chunk;if(body.length>20000)throw new Error('Body too large');}const data=JSON.parse(body||'{}');const text=String(data.text||'').trim();if(!text||text.length>5000)throw new Error('Невалиден TTS текст.');const audio=await synthesize(text);res.writeHead(200,{'Content-Type':'audio/mpeg','Content-Length':audio.length,'Cache-Control':'no-store','X-Landmark-Voice':VOICE});return res.end(audio);}catch(err){console.error('KALINA TTS ERROR:',err.message||err);return json(res,502,{error:'Kalina TTS не успя да генерира гласа.',detail:String(err.message||err).slice(0,300)});}
  }
  let urlPath=decodeURIComponent(route);if(urlPath==='/')urlPath='/index.html';const filePath=path.normalize(path.join(PUBLIC,urlPath));if(!filePath.startsWith(PUBLIC)){res.writeHead(403);return res.end('Forbidden');}
  fs.readFile(filePath,(err,data)=>{if(err){res.writeHead(404);return res.end('Not found');}res.writeHead(200,{'Content-Type':mime[path.extname(filePath).toLowerCase()]||'application/octet-stream','Cache-Control':'no-store'});res.end(data);});
});

const wss=new WebSocketServer({server,path:'/ws'});
wss.on('connection',(ws,req)=>{
  ws.isAlive=true;ws.on('pong',()=>{ws.isAlive=true});
  ws.browserSessionId=ensureBrowserSession(req,null);
  send(ws,{type:'hello',version:'V17.7',twitch:browserSessionStatus(ws.browserSessionId)});
  ws.on('message',msg=>handleMessage(ws,msg));
  ws.on('close',()=>disconnectGameConnection(ws));
});
const wsHeartbeat=setInterval(()=>{
  wss.clients.forEach(ws=>{
    if(ws.isAlive===false){try{ws.terminate();}catch{};return;}
    ws.isAlive=false;try{ws.ping();}catch{}
  });
},20000);
wss.on('close',()=>clearInterval(wsHeartbeat));

server.on('error',err=>{if(err.code==='EADDRINUSE'){console.error('Port 3000 is already in use. Close the old Landmark Duel server first.');process.exit(2);}throw err;});
server.listen(PORT,'0.0.0.0',()=>{
  console.log(`LANDMARK DUEL V18 RENDER HOSTED: listening on 0.0.0.0:${PORT}`);
  if(publicBaseUrl)console.log(`PUBLIC URL: ${publicBaseUrl}`);console.log(`Questions: ${MATCH_QUESTIONS} | Voice: ${VOICE}`);
  console.log(`Twitch secret: ${readTwitchSecret()?'FOUND':'MISSING - set TWITCH_CLIENT_SECRET in Render Environment'}`);
  if(twitchSession){console.log(`Saved Twitch login: ${twitchSession.user.display_name}`);startTwitchEventSub();}
});
