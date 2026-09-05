const MAX_HP=5000;
const CIRC=2*Math.PI*51;
const $=id=>document.getElementById(id);
const PROFILE_KEY='landmark_duel_profile_v17';

let profile={xp:0,wins:0,correct:0,answered:0,streak:0,name:'Player',
  ...JSON.parse(localStorage.getItem(PROFILE_KEY)||'{}')};
let ws=null,myId=null,roomCode=null,hostId=null,players=[],currentQ=null,roundNo=0,totalRounds=25;
let timerInterval=null,deadline=0,locked=false,resolved=false,fiftyUsed=false,friendUsed=false,activeVoiceAudio=null;
let twitchStatus={configured:false,connected:false,user:null,chatReady:false,lastError:''};
let serverPublicUrl='';
let reconnectTimer=null,reconnectDelay=1000,manualClose=false;
const RESUME_KEY='landmark_duel_room_resume_v177';
function loadResumes(){try{return JSON.parse(localStorage.getItem(RESUME_KEY)||'{}')}catch{return {}}}
function getResume(code){return loadResumes()[String(code||'').toUpperCase()]||null}
function saveResume(code,data){const all=loadResumes();all[String(code).toUpperCase()]=data;localStorage.setItem(RESUME_KEY,JSON.stringify(all))}
function clearResume(code){const all=loadResumes();delete all[String(code||'').toUpperCase()];localStorage.setItem(RESUME_KEY,JSON.stringify(all))}


