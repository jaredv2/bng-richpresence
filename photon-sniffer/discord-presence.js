#!/usr/bin/env node
'use strict';
/**
 * BuildNow GG — Real Discord Rich Presence
 * Reads photon-sniffer decryptor's /presence and shows on your Discord profile:
 *   • Game mode (gm: DF, BR etc) — human readable
 *   • In Lobby / In Game / Loading
 *   • Players in game / max (255 from GameProperties)
 *   • Kills / alive
 *
 * Setup:
 *  1. Create app at https://discord.com/developers/applications → New Application
 *     → Rich Presence → add images:  buildnow  (512x512) , lobby / ingame
 *  2. Copy Application ID
 *  3. Run:  set DISCORD_CLIENT_ID=123456789012345678 && node photon-sniffer/discord-presence.js
 *     or:  node photon-sniffer/discord-presence.js --client-id 123...
 *  4. Keep decryptor + game + Discord desktop running
 *
 * Polls http://127.0.0.1:8765/presence every 1.5s (decryptor must be running)
 */

const http = require('http');
let RPC;
try { RPC = require('discord-rpc'); } catch (e) {
  console.error('[presence] discord-rpc not found — run `npm install` in repo root. Rich Presence disabled, decryptor still works.');
  console.error('  ' + e.message);
  // keep process alive so tray doesn't restart-loop, but do nothing
  setInterval(()=>{}, 1<<30);
}

const args = process.argv.slice(2);
function argVal(name){ const i=args.indexOf(name); return i>=0 ? args[i+1] : null; }

const CLIENT_ID = process.env.DISCORD_CLIENT_ID || argVal('--client-id') || argVal('--id') || '1529945836199608531';
if (!CLIENT_ID || CLIENT_ID==='0') {
  console.error('[presence] Missing DISCORD_CLIENT_ID');
  console.error('  Create app: https://discord.com/developers/applications');
  console.error('  Then: set DISCORD_CLIENT_ID=YOUR_APP_ID && node photon-sniffer/discord-presence.js');
  console.error('  Or:   node photon-sniffer/discord-presence.js --client-id YOUR_APP_ID');
  process.exit(1);
}

const PRESENCE_URL = process.env.PRESENCE_URL || 'http://127.0.0.1:8765/presence';
const POLL_MS = 1500;

const GM_NAMES = {
  DF: 'Free Mode',
  zw_lg: 'Lategame Zone Wars',
  zw: 'Zone Wars',
  BF: 'Boxfights',
  BF2V2: 'Boxfights 2v2',
  bf: 'Boxfights',
  bf2v2: 'Boxfights 2v2'
};
function gmLabel(gm, gv){
  if (gv === 'duo' && gm) {
    const base = GM_NAMES[gm] || GM_NAMES[gm.toLowerCase()] || gm;
    return `Duo ${base}`;
  }
  if(!gm) return 'BuildNow GG';
  return GM_NAMES[gm] || GM_NAMES[gm.toLowerCase()] || gm;
}

let rpc = new RPC.Client({ transport: 'ipc' });
let startTs = Math.floor(Date.now()/1000);
let lastActivity = '';

function fetchPresence(){
  return new Promise((resolve)=>{
    http.get(PRESENCE_URL, res=>{
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>{
        try{ const j=JSON.parse(d); resolve(j.presence || j); }catch{ resolve(null); }
      });
    }).on('error',()=> resolve(null));
  });
}

