#!/usr/bin/env node
'use strict';

/**
 * Photon Sniffer — Decryptor / Live Viewer (Node, zero deps)
 *
 * Listens on 127.0.0.1:8765 for raw Photon frames forwarded by
 * photon-sniffer.user.js and decodes them with rich ANSI-colored logging.
 *
 * Transports (all loopback-safe, all accepted):
 *   POST http://127.0.0.1:8765/capture  {sessionId, records:[{seq,t,dir,url,rawHex}]}
 *   POST http://localhost:8765/capture  (same)
 *   WS   ws://127.0.0.1:8765/ws          (same JSON over WebSocket — preferred, not PNA-gated)
 *   GET  http://127.0.0.1:8765/status    (health + stats)
 *
 * Also doubles as offline decoder:
 *   node decryptor.js captures/foo.jsonl            (pretty-prints + summary)
 *   node decryptor.js --json captures/foo.jsonl     (json output)
 *
 * Decoder is byte-identical to tools/decoder.js — GpBinaryV16 LE minimal.
 * Reference: photon-capture-*.jsonl + docs/websocket-packets.md
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// ANSI — zero-dep, 24-bit, works in PowerShell + Windows Terminal
// ---------------------------------------------------------------------------
const R = '\x1b[0m';
const B = '\x1b[1m';
const D = '\x1b[2m';
const I = '\x1b[3m';
function c(r, g, b, s) { return `\x1b[38;2;${r};${g};${b}m${s}${R}`; }
function bg(r, g, b, s) { return `\x1b[48;2;${r};${g};${b}m${s}${R}`; }

const COL = {
  sys: (s) => c(124, 58, 237, s),          // violet
  ok: (s) => c(16, 185, 129, s),           // emerald
  err: (s) => c(239, 68, 68, s),           // red
  warn: (s) => c(245, 158, 11, s),         // amber
  info: (s) => c(156, 163, 175, s),        // gray
  in: (s) => c(6, 182, 212, s),            // cyan  — inbound
  out: (s) => c(251, 191, 36, s),          // yellow — outbound
  ns: (s) => c(96, 165, 250, s),           // blue — NameServer
  game: (s) => c(244, 114, 182, s),        // pink — GCAMS/game
  op: (s) => c(251, 146, 60, s),           // orange — Operation
  ev: (s) => c(167, 139, 250, s),          // purple — Event
  hex: (s) => c(110, 231, 183, s),
  ascii: (s) => c(156, 163, 175, s),
  dim: (s) => D + s + R,
  bold: (s) => B + s + R,
  tag: (label, clr) => bg(clr[0], clr[1], clr[2], c(255, 255, 255, ` ${label} `)),
};

const TAG = {
  SYS: bg(124, 58, 237, c(255, 255, 255, ' SYS ')),
  IN: bg(6, 182, 212, c(0, 32, 48, ' IN  ')),
  OUT: bg(251, 191, 36, c(40, 24, 0, ' OUT ')),
  NS: bg(37, 99, 235, c(255, 255, 255, ' NS  ')),
  GAME: bg(190, 24, 93, c(255, 255, 255, ' GAME')),
  OK: bg(16, 185, 129, c(0, 32, 24, ' OK  ')),
  ERR: bg(239, 68, 68, c(255, 255, 255, ' ERR ')),
  EVT: bg(109, 40, 217, c(255, 255, 255, ' EVT ')),
  OP: bg(194, 65, 12, c(255, 255, 255, ' OP  ')),
};

function ts() {
  const d = new Date();
  return D + d.toISOString().slice(11, 23) + R;
}
function labelForUrl(url) {
  const u = String(url || '');
  if (u.includes('ns.exitgames') || u.includes('NameServer')) return 'NS';
  if (u.includes('gcams')) { const m = u.match(/gcams(\d+)/); return m ? `GCAMS${m[1]}` : 'GAME'; }
  if (u.toLowerCase().includes('exitgames')) return 'PHOTON';
  if (u.includes('test://')) return 'TEST';
  return 'WS';
}
function tagForLabel(lbl) {
  if (lbl === 'NS') return TAG.NS;
  if (lbl.startsWith('GCAMS') || lbl === 'GAME') return TAG.GAME;
  return TAG.SYS;
}

// ---------------------------------------------------------------------------
// Decoder — ported from tools/decoder.js (browser-safe, no deps)
// ---------------------------------------------------------------------------
const OPERATIONS = {
  255: 'Join', 254: 'Leave', 253: 'RaiseEvent', 252: 'SetProperties',
  251: 'GetProperties', 250: 'ExchangeKeysForEncryption', 249: 'Ping',
  248: 'ChangeGroups', 231: 'AuthenticateOnce', 230: 'Authenticate',
  229: 'JoinLobby', 228: 'LeaveLobby', 227: 'CreateRoom', 226: 'JoinRoom',
  225: 'JoinRandomRoom', 224: 'CancelJoinRandomRoom', 220: 'GetRegions',
};
const EVENTS = {
  255: 'Join', 254: 'Leave', 253: 'PropertiesChanged', 226: 'AppStats',
  200: 'RPC', 201: 'SendSerialize', 202: 'Instantiation', 203: 'CloseConnection',
  204: 'Destroy', 205: 'RemoveCachedRPCs', 206: 'SendSerializeReliable',
  207: 'DestroyPlayer', 208: 'AssignMaster', 209: 'OwnershipRequest',
  210: 'OwnershipTransfer', 211: 'VacantViewIds'
};
const PARAMS = {
  255: 'RoomName', 254: 'ActorNr', 253: 'TargetActorNr', 252: 'ActorList',
  251: 'Properties', 250: 'Broadcast', 249: 'PlayerProperties', 248: 'GameProperties',
  247: 'Cache', 246: 'ReceiverGroup', 245: 'Data', 244: 'Code', 241: 'CleanupCacheOnLeave',
  240: 'Group', 239: 'Remove/PublishUserId', 238: 'Add', 237: 'SuppressRoomEvents',
  236: 'EmptyRoomTTL', 235: 'PlayerTTL', 234: 'EventForward', 233: 'IsComingBack',
  232: 'CheckUserOnJoin', 231: 'ExpectedValues', 230: 'Address', 229: 'PeerCount',
  228: 'GameCount', 227: 'MasterPeerCount', 225: 'UserId', 224: 'ApplicationId',
  223: 'MatchMakingType', 222: 'GameList', 221: 'Token', 220: 'AppVersion',
  218: 'Info', 217: 'ClientAuthenticationType', 216: 'ClientAuthenticationParams',
  215: 'JoinMode', 214: 'ClientAuthenticationData', 213: 'LobbyName', 212: 'LobbyType',
  210: 'Region', 196: 'Cluster',
};
const GP_TYPE = {
  0: 'Unknown', 2: 'Boolean', 3: 'Byte', 4: 'Short', 5: 'Float', 6: 'Double',
  7: 'String', 8: 'Null', 9: 'CompressedInt', 10: 'CompressedLong', 11: 'Int1',
  12: 'Int1_', 13: 'Int2', 14: 'Int2_', 15: 'L1', 16: 'L1_', 17: 'L2', 18: 'L2_',
  19: 'Custom', 20: 'Dictionary', 21: 'Hashtable', 23: 'ObjectArray',
  27: 'BooleanFalse', 28: 'BooleanTrue', 29: 'ShortZero', 30: 'IntZero',
  31: 'LongZero', 32: 'FloatZero', 33: 'DoubleZero', 34: 'ByteZero'
};

function hexStr(bytes, max) {
  let s = ''; const n = Math.min(bytes.length, max || 256);
  for (let i = 0; i < n; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return s;
}
function asciiStr(bytes, max) {
  let s = ''; const n = Math.min(bytes.length, max || 128);
  for (let i = 0; i < n; i++) { const c = bytes[i]; s += (c >= 32 && c < 127) ? String.fromCharCode(c) : '.'; }
  return s;
}
function hexToBytes(hex) {
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) b[i / 2] = parseInt(hex.substr(i, 2), 16);
  return b;
}
function utf8Decode(b) {
  try { return Buffer.from(b).toString('utf8'); } catch { return String.fromCharCode(...b); }
}

class Reader {
  constructor(bytes, le, minimal) { this.b = bytes; this.pos = 0; this.le = !!le; this.minimal = !!minimal; }
  get left() { return this.b.length - this.pos; }
  byte() { return this.b[this.pos++]; }
  bytes(n) { const r = this.b.slice(this.pos, this.pos + n); this.pos += n; return r; }
  readCount() { let v = this.byte(); if (v >= 0x80) v |= this.byte() << 8; return v; }
  count() { return this.minimal ? this.readCount() : this.uint16(); }
  strLen() { return this.minimal ? this.readCount() : this.uint16(); }
  intLen() { return this.minimal ? this.readCount() : this.uint32(); }
  uint16() { const v = this.le ? (this.b[this.pos] | (this.b[this.pos + 1] << 8)) : ((this.b[this.pos] << 8) | this.b[this.pos + 1]); this.pos += 2; return v; }
  int16() { const v = this.uint16(); return v > 0x7fff ? v - 0x10000 : v; }
  uint32() { const b = this.b; const v = this.le ? (b[this.pos] | (b[this.pos + 1] << 8) | (b[this.pos + 2] << 16) | (b[this.pos + 3] << 24)) : ((b[this.pos] << 24) | (b[this.pos + 1] << 16) | (b[this.pos + 2] << 8) | b[this.pos + 3]); this.pos += 4; return v >>> 0; }
  compInt() { let r = 0, s = 0, b; do { b = this.byte(); r |= (b & 0x7f) << s; s += 7; } while (b & 0x80); return r; }
}
const isArrType = t => (t & 0x40) !== 0;
function readValue(r, type, depth, warnings) {
  if (depth > 12) { warnings.push('max depth'); return { type: 'deep' }; }
  switch (type) {
    case 2: return { type: 'Boolean', value: r.byte() !== 0 };
    case 3: return { type: 'Byte', value: r.byte() };
    case 4: return { type: 'Short', value: r.int16() };
    case 5: { const buf = Buffer.from(r.bytes(4)); return { type: 'Float', value: buf.readFloatLE(0) }; }
    case 6: { const buf = Buffer.from(r.bytes(8)); return { type: 'Double', value: buf.readDoubleLE(0) }; }
    case 7: { const len = r.strLen(); return { type: 'String', value: utf8Decode(r.bytes(len)) }; }
    case 8: return { type: 'Null', value: null };
    case 9: return { type: 'Int', value: r.compInt() };
    case 10: return { type: 'Long', value: r.compInt() };
    case 11: return { type: 'Int', value: r.byte() };
    case 12: return { type: 'Int', value: -r.byte() };
    case 13: return { type: 'Int', value: r.uint16() };
    case 14: return { type: 'Int', value: -r.uint16() };
    case 15: return { type: 'Long', value: r.byte() };
    case 16: return { type: 'Long', value: -r.byte() };
    case 17: return { type: 'Long', value: r.uint16() };
    case 18: return { type: 'Long', value: -r.uint16() };
    case 19: { const code = r.byte(); const rest = Math.min(r.left, 96); return { type: 'Custom#' + code, value: { hex: hexStr(r.bytes(rest)), rest } }; }
    case 20: return readDictionary(r, depth, warnings);
    case 21: return readHashtable(r, depth, warnings);
    case 23: return readObjectArray(r, depth, warnings);
    case 27: return { type: 'Boolean', value: false };
    case 28: return { type: 'Boolean', value: true };
    case 29: return { type: 'Short', value: 0 };
    case 30: return { type: 'Int', value: 0 };
    case 31: return { type: 'Long', value: 0 };
    case 32: return { type: 'Float', value: 0 };
    case 33: return { type: 'Double', value: 0 };
    case 34: return { type: 'Byte', value: 0 };
    default:
      if (isArrType(type)) return readArray(r, type, depth, warnings);
      warnings.push('unknown GpType ' + type + ' @' + r.pos);
      return { type: 'Unknown(' + type + ')', value: hexStr(r.bytes(Math.max(1, Math.min(r.left, 32)))) };
  }
}
function readArray(r, type, depth, warnings) {
  const elem = type & 0x3f;
  if (elem === 3) {
    const len = r.intLen();
    if (len < 0 || len > 4000000) { warnings.push('byte[] len ' + len + ' invalid'); return { type: 'ByteArray', value: { hex: '?', len: -1 } }; }
    if (len > r.left) { warnings.push('byte[] len ' + len + ' > remaining ' + r.left); return { type: 'ByteArray', value: { hex: hexStr(r.bytes(r.left)), len: r.left } }; }
    const bytes = r.bytes(len);
    return { type: 'ByteArray', value: { hex: hexStr(bytes), len, ascii: asciiStr(bytes, 64) } };
  }
  let count, effElem = elem;
  if (type === 0x40) { count = r.count(); effElem = r.byte(); } else { count = r.count(); }
  if (count > 65535) { warnings.push('array len ' + count + ' invalid'); return { type: 'Array', value: hexStr(r.bytes(Math.min(r.left, 64))) }; }
  const items = [];
  for (let i = 0; i < count; i++) items.push(readValue(r, effElem, depth + 1, warnings));
  return { type: 'Array[' + (GP_TYPE[effElem] || effElem) + ']', value: items };
}
function readHashtable(r, depth, warnings) {
  const count = r.count();
  if (count > 65535) { warnings.push('hashtable len invalid'); return { type: 'Hashtable', value: hexStr(r.bytes(Math.min(r.left, 64))) }; }
  const map = {};
  for (let i = 0; i < count; i++) {
    const kt = r.byte(); const key = readValue(r, kt, depth + 1, warnings);
    const vt = r.byte(); const val = readValue(r, vt, depth + 1, warnings);
    map[String(typeof key.value === 'string' ? key.value : key.value)] = val;
  }
  return { type: 'Hashtable', value: map };
}
function readDictionary(r, depth, warnings) {
  const kt = r.byte(), vt = r.byte(); const count = r.count();
  if (count > 65535) { warnings.push('dict len invalid'); return { type: 'Dictionary', value: hexStr(r.bytes(Math.min(r.left, 64))) }; }
  const map = {};
  for (let i = 0; i < count; i++) {
    const ek = (kt === 0 || kt === 42) ? r.byte() : kt;
    const key = readValue(r, ek, depth + 1, warnings);
    const ev = (vt === 0 || vt === 42) ? r.byte() : vt;
    const val = readValue(r, ev, depth + 1, warnings);
    map[String(typeof key.value === 'string' ? key.value : key.value)] = val;
  }
  return { type: 'Dictionary<' + (GP_TYPE[kt] || kt) + ',' + (GP_TYPE[vt] || vt) + '>', value: map };
}
function readObjectArray(r, depth, warnings) {
  const count = r.count();
  if (count > 65535) { warnings.push('objarray len invalid'); return { type: 'ObjectArray', value: hexStr(r.bytes(Math.min(r.left, 64))) }; }
  const items = [];
  for (let i = 0; i < count; i++) { const t = r.byte(); items.push(readValue(r, t, depth + 1, warnings)); }
  return { type: 'ObjectArray', value: items };
}
function readParams(r, count, depth, warnings) {
  const params = [];
  for (let i = 0; i < count; i++) {
    if (r.left <= 0) { warnings.push('param ' + i + ' past end'); break; }
    const key = r.byte(); const t = r.byte();
    params.push({ key, keyName: PARAMS[key] || ('p' + key), value: readValue(r, t, depth + 1, warnings) });
  }
  return params;
}
function readOperationRequest(r, depth, warnings) {
  const opCode = r.byte(); const paramCount = r.count(); const params = readParams(r, paramCount, depth, warnings);
  return { kind: 'OperationRequest', opCode, opName: OPERATIONS[opCode] || ('op#' + opCode), params };
}
function readOperationResponse(r, depth, warnings) {
  const opCode = r.byte(); const returnCode = r.int16();
  let debugMsg = null; const dbgType = r.byte();
  if (dbgType === 7) { const len = r.count(); debugMsg = utf8Decode(r.bytes(len)); }
  else if (dbgType !== 0 && dbgType !== 8) { warnings.push('debug field type ' + dbgType); }
  const paramCount = r.count(); const params = readParams(r, paramCount, depth, warnings);
  return { kind: 'OperationResponse', opCode, opName: OPERATIONS[opCode] || ('op#' + opCode), returnCode, debugMsg, params };
}
function readEventData(r, depth, warnings) {
  const evCode = r.byte(); const paramCount = r.count(); const params = readParams(r, paramCount, depth, warnings);
  return { kind: 'EventData', evCode, evName: EVENTS[evCode] || ('event#' + evCode), params };
}
function parseMessage(msgBytes, warnings) {
  if (msgBytes.length < 2) { warnings.push('msg < 2B'); return null; }
  const sign = msgBytes[0]; const type = msgBytes[1];
  const r = new Reader(msgBytes, true, true); r.pos = 2;
  const isEncrypted = (sign & 0x0f) === 0x04 || (sign & 0x0f) === 0x05;
  const MSG_TYPE_NAMES = { 1: 'Session', 2: 'OperationRequest', 3: 'OperationResponse', 4: 'EventData', 5: 'InitMessage', 6: 'InitRequest', 7: 'InitResponse' };
  const typeName = MSG_TYPE_NAMES[type] || ('type#' + type);
  const res = { sign: sign.toString(16).toUpperCase().padStart(2, '0'), type, typeName, encrypted: isEncrypted };
  if (type === 2) { res.req = readOperationRequest(r, 0, warnings); }
  else if (type === 3) { res.resp = readOperationResponse(r, 0, warnings); }
  else if (type === 4) { res.ev = readEventData(r, 0, warnings); }
  else { const rest = Math.min(r.left, 96); res.rawTail = hexStr(msgBytes.slice(2, 2 + rest)); }
  let next = -1;
  for (let i = r.pos; i < msgBytes.length; i++) { if (msgBytes[i] === 0xF3 || msgBytes[i] === 0xF4) { next = i; break; } }
  res.consumed = next >= 0 ? next : msgBytes.length;
  res.warnings = warnings;
  return res;
}
function stripColorTags(str) { return str.replace(/<color[^>]*>/gi, '').replace(/<\/color>/gi, ''); }
function parseKillfeedText(raw) {
  const clean = stripColorTags(raw);
  const out = { raw, text: clean, type: null, killer: null, victim: null };
  if (clean.includes(' killed ')) { const p = clean.split(' killed '); out.type = 'kill'; out.killer = p[0].trim(); out.victim = p[1].trim(); }
  else if (clean.includes(' knocked ')) { const p = clean.split(' knocked '); out.type = 'knock'; out.killer = p[0].trim(); out.victim = p[1].trim(); }
  else if (clean.includes(' Left Match')) { out.type = 'leave'; out.killer = clean.replace(' Left Match', '').trim(); }
  else if (clean.includes(' joined')) { out.type = 'join'; out.killer = clean.replace(' joined', '').trim(); }
  else out.type = 'other';
  return out;
}

// ---------------------------------------------------------------------------
// Pretty-print helpers
// ---------------------------------------------------------------------------
function hexDump(hex, bytesPerLine = 16) {
  const b = hexToBytes(hex);
  let out = '';
  for (let i = 0; i < b.length; i += bytesPerLine) {
    const chunk = b.slice(i, i + bytesPerLine);
    const hx = Array.from(chunk).map(x => (x < 16 ? '0' : '') + x.toString(16)).join(' ');
    const asc = asciiStr(chunk);
    out += `  ${D}${String(i).padStart(4, '0')}${R}  ${COL.hex(hx.padEnd(bytesPerLine * 3 - 1, ' '))}  ${COL.ascii('|'+asc+'|')}\n`;
  }
  return out.replace(/\n$/, '');
}
function unwrapValue(v){
  if (!v || typeof v!=='object') return v;
  if (v.type==='String'||v.type==='Int'||v.type==='Long'||v.type==='Byte'||v.type==='Short'||v.type==='Float'||v.type==='Double'||v.type==='Boolean') return v.value;
  if (v.type==='Hashtable' || v.type.startsWith('Dictionary')) {
    const o={}; for(const[k,val] of Object.entries(v.value||{})) o[k]=unwrapValue(val); return o;
  }
  if (v.type==='ByteArray') {
    // try utf8, else hex
    try{ const s=Buffer.from(v.value.hex,'hex').toString('utf8'); if(/^[\x20-\x7E]+$/.test(s.trim()) && s.length>=2) return s; }catch{}
    return { _bytes: v.value.hex.slice(0,64)+(v.value.hex.length>64?'…':''), ascii:v.value.ascii };
  }
  if (v.type.startsWith('Array')||v.type==='ObjectArray') return (v.value||[]).map(unwrapValue);
  if (v.value===null) return null;
  if (typeof v.value==='object') return v.value;
  return v.value;
}
function prettyValue(v, indent = 2) {
  const pad = ' '.repeat(indent);
  if (!v || typeof v !== 'object') return String(v);
  if (v.type === 'String') return c(186, 230, 253, `"${v.value}"`);
  if (v.type === 'Hashtable' || v.type.startsWith('Dictionary') || v.type === 'Dictionary') {
    const entries = Object.entries(v.value || {});
    if (!entries.length) return D + '{}' + R;
    // human-readable JSON block + still show types dimmed
    let s = '{\n';
    for (const [k, val] of entries) {
      const ks = c(251, 207, 232, k);
      const plain = JSON.stringify(unwrapValue(val));
      const plainCol = c(156,163,175, plain.length>120? plain.slice(0,120)+'…' : plain);
      s += `${pad}  ${ks}: ${prettyValue(val, indent + 2)}  ${D}→ ${plainCol}${R}\n`;
    }
    s += pad + '}';
    return s;
  }
  if (v.type === 'ByteArray') {
    const u=unwrapValue(v);
    if (typeof u==='string') return c(186,230,253, `"${u}"`)+D+` (utf8)`+R;
    return c(110, 231, 183, `ByteArray[${v.value.len}] hex=${v.value.hex.slice(0, 48)}${v.value.hex.length > 48 ? '…' : ''} ascii="${v.value.ascii}"`);
  }
  if (v.type.startsWith('Array') || v.type === 'ObjectArray') {
    const arr = v.value;
    if (!arr || !arr.length) return '[]';
    if (arr.length > 6) return `[${arr.slice(0, 3).map(x => prettyValue(x, indent + 2)).join(', ')}, … +${arr.length - 3} more]`;
    return `[${arr.map(x => prettyValue(x, indent + 2)).join(', ')}]`;
  }
  if (v.value === null || v.value === undefined) return D + 'null' + R;
  if (typeof v.value === 'object') return JSON.stringify(v.value).slice(0, 180);
  return c(253, 224, 71, String(v.value)) + D + ` (${v.type})` + R;
}
function jsonBlock(v){
  try { return JSON.stringify(unwrapValue(v), null, 2); } catch { return String(v); }
}
function summarize(rec, msg) {
  if (!msg) return COL.dim(' (no decode)');
  if (msg.req) return `${TAG.OP} ${COL.op(`${msg.req.opName} (${msg.req.opCode})`)}  params=${msg.req.params.length}`;
  if (msg.resp) return `${TAG.OP} ${COL.op(`${msg.resp.opName} (${msg.resp.opCode})`)}  ret=${msg.resp.returnCode}  params=${msg.resp.params.length}`;
  if (msg.ev) return `${TAG.EVT} ${COL.ev(`${msg.ev.evName} (${msg.ev.evCode})`)}  params=${msg.ev.params.length}`;
  return `${D}${msg.typeName}${R} rawTail=${(msg.rawTail || '').slice(0, 40)}`;
}

// ---------------------------------------------------------------------------
// Decryptor log — one packet
// ---------------------------------------------------------------------------
let totalIn = 0, totalOut = 0, totalDecoded = 0, totalErr = 0;
const seenOps = new Map(), seenEvs = new Map();

function logPacket(rec) {
  const dirTag = rec.dir === 'in' ? TAG.IN : TAG.OUT;
  const lbl = labelForUrl(rec.url || rec.fullUrl);
  const lblTag = tagForLabel(lbl);
  const tStr = ts();
  const seqStr = D + `#${String(rec.seq).padStart(4, '0')}` + R;
  const bytes = rec.rawHex.length / 2;
  const encPreview = rec.rawHex.slice(0, 2).toUpperCase() === 'F4' ? c(248, 113, 113, '🔒 ENC') : c(52, 211, 153, '🔓 CLR');

  const warnings = [];
  let msg = null;
  let err = null;
  try {
    const b = hexToBytes(rec.rawHex);
    msg = parseMessage(b, warnings);
    if (msg) totalDecoded++;
    // drop Init spam even if client still sends it (extra safety)
    if (msg && (msg.typeName === 'InitRequest' || msg.typeName === 'InitResponse')) return;
  } catch (e) { err = e.message; totalErr++; warnings.push(err); }

  const sum = msg ? summarize(rec, msg) : (err ? COL.err(` decode error: ${err}`) : COL.dim(' (empty)'));

  const dirCol = rec.dir === 'in' ? COL.in : COL.out;
  console.log(`${tStr} ${dirTag} ${lblTag} ${seqStr} ${dirCol(rec.dir.toUpperCase().padEnd(4))} ${B}${String(bytes).padStart(4)}B${R}  ${encPreview}  ${sum}  ${D}${rec.url}${R}`);
  if (warnings.length) console.log(`  ${COL.warn('⚠ warnings:')} ${warnings.join('; ')}`);

  if (msg) {
    let plainSummary = null;
    try {
      if (msg.req) plainSummary = { kind: msg.req.opName, params: Object.fromEntries(msg.req.params.map(p=>[p.keyName, unwrapValue(p.value)])) };
      else if (msg.resp) plainSummary = { kind: msg.resp.opName, ret: msg.resp.returnCode, params: Object.fromEntries(msg.resp.params.map(p=>[p.keyName, unwrapValue(p.value)])) };
      else if (msg.ev) plainSummary = { kind: msg.ev.evName, params: Object.fromEntries(msg.ev.params.map(p=>[p.keyName, unwrapValue(p.value)])) };
    } catch {}
    const verbose = process.argv.includes('--verbose');

    if (msg.req) {
      seenOps.set(msg.req.opName, (seenOps.get(msg.req.opName) || 0) + 1);
      if (verbose) {
        for (const p of msg.req.params) {
          const isInteresting = ['RoomName', 'GameProperties', 'PlayerProperties', 'Address', 'Token'].includes(p.keyName);
          const bullet = isInteresting ? c(251, 146, 60, '●') : D + '·' + R;
          console.log(`  ${bullet} ${c(253, 186, 116, p.keyName.padEnd(16))} ${D}(${p.value.type})${R} = ${prettyValue(p.value, 4)}`);
        }
      }
      // human-readable JSON — default view
      if (plainSummary && Object.keys(plainSummary.params).length) {
        const j = JSON.stringify(plainSummary.params, null, 2);
        console.log(`  ${c(251,191,36,'▶ JSON')} ${D}${msg.req.opName}:${R}\n${c(250, 204, 255, j.split('\n').map(l=>'    '+l).join('\n'))}`);
        if (plainSummary.params.GameProperties && plainSummary.params.GameProperties.gm) {
          console.log(`  ${B}${c(251,191,36,'★ gm = "'+plainSummary.params.GameProperties.gm+'"')}${R}`);
        }
      }
    } else if (msg.resp) {
      seenOps.set(msg.resp.opName, (seenOps.get(msg.resp.opName) || 0) + 1);
      if (msg.resp.debugMsg) console.log(`  ${COL.info('debugMsg:')} "${msg.resp.debugMsg}"`);
      if (verbose) {
        for (const p of msg.resp.params) {
          const bullet = p.keyName === 'RoomName' || p.keyName === 'Address' ? c(16, 185, 129, '●') : D + '·' + R;
          console.log(`  ${bullet} ${c(110, 231, 183, p.keyName.padEnd(16))} ${D}(${p.value.type})${R} = ${prettyValue(p.value, 4)}`);
        }
      }
      if (plainSummary && Object.keys(plainSummary.params).length) {
        const j = JSON.stringify(plainSummary.params, null, 2);
        console.log(`  ${c(16,185,129,'▶ JSON')} ${D}${msg.resp.opName} response:${R}\n${c(156,163,175, j.split('\n').map(l=>'    '+l).join('\n'))}`);
      }
    } else if (msg.ev) {
      seenEvs.set(msg.ev.evName, (seenEvs.get(msg.ev.evName) || 0) + 1);
      if (verbose) {
        for (const p of msg.ev.params) {
          console.log(`  ${c(216, 180, 254, p.keyName.padEnd(16))} ${D}(${p.value.type})${R} = ${prettyValue(p.value, 4)}`);
        }
      }
      if (plainSummary && Object.keys(plainSummary.params).length) {
        const j = JSON.stringify(plainSummary.params, null, 2);
        // highlight killfeed / gm
        let extra = '';
        if (plainSummary.params.Data && typeof plainSummary.params.Data === 'string') {
          const kf = parseKillfeedText(plainSummary.params.Data);
          if (kf.type==='kill') extra = c(248,113,113,`  ☠ ${kf.killer} killed ${kf.victim}`);
        }
        if (plainSummary.params.Properties && plainSummary.params.Properties.gm) extra += c(251,191,36,`  ★ gm=${plainSummary.params.Properties.gm}`);
        console.log(`  ${c(244,114,182,'▶ JSON')} ${D}${msg.ev.evName}:${R}\n${c(230, 210, 255, j.split('\n').map(l=>'    '+l).join('\n'))}${extra}`);
      }
    } else {
      console.log(`  ${D}rawTail:${R} ${COL.hex((msg.rawTail || '').slice(0, 80))}`);
    }
  }

  const interesting = msg && ((msg.ev && [101, 253, 255, 254].includes(msg.ev.evCode)) || (msg.req && [225, 226, 227].includes(msg.req.opCode)));
  if (interesting || bytes <= 32) {
    // no hex dump for human-readable mode — show only if --hex flag (keep concise)
    if (process.argv.includes('--hex')) console.log(hexDump(rec.rawHex, 16));
  } else {
    if (process.argv.includes('--hex')) {
      const preview = rec.rawHex.slice(0, 96) + (rec.rawHex.length > 96 ? D + ` … +${rec.rawHex.length - 96} hex chars` + R : '');
      console.log(`  ${D}hex:${R} ${COL.hex(preview)}  ${D}ascii:${R} ${COL.ascii(asciiStr(hexToBytes(rec.rawHex), 64))}`);
    }
  }

  console.log(D + '─'.repeat(88) + R);
}

// ---------------------------------------------------------------------------
// Offline file mode  (node decryptor.js foo.jsonl)
// ---------------------------------------------------------------------------
function runOffline(files, asJson) {
  const allRecs = [];
  for (const f of files) {
    const p = path.resolve(f);
    if (!fs.existsSync(p)) { console.error(`${TAG.ERR} file not found: ${p}`); continue; }
    const txt = fs.readFileSync(p, 'utf8');
    // detect jsonl vs single json
    if (txt.trim().startsWith('{') && txt.trim().includes('"records"')) {
      // batch json {sessionId, records}
      try { const j = JSON.parse(txt); if (j.records) allRecs.push(...j.records); } catch {}
    } else {
      for (const line of txt.split('\n')) {
        if (!line.trim()) continue;
        try { const r = JSON.parse(line); if (r.rawHex) allRecs.push(r); } catch {}
      }
    }
  }
  if (!allRecs.length) { console.error(`${TAG.ERR} no records found in ${files.join(', ')}`); process.exit(1); }

  console.log(`${TAG.SYS} ${B}OFFLINE DECODE${R}  ${allRecs.length} records from ${files.length} file(s)\n`);
  for (const r of allRecs) logPacket(r);

  // summary
  console.log(`\n${B}SUMMARY${R}  total ${allRecs.length}  in ${allRecs.filter(r => r.dir === 'in').length}  out ${allRecs.filter(r => r.dir === 'out').length}  decoded ${totalDecoded}  errors ${totalErr}`);
  if (seenOps.size) { console.log(`\n  ${TAG.OP} Operations:`); for (const [k, v] of [...seenOps].sort((a,b)=>b[1]-a[1])) console.log(`    ${COL.op(k.padEnd(22))} ${v}`); }
  if (seenEvs.size) { console.log(`\n  ${TAG.EVT} Events:`); for (const [k, v] of [...seenEvs].sort((a,b)=>b[1]-a[1])) console.log(`    ${COL.ev(k.padEnd(22))} ${v}`); }

  if (asJson) {
    const out = allRecs.map(r => {
      try { const b = hexToBytes(r.rawHex); const w=[]; const m=parseMessage(b,w); return { ...r, msg:m, warnings:w }; } catch(e){ return {...r, error:e.message} }
    });
    console.log(JSON.stringify(out, null, 2));
  }
}

// ---------------------------------------------------------------------------
// Live server mode
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PHOTON_SNIFFER_PORT || process.env.PORT || 8765);
const CAPTURES_DIR = path.join(__dirname, 'captures');
const MAX_BODY = 1024 * 1024;
const MAX_RECS = 200;
const MAX_HEX = 4096;
const HEX_RE = /^[0-9a-f]+$/;
const SESS_RE = /^[A-Za-z0-9-]{8,64}$/;

function banner() {
  const art = `
  ${c(124,58,237, '  ██████╗ ██╗  ██╗ ██████╗ ████████╗ ██████╗ ███╗   ██╗')}   ${B}PHOTON SNIFFER${R}  ${D}decryptor v1.0.0${R}
  ${c(124,58,237, '  ██╔══██╗██║  ██║██╔═══██╗╚══██╔══╝██╔═══██╗████╗  ██║')}   ${COL.info('listening on')} ${B}http://127.0.0.1:${PORT}${R}  ${D}and${R}  ${B}http://localhost:${PORT}${R}
  ${c(124,58,237, '  ██████╔╝███████║██║   ██║   ██║   ██║   ██║██╔██╗ ██║')}   ${D}transports: POST /capture  +  WS /ws${R}
  ${c(124,58,237, '  ██╔═══╝ ██╔══██║██║   ██║   ██║   ██║   ██║██║╚██╗██║')}   ${COL.dim('zero deps — ANSI colors — GpBinaryV16 decoder — live hexdump')}
  ${c(124,58,237, '  ██║     ██║  ██║╚██████╔╝   ██║   ╚██████╔╝██║ ╚████║')}
  ${c(124,58,237, '  ╚═╝     ╚═╝  ╚═╝ ╚═════╝    ╚═╝    ╚═════╝ ╚═╝  ╚═══╝')}   ${COL.ok('CONNECT userscript →')} ${B}tampermonkey photon-sniffer.user.js${R}
  `;
  console.log(art);
  console.log(`${TAG.SYS} ${COL.info('Photon targets:')}  ${c(96,165,250,'ns.exitgames.com:19093')}  ${c(244,114,182,'gcams*.exitgames.com:1909*')}  ${D}app=${'30773790-f9fe-487c-92c2-19517c5c39ad'.slice(0,8)}…${R}`);
  console.log(`${TAG.SYS} ${COL.info('Tip:')} filter console by ${B}[PHOTON]${R} in DevTools — every packet is %c-colored on the page too`);
  console.log(`${TAG.SYS} ${COL.info('Offline:')} ${D}node decryptor.js captures/foo.jsonl${R}  ${D}|${R}  ${D}node decryptor.js --json foo.jsonl > decoded.json${R}`);
  console.log(D + '─'.repeat(88) + R);
}

function validateBatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Body must be JSON object' };
  if (typeof body.sessionId !== 'string' || !SESS_RE.test(body.sessionId)) return { error: 'sessionId must be 8-64 [A-Za-z0-9-]' };
  if (!Array.isArray(body.records) || !body.records.length || body.records.length > MAX_RECS) return { error: `records must be 1-${MAX_RECS} items` };
  const details = {};
  let lastSeq = -1;
  body.records.forEach((r, i) => {
    const at = `records.${i}`;
    if (!r || typeof r !== 'object') { details[at] = 'must be object'; return; }
    if (!Number.isInteger(r.seq) || r.seq < 0) details[`${at}.seq`] = 'non-negative int';
    else if (r.seq <= lastSeq) details[`${at}.seq`] = 'must be increasing';
    else lastSeq = r.seq;
    if (!Number.isInteger(r.t) || r.t < 0) details[`${at}.t`] = 'epoch ms int';
    if (r.dir !== 'in' && r.dir !== 'out') details[`${at}.dir`] = "must be 'in' or 'out'";
    if (typeof r.url !== 'string' || !r.url.length || r.url.length > 256) details[`${at}.url`] = '1-256 char string';
    if (typeof r.rawHex !== 'string' || !r.rawHex.length || r.rawHex.length > MAX_HEX || !HEX_RE.test(r.rawHex) || r.rawHex.length % 2 !== 0) details[`${at}.rawHex`] = `even lowercase hex 1-${MAX_HEX}`;
  });
  if (Object.keys(details).length) return { error: 'Invalid records', details };
  return { ok: true, sessionId: body.sessionId, records: body.records };
}

// ---------------------------------------------------------------------------
// Rich Presence — derived from essential packets (for Discord)
// ---------------------------------------------------------------------------
const presence = {
  updatedAt: null,
  status: 'idle',
  room: null,
  region: null,
  self: { name: null, actorNr: null, kills: 0, deaths: 0, alive: null, skin: null, pickaxe: null, gameId: null },
  players: [],
  playersCount: 0,
  maxPlayers: 12,
  gameMode: null,
  gameVariant: null, // gv: "duo" → Duo {mode}
  inParty: false,
  scene: { curScn: null, gm: null, gv: null, stG: null },
  lastKillfeed: null,
  lastKnocked: null,
  raw: { lastOp: null, lastEvent: null },
};
let lastPacketAt = Date.now();
// auto-reset to idle when tab closed — no packets for 12s → clear presence (so Discord clears too)
setInterval(()=>{
  if (Date.now() - lastPacketAt > 12000 && presence.status !== 'idle') {
    presence.status = 'idle';
    presence.players = []; presence.playersCount = 0;
    presence.gameMode = null; presence.gameVariant = null; presence.scene.curScn = null;
    presence.updatedAt = new Date().toISOString();
  }
}, 5000);
const BOT_API = process.env.BOT_API || 'http://127.0.0.1:8766';
let sessionToken = null;
let playStart = null; // {gm, t}
function botPost(path, body){
  if (!sessionToken) return;
  try {
    const data = JSON.stringify(body);
    const u = new URL(BOT_API + path);
    const opts = { method:'POST', hostname:u.hostname, port:u.port, path:u.pathname, headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)} };
    const req = http.request(opts, res=>{ res.on('data',()=>{}); });
    req.on('error',()=>{});
    req.write(data); req.end();
  } catch {}
}

function updatePresenceFromPacket(rec, msg) {
  try {
    lastPacketAt = Date.now();
    presence.updatedAt = new Date().toISOString();
    if (msg && msg.req) {
      presence.raw.lastOp = `${msg.req.opName}(${msg.req.opCode})`;
      const rn = msg.req.params.find(p => p.keyName === 'RoomName');
      if (rn && rn.value && rn.value.value) presence.room = rn.value.value;
      // GameProperties.gm + maxPlayers (255)
      const gp = msg.req.params.find(p => p.keyName === 'GameProperties');
      if (gp && gp.value && gp.value.value) {
        const gm = gp.value.value.gm; if (gm && gm.value) { presence.gameMode = gm.value; presence.scene.gm = gm.value; }
        const gv = gp.value.value.gv; if (gv && gv.value) { presence.gameVariant = gv.value; presence.scene.gv = gv.value; }
        const party = gp.value.value.Party; if (party && party.value != null) presence.inParty = !!party.value;
        const maxP = gp.value.value['255']; if (maxP && maxP.value != null) presence.maxPlayers = Number(maxP.value) || 12;
        // mode picked → count as 1/Max even before Join event
        if (presence.gameMode && presence.playersCount === 0) { presence.playersCount = 1; if(!presence.players.length) presence.players.push({actorNr:1, name: presence.self.name||'You', kills:0, deaths:0, alive:true}); }
      }
      const pProps = msg.req.params.find(p => p.keyName === 'PlayerProperties');
      if (pProps && pProps.value && pProps.value.value) {
        const pp = pProps.value.value;
        if (pp['255'] && pp['255'].value) presence.self.name = pp['255'].value || presence.self.name;
        if (pp['skid'] && pp['skid'].value) presence.self.skin = pp['skid'].value;
        if (pp['pid'] && pp['pid'].value) presence.self.pickaxe = pp['pid'].value;
        if (pp['pfid'] && pp['pfid'].value) presence.self.gameId = pp['pfid'].value;
        if (sessionToken && (pp['255']||pp['skid']||pp['pid']||pp['pfid'])) {
          botPost('/api/player-sync', { token: sessionToken, game_username: pp['255']?.value||undefined, skin: pp['skid']?.value||undefined, pickaxe: pp['pid']?.value||undefined, game_id: pp['pfid']?.value||undefined });
        }
      }
      if (msg.req.opName === 'CreateRoom' || msg.req.opName === 'JoinRoom' || msg.req.opName === 'JoinRandomRoom') {
        presence.status = 'loading';
        if (!playStart) playStart = { gm: presence.gameMode||'unknown', t: Date.now() };
      }
      if (msg.req.opName === 'JoinLobby' || msg.req.opName === 'JoinRandomRoom') presence.status = 'in_lobby';
    }
    if (msg && msg.resp) {
      presence.raw.lastOp = `${msg.resp.opName} resp ${msg.resp.returnCode}`;
      const addr = msg.resp.params.find(p => p.keyName === 'Address');
      if (addr && addr.value.value) presence.region = addr.value.value;
      if (msg.resp.debugMsg && /Room/.test(msg.resp.debugMsg)) presence.room = presence.room || msg.resp.debugMsg;
    }
    if (msg && msg.ev) {
      presence.raw.lastEvent = `${msg.ev.evName}(${msg.ev.evCode})`;
      if (msg.ev.evCode === 255) { // Join — player joined
        presence.status = 'in_game';
        let actorNr = null, name = null;
        for (const p of msg.ev.params) {
          if (p.keyName === 'ActorNr' && p.value.value != null) actorNr = p.value.value;
          if (p.keyName === 'Properties' && p.value.value) {
            for (const [k,v] of Object.entries(p.value.value)) if (k==='255' && v.value) name=v.value;
          }
        }
        if (actorNr==null) actorNr = presence.players.length+1;
        if (!presence.players.find(pl=>pl.actorNr===actorNr)) {
          presence.players.push({ actorNr, name: name||`Player ${actorNr}`, kills:0, deaths:0, alive:true });
        }
        presence.playersCount = presence.players.length;
        if (actorNr && !presence.self.actorNr) presence.self.actorNr = actorNr;
        if (name && !presence.self.name) presence.self.name = name;
      }
      if (msg.ev.evCode === 254) { // Leave
        let actorNr=null;
        for (const p of msg.ev.params) if (p.keyName==='ActorNr' && p.value.value!=null) actorNr=p.value.value;
        if (actorNr!=null) presence.players = presence.players.filter(pl=>pl.actorNr!==actorNr);
        presence.playersCount = presence.players.length;
        if (presence.playersCount===0) presence.status='in_lobby';
      }
      if (msg.ev.evCode === 253) {
        for (const p of msg.ev.params) {
          if (p.keyName === 'Properties' && p.value.value) {
            for (const [k,v] of Object.entries(p.value.value)) {
              if (k === 'curScn' && v.value) {
                const prev = presence.status;
                presence.scene.curScn = v.value;
                const low = String(v.value).toLowerCase();
                if (low.includes('lobby')) presence.status='in_lobby';
                else if (low.includes('game') || low.includes('zonewars') || low.includes('zw_lg') || low.includes('boxfights')) presence.status='in_game';
                if (!presence.gameMode && /bf2v2|boxfights.*2v2/i.test(v.value)) presence.gameMode='BF2V2';
                else if (!presence.gameMode && /boxfights/i.test(v.value)) presence.gameMode='BF';
                else if (!presence.gameMode && /zw_lg|lategame/i.test(v.value)) presence.gameMode='zw_lg';
                else if (!presence.gameMode && /zonewars/i.test(v.value)) presence.gameMode='zw';
                // lobby → 0/0, but if mode already picked keep 1/max
                if (presence.status==='in_lobby') {
                  if (presence.gameMode) { presence.playersCount = 1; if(!presence.players.length) presence.players=[{actorNr:1,name:presence.self.name||'You',kills:0,deaths:0,alive:true}]; }
                  else { presence.playersCount = 0; presence.players = []; }
                }
                // playtime: leaving game
                if (prev==='in_game' && presence.status==='in_lobby' && playStart) {
                  const secs = Math.floor((Date.now()-playStart.t)/1000);
                  if (secs>5) botPost('/api/playtime', { token: sessionToken, gm: playStart.gm, seconds: secs });
                  // win if still alive at exit
                  if (presence.self.alive) botPost('/api/event', { token: sessionToken, type:'win', gm: playStart.gm });
                  else botPost('/api/event', { token: sessionToken, type:'defeat', gm: playStart.gm });
                  playStart=null;
                } else if (prev!=='in_game' && presence.status==='in_game' && !playStart) {
                  playStart={ gm: presence.gameMode||'unknown', t:Date.now() };
                }
              }
              if (k === 'gm' && v.value!=null) { presence.scene.gm = v.value; presence.gameMode = v.value; }
              if (k === 'gv' && v.value!=null) { presence.scene.gv = v.value; presence.gameVariant = v.value; }
              if (k === 'Party' && v.value!=null) presence.inParty = !!v.value;
              if (k === 'stG' && v.value!=null) presence.scene.stG = v.value;
              if (k === 'dh' && v.value!=null) {
                const nd = Number(v.value)||0;
                if (nd > (presence.self.deaths||0) && sessionToken) botPost('/api/event', { token: sessionToken, type:'death', gm: presence.gameMode||'unknown' });
                presence.self.deaths = nd;
              }
              if (k === 'alv' && v.value!=null) presence.self.alive = !!v.value;
            }
          }
          if (p.keyName === 'ActorNr' && p.value.value!=null) {
            const pl = presence.players.find(x=>x.actorNr===p.value.value);
            if (pl && p.value.value!=null) {
              // update that player's props in next packet's Properties, here just ensure exists
            }
          }
        }
      }
      for (const p of msg.ev.params) {
        if (p.keyName === 'Data' && p.value && p.value.type === 'String' && typeof p.value.value === 'string') {
          const kf = parseKillfeedText(p.value.value);
          if (kf.type === 'knock') {
            presence.lastKnocked = kf;
            presence.lastKillfeed = kf;
            if (sessionToken) botPost('/api/event', { token: sessionToken, type:'knock', gm: presence.gameMode||'unknown' });
          } else if (kf.type === 'kill') {
            presence.lastKillfeed = kf;
            if (kf.killer && presence.self.name && kf.killer === presence.self.name) {
              presence.self.kills++;
              if (sessionToken) botPost('/api/event', { token: sessionToken, type:'kill', gm: presence.gameMode||'unknown' });
            }
          } else if (kf.type !== 'other') {
            presence.lastKillfeed = kf;
          }
        }
      }
      // also catch Data containing Hashtable with kill info
      if (msg.ev.evCode === 101 || msg.ev.evCode === 200) {
        // generic — presence updated
      }
    }
  } catch {}
}

function handleBatch(parsed, sock) {
  if (!parsed) {
    const msg = 'Invalid JSON';
    if (sock) try { sock.write(wsFrame(0x1, JSON.stringify({ error: msg }))); } catch {}
    return { status: 400, body: { error: { code: 'VALIDATION_ERROR', message: msg } } };
  }
  // token per session (from userscript)
  if (parsed.token && typeof parsed.token === 'string') sessionToken = parsed.token;
  else if (parsed.sessionId) { /* keep previous */ }
  const v = validateBatch(parsed);
  if (!v.ok) {
    if (sock) try { sock.write(wsFrame(0x1, JSON.stringify({ error: v.error, details: v.details })) ); } catch {}
    return { status: 400, body: { error: { code: 'VALIDATION_ERROR', message: v.error, details: v.details } } };
  }
  const isTest = v.records.some(r => String(r.url).includes('self-test'));
  if (isTest) console.log(`\n${TAG.OK} ${COL.ok('SELF-TEST')} ${D}received ${v.records.length} test frame(s) — transport OK!${R}\n`);
  for (const r of v.records) {
    if (r.dir === 'in') totalIn++; else totalOut++;
    // full decode + presence update (lightweight)
    const warnings = [];
    let msg = null;
    try { msg = parseMessage(hexToBytes(r.rawHex), warnings); } catch {}
    if (msg) updatePresenceFromPacket(r, msg);
    logPacket(r);
    // attach decoded essential summary to record for file
    r._decoded = msg ? { typeName: msg.typeName, req: msg.req ? { opName: msg.req.opName, opCode: msg.req.opCode } : undefined, ev: msg.ev ? { evName: msg.ev.evName, evCode: msg.ev.evCode } : undefined } : null;
  }
  try {
    fs.mkdirSync(CAPTURES_DIR, { recursive: true });
    const fp = path.join(CAPTURES_DIR, `${v.sessionId}.jsonl`);
    const lines = v.records.map(r => JSON.stringify(r)).join('\n') + '\n';
    fs.appendFileSync(fp, lines);
  } catch {}
  return { status: 204, body: null };
}

