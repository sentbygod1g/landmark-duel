const {spawn}=require('child_process');
const WebSocket=require('ws');
const http=require('http');
const path=require('path');

const root=__dirname;
const server=spawn(process.execPath,[path.join(root,'server.js')],{cwd:root,stdio:['ignore','pipe','pipe']});
let logs='';
server.stdout.on('data',d=>logs+=d.toString());
server.stderr.on('data',d=>logs+=d.toString());

function wait(ms){return new Promise(r=>setTimeout(r,ms))}
function health(){
  return new Promise((resolve,reject)=>{
    http.get('http://127.0.0.1:3000/health',r=>{
      let s='';r.on('data',d=>s+=d);r.on('end',()=>resolve(s));
    }).on('error',reject);
  });
}
function makeClient(name){
  const ws=new WebSocket('ws://127.0.0.1:3000/ws');
  const q=[];
  ws.on('message',d=>{try{q.push(JSON.parse(d.toString()))}catch{}});
  return {name,ws,q};
}
async function next(c,type,timeout=4000){
  const end=Date.now()+timeout;
  while(Date.now()<end){
    const i=c.q.findIndex(x=>x.type===type);
    if(i>=0)return c.q.splice(i,1)[0];
    await wait(20);
  }
  throw new Error(`Timeout waiting ${type} for ${c.name}. Queue=${JSON.stringify(c.q)}`);
}
function send(c,o){c.ws.send(JSON.stringify(o))}
(async()=>{
  try{
    for(let i=0;i<60;i++){try{if((await health()).includes('v17-twitch-ok'))break}catch{} await wait(50)}
    if(!(await health()).includes('v17-twitch-ok'))throw new Error('health failed');

    const a=makeClient('Alice'),b=makeClient('Bob');
    await Promise.all([next(a,'hello'),next(b,'hello')]);

    send(a,{type:'create_room',name:'Alice'});
    const ja=await next(a,'joined');
    send(b,{type:'join_room',name:'Bob',code:ja.code});
    const jb=await next(b,'joined');
    if(ja.code!==jb.code)throw new Error('room code mismatch');

    await next(a,'room_state'); await next(a,'room_state');
    await next(b,'room_state');

    send(a,{type:'start_match'});
    const qa=await next(a,'round_question'),qb=await next(b,'round_question');
    if(qa.question.id!==qb.question.id)throw new Error('question mismatch');
    if('correct' in qa.question)throw new Error('correct answer leaked to client');

    send(a,{type:'voice_done'});send(b,{type:'voice_done'});
    await Promise.all([next(a,'timer_start'),next(b,'timer_start')]);

    // Test server-authoritative joker.
    send(a,{type:'use_joker',kind:'friend'});
    const joker=await next(a,'joker_result');
    if(!Number.isInteger(joker.correctIndex))throw new Error('joker failed');

    // Alice answers correctly, Bob deliberately answers differently.
    send(a,{type:'submit_answer',index:joker.correctIndex});
    send(b,{type:'submit_answer',index:(joker.correctIndex+1)%4});
    const [ra,rb]=await Promise.all([next(a,'round_result'),next(b,'round_result')]);
    const ar=ra.results.find(x=>x.id===ja.playerId);
    const br=ra.results.find(x=>x.id===jb.playerId);
    if(!ar.correct||br.correct)throw new Error('correctness logic failed');
    const ahp=ra.players.find(x=>x.id===ja.playerId).hp;
    const bhp=ra.players.find(x=>x.id===jb.playerId).hp;
    if(ahp!==5000||!(bhp<5000))throw new Error(`HP logic failed: ${ahp}/${bhp}`);

    send(a,{type:'result_voice_done'});send(b,{type:'result_voice_done'});
    const [q2a,q2b]=await Promise.all([next(a,'round_question'),next(b,'round_question')]);
    if(q2a.roundNo!==2||q2b.roundNo!==2)throw new Error('round advance failed');

    console.log('PASS: health');
    console.log('PASS: two real WebSocket clients joined same room');
    console.log('PASS: both received same question');
    console.log('PASS: correct answer is NOT leaked in question payload');
    console.log('PASS: timer waits for both voice_done events');
    console.log('PASS: server-authoritative friend joker');
    console.log('PASS: only losing opponent HP dropped');
    console.log('PASS: both clients advanced to round 2');
    a.ws.close();b.ws.close();
  }catch(e){
    console.error('FAIL:',e.stack||e);process.exitCode=1;
  }finally{
    setTimeout(()=>server.kill(),100);
  }
})();
