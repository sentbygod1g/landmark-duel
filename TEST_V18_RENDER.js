const fs=require('fs');
const s=fs.readFileSync('server.js','utf8');
const p=JSON.parse(fs.readFileSync('package.json','utf8'));
const r=fs.readFileSync('render.yaml','utf8');
const q=JSON.parse(fs.readFileSync('questions.json','utf8'));
const checks=[
  ['PORT env', s.includes("process.env.PORT || 3000")],
  ['bind 0.0.0.0', s.includes("server.listen(PORT,'0.0.0.0'")],
  ['Render public URL', s.includes('process.env.RENDER_EXTERNAL_URL')],
  ['Twitch secret env', s.includes('process.env.TWITCH_CLIENT_SECRET')],
  ['WebSocket /ws', s.includes("path:'/ws'")],
  ['HTTP fallback connect', s.includes("'/api/game/connect'")],
  ['health route', s.includes("route==='/health'")],
  ['render yaml health', r.includes('healthCheckPath: /health')],
  ['render yaml npm install', r.includes('buildCommand: npm install')],
  ['25 questions', q.length===25],
  ['25 unique ids', new Set(q.map(x=>x.id)).size===25],
  ['node start', p.scripts.start==='node server.js']
];
let bad=0;for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} ${name}`);if(!ok)bad++;}
if(bad)process.exit(1);
