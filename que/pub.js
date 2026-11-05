'use strict';
/**
 * quehong public mirror - the only internet-facing piece of the queue system.
 * Runs on the VPS (quehong.berkatselalu.com). Zero dependencies.
 *
 * The branch mini-PC pushes queue snapshots here (outbound HTTPS, Bearer
 * QUE_TOKEN); customers' phones read their ticket's live position from the
 * "QR Queue" landing page. When the mini-PC flags a ticket seated/finished
 * the token is revoked and the page stops showing the queue.
 *
 * Env: QUE_PUB_PORT (3200), HOST (127.0.0.1 behind nginx), QUE_TOKEN (required).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { send, readBody, bearerOk, requireEnv } = require('../server/http-util');

requireEnv(['QUE_TOKEN'], 'quehong-pub');

const PORT = Number(process.env.QUE_PUB_PORT || 3200);
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.QUE_TOKEN;
const STATE_FILE = process.env.QUE_PUB_STATE || path.join(__dirname, 'data', 'pub_mirror.json');

let mirror = { store: 'Edo Sushi', day: '', last_called: null, tickets: [], received_at: 0 };
try { mirror = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { /* fresh start */ }

function saveMirror() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(mirror));
  } catch (e) { console.error('[que-pub] persist failed:', e.message); }
}

const PAGE = (body, dead) => `<!doctype html>
<html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Antrian - Edo Sushi</title>
<style>
:root { --surface:#ebebea; --ink:#1a1a1a; --muted:#6b6b6b; --accent:#b3201f; }
* { box-sizing:border-box; margin:0; font-family:system-ui,sans-serif; }
body { background:var(--surface); color:var(--ink); min-height:100vh; display:grid; place-items:center; padding:20px; }
.card { background:#fff; border:1px solid #ddd; width:min(420px,100%); padding:36px 28px; text-align:center; }
h1 { font-size:18px; font-weight:800; }
.sub { color:var(--muted); font-size:13px; margin-bottom:22px; }
.num { font-size:72px; font-weight:800; color:var(--accent); line-height:1.1; }
.ahead { font-size:40px; font-weight:800; margin:6px 0 2px; }
.lbl { color:var(--muted); font-size:13px; text-transform:uppercase; letter-spacing:.06em; margin-top:18px; }
.state { font-size:17px; line-height:1.5; margin-top:14px; }
.done { color:var(--muted); }
</style></head><body><div class="card">${body}</div>
${dead ? '' : '<script>setTimeout(() => location.reload(), 7000)</script>'}</body></html>`;

function ticketPage(t) {
  if (!t) return PAGE('<h1>Edo Sushi</h1><div class="sub">Antrian / queue</div><div class="state done">' +
    'Tautan antrian tidak dikenal atau sudah berakhir.<br>This queue link is unknown or has expired.</div>', true);
  const head = `<h1>Edo Sushi</h1><div class="sub">Antrian Anda / your queue</div><div class="num">${t.disp}</div>`;
  if (t.revoked || ['seated', 'finished', 'cancelled'].includes(t.state)) {
    return PAGE(head + '<div class="state done">Antrian selesai, selamat menikmati!<br>Queue finished. Enjoy your meal.</div>', true);
  }
  if (t.state === 'called') {
    return PAGE(head + `<div class="state"><b>GILIRAN ANDA!</b> Silakan ke pintu masuk dan pindai QR struk Anda.<br>It's your turn! Go to the entrance and scan your ticket QR.</div>`);
  }
  if (t.state === 'pending') {
    return PAGE(head + `<div class="state">Nomor Anda sempat terlewat. Saat tiba di restoran, langsung pindai QR struk Anda di pintu masuk. Anda masuk kembali dekat urutan depan.<br>Your number was missed. Scan your ticket QR at the entrance when you arrive and you re-enter near the front.</div>`);
  }
  return PAGE(head +
    `<div class="lbl">Antrian di depan Anda / groups ahead</div><div class="ahead">${t.ahead}</div>` +
    `<div class="lbl">Terakhir dipanggil / now serving</div><div class="state">Q${String(mirror.last_called || 0).padStart(3, '0')}</div>` +
    `<div class="state">Kami akan memanggil via WhatsApp saat giliran Anda dekat.<br>We will message you on WhatsApp when your turn is near.</div>`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'POST' && url.pathname === '/api/mirror') {
      if (!bearerOk(req, TOKEN)) return send(res, 401, { status: false, msg: 'unauthorized' });
      const body = await readBody(req);
      mirror = { ...body, received_at: Date.now() };
      saveMirror();
      return send(res, 200, { status: true });
    }
    if (req.method === 'GET' && url.pathname === '/healthz') {
      return send(res, 200, { status: true, tickets: mirror.tickets.length, age_s: mirror.received_at ? Math.round((Date.now() - mirror.received_at) / 1000) : null });
    }
    const m = url.pathname.match(/^\/(?:api\/)?q\/([0-9a-f]{20})$/);
    if (req.method === 'GET' && m) {
      const t = mirror.tickets.find(x => x.token === m[1]);
      if (url.pathname.startsWith('/api/')) return send(res, t ? 200 : 404, { status: !!t, data: t || null, last_called: mirror.last_called });
      return send(res, 200, ticketPage(t), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, PAGE('<h1>Edo Sushi</h1><div class="state done">Antrian walk-in: pindai QR pada struk antrian Anda.<br>Walk-in queue: scan the QR on your queue ticket.</div>', true), 'text/html; charset=utf-8');
    }
    return send(res, 404, { status: false, msg: 'not_found' });
  } catch (e) {
    return send(res, 500, { status: false, msg: e.message });
  }
});

function start(port = PORT) {
  return new Promise(resolve => {
    server.listen(port, HOST, () => {
      console.log(`quehong public mirror on http://${HOST}:${server.address().port}`);
      resolve(server);
    });
  });
}

if (require.main === module) start();
module.exports = { start, server };
