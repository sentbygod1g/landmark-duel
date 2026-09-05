const fs=require('fs');
const path=require('path');
const root=__dirname;
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');
const app=fs.readFileSync(path.join(root,'public','app.js'),'utf8');
const launcher=fs.readFileSync(path.join(root,'LAUNCH_TWITCH.js'),'utf8');
const qs=JSON.parse(fs.readFileSync(path.join(root,'questions.json'),'utf8'));
const checks=[
 ['25 questions',qs.length===25],
 ['25 unique landmark ids',new Set(qs.map(q=>q.id||q.landmark_id)).size===25],
 ['HTTP fallback connect endpoint',server.includes("route==='/api/game/connect'")],
 ['HTTP fallback send endpoint',server.includes("route==='/api/game/send'")],
 ['HTTP fallback poll endpoint',server.includes("route==='/api/game/poll'")],
 ['HTTP virtual client queue',server.includes('httpGameClients')&&server.includes('queue.splice(0,100)')],
 ['shared disconnect recovery',server.includes('disconnectGameConnection')&&server.includes('schedulePlayerCleanup')],
 ['browser switches to HTTP after WS failure',app.includes('connectHttp()')&&app.includes("transportMode='http'")],
 ['browser HTTP send transport',app.includes("'/api/game/send'")],
 ['browser HTTP polling transport',app.includes('/api/game/poll?clientId=')],
 ['room resume retained',app.includes("type:'resume_room'")&&app.includes('resumeToken')],
 ['per-browser Twitch sessions retained',server.includes('browserTwitchSessions')&&server.includes('ensureBrowserSession')],
 ['V17.7 hello',server.includes("version:'V17.7'")],
 ['V17.7 launcher label',launcher.includes('V17.7')&&!launcher.includes('V17.4 STABLE PUBLIC LINK')],
];
let bad=0;for(const [n,ok] of checks){console.log(`${ok?'PASS':'FAIL'}: ${n}`);if(!ok)bad++;}
process.exitCode=bad?1:0;
