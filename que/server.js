'use strict';
/**
 * quehong local server - runs on the branch mini-PC (same box as the ESB
 * bridge agent). Serves, over the LAN:
 *   /register   the registration tablet (name | WhatsApp | pax -> prints ticket)
 *   /display    TV screens: ?view=queue (Showing Queue) | ?view=seat (Showing
 *               Seat: floor plan, blinking table, voice call) | ?view=auto
 *   /scan       the USB QR-scanner station (scanner types the code + Enter)
 *   /admin      staff kanban: waiting / called / pending / seated + table grid
 *
 * Talks to:
 *   - the TM-T82X printer (que/printer.js, QUE_PRINT target)
 *   - the Baileys worker over localhost (/api/que/wa/*)
 *   - the ESB bridge agent, which pushes busy tables (/api/que/esb-occupancy)
 *   - the public VPS mirror quehong (QUE_PUB_URL + QUE_TOKEN): queue snapshots
 *     for the customers' landing pages, pushed outbound-only.
 *
 * Env: QUE_PORT (3200), HOST (bind 0.0.0.0 on the mini-PC so tablets/TVs
 * reach it), QUE_PIN (admin PIN), QUE_PRINT, QUE_PUB_URL, QUE_TOKEN,
 * QUE_WA_NUMBER (the bot's number for the wa.me QR), QUE_VOICE (id|id+en).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { send, readBody } = require('../server/http-util');
const { QueStore, fmtNumber } = require('./store');
const printer = require('./printer');

const PORT = Number(process.env.QUE_PORT || 3200);
const HOST = process.env.HOST || '127.0.0.1';
const PIN = process.env.QUE_PIN || '0000';
const PRINT = process.env.QUE_PRINT || '';
const PUB_URL = (process.env.QUE_PUB_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.QUE_TOKEN || '';
const WA_NUMBER = (process.env.QUE_WA_NUMBER || '').replace(/[^\d]/g, '');
const VOICE = process.env.QUE_VOICE || 'id';
const PUBLIC_DIR = path.join(__dirname, 'public');

// Natural neural voices (QUE_TTS=edge): the server renders each call line to
// mp3 via `python -m edge_tts` (pip install edge-tts), cached per utterance in
// data/voice/. The displays fall back to the browser voice when this is off,
// fails, or the internet is down.
const TTS = (process.env.QUE_TTS || 'browser').toLowerCase();
const TTS_VOICES = {
  id: process.env.QUE_TTS_VOICE_ID || 'id-ID-GadisNeural',   // woman, Bahasa
  en: process.env.QUE_TTS_VOICE_EN || 'en-US-JennyNeural',   // woman, English
};
const PYTHON = process.env.QUE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const VOICE_DIR = path.join(__dirname, 'data', 'voice');

const ttsInflight = new Map(); // file -> Promise, so concurrent displays share one render

function ttsGenerate(text, lang) {
  const voice = TTS_VOICES[lang] || TTS_VOICES.id;
  const file = path.join(VOICE_DIR, crypto.createHash('sha1').update(voice + '|' + text).digest('hex') + '.mp3');
  if (fs.existsSync(file)) return Promise.resolve(file);
  if (ttsInflight.has(file)) return ttsInflight.get(file);
  fs.mkdirSync(VOICE_DIR, { recursive: true });
  const job = new Promise((resolve, reject) => {
    // Unique temp name: two renders of the same text must never share a file
    // (Windows holds locks and renameSync EBUSY would otherwise crash us).
    const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(3).toString('hex') + '.part';
    const p = spawn(PYTHON, ['-m', 'edge_tts', '--voice', voice, '--text', text, '--write-media', tmp]);
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => {
      try {
        if (code === 0 && fs.existsSync(tmp) && fs.statSync(tmp).size > 0) {
          if (!fs.existsSync(file)) fs.renameSync(tmp, file);
          else fs.rmSync(tmp, { force: true }); // another render won the race
          resolve(file);
        } else {
          fs.rmSync(tmp, { force: true });
          reject(new Error('edge-tts exit ' + code + ': ' + err.slice(-180)));
        }
      } catch (e) {
        // EBUSY and friends: never let a file lock kill the server. If the
        // final file exists (whoever holds the lock produced it), use it.
        fs.rm(tmp, { force: true }, () => {});
        if (fs.existsSync(file)) resolve(file); else reject(e);
      }
    });
  });
  ttsInflight.set(file, job);
  job.finally(() => ttsInflight.delete(file)).catch(() => {});
  return job;
}

if (PIN === '0000') console.error('[que] WARNING: QUE_PIN is the default 0000 - set a real admin PIN');

const minutes = (v, dflt) => Math.max(1, Number(v) || dflt) * 60 * 1000;
const store = new QueStore({
  noShowMs: minutes(process.env.QUE_NO_SHOW_MINUTES, 5),          // called -> Missed
  pendingExpireMs: minutes(process.env.QUE_PENDING_EXPIRE_MINUTES, 60), // Missed -> gone
  seatedTimeoutMs: minutes(process.env.QUE_SEAT_HOLD_MINUTES, 45), // table hold w/o ESB
});
const clients = new Set(); // SSE

store.listen(ev => {
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) res.write(line);
  pushMirrorSoon();
});

// ---- VPS mirror push (outbound only; queue keeps working offline) ----
let mirrorTimer = null, mirrorFailLogged = false;
function pushMirrorSoon() {
  if (!PUB_URL || mirrorTimer) return;
  mirrorTimer = setTimeout(pushMirror, 800);
}
async function pushMirror() {
  mirrorTimer = null;
  if (!PUB_URL) return;
  try {
    const r = await fetch(PUB_URL + '/api/mirror', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
      body: JSON.stringify(store.mirror()),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    if (mirrorFailLogged) { console.log('[que] mirror push recovered'); mirrorFailLogged = false; }
  } catch (e) {
    if (!mirrorFailLogged) { console.error('[que] mirror push failing (will keep retrying):', e.message); mirrorFailLogged = true; }
  }
}

function landingUrl(t) {
  return (PUB_URL || `http://localhost:${PORT}`) + '/q/' + t.token;
}

async function printTicket(t) {
  const waText = encodeURIComponent(t.code);
  const buf = printer.buildTicket({
    store: store.storeName, disp: fmtNumber(t.number), pax: t.pax, name: t.name,
    queueUrl: landingUrl(t),
    waUrl: WA_NUMBER ? `https://wa.me/${WA_NUMBER}?text=${waText}` : `WA:${t.code}`,
    split: t.split,
  });
  await printer.printRaw(buf, PRINT);
}

function pinOk(req, url) {
  const got = req.headers['x-que-pin'] || url.searchParams.get('pin') || '';
  return got === PIN;
}
function isLoopback(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

async function handleApi(req, res, url) {
  const route = url.pathname.replace(/^\/api\/que\//, '');

  // ---- tablet ----
  if (req.method === 'POST' && route === 'register') {
    const body = await readBody(req);
    const t = store.register(body);
    let printed = true;
    try { await printTicket(t); } catch (e) { printed = false; console.error('[que] print failed:', e.message); }
    store.tick();
    return send(res, 200, {
      status: true, data: {
        number: t.number, disp: fmtNumber(t.number), code: t.code, split: t.split,
        position: Math.max(0, store.state.main.indexOf(t.token)), printed,
        landing_url: landingUrl(t),
      },
    });
  }

  // ---- scanner station ----
  if (req.method === 'POST' && route === 'scan') {
    const body = await readBody(req);
    return send(res, 200, store.scan(body.data));
  }

  // ---- displays / admin reads ----
  if (req.method === 'GET' && route === 'overview') return send(res, 200, store.overview());
  if (req.method === 'GET' && route === 'config') {
    const inv = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'tables.json'), 'utf8'));
    return send(res, 200, { store: store.storeName, voice: VOICE, tts: TTS, view: inv.view, tables: inv.tables });
  }
  if (req.method === 'GET' && route === 'voice') {
    if (TTS !== 'edge') return send(res, 404, { ok: false, msg: 'tts off' });
    const text = (url.searchParams.get('text') || '').trim().slice(0, 200);
    const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'id';
    if (!text) return send(res, 400, { ok: false, msg: 'no text' });
    try {
      const data = fs.readFileSync(await ttsGenerate(text, lang));
      res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'max-age=86400' });
      return res.end(data);
    } catch (e) {
      console.error('[que] tts failed (display falls back to browser voice):', e.message);
      return send(res, 503, { ok: false, msg: e.message });
    }
  }
  if (req.method === 'GET' && route === 'events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  // ---- admin (PIN) ----
  if (req.method === 'POST' && route === 'admin') {
    if (!pinOk(req, url)) return send(res, 401, { ok: false, msg: 'bad pin' });
    const body = await readBody(req);
    if (body.op === 'reprint') {
      const t = store.ticket(body.arg);
      if (!t) return send(res, 404, { ok: false });
      try { await printTicket(t); return send(res, 200, { ok: true }); }
      catch (e) { return send(res, 500, { ok: false, msg: e.message }); }
    }
    return send(res, 200, store.admin(body.op, body.arg));
  }

  // ---- local peers: agent occupancy + WA worker (loopback or PIN) ----
  if (!isLoopback(req) && !pinOk(req, url)) return send(res, 401, { ok: false, msg: 'loopback or pin required' });
  if (req.method === 'POST' && route === 'esb-occupancy') {
    const body = await readBody(req);
    store.esbOccupancy(body.busy || []);
    return send(res, 200, { ok: true });
  }
  if (req.method === 'POST' && route === 'wa/inbound') {
    const body = await readBody(req);
    return send(res, 200, store.waInbound(body));
  }
  if (req.method === 'GET' && route === 'wa/outbox') return send(res, 200, { messages: store.pullOutbox() });
  if (req.method === 'POST' && route === 'wa/ack') {
    const body = await readBody(req);
    store.ackOutbox(body.ids);
    return send(res, 200, { ok: true });
  }

  return send(res, 404, { ok: false, msg: 'not_found' });
}

const PAGES = { '/': 'index.html', '/register': 'register.html', '/display': 'display.html', '/scan': 'scan.html', '/admin': 'admin.html' };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml' };

function serveStatic(req, res, url) {
  // Local fallback for the landing page when no VPS is configured (dev).
  const q = url.pathname.match(/^\/q\/([0-9a-f]{20})$/);
  if (q) {
    const t = store.ticket(q[1]);
    const m = store.mirror().tickets.find(x => x.token === q[1]);
    return send(res, 200, t ? { status: true, data: m || { revoked: true } } : { status: false });
  }
  const rel = PAGES[url.pathname] || url.pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'forbidden', 'text/plain');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/que/')) return await handleApi(req, res, url);
    if (req.method === 'GET') return serveStatic(req, res, url);
    return send(res, 405, 'method not allowed', 'text/plain');
  } catch (e) {
    return send(res, 500, { ok: false, msg: e.message });
  }
});

function start(port = PORT) {
  setInterval(() => store.tick(), 3000).unref();
  setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25000).unref();
  if (PUB_URL) setInterval(pushMirror, 30000).unref();
  return new Promise(resolve => {
    server.listen(port, HOST, () => {
      console.log(`quehong local on http://${HOST}:${server.address().port} (print=${PRINT || 'file (dev)'}, pub=${PUB_URL || 'none'}, wa=${WA_NUMBER || 'unset'})`);
      resolve(server);
    });
  });
}

if (require.main === module) start();
module.exports = { start, server, store };