// ---- WS framing (minimal RFC6455) ----
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function wsFrame(opcode, payload) {
  if (!Buffer.isBuffer(payload)) payload = Buffer.from(String(payload), 'utf8');
  const len = payload.length; let h;
  if (len < 126) h = Buffer.from([0x80 | opcode, len]);
  else if (len < 65536) { h = Buffer.alloc(4); h[0]=0x80|opcode; h[1]=126; h.writeUInt16BE(len,2); }
  else { h = Buffer.alloc(10); h[0]=0x80|opcode; h[1]=127; h.writeBigUInt64BE(BigInt(len),2); }
  return Buffer.concat([h, payload]);
}
function parseWsFrame(buf) {
  if (buf.length < 2) return null;
  const b0=buf[0], b1=buf[1], op=b0&0x0F, masked=(b1&0x80)!==0;
  let len=b1&0x7F, i=2;
  if (len===126){ if(buf.length<i+2) return null; len=buf.readUInt16BE(i); i+=2; }
  else if(len===127){ if(buf.length<i+8) return null; len=Number(buf.readBigUInt64BE(i)); i+=8; }
  const maskStart=i; if(masked) i+=4;
  if(buf.length<i+len) return null;
  let payload=buf.slice(i,i+len);
  if(masked){ const key=buf.slice(maskStart,maskStart+4); const out=Buffer.alloc(len); for(let j=0;j<len;j++) out[j]=payload[j]^key[j%4]; payload=out; }
  i+=len;
  return { consumed:i, type: op===0x8?'close':op===0x9?'ping':op===0xA?'pong':'data', data:payload };
}

