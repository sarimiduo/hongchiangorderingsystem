'use strict';
/**
 * Hong Chiang Ordering System — app server (apphong).
 *
 * Zero-dependency Node server that:
 *  - serves the ESB-style ordering SPA from /public
 *  - exposes the app API under /api/*
 *  - talks to the Hong-Chiang KDS API either via the built-in mock
 *    (KDS_MODE=mock, default) or a real KDS device (KDS_MODE=real,
 *    KDS_BASE_URL=http://{host}:5500/kds)
 *  - pushes every saved order to the midhong bridge (BRIDGE_URL) and receives
 *    the settlement callback when the ESB cashier finishes the bill.
 *
 * The real KDS API (spec v2.0.1) is read/status-update only — it has no
 * create-order or menu endpoint. The menu catalog and order creation live
 * in this app. Stage 1 is cashier-only: there is no in-app payment.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const kdsMock = require('./kds-mock');
const { send, readBody, bearerOk, requireEnv } = require('./http-util');

requireEnv(['BRIDGE_URL', 'BRIDGE_TOKEN'], 'apphong');
const bridgeClient = require('./bridge-client');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const KDS_MODE = (process.env.KDS_MODE || 'mock').toLowerCase();
const KDS_BASE_URL = (process.env.KDS_BASE_URL || 'http://127.0.0.1:5500/kds').replace(/\/+$/, '');
const CURRENCY = process.env.CURRENCY || 'Rp';
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN;

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MENU = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'menu.json'), 'utf8'));
const KDS_PATHS = new Set(['walkIns/get', 'tables/search', 'orders/details', 'reservations/update', 'walkIns/update']);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.webm': 'video/webm', '.mp4': 'video/mp4', '.woff2': 'font/woff2',
};

/** The menu the app serves: ESB-synced catalog (from midhong) wins over the local file. */
async function activeMenu() {
  const esb = await bridgeClient.menu();
  if (esb) return { store: MENU.store, ...esb };
  return { source: 'local', ...MENU };
}

