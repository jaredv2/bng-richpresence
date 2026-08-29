// ==UserScript==
// @name         Photon Sniffer — Rich Presence Only (friend build)
// @namespace    photon-sniffer.local
// @version      1.0.10-presence
// @description  Hooks Photon WSS inside buildnow-gg.game-files.crazygames.com only — Rich Presence essentials only (no login, no kills DB). Streams to 127.0.0.1:8765 for tray exe.
// @author       photon-sniffer
// @match        https://buildnow-gg.game-files.crazygames.com/*
// @all-frames   true
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// @connect      127.0.0.1:8765
// @connect      localhost:8765
// @connect      exitgames.com
// @connect      cdn.jsdelivr.net
// ==/UserScript==

/*  Photon Sniffer — Tampermonkey
 *
 *  What:  intercepts ALL WebSocket traffic that matches Photon/ExitGames
 *         (ns.exitgames.com, gcams*.exitgames.com, app=30773790-f9fe-...) and
 *         forwards raw binary frames to a local Node decryptor:
 *            http://127.0.0.1:8765/capture   (POST json)
 *            ws://127.0.0.1:8765/ws         (persistent WS, preferred)
 *
 *  Why loopback is hard: Chrome's Private Network Access / CORS blocks
 *  fetch('http://127.0.0.1') from https pages. Fix:
 *    1) GM_xmlhttpRequest  — runs in extension context, bypasses PNA completely (BEST)
 *    2) WebSocket to decryptor — NOT gated by PNA yet (GOOD fallback)
 *    3) fetch({targetAddressSpace:'loopback'}) — modern Chrome hint
 *    4) navigator.sendBeacon — last resort (pagehide)
 *
 *  Logging: every hook/send/recv/flush is %c-colored in DevTools. Filter
 *  console by "[PHOTON]" to see only us.
 *
 *  Decryptor: node photon-sniffer/decryptor.js  (console, colorful, zero deps)
 *
 *  Tested against:
 *    wss://ns.exitgames.com:19093/?libversion=4.1.6.0&sid=30&app=NameServer            (NameServer)
 *    wss://gcams1128.exitgames.com:19090/?libversion=4.1.6.0&sid=30&app=30773790-f9fe-487c-92c2-19517c5c39ad (Game)
 *    wss://gcams2017.exitgames.com:19091/game/?libversion=4.1.6.0&sid=30&app=...   (Game alt)
 */