function cors(res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  res.setHeader('Access-Control-Allow-Private-Network','true');
}
function sendJson(res,status,body){
  res.writeHead(status,{'Content-Type':'application/json'});
  res.end(JSON.stringify(body));
}
function readBody(req, cb){
  let body='', bytes=0, too=false;
  req.on('data', ch=>{ bytes+=Buffer.byteLength(ch); if(bytes<=MAX_BODY) body+=ch; else too=true; });
  req.on('end', ()=> cb(too?null:body, too));
}
function tryJson(s){ try{ return JSON.parse(s); }catch{ return null; } }

const server = http.createServer((req,res)=>{
  cors(res);
  if ((req.headers.upgrade||'').toLowerCase()==='websocket'){ handleWsUpgrade(req,res); return; }
  if (req.method==='OPTIONS'){ res.writeHead(204); res.end(); return; }
  if (req.method==='GET' && (req.url==='/' || req.url==='/status')){
    sendJson(res,200,{ ok:true, service:'photon-sniffer decryptor', port:PORT, uptime:process.uptime(), totalIn, totalOut, totalDecoded, totalErr, seenOps:Object.fromEntries(seenOps), seenEvs:Object.fromEntries(seenEvs), presence });
    return;
  }
  if (req.method==='GET' && req.url==='/presence'){
    sendJson(res,200,{ ok:true, presence, stats:{ totalIn, totalOut, totalDecoded, seenOps:Object.fromEntries(seenOps), seenEvs:Object.fromEntries(seenEvs) } });
    return;
  }
  if ((req.method==='POST' || req.method==='GET') && req.url==='/clear'){
    presence.status='idle'; presence.players=[]; presence.playersCount=0; presence.gameMode=null; presence.scene.curScn=null; presence.updatedAt=new Date().toISOString();
    lastPacketAt = 0;
    sendJson(res,200,{ ok:true, cleared:true });
    return;
  }
  if (req.method==='GET' && req.url==='/presence/sse'){
    // Server-Sent Events for live Rich Presence
    res.writeHead(200,{ 'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive','Access-Control-Allow-Origin':'*' });
    res.write(`data: ${JSON.stringify(presence)}\n\n`);
    const iv = setInterval(()=>{ try{ res.write(`data: ${JSON.stringify(presence)}\n\n`); }catch{} }, 1500);
    req.on('close', ()=> clearInterval(iv));
    return;
  }
  if (req.method==='POST' && (req.url==='/capture' || req.url==='/debug/capture')){
    readBody(req,(body,too)=>{
      if(too){ sendJson(res,413,{error:{code:'PAYLOAD_TOO_LARGE',message:`Body > ${MAX_BODY}B`}}); return; }
      const r = handleBatch(tryJson(body), null);
      if(r.status===204){ res.writeHead(204); res.end(); }
      else sendJson(res,r.status,r.body);
    });
    return;
  }
  sendJson(res,404,{error:{code:'NOT_FOUND',message:'POST /capture  or  WS /ws  or  GET /status'}});
});