function saveProfile(){localStorage.setItem(PROFILE_KEY,JSON.stringify(profile));renderProfile()}
function renderProfile(){
  const acc=profile.answered?Math.round(profile.correct/profile.answered*100)+'%':'—';
  $('profileName').textContent=profile.name;$('profileXp').textContent=profile.xp;
  $('profileWins').textContent=profile.wins;$('profileAccuracy').textContent=acc;
  $('p1Xp').textContent=profile.xp+' XP';
}
let transportMode='ws',httpClientId=null,httpPollRunning=false,wsFailureCount=0;
async function transportOpened(){
  if(reconnectTimer){clearTimeout(reconnectTimer);reconnectTimer=null}reconnectDelay=1000;
  $('connectionText').textContent=transportMode==='http'?'🟢 Сървърът е онлайн (стабилна HTTP връзка).':'🟢 Сървърът е онлайн.';
  $('lobbyError').textContent='';
  $('createRoomBtn').disabled=false;$('joinRoomBtn').disabled=false;
  await refreshTwitchStatus();
  const target=(roomCode||codeFromLink||'').toUpperCase();
  const saved=getResume(target);
  if(target&&saved?.resumeToken){wsSend({type:'resume_room',code:target,resumeToken:saved.resumeToken,country:($('countryInput').value||'').trim()});return;}
  if(codeFromLink&&qs.get('twitch')==='connected'&&!roomCode){
    const name=(twitchStatus.user?.display_name||$('nameInput').value||'Player').trim();
    profile.name=name;saveProfile();wsSend({type:'join_room',name,country:($('countryInput').value||'').trim(),code:codeFromLink});
  }
}
function wsSend(obj){
  if(transportMode==='http'&&httpClientId){fetch('/api/game/send',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientId:httpClientId,message:obj})}).catch(()=>{});return;}
  if(ws&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(obj));
}
async function httpPollLoop(){
  if(httpPollRunning)return;httpPollRunning=true;
  while(transportMode==='http'&&httpClientId){
    try{
      const r=await fetch(`/api/game/poll?clientId=${encodeURIComponent(httpClientId)}&t=${Date.now()}`,{cache:'no-store'});
      if(!r.ok)throw new Error('poll');
      const data=await r.json();for(const d of (data.messages||[]))handle(d);
      await new Promise(x=>setTimeout(x,250));
    }catch{await new Promise(x=>setTimeout(x,1000));}
  }
  httpPollRunning=false;
}
async function connectHttp(){
  transportMode='http';
  try{
    const r=await fetch('/api/game/connect',{method:'POST',cache:'no-store'});if(!r.ok)throw new Error('connect');
    const data=await r.json();httpClientId=data.clientId;
    await transportOpened();httpPollLoop();
  }catch{
    $('connectionText').textContent='🔴 Няма връзка със сървъра.';
    $('lobbyError').textContent='HTTP fallback също не успя.';
    setTimeout(connectHttp,1500);
  }
}
function connect(){
  if(transportMode==='http'){connectHttp();return;}
  if(ws&&[WebSocket.OPEN,WebSocket.CONNECTING].includes(ws.readyState))return;
  const proto=location.protocol==='https:'?'wss':'ws';
  let opened=false;
  ws=new WebSocket(`${proto}://${location.host}/ws`);
  const guard=setTimeout(()=>{if(!opened&&transportMode==='ws'){try{ws.close()}catch{};connectHttp();}},3500);
  ws.onopen=async()=>{opened=true;clearTimeout(guard);wsFailureCount=0;await transportOpened();};
  ws.onclose=()=>{
    clearTimeout(guard);if(transportMode!=='ws')return;
    wsFailureCount++;
    $('connectionText').textContent='🟠 WebSocket прекъсна — минавам на стабилна HTTP връзка…';
    $('lobbyError').textContent='Възстановявам стаята без WebSocket…';
    if(wsFailureCount>=1){connectHttp();return;}
  };
  ws.onerror=()=>{};
  ws.onmessage=e=>{let d;try{d=JSON.parse(e.data)}catch{return}handle(d);};
}
function handle(d){
  if(d.type==='error'){$('lobbyError').textContent=d.message;$('feedback').textContent='⚠ '+d.message;return}
  if(d.type==='joined'){
    myId=d.playerId;roomCode=d.code;
    if(d.resumeToken)saveResume(roomCode,{resumeToken:d.resumeToken,playerId:d.playerId});
    $('joinControls').classList.add('hidden');$('roomControls').classList.remove('hidden');
    $('roomCode').textContent=roomCode;
    const base=serverPublicUrl||location.origin;
    const link=`${base}/?room=${encodeURIComponent(roomCode)}`;
    $('shareLink').value=link;
    history.replaceState(null,'',`?room=${encodeURIComponent(roomCode)}`);
    return;
  }
  if(d.type==='twitch_status'){return;} // per-player Twitch status is fetched by this browser's private session cookie
  if(d.type==='player_reconnected'){
    $('connectionText').textContent='🟢 Връзката е възстановена.';$('lobbyError').textContent='';
    return;
  }
  if(d.type==='twitch_chat_message'){
    $('twitchChatStatus').textContent=`Chat: ${d.chatter}: ${d.text}`;
    $('twitchChatStatus').className='twitch-chat-status ready';
    return;
  }
  if(d.type==='twitch_duel_command'){
    const box=$('twitchDuelAlert');box.textContent=`⚔️ TWITCH DUEL: ${d.challenger} предизвика @${d.target}`;box.classList.remove('hidden');
    setTimeout(()=>box.classList.add('hidden'),12000);
    return;
  }
  if(d.type==='room_state'){
    hostId=d.hostId;players=d.players||[];
    renderPlayers();
    $('lobbyPlayers').textContent=players.map(p=>`● ${p.name}`).join('   VS   ') || 'Чакаме играчи…';
    const ready=players.length===2&&players.every(p=>p.connected)&&d.phase==='lobby';
    $('hostStartBtn').classList.toggle('hidden',!(ready&&myId===hostId));
    $('guestWait').classList.toggle('hidden',!(ready&&myId!==hostId));
    if(ready)$('connectionText').textContent='🟢 Двамата сте в стаята. Готови за REAL 1V1.';
    else if(players.some(p=>!p.connected))$('connectionText').textContent='🟠 Чакаме прекъсналия играч да се върне…';
    if(d.phase!=='lobby'&&d.phase!=='disconnected')$('lobbyPanel').classList.add('hidden');
    return;
  }
  if(d.type==='round_question') return receiveQuestion(d);
  if(d.type==='timer_start') return startTimer(d.deadline);
  if(d.type==='player_locked'){
    if(d.playerId===myId)$('p1Status').textContent='LOCKED';
    else $('p2Status').textContent='LOCKED';
    return;
  }
  if(d.type==='joker_result') return applyJoker(d);
  if(d.type==='round_result') return showResult(d);
  if(d.type==='match_end') return endMatch(d);
  if(d.type==='opponent_disconnected'){
    $('feedback').textContent=`🟠 ${d.name} прекъсна връзката. Пазим мястото му за 2 минути.`;
    $('syncStatus').textContent='WAITING FOR RECONNECT';
    return;
  }
}
function setAvatar(imgId,fallbackId,url,label){
  const img=$(imgId),fb=$(fallbackId);if(!img||!fb)return;
  if(url){img.onload=()=>{img.style.display='block';fb.style.display='none'};img.onerror=()=>{img.style.display='none';fb.style.display='flex'};img.src=url;}
  else{img.removeAttribute('src');img.style.display='none';fb.style.display='flex';fb.textContent=label||'P';}
}
function renderPlayers(){
  const me=players.find(p=>p.id===myId),op=players.find(p=>p.id!==myId);
  if(me){$('p1Name').textContent=me.name;$('p1Hp').textContent=me.hp;$('p1Bar').style.width=Math.max(0,me.hp/MAX_HP*100)+'%';$('p1Country').textContent='🌍 '+(me.country||'Не е зададена');setAvatar('p1Avatar','p1AvatarFallback',me.avatar,'YOU')}
  if(op){$('p2Name').textContent=op.name;$('p2Hp').textContent=op.hp;$('p2Bar').style.width=Math.max(0,op.hp/MAX_HP*100)+'%';$('p2Country').textContent='🌍 '+(op.country||'Не е зададена');setAvatar('p2Avatar','p2AvatarFallback',op.avatar,'P2')}
  else{$('p2Name').textContent='Чакаме приятел';$('p2Hp').textContent='5000';$('p2Bar').style.width='100%';$('p2Country').textContent='🌍 —';setAvatar('p2Avatar','p2AvatarFallback','','P2')}
}
function setDamage(mult){
  const text=`DMG x${Number.isInteger(mult)?mult:mult.toFixed(2)}`;
  $('leftDamage').textContent=text;$('rightDamage').textContent=text;
}
function setTimer(v,mode='waiting'){
  $('timer').textContent=v;
  const p=Math.max(0,v/60),offset=CIRC*(1-p);
  $('timerProgress').style.strokeDasharray=CIRC;
  $('timerProgress').style.strokeDashoffset=offset;
  $('timerRing').className='timer-ring '+(mode==='urgent'?'urgent':mode==='waiting'?'waiting':'');
}
function setPhoto(q){
  const img=$('landmarkPhoto'),load=$('photoLoading');
  load.classList.remove('hidden');load.textContent='Зареждане на снимката…';
  const next=new Image();next.decoding='async';
  next.onload=()=>{img.src=next.src;load.classList.add('hidden')};
  let retried=false;next.onerror=()=>{if(!retried){retried=true;load.textContent='Презареждам снимката…';next.src=q.image+'?retry='+Date.now();return;}load.textContent='Снимката не можа да се зареди.'};
  next.src=q.image;
}
async function speak(text){
  try{
    $('voiceStatus').textContent='🎙 Зареждам Kalina…';
    const r=await fetch('/api/tts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})});
    if(!r.ok){$('voiceStatus').textContent='❌ Kalina TTS грешка';return false}
    const blob=await r.blob(),url=URL.createObjectURL(blob);
    if(activeVoiceAudio){activeVoiceAudio.pause();activeVoiceAudio=null}
    const audio=new Audio(url);activeVoiceAudio=audio;
    $('voiceStatus').textContent='🔊 KALINA · BG WOMAN';
    return await new Promise(resolve=>{
      let done=false;
      const finish=ok=>{if(done)return;done=true;URL.revokeObjectURL(url);if(activeVoiceAudio===audio)activeVoiceAudio=null;resolve(ok)};
      audio.onended=()=>finish(true);audio.onerror=()=>finish(false);audio.play().catch(()=>finish(false));
    });
  }catch{$('voiceStatus').textContent='❌ Kalina voice server error';return false}
}
async function receiveQuestion(d){
  currentQ=d.question;roundNo=d.roundNo;totalRounds=d.total;locked=false;resolved=false;
  clearInterval(timerInterval);deadline=0;setTimer(60,'waiting');setDamage(d.multiplier);
  const remain=totalRounds-roundNo+1;$('roundNow').textContent=remain;$('questionsLeft').textContent=remain;
  players=d.players||players;renderPlayers();
  $('p1Status').textContent='СЛУША';$('p2Status').textContent='СЛУША';
  $('syncStatus').textContent='И ДВАМАТА СЛУШАТ';
  $('feedback').textContent='';setPhoto(currentQ);$('questionText').textContent=currentQ.question;
  const box=$('answers');box.innerHTML='';
  currentQ.answers.forEach((t,i)=>{
    const b=document.createElement('button');b.className='answer';b.disabled=true;b.dataset.i=i;
    b.innerHTML=`<span class="letter">${['A','B','C','D'][i]}</span><span>${t}</span>`;
    b.onclick=()=>selectAnswer(i,b);box.appendChild(b);
  });
  $('fiftyBtn').disabled=fiftyUsed;$('friendBtn').disabled=friendUsed;
  const ok=await speak(`${currentQ.question}. Отговор А: ${currentQ.answers[0]}. Отговор Б: ${currentQ.answers[1]}. Отговор В: ${currentQ.answers[2]}. Отговор Г: ${currentQ.answers[3]}.`);
  $('voiceStatus').textContent=ok?'⏳ Чакаме и другия играч да чуе въпроса…':'⚠ Гласът не тръгна, но казваме на сървъра да продължи.';
  wsSend({type:'voice_done'});
}
function startTimer(serverDeadline){
  deadline=serverDeadline;locked=false;resolved=false;
  [...$('answers').children].forEach(b=>b.disabled=false);
  $('fiftyBtn').disabled=fiftyUsed;$('friendBtn').disabled=friendUsed;
  $('p1Status').textContent='ИЗБИРА';$('p2Status').textContent='ИЗБИРА';
  $('syncStatus').textContent='LIVE · REAL 1V1';$('voiceStatus').textContent='⏱ 60 секунди';
  clearInterval(timerInterval);
  const tick=()=>{
    const left=Math.max(0,Math.ceil((deadline-Date.now())/1000));
    setTimer(left,left<=10?'urgent':'normal');
    if(left<=0){clearInterval(timerInterval);[...$('answers').children].forEach(b=>b.disabled=true)}
  };
  tick();timerInterval=setInterval(tick,200);
}
function selectAnswer(i,b){
  if(locked||resolved||!deadline||Date.now()>deadline)return;
  locked=true;
  [...$('answers').children].forEach(x=>{x.disabled=true;x.classList.remove('selected')});
  b.classList.add('selected');
  $('p1Status').textContent='LOCKED';$('feedback').textContent='🔒 Заключи отговора. Чакаме приятеля ти…';
  wsSend({type:'submit_answer',index:i});
}
function applyJoker(d){
  if(d.kind==='fifty'){
    fiftyUsed=true;$('fiftyBtn').disabled=true;$('fiftyBtn').textContent='50 / 50 ✓ ИЗПОЛЗВАН';
    (d.removed||[]).forEach(i=>$('answers').children[i]?.classList.add('hidden-answer'));
  }else if(d.kind==='friend'){
    friendUsed=true;$('friendBtn').disabled=true;$('friendBtn').textContent='☎ ПОМОЩ ✓ ИЗПОЛЗВАНА';
    $('feedback').textContent=`☎ Верният отговор е ${['A','B','C','D'][d.correctIndex]} — ${d.correctAnswer}`;
  }
}
async function showResult(d){
  resolved=true;clearInterval(timerInterval);
  const mine=d.results.find(r=>r.id===myId),opp=d.results.find(r=>r.id!==myId);
  const mePlayer=d.players.find(p=>p.id===myId),opPlayer=d.players.find(p=>p.id!==myId);
  players=d.players;renderPlayers();
  [...$('answers').children].forEach((b,i)=>{
    b.disabled=true;
    if(i===d.correctIndex)b.classList.add('correct');
    const selected=b.classList.contains('selected');
    if(selected&&i!==d.correctIndex)b.classList.add('wrong');
  });
  $('p1Status').textContent=mine?.answered?'LOCKED':'NO ANSWER';
  $('p2Status').textContent=opp?.answered?'LOCKED':'NO ANSWER';
  profile.answered++;
  if(mine?.correct){profile.correct++;profile.streak++;profile.xp+=120}else profile.streak=0;
  saveProfile();
  const a=mine?.correct?`✅ ТИ: ПРАВИЛНО · ТИ СВАЛИ -${mine.damage} HP НА ${opp?.name||'ПРОТИВНИКА'}`:mine?.answered?'❌ ТИ: ГРЕШНО':'⌛ ТИ: НЯМА ОТГОВОР';
  const b=opp?.correct?`✅ ${opp.name}: ПРАВИЛНО · ТОЙ ТИ СВАЛИ -${opp.damage} HP`:opp?.answered?`❌ ${opp.name}: ГРЕШНО`:`⌛ ${opp.name}: НЯМА ОТГОВОР`;
  $('feedback').textContent=`${a} | ${b} | HP ${mePlayer.hp} : ${opPlayer.hp} | Верният: ${d.correctAnswer}`;
  $('syncStatus').textContent='ROUND RESULT';
  await speak(`${mine?.correct?'Правилно':'Грешно'}. Верният отговор е ${d.correctAnswer}.`);
  wsSend({type:'result_voice_done'});
}
async function endMatch(d){
  resolved=true;clearInterval(timerInterval);setTimer(0,'waiting');
  players=d.players;renderPlayers();$('roundNow').textContent='0';$('questionsLeft').textContent='0';
  let line='Мачът завърши наравно.',text='🏁 РАВЕНСТВО';
  if(d.winnerId){
    text=`🏁 ПОБЕДИТЕЛ: ${d.winnerName}`;
    line=`Край на мача. Победител е ${d.winnerName}. Поздравления!`;
    if(d.winnerId===myId){profile.wins++;saveProfile()}
  }
  $('feedback').textContent=text;$('syncStatus').textContent='MATCH FINISHED';$('voiceStatus').textContent='🎙 Kalina обявява победителя…';
  await speak(line);
  $('voiceStatus').textContent='Мачът приключи. За нов мач презаредете страницата и направете нова стая.';
}

async function refreshPublicUrl(){
  try{
    const r=await fetch('/api/public-url',{cache:'no-store'});
    if(!r.ok)return;
    const d=await r.json();
    if(d.publicUrl){
      serverPublicUrl=d.publicUrl.replace(/\/$/,'');
      if(roomCode)$('shareLink').value=`${serverPublicUrl}/?room=${encodeURIComponent(roomCode)}`;
    }
  }catch{}
}

async function refreshTwitchStatus(){
  try{
    const r=await fetch('/api/twitch/status',{cache:'no-store'});
    if(!r.ok)throw new Error('status');
    twitchStatus=await r.json();renderTwitchStatus();
  }catch{
    twitchStatus={configured:false,connected:false,user:null,chatReady:false,lastError:'Twitch status недостъпен'};renderTwitchStatus();
  }
}
function renderTwitchStatus(){
  const st=twitchStatus||{};
  if(st.connected&&st.user){
    $('twitchStatus').textContent=`✅ ${st.user.display_name} (@${st.user.login})`;
    $('twitchConnectBtn').textContent='RECONNECT TWITCH';
    $('twitchChatStatus').textContent=st.chatReady?'Chat: 🟢 слушаме !duel командите':st.lastError?`Chat: ❌ ${st.lastError}`:'Chat: 🟡 свързване към EventSub…';
    $('twitchChatStatus').className='twitch-chat-status '+(st.chatReady?'ready':st.lastError?'error':'');
    profile.name=st.user.display_name||profile.name;saveProfile();$('nameInput').value=profile.name;
    const img=$('p1Avatar'),fallback=$('p1AvatarFallback');
    if(st.user.profile_image_url){img.src=st.user.profile_image_url;img.style.display='block';fallback.style.display='none'}
  }else{
    $('twitchStatus').textContent=st.configured?'Twitch е готов за login.':'⚠ Липсва Client Secret на този компютър.';
    $('twitchChatStatus').textContent='Chat: offline';$('twitchChatStatus').className='twitch-chat-status';
    $('twitchConnectBtn').textContent='CONNECT TWITCH';
  }
}
function connectTwitch(){
  const ret=encodeURIComponent(location.href);
  // Always start OAuth on the same origin the player opened. Remote friends must never be sent to localhost.
  location.href=`${location.origin}/auth/twitch/start?return=${ret}`;
}

$('createRoomBtn').onclick=()=>{
  const name=($('nameInput').value||'').trim()||'Player';
  profile.name=name;saveProfile();$('lobbyError').textContent='';wsSend({type:'create_room',name,country:($('countryInput').value||'').trim()});
};
$('joinRoomBtn').onclick=()=>{
  const name=($('nameInput').value||'').trim()||'Player';
  const code=($('roomInput').value||'').trim().toUpperCase();
  profile.name=name;saveProfile();$('lobbyError').textContent='';wsSend({type:'join_room',name,country:($('countryInput').value||'').trim(),code});
};
$('hostStartBtn').onclick=()=>wsSend({type:'start_match'});
$('copyLinkBtn').onclick=async()=>{
  try{await navigator.clipboard.writeText($('shareLink').value);$('copyLinkBtn').textContent='COPIED ✓'}
  catch{$('shareLink').select();document.execCommand('copy');$('copyLinkBtn').textContent='COPIED ✓'}
};
$('fiftyBtn').onclick=()=>{if(!locked&&!fiftyUsed)wsSend({type:'use_joker',kind:'fifty'})};
$('friendBtn').onclick=()=>{if(!locked&&!friendUsed)wsSend({type:'use_joker',kind:'friend'})};
$('twitchConnectBtn').onclick=connectTwitch;
$('profileBtn').onclick=()=>$('profileDialog').showModal();
$('top15Btn').onclick=()=>$('top15Dialog').showModal();
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());