(function () {
  'use strict';

  const HREF = (() => { try { return location.href; } catch { return ''; } })();
  const IS_GAME_FRAME = HREF.includes('buildnow-gg.game-files.crazygames.com');
  if (!IS_GAME_FRAME) return;
  const FRAME_TAG = 'GAME_FRAME';
  // presence-only build — no login, no bot API
  let loginToken = null;
  let isGuest = true;
  let discordUsername = null;
  const GMGet = (k,d=null)=>d;
  const GMSet = ()=>{};
  function apiPost(path, body, cb){ cb(false); }
  function toastTopFrame(text){ try{ console.log('[PHOTON] '+text);}catch{} }

  function showTokenPrompt(){ /* no-op — presence-only */ }

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------
  const APP_ID = '30773790-f9fe-487c-92c2-19517c5c39ad';
  const PHOTON_HOSTS = ['exitgames.com', 'photon']; // substring match

  const DECRYPTOR_PRIMARY = 'http://127.0.0.1:8765';
  const DECRYPTOR_FALLBACK = 'http://localhost:8765';
  const DECRYPTOR_WS_PRIMARY = 'ws://127.0.0.1:8765/ws';
  const DECRYPTOR_WS_FALLBACK = 'ws://localhost:8765/ws';

  const BATCH_MAX = 40;
  const FLUSH_MS = 250;
  const WS_RECONNECT_MS = 2500;
  const WS_MAX_RETRIES = 4;

  // Only send what Rich Presence needs — drop movement/RPC spam (fixes 80→5 fps)
  const ESSENTIAL_ONLY = true; // false = capture everything (debug)
  // Keep: auth(230,231) + joinRandom(225) + joinRoom(226) + createRoom(227) + setProperties(252) + leave(254)
  const ESSENTIAL_OPS = new Set([225,226,227,230,231,252,254]);
  // Keep: join(255) + leave(254) + propertiesChanged(253) + killfeed(101)
  const ESSENTIAL_EVS = new Set([101,253,254,255]);
  const DROP_EVS_NOISY = new Set([200,201,202,204,206]); // RPC/SendSerialize/movement — always drop

  const VERBOSE = false; // true = log every packet, false = essentials only

  // ---------------------------------------------------------------------------
  // Fancy logger — every line is %c colored, filterable by "[PHOTON]"
  // ---------------------------------------------------------------------------
  const PAL = {
    bgSys: 'background:#7c3aed;color:#fff;padding:1px 6px;border-radius:3px;font-weight:900',
    bgIn: 'background:#06b6d4;color:#00202b;padding:1px 6px;border-radius:3px;font-weight:900',
    bgOut: 'background:#f59e0b;color:#1a0f00;padding:1px 6px;border-radius:3px;font-weight:900',
    bgWs: 'background:#111827;color:#a78bfa;padding:1px 6px;border-radius:3px;font-weight:700',
    bgOk: 'background:#10b981;color:#002018;padding:1px 6px;border-radius:3px;font-weight:800',
    bgErr: 'background:#ef4444;color:#fff;padding:1px 6px;border-radius:3px;font-weight:900',
    bgInfo: 'background:#1f2937;color:#e5e7eb;padding:1px 6px;border-radius:3px',
    txtDim: 'color:#9ca3af',
    txtCyan: 'color:#06b6d4;font-weight:700',
    txtYellow: 'color:#fbbf24;font-weight:700',
    txtPink: 'color:#f472b6;font-weight:700',
    txtGreen: 'color:#34d399;font-weight:700',
  };

  const tag = (label, style) => [`%c[${label}]`, style];

  function logSys(msg, ...rest) {
    console.log(`%c[PHOTON]%c %c[SYS]%c ${msg}`, 'color:#7c3aed;font-weight:900', '', PAL.bgSys, '', ...rest);
  }
  function logWs(msg, ...rest) {
    console.log(`%c[PHOTON]%c %c[WS]%c ${msg}`, 'color:#7c3aed;font-weight:900', '', PAL.bgWs, '', ...rest);
  }
  function logIn(msg, ...rest) {
    if (!VERBOSE) return;
    console.log(`%c[PHOTON]%c %c[IN ]%c ${msg}`, 'color:#06b6d4;font-weight:900', '', PAL.bgIn, '', ...rest);
  }
  function logOut(msg, ...rest) {
    if (!VERBOSE) return;
    console.log(`%c[PHOTON]%c %c[OUT]%c ${msg}`, 'color:#f59e0b;font-weight:900', '', PAL.bgOut, '', ...rest);
  }
  function logOk(msg, ...rest) {
    console.log(`%c[PHOTON]%c %c[OK]%c ${msg}`, 'color:#10b981;font-weight:900', '', PAL.bgOk, '', ...rest);
  }
  function logErr(msg, ...rest) {
    console.warn(`%c[PHOTON]%c %c[ERR]%c ${msg}`, 'color:#ef4444;font-weight:900', '', PAL.bgErr, '', ...rest);
  }
  function logInfo(msg, ...rest) {
    console.log(`%c[PHOTON]%c %c[INF]%c ${msg}`, 'color:#6b7280;font-weight:800', '', PAL.bgInfo, '', ...rest);
  }

  logSys(`[GAME_FRAME] href=${location.href.slice(0, 120)} app=${APP_ID.slice(0,8)}…`);
  logSys(`essentials-only=${ESSENTIAL_ONLY} → decryptor ${DECRYPTOR_PRIMARY}/capture`);

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  function isPhotonUrl(url) {
    if (!url) return false;
    const u = String(url);
    if (u.includes(APP_ID)) return true;
    for (const h of PHOTON_HOSTS) if (u.toLowerCase().includes(h)) return true;
    // also match crazygames photon relay? fallback
    if (u.includes('wss://') && u.includes('exitgames')) return true;
    return false;
  }

  function shortUrl(url) {
    return String(url)
      .replace(/^wss?:\/\//, '')
      .replace(/\?libversion.*$/, '')
      .slice(0, 80);
  }

  function labelForUrl(url) {
    const u = String(url);
    if (u.includes('ns.exitgames.com')) return 'NameServer';
    if (u.includes('gcams')) {
      const m = u.match(/gcams(\d+)/);
      return m ? `GCAMS${m[1]}` : 'GCAMS';
    }
    if (u.includes('exitgames')) return 'Photon';
    return 'WS';
  }

  function hexOf(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return s;
  }

  function previewHex(hex, max = 72) {
    if (hex.length <= max) return hex;
    return hex.slice(0, max) + '…' + `(${hex.length / 2}B)`;
  }

  // lightweight decode preview (F3/F4 sign + msgType)
  function previewFrame(hex) {
    if (!hex || hex.length < 4) return '??';
    const sign = hex.slice(0, 2).toUpperCase();
    const type = parseInt(hex.slice(2, 4), 16);
    const names = { 1: 'Session', 2: 'OpReq', 3: 'OpRes', 4: 'Event', 5: 'Init', 6: 'InitReq', 7: 'InitResp' };
    const enc = (parseInt(sign, 16) & 0x0f) === 0x04 || (parseInt(sign, 16) & 0x0f) === 0x05 ? '🔒' : '🔓';
    return `${enc} F${sign} type=${type}(${names[type] || '?'})`;
  }

  // No banner/badge - silent for game frame (all stats via decryptor + console filter [PHOTON])
  let badgeStats = { in: 0, out: 0, sent: 0, errors: 0, dropped: 0 };
  function updateBadge() {} // no-op (kept for call sites)

  // Toastify — show once when first essential packet is captured (game-frame only)
  let toastShown = false;
  let toastifyReady = false;
  function ensureToastify(cb){
    if (toastifyReady && typeof Toastify !== 'undefined') return cb();
    try {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://cdn.jsdelivr.net/npm/toastify-js@1.12.0/src/toastify.min.css';
      document.documentElement.appendChild(link);
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/toastify-js@1.12.0/src/toastify.min.js';
      s.onload = () => { toastifyReady = true; cb(); };
      s.onerror = () => cb();
      document.documentElement.appendChild(s);
      setTimeout(cb, 1500);
    } catch { cb(); }
  }
  function showFirstPacketToast(rec){
    if (toastShown) return;
    toastShown = true;
    const hasDecoded = rec && rec.decoded && rec.decoded.name;
    const text = hasDecoded ? `Connected — ${hasDecoded}` : 'Connected to game';
    const baseStyle = { background:'#000000', color:'#FFFFFF', borderRadius:'8px', border:'1px solid rgb(255 255 255 / 12%)', boxShadow:'0 4px 16px rgb(0 0 0 / 12%)', fontFamily:'Inter, system-ui, -apple-system, sans-serif', fontSize:'14px', fontWeight:'500', lineHeight:'1.4', padding:'12px 16px', maxWidth:'360px' };
    ensureToastify(() => {
      try {
        if (typeof Toastify !== 'undefined') {
          Toastify({ text, duration: 3200, gravity: 'top', position: 'right', stopOnFocus: true, style: baseStyle }).showToast();
        } else {
          const d=document.createElement('div'); d.textContent=text;
          Object.assign(d.style,{position:'fixed',top:'16px',right:'16px',zIndex:2147483647,background:baseStyle.background,color:baseStyle.color,borderRadius:baseStyle.borderRadius,border:baseStyle.border,boxShadow:baseStyle.boxShadow,fontFamily:baseStyle.fontFamily,fontSize:baseStyle.fontSize,fontWeight:baseStyle.fontWeight,padding:baseStyle.padding,lineHeight:baseStyle.lineHeight,maxWidth:baseStyle.maxWidth,textAlign:'left'});
          document.body.appendChild(d); setTimeout(()=>d.remove(),3500);
        }
      } catch {}
    });
  }

  // ---------------------------------------------------------------------------
  // Decryptor transport — batching + loopback-safe delivery
  // ---------------------------------------------------------------------------
  let sessionId = null;
  try { sessionId = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : null; } catch {}
  if (!sessionId) sessionId = 'sniff-' + Math.random().toString(16).slice(2) + '-' + Date.now().toString(36);

  let seq = 0;
  let queue = [];
  let flushTimer = null;
  let wsDecryptor = null;
  let wsReady = false;
  let wsRetry = null;
  let wsAttempts = 0;
  let wsDisabled = false;
  let flushInFlight = false;

  // Capture native WebSocket BEFORE we hook it — so decryptor WS bypasses our own hook
  const NativeWS = (typeof unsafeWindow !== 'undefined' && unsafeWindow.WebSocket) || window.WebSocket;
  const GM = typeof GM_xmlhttpRequest !== 'undefined' ? GM_xmlhttpRequest : (typeof unsafeWindow !== 'undefined' && unsafeWindow.GM_xmlhttpRequest) || null;
  const hasGM = !!GM;

  logSys(`session ${sessionId.slice(0,8)}… hasGM=${hasGM}`);

  // -- WebSocket to decryptor (best-effort, GM_xhr is the reliable primary) --
  function connectDecryptorWs() {
    if (wsDisabled) return;
    if (wsDecryptor && (wsDecryptor.readyState === 0 || wsDecryptor.readyState === 1)) return;
    if (wsAttempts >= WS_MAX_RETRIES) {
      if (!wsDisabled) {
        wsDisabled = true;
        logInfo(`WS disabled after ${wsAttempts} fails — using GM_xhr only (reliable). No more WS retries. Run __PHOTON_SNIFFER__.reconnect() to try again.`);
        updateBadge(`WS off — GM_xhr active ✓`, '#34d399');
      }
      return;
    }
    const url = DECRYPTOR_WS_PRIMARY;
    wsAttempts++;
    try {
      if (wsAttempts === 1) logWs(`connecting → ${url} … (attempt ${wsAttempts}/${WS_MAX_RETRIES}, PNA requires decryptor header)`);
      else logWs(`reconnecting → ${url} … (attempt ${wsAttempts}/${WS_MAX_RETRIES})`);
      updateBadge(`connecting decryptor WS… (${wsAttempts}/${WS_MAX_RETRIES})`, '#fbbf24');
      // Use NativeWS to bypass our Photon hook (and avoid double-wrap with old buildnow tracker)
      wsDecryptor = new NativeWS(url);
      wsDecryptor.binaryType = 'arraybuffer';
      wsDecryptor.onopen = () => {
        wsReady = true;
        wsAttempts = 0; // reset on success
        logOk(`decryptor WS OPEN → ${url}  (keep-alive, will use for sends when available)`);
        updateBadge(`decryptor WS ● connected`, '#34d399');
        if (queue.length) flush();
      };
      wsDecryptor.onclose = (ev) => {
        const wasReady = wsReady;
        wsReady = false;
        wsDecryptor = null;
        const code = ev && ev.code != null ? ev.code : '?';
        const reason = ev && ev.reason ? ev.reason : '-';
        const clean = ev && ev.wasClean ? 'clean' : 'unclean';
        logWs(`decryptor WS closed code=${code} reason=${reason||'-'} wasClean=${clean} wasReady=${wasReady} — ${wsAttempts < WS_MAX_RETRIES ? `retry in ${WS_RECONNECT_MS}ms` : 'giving up (GM_xhr will still work)'} ${!wasReady && wsAttempts<=2 ? '(hint: ws:// from https may be mixed-content blocked — GM_xhr is fine. Try http://localhost:8765/status to confirm decryptor up)' : ''}`);
        if (!wasReady && code === 1006) logErr(`WS abnormal close 1006 — likely mixed-content or PNA block. GM_xhr is the reliable fallback, no action needed.`);
        updateBadge(wsAttempts < WS_MAX_RETRIES ? `decryptor WS ○ closed (${code}) — retry…` : `WS off — GM_xhr ✓`, wsAttempts < WS_MAX_RETRIES ? '#f472b6' : '#34d399');
        if (wsRetry) clearTimeout(wsRetry);
        if (!wsDisabled && wsAttempts < WS_MAX_RETRIES) wsRetry = setTimeout(connectDecryptorWs, WS_RECONNECT_MS);
      };
      wsDecryptor.onerror = (e) => {
        // onerror is followed by onclose — just log once verbosely
        logErr(`decryptor WS error → ${url}  code=?, handshake blocked? decryptor up? — check http://127.0.0.1:8765/status  (GM_xhr will still deliver)`);
        updateBadge(`decryptor WS error — will retry`, '#ef4444');
      };
      wsDecryptor.onmessage = (ev) => {
        try { logInfo(`decryptor_echo: ${String(ev.data).slice(0, 200)}`); } catch {}
      };
    } catch (e) {
      logErr(`WS ctor failed: ${e.message}`);
      if (wsRetry) clearTimeout(wsRetry);
      if (!wsDisabled && wsAttempts < WS_MAX_RETRIES) wsRetry = setTimeout(connectDecryptorWs, WS_RECONNECT_MS);
    }
  }
  connectDecryptorWs();

  // also try localhost fallback once if primary never connects
  let wsFallback = null;
  function tryFallbackWs() {
    if (wsReady || wsDisabled) return;
    try {
      logWs(`trying fallback → ${DECRYPTOR_WS_FALLBACK} …`);
      wsFallback = new NativeWS(DECRYPTOR_WS_FALLBACK);
      wsFallback.onopen = () => { logOk(`decryptor WS (fallback) OPEN → ${DECRYPTOR_WS_FALLBACK}`); wsDecryptor = wsFallback; wsReady = true; wsAttempts = 0; };
      wsFallback.onclose = (ev) => { logWs(`fallback WS closed code=${ev.code}`); wsFallback = null; };
      wsFallback.onerror = () => { try { wsFallback.close(); } catch {} wsFallback = null; };
    } catch {}
  }
  setTimeout(tryFallbackWs, 3500);

  function sendViaGM(payload, onDone) {
    if (!hasGM) { onDone(false); return; }
    const urls = [DECRYPTOR_PRIMARY + '/capture', DECRYPTOR_FALLBACK + '/capture'];
    let idx = 0;
    function attempt() {
      if (idx >= urls.length) { onDone(false); return; }
      const url = urls[idx++];
      try {
        GM({
          method: 'POST',
          url,
          headers: { 'Content-Type': 'application/json' },
          data: payload,
          timeout: 4000,
          onload: (res) => {
            const ok = res.status >= 200 && res.status < 300;
            if (ok) {
              logOk(`GM_xhr POST ${url} → ${res.status} (${payload.length}B)`);
              badgeStats.sent += JSON.parse(payload).records.length;
              updateBadge(`GM → ${labelForUrl(url)} ${res.status}  queue ${queue.length}`, '#34d399');
              onDone(true);
            } else {
              logErr(`GM_xhr POST ${url} → ${res.status} ${res.responseText.slice(0, 120)}`);
              attempt();
            }
          },
          onerror: () => { logErr(`GM_xhr network error → ${url}`); attempt(); },
          ontimeout: () => { logErr(`GM_xhr timeout → ${url}`); attempt(); },
        });
      } catch (e) {
        logErr(`GM_xhr throw → ${url}: ${e.message}`);
        attempt();
      }
    }
    attempt();
  }

  function sendViaFetch(payload, onDone) {
    const urls = [DECRYPTOR_PRIMARY + '/capture', DECRYPTOR_FALLBACK + '/capture'];
    let idx = 0;
    function attempt() {
      if (idx >= urls.length) { onDone(false); return; }
      const url = urls[idx++];
      try {
        // targetAddressSpace:loopback is the modern PNA opt-in for Chrome
        fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
          keepalive: true,
          // @ts-ignore — Chrome PNA header
          targetAddressSpace: 'loopback',
        }).then(res => {
          if (res.ok) {
            logOk(`fetch POST ${url} → ${res.status}`);
            badgeStats.sent += JSON.parse(payload).records.length;
            updateBadge(`fetch → ${res.status}  queue ${queue.length}`, '#34d399');
            onDone(true);
          } else {
            logErr(`fetch POST ${url} → ${res.status}`);
            attempt();
          }
        }).catch(err => {
          logErr(`fetch POST ${url} failed: ${err && err.message ? err.message : err}`);
          attempt();
        });
      } catch (e) {
        logErr(`fetch throw: ${e.message}`);
        attempt();
      }
    }
    attempt();
  }

  let hasWelcomedSession = false;
  let sessionStartMs = null;
  let sessionGm = null;

  function maybeWelcome(decoded){
    if (isGuest || !loginToken || hasWelcomedSession) return;
    if (!decoded || decoded.code!==230 || decoded.kind!=='OpReq') return; // first auth
    hasWelcomedSession = true;
    const firstSeen = GMGet('bn_first_seen', true);
    const gameName = GMGet('bn_game_username', null);
    if (firstSeen) {
      toastTopFrame(`Welcome here @${discordUsername||'player'}`, false);
    } else if (gameName) {
      toastTopFrame(`Welcome back ${gameName}`, false);
    } else {
      // fetch game name from API via validate
      apiPost('/api/validate-token', {token: loginToken}, (ok,txt)=>{
        if(ok){ try{ const j=JSON.parse(txt); const gn=j.game_username||gameName||discordUsername; toastTopFrame(`Welcome back ${gn}`, false); }catch{ toastTopFrame(`Welcome back @${discordUsername}`, false); } }
        else toastTopFrame(`Welcome back`, false);
      });
    }
    GMSet('bn_welcomed', true);
  }

  function flush() {
    if (!queue.length) { flushTimer = null; return; }
    if (flushInFlight) { if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_MS); return; }
    flushTimer = null;
    const batch = queue.splice(0, BATCH_MAX);
    for (const r of batch) {
      ensureHex(r);
      maybeWelcome(r.decoded);
      if (VERBOSE) {
        const arrow = r.dir==='in'?'◀':'▶'; const col = r.dir==='in'?PAL.txtCyan:PAL.txtYellow;
        const decStr = r.decoded?` ${r.decoded.kind} ${r.decoded.name}(${r.decoded.code})`:'';
        (r.dir==='in'?logIn:logOut)(`${arrow} ${r.label} #${r.seq} ${r._bytes?r._bytes.length:r.rawHex.length/2}B ${previewFrame(r.rawHex)}${decStr}`, col);
      }
    }
    const payload = JSON.stringify({ sessionId, token: loginToken || null, records: batch });

    // 1) GM_xhr FIRST — extension context, bypasses PNA + mixed-content + CORS (most reliable)
    //    WS is best-effort second choice (may be blocked ws:// from https).
    flushInFlight = true;
    sendViaGM(payload, (ok) => {
      if (ok) {
        flushInFlight = false;
        if (queue.length) flushTimer = setTimeout(flush, 40);
        return;
      }
      // 2) try WS if GM failed and WS ready
      if (wsDecryptor && wsDecryptor.readyState === 1) {
        try {
          wsDecryptor.send(payload);
          flushInFlight = false;
          logOk(`WS send ${batch.length} frames → decryptor (${payload.length}B)`);
          badgeStats.sent += batch.length;
          updateBadge(`WS → ${batch.length} frames  total ${badgeStats.sent}`, '#a78bfa');
          if (queue.length) flushTimer = setTimeout(flush, 40);
          return;
        } catch (e) {
          logErr(`WS send failed: ${e.message} — falling back to fetch`);
        }
      } else if (wsAttempts >= WS_MAX_RETRIES) {
        logInfo(`GM failed + WS disabled (after retries) — trying fetch…`);
      }
      // 3) fetch fallback
      sendViaFetch(payload, (ok2) => {
        flushInFlight = false;
        if (ok2) {
          if (queue.length) flushTimer = setTimeout(flush, 40);
          return;
        }
        // 4) re-queue + retry later (don't drop)
        logErr(`all transports failed — re-queueing ${batch.length} frames, will retry… (is node decryptor.js running? check http://127.0.0.1:8765/status)`);
        badgeStats.errors++;
        updateBadge(`transport failed — re-queue ${batch.length} — is decryptor up?`, '#ef4444');
        queue = batch.concat(queue).slice(0, BATCH_MAX * 4); // cap
        flushTimer = setTimeout(flush, 1200);
        // nudge WS reconnect once
        if (!wsReady && !wsDisabled) connectDecryptorWs();
      });
    });
  }

  function scheduleFlush() {
    if (flushTimer) return;
    if (queue.length >= BATCH_MAX) flush();
    else flushTimer = setTimeout(flush, FLUSH_MS);
  }

  // --- lightweight inline filter/decrypt for Rich Presence (no full GpBinary decode needed) ---
  function isEssentialBytes(bytes) {
    if (!ESSENTIAL_ONLY) return true;
    if (!bytes || bytes.length < 3) return false;
    const type = bytes[1]; // 2=OpReq 3=OpRes 4=Event
    if (type === 6 || type === 7) return false; // drop InitRequest/InitResponse noise (user request)
    const code = bytes[2];
    if (type === 2 || type === 3) return ESSENTIAL_OPS.has(code);
    if (type === 4) {
      if (DROP_EVS_NOISY.has(code)) return false;
      return ESSENTIAL_EVS.has(code);
    }
    return type === 1 || type === 5; // keep Session only, drop Init
  }
  function lightDecode(bytes) {
    // split concatenated F3 frames, return first essential summary for console
    try {
      if (!bytes || bytes.length < 3) return null;
      const type = bytes[1], code = bytes[2];
      const names = {2:'OpReq',3:'OpRes',4:'Event'};
      const opNames = {255:'Join',254:'Leave',253:'RaiseEvent',252:'SetProperties',251:'GetProperties',230:'Authenticate',229:'JoinLobby',227:'CreateRoom',226:'JoinRoom',225:'JoinRandom'};
      const evNames = {255:'Join',254:'Leave',253:'PropertiesChanged',101:'Killfeed',200:'RPC',201:'SendSerialize'};
      if (type===2) return { kind:names[type], code, name: opNames[code]||('op#'+code) };
      if (type===3) return { kind:names[type], code, name: opNames[code]||('op#'+code) };
      if (type===4) return { kind:names[type], code, name: evNames[code]||('ev#'+code) };
      return { kind:'type#'+type, code };
    } catch { return null; }
  }

  // defer hex encoding to flush (idle) to keep hot path <0.1ms
  function enqueue(dir, bytes, url) {
    if (!bytes || !bytes.length) return;
    if (ESSENTIAL_ONLY && !isEssentialBytes(bytes)) { badgeStats.dropped++; return; }
    const rec = {
      seq: ++seq,
      t: Date.now(),
      dir,
      url: shortUrl(url),
      fullUrl: String(url).slice(0, 256),
      label: labelForUrl(url),
      _bytes: bytes,
      decoded: lightDecode(bytes),
    };
    queue.push(rec);
    if (dir === 'in') badgeStats.in++; else badgeStats.out++;
    if (!toastShown && IS_GAME_FRAME) showFirstPacketToast(rec);
    scheduleFlush();
  }

  // hex on idle, not hot path
  function ensureHex(rec){
    if (rec.rawHex) return rec.rawHex;
    try { rec.rawHex = hexOf(rec._bytes); delete rec._bytes; } catch { rec.rawHex=''; }
    return rec.rawHex;
  }

  // pagehide fallback — beacon last batch
  try {
    window.addEventListener('pagehide', () => {
      if (!queue.length) return;
      const payload = JSON.stringify({ sessionId, records: queue.splice(0, BATCH_MAX) });
      const urls = [DECRYPTOR_PRIMARY + '/capture', DECRYPTOR_FALLBACK + '/capture'];
      for (const u of urls) { try { navigator.sendBeacon(u, new Blob([payload], { type: 'application/json' })); logSys(`sendBeacon ${queue.length} frames → ${u}`); break; } catch {} }
    });
  } catch {}

  // ---------------------------------------------------------------------------
  // Disable WS-to-decryptor — it was the crash source (ws:// from https = mixed-content 1006)
  // All frames go via GM_xmlhttpRequest (extension → bypasses PNA/mixed-content)
  // ---------------------------------------------------------------------------
  wsDisabled = true;
  try { if (wsRetry) clearTimeout(wsRetry); wsRetry=null; } catch {}
  try { if (wsDecryptor && wsDecryptor.readyState===1) { try{wsDecryptor.close();}catch{}} wsDecryptor=null; wsReady=false; } catch {}
  try { wsFallback=null; } catch {}
  logSys(`WS-to-decryptor DISABLED — using GM_xhr only (no ws:// mixed-content 1006)`);

  // ---------------------------------------------------------------------------
  // WebSocket hook — capture packets, return them via enqueue → GM_xhr
  // Root cause of "no packets": previous onmessage defineProperty stored fn
  // in a closure (_onmsg) instead of the browser's native slot → browser
  // never dispatched 'message' to it. Fix: delegate to native getter/setter.
  // Also patch prototype send/addEventListener BEFORE hooking constructor.
  // ---------------------------------------------------------------------------
  const hookKey = '__photon_sniffer_hooked__';
  const win = (typeof unsafeWindow !== 'undefined' && unsafeWindow !== window) ? unsafeWindow : window;
  const windowsToHook = new Set([window, win].filter(Boolean));

  // cross-realm safe — zero-copy peek for hot path, copy only if needed
  function toBytes(data) {
    try {
      if (!data) return null;
      if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
      if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset||0, (data.byteOffset||0)+data.byteLength));
      const tag = Object.prototype.toString.call(data);
      if (tag === '[object ArrayBuffer]') return new Uint8Array(data.slice(0));
      if (tag.includes('Array') && data && data.buffer) {
        try { return new Uint8Array(data.buffer.slice(data.byteOffset||0, (data.byteOffset||0)+data.byteLength)); } catch {}
      }
      if (data && typeof data.byteLength === 'number' && typeof data.slice === 'function') {
        try { return new Uint8Array(data.slice(0)); } catch {}
      }
    } catch {}
    return null;
  }
  // fast peek without allocation — returns {type,code} or null
  function peekHeader(data) {
    try {
      if (!data) return null;
      if (data instanceof ArrayBuffer) { const v=new Uint8Array(data); return v.length>=3?{type:v[1],code:v[2]}:null; }
      if (ArrayBuffer.isView(data)) return data.length>=3?{type:data[1],code:data[2]}:null;
      if (data && typeof data.byteLength==='number' && data.byteLength>=3) { try{const v=new Uint8Array(data.buffer||data,0,3); return {type:v[1],code:v[2]};}catch{}}
    } catch {}
    return null;
  }
  function isEssentialHeader(h){
    if (!h) return false;
    if (!ESSENTIAL_ONLY) return true;
    if (h.type===6||h.type===7) return false;
    if (h.type===2||h.type===3) return ESSENTIAL_OPS.has(h.code);
    if (h.type===4) { if (DROP_EVS_NOISY.has(h.code)) return false; return ESSENTIAL_EVS.has(h.code); }
    return h.type===1||h.type===5;
  }

  function captureOut(bytes, url) { try { if (bytes && bytes.length) enqueue('out', bytes, url || 'unknown'); } catch {} }
  function captureIn(bytes, url)  { try { if (bytes && bytes.length) enqueue('in', bytes, url || 'unknown'); } catch {} }

  for (const w of windowsToHook) {
    try {
      const Proto = w.WebSocket && w.WebSocket.prototype;
      if (!Proto || Proto[hookKey+'_proto']) continue;

      const origSend = Proto.send;
      Proto.send = function (data) {
        try {
          const u = this.url || '';
          if (isPhotonUrl(u)) {
            // FPS hot path: peek header WITHOUT copy, drop noisy before any allocation
            if (ESSENTIAL_ONLY) {
              const h = peekHeader(data);
              if (h && !isEssentialHeader(h)) { return origSend.call(this, data); }
              // also skip tiny pings if not essential
              if (!h) { /* Blob/string -> let through but don't capture */ }
            }
            const b = toBytes(data);
            if (b) captureOut(b, u);
            else if (typeof Blob !== 'undefined' && data instanceof Blob) {
              data.arrayBuffer().then(ab=>{ const bb=toBytes(ab); if(bb && isEssentialHeader(peekHeader(bb)||{type:4,code:0})) captureOut(bb, u); }).catch(()=>{});
            }
          }
        } catch {}
        return origSend.call(this, data);
      };

      const origAdd = Proto.addEventListener;
      Proto.addEventListener = function (type, listener, opts) {
        if (type === 'message' && typeof listener === 'function' && isPhotonUrl(this.url||'')) {
          const self = this;
          const wrapped = function (ev) {
            try {
              const d=ev.data;
              if (ESSENTIAL_ONLY) { const h=peekHeader(d); if(h && !isEssentialHeader(h)) return listener.call(this,ev); }
              const b = toBytes(d);
              if (b) captureIn(b, self.url);
              else if (typeof Blob !== 'undefined' && d instanceof Blob) d.arrayBuffer().then(ab=>{ const bb=toBytes(ab); if(bb) captureIn(bb, self.url); }).catch(()=>{});
            } catch {}
            return listener.call(this, ev);
          };
          wrapped.__orig = listener;
          return origAdd.call(this, type, wrapped, opts);
        }
        return origAdd.call(this, type, listener, opts);
      };

      try {
        const desc = Object.getOwnPropertyDescriptor(Proto, 'onmessage');
        if (desc && desc.set && desc.get) {
          const nativeGet = desc.get, nativeSet = desc.set;
          Object.defineProperty(Proto, 'onmessage', {
            configurable: true,
            get() { const v = nativeGet.call(this); return v && v.__orig ? v.__orig : v; },
            set(fn) {
              if (typeof fn === 'function' && isPhotonUrl(this.url||'')) {
                const self = this;
                const wrapped = function (ev) {
                  try {
                    const d=ev.data;
                    if (ESSENTIAL_ONLY) { const h=peekHeader(d); if(h && !isEssentialHeader(h)) return fn.call(this,ev); }
                    const b=toBytes(d); if(b) captureIn(b, self.url);
                  } catch {}
                  return fn.call(this, ev);
                };
                wrapped.__orig = fn;
                return nativeSet.call(this, wrapped);
              }
              return nativeSet.call(this, fn);
            }
          });
        }
      } catch (e) { logErr(`onmessage patch failed: ${e.message}`); }

      Proto[hookKey+'_proto'] = true;
      logSys(`prototype patches (send/addEventListener/onmessage) on ${w===window?'window':'unsafeWindow'} ✓`);
    } catch (e) { logErr(`proto patch failed: ${e.message}`); }
  }

  function instrumentPhotonWs(ws, url) {
    if (ws[hookKey]) return ws;
    ws[hookKey] = true;
    // open/close/error badge — these go through addEventListener which is now wrapped,
    // but captureIn for those is harmless (no ev.data)
    ws.addEventListener('open', () => { logOk(`WSS OPEN  ◉ ${labelForUrl(url)} → ${url}`); updateBadge(`◉ ${labelForUrl(url)} OPEN`, '#34d399'); });
    ws.addEventListener('close', (ev) => { logWs(`WSS CLOSE ${labelForUrl(url)} code=${ev.code} reason=${ev.reason||'-'} wasClean=${ev.wasClean}`); updateBadge(`○ ${labelForUrl(url)} closed`, '#9ca3af'); });
    ws.addEventListener('error', () => { logErr(`WSS ERROR ${labelForUrl(url)}`); });
    return ws;
  }

  for (const w of windowsToHook) {
    try {
      const OrigWS = w.WebSocket;
      if (!OrigWS || OrigWS[hookKey]) continue;
      logSys(`hooking WebSocket constructor on ${w===window?'window':'unsafeWindow'} — orig=${OrigWS.name||'WebSocket'}`);
      function HookedWS(url, protocols) {
        const isDecryptor = String(url).includes('127.0.0.1:8765') || String(url).includes('localhost:8765');
        if (isDecryptor) return protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
        const ws = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
        if (!isPhotonUrl(url)) { logInfo(`WS bypass (non-Photon) → ${String(url).slice(0,90)}`); return ws; }
        logOk(`HOOKED Photon WSS [${FRAME_TAG}] → ${url}`);
        logInfo(`frame href: ${HREF.slice(0,100)}`);
        updateBadge(`● ${labelForUrl(url)} [${FRAME_TAG}]`, '#a78bfa');
        try { ws.binaryType = 'arraybuffer'; } catch {}
        return instrumentPhotonWs(ws, url);
      }
      HookedWS.prototype = OrigWS.prototype;
      HookedWS.CONNECTING = OrigWS.CONNECTING; HookedWS.OPEN = OrigWS.OPEN; HookedWS.CLOSING = OrigWS.CLOSING; HookedWS.CLOSED = OrigWS.CLOSED;
      HookedWS[hookKey] = true;
      w.WebSocket = HookedWS;
      logSys(`WebSocket hook installed on ${w===window?'window':'unsafeWindow'} ✓`);
    } catch (e) { logErr(`hook failed: ${e.message}`); }
  }

  // ---------------------------------------------------------------------------
  // Public debug API (console)
  // ---------------------------------------------------------------------------
  try {
    const api = {
      sessionId,
      get seq() { return seq; },
      get queueLen() { return queue.length; },
      get stats() { return { ...badgeStats, sessionId, wsReady, hasGM, wsAttempts, wsDisabled, NativeWS: !!NativeWS }; },
      flush: () => flush(),
      reconnect: () => { wsDisabled=false; wsAttempts=0; connectDecryptorWs(); logSys('reconnect forced — WS re-enabled'); },
      dump: () => {
        try { return sessionStorage.getItem('__photon_sniffer_backup__') || ''; } catch { return queue.map(r => JSON.stringify(r)).join('\n'); }
      },
      download: () => {
        try {
          const txt = api.dump();
          const blob = new Blob([txt], { type: 'application/x-ndjson' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `photon-sniff-${sessionId}.jsonl`;
          document.body.appendChild(a); a.click();
          setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
          logOk(`downloaded ${txt.split('\n').filter(Boolean).length} records → photon-sniff-${sessionId}.jsonl`);
        } catch (e) { logErr(`download failed: ${e.message}`); }
      },
      test: () => {
        // send a fake frame to verify decryptor is reachable
        enqueue('out', new Uint8Array([0xF3, 0x02, 0xE6, 0x03]), 'test://photon-sniffer/self-test');
        logSys('self-test frame enqueued — check decryptor console for it');
      }
    };
    window.__PHOTON_SNIFFER__ = api;
    if (typeof unsafeWindow !== 'undefined' && unsafeWindow !== window) unsafeWindow.__PHOTON_SNIFFER__ = api;
    logSys(`API → window.__PHOTON_SNIFFER__  {sessionId, stats, flush(), reconnect(), dump(), download(), test()}`);
    logInfo(`tip: run __PHOTON_SNIFFER__.test() to send a test frame to the decryptor`);
  } catch {}

  logSys('ready — waiting for Photon WSS connections…');
  logInfo('open DevTools → Console, filter "[PHOTON]" — every packet will be %c colored', 'color:#a78bfa;font-weight:900');
  logInfo('decryptor: %c node photon-sniffer/decryptor.js', 'color:#34d399;font-weight:900');
})();