function handleWsUpgrade(req,res){
  const key=req.headers['sec-websocket-key'];
  if(!key){ sendJson(res,400,{error:{code:'VALIDATION_ERROR',message:'Missing Sec-WebSocket-Key'}}); return; }
  const accept=crypto.createHash('sha1').update(key+WS_GUID).digest('base64');
  const origin = req.headers.origin || '-';
  const host = req.headers.host || '-';
  res.writeHead(101,{ 'Upgrade':'websocket','Connection':'Upgrade','Sec-WebSocket-Accept':accept, 'Access-Control-Allow-Private-Network':'true', 'Access-Control-Allow-Origin':'*' });
  res.end();
  const sock=req.socket;
  try { sock.setKeepAlive(true, 30000); sock.setNoDelay(true); sock.setTimeout(0); } catch {}
  console.log(`\n${TAG.OK} ${COL.ok('WS CONNECT')} ${D}${req.url}${R}  from ${sock.remoteAddress}:${sock.remotePort}  origin=${origin} host=${host}  — streaming (PNA header sent)…\n`);
  let acc=Buffer.alloc(0);
  sock.on('data', ch=>{
    acc=Buffer.concat([acc,ch]);
    while(acc.length){
      const fr=parseWsFrame(acc);
      if(!fr) break;
      acc=acc.slice(fr.consumed);
      if(fr.type==='close'){ try{sock.write(wsFrame(0x8,Buffer.alloc(0)));}catch{} sock.destroy(); console.log(`${TAG.SYS} WS client close frame`); return; }
      if(fr.type==='ping'){ try{sock.write(wsFrame(0xA,fr.data));}catch{} continue; }
      try {
        const r = handleBatch(tryJson(fr.data.toString('utf8')), sock);
        // 204 = no echo; errors already sent via sock
        if(r.status!==204 && r.body){ /* already handled */ }
      } catch(e){ console.log(`${TAG.ERR} WS handle error ${e.message}`); }
    }
  });
  sock.on('error',(e)=>{ console.log(`${TAG.ERR} WS socket error ${e.message}  from ${sock.remoteAddress}:${sock.remotePort}`); });
  sock.on('close',(hadErr)=>{ console.log(`${D}WS socket closed  hadError=${hadErr}  ${sock.remoteAddress}:${sock.remotePort}${R}`); });
}