function inferCountryFromLocale(){
  const reg=(navigator.language||'').split('-')[1]?.toUpperCase()||'';
  const names={BG:'България',US:'САЩ',GB:'Великобритания',DE:'Германия',FR:'Франция',ES:'Испания',IT:'Италия',RO:'Румъния',GR:'Гърция',TR:'Турция',NL:'Нидерландия',BE:'Белгия',AT:'Австрия',CH:'Швейцария',CA:'Канада',AU:'Австралия',PT:'Португалия',PL:'Полша',CZ:'Чехия',RS:'Сърбия',MK:'Северна Македония'};
  return names[reg]||reg||'';
}

const qs=new URLSearchParams(location.search),codeFromLink=(qs.get('room')||'').toUpperCase();
$('nameInput').value=profile.name==='Player'?'':profile.name;
$('countryInput').value=localStorage.getItem('landmark_duel_country')||inferCountryFromLocale();
$('countryInput').addEventListener('change',()=>localStorage.setItem('landmark_duel_country',$('countryInput').value.trim()));
if(codeFromLink)$('roomInput').value=codeFromLink;
$('createRoomBtn').disabled=true;$('joinRoomBtn').disabled=true;
renderProfile();setTimer(60,'waiting');refreshPublicUrl();refreshTwitchStatus().finally(connect);setInterval(refreshTwitchStatus,10000);setInterval(refreshPublicUrl,5000);
