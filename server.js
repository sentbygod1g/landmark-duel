const http=require('http'),fs=require('fs'),path=require('path');
const PORT=Number(process.env.PORT||3000),PUBLIC=path.join(__dirname,'public');
const crypto=require('crypto');
const TWITCH_CLIENT_ID=process.env.TWITCH_CLIENT_ID||'cc5te66gm5qmewa3pz1cfuqhcfx28i';
const TWITCH_CLIENT_SECRET=process.env.TWITCH_CLIENT_SECRET||'';
const GOOGLE_MAPS_API_KEY=process.env.GOOGLE_MAPS_API_KEY||'';
const TWITCH_REDIRECT_URI=process.env.TWITCH_REDIRECT_URI||'https://landmark-duel.onrender.com/auth/twitch/callback';
function cookies(req){return Object.fromEntries(String(req.headers.cookie||'').split(';').map(x=>x.trim()).filter(Boolean).map(x=>{let i=x.indexOf('=');return [decodeURIComponent(x.slice(0,i)),decodeURIComponent(x.slice(i+1))]}))}
function cookie(n,v,o=''){return `${n}=${encodeURIComponent(v)}; Path=/; SameSite=Lax; ${o}`}
function redir(res,url,headers={}){res.writeHead(302,{Location:url,...headers});res.end()}


