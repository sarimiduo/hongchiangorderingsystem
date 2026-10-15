'use strict';
/**
 * midhong — the ESB bridge middleware as its own service.
 *
 *   apphong  --POST /api/bridge/orders-->  midhong queue  <--polls--  mini-PC agent --> ESB POS
 *   apphong  <--POST /api/bridge/callback--  midhong  <--report settled--  agent watcher
 *
 * Zero dependencies. Serves a small monitor page on "/".
 * Env: MID_PORT, APP_URL, BRIDGE_TOKEN (apphong <-> midhong), AGENT_TOKEN (agent <-> midhong),
 *      BRIDGE_SIM, BRIDGE_SIM_SETTLE_SECONDS, HOST (bind address, default 127.0.0.1).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const bridge = require('./bridge');
const { send, readBody, bearerOk, requireEnv } = require('./http-util');

requireEnv(['APP_URL', 'BRIDGE_TOKEN', 'AGENT_TOKEN'], 'midhong');

const MID_PORT = Number(process.env.MID_PORT || 3100);
const HOST = process.env.HOST || '127.0.0.1';
const APP_URL = process.env.APP_URL.replace(/\/+$/, '');
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN;
const MONITOR_HTML = path.join(__dirname, '..', 'public-mid', 'index.html');
// the monitor page reuses apphong's credited pictures (public/img) under /img/*
const IMG_DIR = path.join(__dirname, '..', 'public', 'img');
const IMG_MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webm': 'video/webm', '.json': 'application/json; charset=utf-8' };

/* ------------------------------------------------ settlement callback → apphong */
const CALLBACK_DELAYS_MS = [2000, 4000, 8000, 16000, 32000, 60000];
const SWEEP_MS = 60000;

/**
 * Tell apphong the cashier settled this order. Retries with the given delays
 * (attempts = delays.length + 1). Never throws; records cmd.callback.
 */