async function buildActivity(p){
  if (!p) return { details: 'BuildNow GG', state: 'Waiting for game…', largeImageKey: 'buildnow', largeImageText: 'buildnow-gg', instance: false };
  let gm = p.gameMode || p.scene?.gm || null;
  const gv = p.gameVariant || p.scene?.gv || p.raw?.gv || null; // "duo" → Duo {mode}
  const curScn = p.scene?.curScn || '';
  if (!gm && /bf2v2|boxfights.*2v2/i.test(curScn)) gm = 'BF2V2';
  else if (!gm && /boxfights/i.test(curScn)) gm = 'BF';
  else if (!gm && /zw_lg|lategame.*zone.*wars/i.test(curScn)) gm = 'zw_lg';
  else if (!gm && /zone.*wars/i.test(curScn)) gm = 'zw';
  const mode = gmLabel(gm, gv);
  const status = p.status || 'idle';
  const inLobby = status==='in_lobby' || /lobby/i.test(curScn);
  const inGame = status==='in_game' || /game|zonewars|free|boxfights/i.test(curScn);
  const inParty = p.inParty === true || p.Party === true;

  let details = mode;
  if (gm) details = `BuildNow — ${mode}`;
  else details = 'BuildNow GG';

  let state = '';
  if (inParty) state = 'In Party • ';
  if (inLobby) state += 'In Lobby';
  else if (inGame) state += 'In Game';
  else if (status==='loading') state += 'Loading…';
  else if (status==='idle') state += 'In Menu';
  else state += status;

  if (!inLobby) {
    let cur = p.playersCount ?? p.players?.length ?? 0;
    let max = p.maxPlayers ?? 12;
    if (p.gameMode && cur === 0) cur = 1; // mode picked → 1/Max
    state += ` • ${cur}/${max} players`;
  }

  // small image = alive/dead
  const smallKey = p.self?.alive === false ? 'dead' : p.self?.alive ? 'alive' : inGame ? 'ingame' : 'lobby';
  const smallText = p.self?.alive === false ? 'Eliminated' : p.self?.alive ? 'Alive' : state;

  return {
    details: details.slice(0,128),
    state: state.slice(0,128),
    largeImageKey: 'buildnow',
    largeImageText: `${mode} — ${curScn || status}`.slice(0,128),
    smallImageKey: smallKey,
    smallImageText: smallText.slice(0,128),
    startTimestamp: startTs,
    instance: false,
  };
}

let lastFetchOk = Date.now();
let hadPresence = false;
async function tick(){
  const p = await fetchPresence();
  if (p && p.updatedAt) lastFetchOk = Date.now();
  const stale = Date.now() - lastFetchOk > 12000; // tab closed → decryptor idle 12s
  const isIdle = !p || p.status === 'idle' || stale;
  if (isIdle) {
    if (hadPresence) {
      hadPresence = false;
      lastActivity = '';
      try { await rpc.clearActivity(); console.log('[presence] cleared — tab closed / idle'); } catch {}
    }
    return;
  }
  hadPresence = true;
  const act = await buildActivity(p);
  const key = JSON.stringify(act);
  if (key === lastActivity) return;
  lastActivity = key;
  try {
    await rpc.setActivity(act);
    const gm = p?.gameMode || p?.scene?.gm || '-';
    console.log(`[presence] ${act.details} | ${act.state} | gm=${gm} | updated=${p?.updatedAt||'-'}`);
  } catch(e){ console.error('[presence] setActivity failed', e.message); }
}

rpc.on('ready', ()=>{
  console.log(`[presence] Discord connected as ${rpc.user.username}#${rpc.user.discriminator}  clientId=${CLIENT_ID}`);
  console.log(`[presence] Reading ${PRESENCE_URL} → Discord Rich Presence`);
  setInterval(tick, POLL_MS);
  tick();
});

rpc.login({ clientId: CLIENT_ID }).catch(e=>{
  console.error('[presence] Discord login failed — is Discord desktop running? ', e.message);
  console.error('If you use Vesktop/ArmCord, set env: set RPC_IPC_PATH=\\\\?\\pipe\\discord-ipc-0');
  process.exit(1);
});

async function clearAndExit(){ try{ await rpc.clearActivity(); }catch{} try{ rpc.destroy(); }catch{} process.exit(0); }
process.on('SIGINT', clearAndExit);
process.on('SIGTERM', clearAndExit);
process.on('exit', ()=>{ try{ rpc.clearActivity(); }catch{} });
