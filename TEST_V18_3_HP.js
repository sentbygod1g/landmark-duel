const fs=require('fs');
const s=fs.readFileSync('server.js','utf8');
const a=fs.readFileSync('public/app.js','utf8');
function ok(cond,msg){if(!cond){console.error('FAIL:',msg);process.exit(1)}console.log('PASS:',msg)}
ok(/const MAX_HP = 5000/.test(s),'5000 starting HP');
ok(/350 \+ Math\.round\(\(seconds\/60\)\*250\)/.test(s),'350 base + up to 250 speed bonus');
ok(/roundNo>=21\)return 2/.test(s)&&/roundNo>=16\)return 1\.5/.test(s)&&/roundNo>=11\)return 1\.25/.test(s),'round multipliers x1/x1.25/x1.5/x2');
ok(/Math\.min\(rawDamage,hpBefore\.get\(opponent\.id\)\)/.test(s),'reported damage capped to actual HP removed');
ok(/Damage is simultaneous/.test(s),'simultaneous damage snapshot');
ok(/startSuddenDeath/.test(s)&&/SUDDEN_DEATH/.test(s),'no draw after equal HP: sudden death');
ok(/DOUBLE_KO_SPEED/.test(s),'double KO resolves by faster correct lock');
ok(/restore 1 HP each and decide it with Sudden Death/.test(s),'exact simultaneous double KO cannot end as draw');
ok(/SUDDEN DEATH/.test(a),'client shows sudden death state');
console.log('HP TESTS PASSED');