const PANO_SEEDS=[
 {lat:-6.1939,lng:106.8493,country:'Indonesia',flag:'🇮🇩'},
 {lat:42.6977,lng:23.3219,country:'Bulgaria',flag:'🇧🇬'},
 {lat:52.5200,lng:13.4050,country:'Germany',flag:'🇩🇪'},
 {lat:48.8566,lng:2.3522,country:'France',flag:'🇫🇷'},
 {lat:41.9028,lng:12.4964,country:'Italy',flag:'🇮🇹'},
 {lat:40.4168,lng:-3.7038,country:'Spain',flag:'🇪🇸'},
 {lat:52.3676,lng:4.9041,country:'Netherlands',flag:'🇳🇱'},
 {lat:37.9838,lng:23.7275,country:'Greece',flag:'🇬🇷'},
 {lat:41.0082,lng:28.9784,country:'Türkiye',flag:'🇹🇷'},
 {lat:35.6762,lng:139.6503,country:'Japan',flag:'🇯🇵'},
 {lat:37.5665,lng:126.9780,country:'South Korea',flag:'🇰🇷'},
 {lat:1.3521,lng:103.8198,country:'Singapore',flag:'🇸🇬'},
 {lat:-33.8688,lng:151.2093,country:'Australia',flag:'🇦🇺'},
 {lat:40.7128,lng:-74.0060,country:'United States',flag:'🇺🇸'}
];
function deepPhotos(v,out=[]){if(!v||out.length>100)return out;if(Array.isArray(v)){for(const x of v)deepPhotos(x,out);return out}if(typeof v==='object'){if((v.fileurlProc||v.fileurl||v.fileUrlProc||v.fileUrl)&&v.lat!=null&&v.lng!=null)out.push(v);for(const x of Object.values(v))if(x&&typeof x==='object')deepPhotos(x,out)}return out}
async function randomPano(excludeRaw=''){
 const excluded=new Set(String(excludeRaw||'').split(',').filter(Boolean));
 const takeUnique=(arr,meta={})=>{
   const good=arr.filter(x=>{const id=String(x.id||x.photoId||x.fileurlProc||x.fileurl||'');const url=x.fileurlProc||x.fileurl||x.fileUrlProc||x.fileUrl;const fov=+(x.fieldOfView||x.fov||360);return id&&!excluded.has(id)&&url&&/^https:\/\//.test(url)&&x.lat!=null&&x.lng!=null&&fov>=280});
   if(!good.length)return null; const x=good[Math.floor(Math.random()*good.length)],url=x.fileurlProc||x.fileurl||x.fileUrlProc||x.fileUrl;
   return {id:String(x.id||x.photoId||url),lat:+x.lat,lng:+x.lng,heading:+(x.heading||x.compassAngle||0),country:meta.country||'Unknown',flag:meta.flag||'🌍',url};
 };
 // Large known 360° KartaView sequence: random pages give many different panoramas.
 for(let attempt=0;attempt<5;attempt++){
   try{const page=1+Math.floor(Math.random()*45),u=`https://api.openstreetcam.org/2.0/photo/?sequenceId=6187609&page=${page}&itemsPerPage=100`;const c=new AbortController(),t=setTimeout(()=>c.abort(),6500),r=await fetch(u,{headers:{'User-Agent':'LandmarkDuel/21.4'},signal:c.signal});clearTimeout(t);if(r.ok){const hit=takeUnique(deepPhotos(await r.json()),{country:'Indonesia',flag:'🇮🇩'});if(hit)return hit}}catch{}
 }
 let seeds=[...PANO_SEEDS].sort(()=>Math.random()-.5);
 for(const seed of seeds){try{let u=`https://api.openstreetcam.org/2.0/photo/?lat=${seed.lat}&lng=${seed.lng}&zoomLevel=13`;let c=new AbortController(),t=setTimeout(()=>c.abort(),6500),r=await fetch(u,{headers:{'User-Agent':'LandmarkDuel/21.4'},signal:c.signal});clearTimeout(t);if(!r.ok)continue;let hit=takeUnique(deepPhotos(await r.json()),seed);if(hit)return hit}catch{}}
 throw Error('No unused panorama available');
}

const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8','.json':'application/json; charset=utf-8'};
const GOOGLE_TARGETS=[
 [42.6977,23.3219],[41.1579,-8.6291],[40.4168,-3.7038],[48.8566,2.3522],[52.5200,13.4050],[41.9028,12.4964],[52.3676,4.9041],[37.9838,23.7275],[41.0082,28.9784],[51.5074,-0.1278],
 [59.3293,18.0686],[55.6761,12.5683],[60.1699,24.9384],[50.0755,14.4378],[48.2082,16.3738],[47.4979,19.0402],[44.4268,26.1025],[45.8150,15.9819],[46.0569,14.5058],[52.2297,21.0122],
 [40.7128,-74.0060],[34.0522,-118.2437],[41.8781,-87.6298],[43.6532,-79.3832],[49.2827,-123.1207],[19.4326,-99.1332],[-23.5505,-46.6333],[-34.6037,-58.3816],[-33.4489,-70.6693],[-12.0464,-77.0428],
 [35.6762,139.6503],[34.6937,135.5023],[37.5665,126.9780],[1.3521,103.8198],[22.3193,114.1694],[25.0330,121.5654],[13.7563,100.5018],[3.1390,101.6869],[-6.2088,106.8456],[-8.4095,115.1889],
 [-33.8688,151.2093],[-37.8136,144.9631],[-36.8485,174.7633],[-41.2866,174.7756],[-33.9249,18.4241],[-26.2041,28.0473],[31.6295,-7.9811],[36.8065,10.1815],[25.2048,55.2708],[32.0853,34.7818]
];
const server=http.createServer(async(req,res)=>{const u=new URL(req.url,'http://localhost');
 if(u.pathname==='/auth/twitch'){const st=crypto.randomBytes(20).toString('hex');let ret=String(u.searchParams.get('return')||'/');if(!ret.startsWith('/')||ret.startsWith('//'))ret='/';const q=new URLSearchParams({client_id:TWITCH_CLIENT_ID,redirect_uri:TWITCH_REDIRECT_URI,response_type:'code',scope:'user:read:email',state:st});return redir(res,'https://id.twitch.tv/oauth2/authorize?'+q,{'Set-Cookie':[cookie('ld_state',st,'HttpOnly; Secure; Max-Age=600'),cookie('ld_return',ret,'HttpOnly; Secure; Max-Age=600')]})}
 if(u.pathname==='/auth/twitch/callback'){try{const c=cookies(req),st=u.searchParams.get('state')||'',code=u.searchParams.get('code')||'';if(!code||!st||st!==c.ld_state)throw Error('Invalid Twitch login');if(!TWITCH_CLIENT_SECRET)throw Error('TWITCH_CLIENT_SECRET missing');const body=new URLSearchParams({client_id:TWITCH_CLIENT_ID,client_secret:TWITCH_CLIENT_SECRET,code,grant_type:'authorization_code',redirect_uri:TWITCH_REDIRECT_URI});const r=await fetch('https://id.twitch.tv/oauth2/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});if(!r.ok)throw Error('Twitch token '+r.status);const j=await r.json();let ret=String(c.ld_return||'/');if(!ret.startsWith('/')||ret.startsWith('//'))ret='/';return redir(res,ret,{'Set-Cookie':[cookie('ld_token',j.access_token,'HttpOnly; Secure; Max-Age='+Math.max(300,+j.expires_in||3600)),cookie('ld_state','','HttpOnly; Secure; Max-Age=0'),cookie('ld_return','','HttpOnly; Secure; Max-Age=0')]})}catch(e){return redir(res,'/?twitch_error='+encodeURIComponent(e.message))}}
 if(u.pathname==='/api/twitch/me'){const tok=cookies(req).ld_token;if(!tok){res.writeHead(401,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify({ok:false}))}try{const r=await fetch('https://api.twitch.tv/helix/users',{headers:{Authorization:'Bearer '+tok,'Client-Id':TWITCH_CLIENT_ID}});if(!r.ok)throw Error('Twitch user '+r.status);const j=await r.json(),x=j.data&&j.data[0];if(!x)throw Error('No Twitch user');res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify({ok:true,user:{id:x.id,login:x.login,displayName:x.display_name,avatar:x.profile_image_url}}))}catch(e){res.writeHead(401,{'Content-Type':'application/json','Cache-Control':'no-store','Set-Cookie':cookie('ld_token','','HttpOnly; Secure; Max-Age=0')});return res.end(JSON.stringify({ok:false}))}}
 if(u.pathname==='/api/random-pano'){try{let p=await randomPano(String(u.searchParams.get('exclude')||''));res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify(p))}catch(e){res.writeHead(500,{'Content-Type':'application/json'});return res.end(JSON.stringify({error:'pano'}))}}
 if(u.pathname==='/api/google-config'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify({key:GOOGLE_MAPS_API_KEY}));}
 if(u.pathname==='/api/random-target'){const t=GOOGLE_TARGETS[Math.floor(Math.random()*GOOGLE_TARGETS.length)];res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify({lat:t[0],lng:t[1]}));}
 if(u.pathname==='/health'||u.pathname==='/api/health'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end(JSON.stringify({ok:true,mode:'geo-duel-v21.6-google-streetview-googlemaps-flag-images',rooms:'browser-p2p'}));}
 if(u.pathname==='/api/pano'){try{const raw=String(u.searchParams.get('url')||''),x=new URL(raw),h=x.hostname.toLowerCase();if(!(h.endsWith('openstreetcam.org')||h.endsWith('kartaview.org')))throw Error('blocked');const c=new AbortController(),t=setTimeout(()=>c.abort(),15000),r=await fetch(x,{headers:{'User-Agent':'LandmarkDuel/20.3'},signal:c.signal});clearTimeout(t);if(!r.ok)throw Error('HTTP '+r.status);const b=Buffer.from(await r.arrayBuffer());res.writeHead(200,{'Content-Type':r.headers.get('content-type')||'image/jpeg','Cache-Control':'public,max-age=3600'});return res.end(b)}catch(e){res.writeHead(502);return res.end('Panorama unavailable')}}
 let f=u.pathname==='/'?path.join(PUBLIC,'index.html'):path.join(PUBLIC,u.pathname.replace(/^\//,''));if(!f.startsWith(PUBLIC))return res.writeHead(403).end();fs.stat(f,(e,st)=>{if(e||!st.isFile()){res.writeHead(404);return res.end('Not found')}res.writeHead(200,{'Content-Type':mime[path.extname(f)]||'application/octet-stream','Cache-Control':'no-store'});fs.createReadStream(f).pipe(res)})});
server.listen(PORT,()=>console.log('Landmark Duel V21.6 on '+PORT));