server.on('error', err=>{
  if(err.code==='EADDRINUSE'){ console.error(`${TAG.ERR} port ${PORT} in use — stop other decryptor or:  PHOTON_SNIFFER_PORT=8766 node decryptor.js`); }
  else console.error(`${TAG.ERR} server error: ${err.message}`);
  process.exitCode=1;
});

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const jsonFlag = args.includes('--json');
const files = args.filter(a=>!a.startsWith('--') && (a.endsWith('.jsonl') || a.endsWith('.json')));

if (files.length){
  runOffline(files, jsonFlag);
  process.exit(0);
}

banner();
server.keepAliveTimeout = 30000;
server.headersTimeout = 31000;
server.listen(PORT, '127.0.0.1', ()=>{
  console.log(`${TAG.OK} ${COL.ok('READY')}  http://127.0.0.1:${PORT}/capture  (POST)   ws://127.0.0.1:${PORT}/ws  (WS)   http://localhost:${PORT}/status`);
  console.log(`${TAG.SYS} captures also appended to ${path.relative(process.cwd(), CAPTURES_DIR)}/<sessionId>.jsonl`);
  console.log(`${TAG.SYS} ${COL.info('WS PNA:')} server sends ${B}Access-Control-Allow-Private-Network: true${R} — if browser blocks ws:// from https, GM_xhr fallback will still deliver`);
  console.log(`${D}waiting for Tampermonkey frames…  open the game and watch packets fly ✈  (test: __PHOTON_SNIFFER__.test() or curl POST)${R}\n`);
});
process.on('SIGINT', ()=>{ console.log(`\n${TAG.SYS} shutting down — in ${totalIn} out ${totalOut} decoded ${totalDecoded} err ${totalErr}`); server.close(()=>process.exit(0)); setTimeout(()=>process.exit(0),1500).unref(); });
process.on('SIGTERM', ()=>{ server.close(()=>process.exit(0)); setTimeout(()=>process.exit(0),1500).unref(); });