/** Call the KDS backend (mock or real). */
async function kds(relPath, body) {
  if (KDS_MODE === 'real') {
    const res = await fetch(`${KDS_BASE_URL}/${relPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    return res.json();
  }
  return kdsMock.handle(relPath, body || {});
}

/**
 * The ESB cashier settled the bill (midhong callback) → close it in the KDS.
 * Returns {status:true, msg:'success'} on success, {status:true, msg:'kds_unknown_order'}
 * when the KDS does not know the order (nothing to heal by retrying), and
 * throws when the KDS itself is unreachable (midhong will retry).
 */
async function settleInKds(p) {
  const out = p.mode === 'dinein' && p.reservation_id
    ? await kds('reservations/update', { id: Number(p.reservation_id), status: 'COMPLETED', payment_method: p.payment_method || '00' })
    : await kds('walkIns/update', { order_no: String(p.order_no), status: 'paid', payment_method: p.payment_method || '00' });
  if (!out || out.status !== true) {
    console.error(`[apphong] settle ${p.order_no}: KDS answered ${JSON.stringify(out)} — acknowledged, not retried`);
    return { status: true, msg: 'kds_unknown_order' };
  }
  console.log(`[apphong] settled ${p.order_no} in KDS (payment ${p.payment_method || '00'}${p.billNum ? ', bill ' + p.billNum : ''})`);
  return { status: true, msg: 'success' };
}

async function handleApi(req, res, url) {
  const route = url.pathname.replace(/^\/api\//, '');

  if (req.method === 'GET' && route === 'menu') return send(res, 200, await activeMenu());

  // ---- bridge: read-only proxies to midhong (keeps the SPA on one origin) ----
  if (req.method === 'GET' && route.startsWith('bridge/status')) {
    const orderNo = url.searchParams.get('order_no');
    try {
      const st = orderNo ? await bridgeClient.status(orderNo) : null;
      return send(res, st ? 200 : 404, st || { status: false, msg: 'not_found' });
    } catch (e) {
      return send(res, 503, { status: false, msg: 'bridge unreachable: ' + e.message });
    }
  }
  if (req.method === 'GET' && route === 'bridge/overview') {
    try {
      return send(res, 200, await bridgeClient.overview());
    } catch (e) {
      return send(res, 503, { status: false, msg: 'bridge unreachable: ' + e.message, agent_live: false, simulator: false, esb_menu: null, commands: [] });
    }
  }

  // ---- bridge: settlement callback from midhong (Bearer BRIDGE_TOKEN) ----
  if (req.method === 'POST' && route === 'bridge/callback') {
    if (!bearerOk(req, BRIDGE_TOKEN)) {
      console.error('[apphong] /api/bridge/callback: bad BRIDGE_TOKEN');
      return send(res, 401, { status: false, msg: 'unauthorized' });
    }
    const body = await readBody(req);
    if (!body.order_no) return send(res, 400, { status: false, msg: 'bad payload' });
    try {
      return send(res, 200, await settleInKds(body));
    } catch (e) {
      return send(res, 502, { status: false, msg: 'KDS unreachable: ' + e.message });
    }
  }

  if (req.method === 'GET' && route === 'config') {
    return send(res, 200, {
      currency: CURRENCY,
      kds_mode: KDS_MODE,
      store: MENU.store,
      payment_methods: kdsMock.PAYMENT_METHODS,
      bridge_url: bridgeClient.BRIDGE_URL,
    });
  }

  // Generic KDS passthrough for the five documented endpoints.
  if (req.method === 'POST' && route.startsWith('kds/')) {
    const rel = route.slice(4);
    if (!KDS_PATHS.has(rel)) return send(res, 404, { status: false, msg: 'S00002', data: [] });
    const body = await readBody(req);

    // App-created orders live in the local store; in real mode fall through
    // to the device if the local store does not know the order.
    if (rel === 'orders/details' && KDS_MODE === 'real') {
      const local = kdsMock.handle(rel, body);
      if (local && local.status) return send(res, 200, local);
    }
    try {
      return send(res, 200, await kds(rel, body));
    } catch (e) {
      return send(res, 502, { status: false, msg: 'KDS unreachable: ' + e.message, data: [] });
    }
  }

  // Save Order — creates the KDS order, then pushes it to midhong -> agent -> ESB POS.
  if (req.method === 'POST' && route === 'checkout') {
    const body = await readBody(req);
    if (!Array.isArray(body.meals) || body.meals.length === 0) {
      return send(res, 400, { status: false, msg: 'empty_cart', data: [] });
    }
    const menu = await activeMenu();
    const catalog = new Map(menu.meals.map(m => [m.meal_id, m]));
    let meals;
    try {
      meals = body.meals.map(m => {
        const cat = catalog.get(Number(m.meal_id));
        if (!cat) throw new Error('unknown meal ' + m.meal_id);
        const extras = Number(m.options_price) || 0;
        const catName = (menu.categories.find(c => c.id === cat.category_id) || {}).name || null;
        return {
          meal_id: cat.meal_id, meal_name: cat.meal_name,
          menu_code: cat.menu_code || '',
          quantity: Math.max(1, Number(m.quantity) || 1),
          price: cat.price + extras,
          remarks: String(m.remarks || ''),
          category_id: cat.category_id, category_name: catName,
        };
      });
    } catch (e) {
      return send(res, 400, { status: false, msg: e.message, data: [] });
    }
    const { order, reservation } = kdsMock.createOrder({
      type: body.type === 'dinein' ? 'dinein' : 'walkin',
      table_id: body.table_id, guest_count: body.guest_count,
      customer: body.customer || {}, note: body.note || '', meals,
    });
    const push = await bridgeClient.pushOrder({
      order_no: order.order_no,
      reservation_id: reservation ? reservation.id : null,
      mode: order.type,
      table_name: body.table_name || null,
      pax: body.guest_count,
      customer: body.customer || {},
      note: body.note || '',
      items: meals.map(m => ({
        menu_code: m.menu_code, menu_name: m.meal_name,
        qty: m.quantity, price: m.price, notes: m.remarks,
      })),
      total: Number(order.total_price),
    });
    return send(res, 200, {
      status: true, msg: 'success',
      data: {
        order_no: order.order_no, order_id: order.id,
        reservation_id: reservation ? reservation.id : null,
        total_price: order.total_price,
        local_only: KDS_MODE === 'real',
        bridge_pushed: push.pushed,
      },
    });
  }

  return send(res, 404, { status: false, msg: 'not_found', data: [] });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || !path.extname(rel)) rel = '/index.html'; // SPA fallback
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
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method === 'GET') return serveStatic(req, res, url);
    return send(res, 405, 'method not allowed', 'text/plain');
  } catch (e) {
    return send(res, 500, { status: false, msg: e.message, data: [] });
  }
});

function start(port = PORT) {
  return new Promise(resolve => {
    server.listen(port, HOST, () => {
      console.log(`Hong Chiang Ordering System listening on http://${HOST}:${server.address().port} (KDS_MODE=${KDS_MODE}${KDS_MODE === 'real' ? ', KDS=' + KDS_BASE_URL : ''}, bridge=${bridgeClient.BRIDGE_URL})`);
      resolve(server);
    });
  });
}

if (require.main === module) start();

module.exports = { start, server, settleInKds };