async function sendCallback(cmd, delaysMs = CALLBACK_DELAYS_MS, appUrl = APP_URL) {
  cmd.callback = cmd.callback || { ok: false, attempts: 0, last_error: null, inflight: false };
  if (cmd.callback.inflight) return false;
  cmd.callback.inflight = true;
  const body = {
    order_no: cmd.order_no, reservation_id: cmd.reservation_id, mode: cmd.mode,
    payment_method: cmd.payment_method || '00', salesNum: cmd.salesNum, billNum: cmd.billNum,
  };
  try {
    for (let i = 0; ; i++) {
      cmd.callback.attempts++;
      try {
        const res = await fetch(appUrl + '/api/bridge/callback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + BRIDGE_TOKEN },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5000),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.status === false) throw new Error(`apphong ${res.status}: ${data.msg || ''}`);
        cmd.callback.ok = true;
        cmd.callback.last_error = null;
        bridge.addEvent(cmd, 'settled', `Callback delivered to apphong (payment ${body.payment_method}${data.msg && data.msg !== 'success' ? ', ' + data.msg : ''})`);
        return true;
      } catch (e) {
        cmd.callback.last_error = e.message;
        if (i >= delaysMs.length) {
          bridge.addEvent(cmd, 'settled', `Callback to apphong failed after ${cmd.callback.attempts} attempt(s): ${e.message} — will retry every ${SWEEP_MS / 1000}s`);
          return false;
        }
        // unref: a pending backoff must not hold the process open (the listening server does that)
        await new Promise(r => setTimeout(r, delaysMs[i]).unref());
      }
    }
  } finally {
    cmd.callback.inflight = false;
  }
}
bridge.state.onSettled = cmd => sendCallback(cmd);

// Re-send callbacks apphong never acknowledged (it was down, or misconfigured).
setInterval(() => {
  for (const c of bridge.state.commands) {
    if (c.stage === 'settled' && c.callback && !c.callback.ok && !c.callback.inflight) sendCallback(c, []);
  }
}, SWEEP_MS).unref();

/* --------------------------------------------------------------------- routes */
function validOrder(b) {
  return b && typeof b.order_no === 'string' && b.order_no
    && (b.mode === 'dinein' || b.mode === 'walkin')
    && Array.isArray(b.items) && b.items.length > 0
    && b.items.every(i => i && Number(i.qty) > 0 && typeof i.menu_name === 'string');
}

async function handleApi(req, res, url) {
  const route = url.pathname.replace(/^\/api\//, '');

  if (req.method === 'GET' && route === 'health') {
    return send(res, 200, {
      ok: true, agent_live: bridge.overview().agent_live,
      queued: bridge.listQueued().length, app_url: APP_URL,
    });
  }

  // ---- public read endpoints (apphong proxies these for the SPA; monitor page) ----
  if (req.method === 'GET' && route.startsWith('bridge/status')) {
    const orderNo = url.searchParams.get('order_no');
    const st = orderNo ? bridge.statusFor(orderNo) : null;
    return send(res, st ? 200 : 404, st || { status: false, msg: 'not_found' });
  }
  if (req.method === 'GET' && route === 'bridge/overview') return send(res, 200, bridge.overview());
  if (req.method === 'GET' && route === 'bridge/menu') return send(res, 200, bridge.appMenuFromEsb() || { source: null });

  // ---- apphong → midhong: order intake (Bearer BRIDGE_TOKEN) ----
  if (req.method === 'POST' && route === 'bridge/orders') {
    if (!bearerOk(req, BRIDGE_TOKEN)) {
      console.error('[midhong] /api/bridge/orders: bad BRIDGE_TOKEN');
      return send(res, 401, { status: false, msg: 'unauthorized' });
    }
    const body = await readBody(req);
    if (!validOrder(body)) return send(res, 400, { status: false, msg: 'bad payload' });
    const existing = bridge.findCommand(body.order_no);
    if (existing) {
      return send(res, 200, { status: true, msg: 'exists', data: { id: existing.id, stage: existing.stage, existing: true } });
    }
    const cmd = bridge.enqueueOrder({
      order_no: body.order_no,
      reservation_id: body.reservation_id == null ? null : Number(body.reservation_id),
      mode: body.mode,
      table_name: body.table_name || null,
      pax: Number(body.pax) || 1,
      customer: body.customer || {},
      note: String(body.note || ''),
      items: body.items.map(i => ({
        menu_code: String(i.menu_code || ''), menu_name: String(i.menu_name),
        qty: Number(i.qty), price: Number(i.price) || 0, notes: String(i.notes || ''),
      })),
      total: Number(body.total) || 0,
    });
    console.log(`[midhong] queued ${cmd.order_no} (${cmd.mode}${cmd.table_name ? ' ' + cmd.table_name : ''}, ${cmd.items.length} item(s))`);
    return send(res, 200, { status: true, msg: 'success', data: { id: cmd.id, stage: cmd.stage, existing: false } });
  }

  // ---- agent endpoints (Bearer AGENT_TOKEN) — unchanged contract ----
  if (route.startsWith('bridge/agent/')) {
    if (!bearerOk(req, bridge.AGENT_TOKEN)) {
      console.error('[midhong] /api/bridge/agent/*: bad AGENT_TOKEN');
      return send(res, 401, { status: false, msg: 'unauthorized' });
    }
    bridge.touchAgent(req.headers['x-agent-info'] ? { info: String(req.headers['x-agent-info']).slice(0, 100) } : null);
    if (req.method === 'GET' && route === 'bridge/agent/commands') {
      return send(res, 200, { status: true, msg: 'success', data: bridge.listQueued() });
    }
    if (req.method === 'POST' && route === 'bridge/agent/report') {
      return send(res, 200, await bridge.report(await readBody(req)));
    }
    if (req.method === 'POST' && route === 'bridge/agent/menu') {
      return send(res, 200, bridge.setEsbMenu(await readBody(req)));
    }
    if (req.method === 'POST' && route === 'bridge/agent/heartbeat') {
      return send(res, 200, { status: true, msg: 'success' });
    }
    return send(res, 404, { status: false, msg: 'not_found' });
  }

  return send(res, 404, { status: false, msg: 'not_found', data: [] });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      return send(res, 200, fs.readFileSync(MONITOR_HTML, 'utf8'), 'text/html; charset=utf-8');
    }
    if (req.method === 'GET' && url.pathname.startsWith('/img/')) {
      const file = path.normalize(path.join(IMG_DIR, url.pathname.slice('/img/'.length)));
      const type = IMG_MIME[path.extname(file)];
      if (!file.startsWith(IMG_DIR) || !type || !fs.existsSync(file)) return send(res, 404, 'not found', 'text/plain');
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' });
      return fs.createReadStream(file).pipe(res);
    }
    return send(res, 404, 'not found', 'text/plain');
  } catch (e) {
    return send(res, 500, { status: false, msg: e.message, data: [] });
  }
});

function start(port = MID_PORT) {
  return new Promise(resolve => {
    server.listen(port, HOST, () => {
      console.log(`midhong bridge listening on http://${HOST}:${server.address().port} (app=${APP_URL}, sim=${process.env.BRIDGE_SIM !== '0' ? 'on' : 'off'})`);
      resolve(server);
    });
  });
}

if (require.main === module) start();

module.exports = { start, server, sendCallback };
