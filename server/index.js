'use strict';
/**
 * Hong Chiang Ordering System — app server.
 *
 * Zero-dependency Node server that:
 *  - serves the ESB-style ordering SPA from /public
 *  - exposes the app API under /api/*
 *  - talks to the Hong-Chiang KDS API either via the built-in mock
 *    (KDS_MODE=mock, default) or a real KDS device (KDS_MODE=real,
 *    KDS_BASE_URL=http://{host}:5500/kds)
 *
 * The real KDS API (spec v2.0.1) is read/status-update only — it has no
 * create-order or menu endpoint. The menu catalog and order creation live
 * in this app; payment/status updates are pushed through the KDS endpoints
 * (reservations/update, walkIns/update).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const kdsMock = require('./kds-mock');

const PORT = Number(process.env.PORT || 3000);
const KDS_MODE = (process.env.KDS_MODE || 'mock').toLowerCase();
const KDS_BASE_URL = (process.env.KDS_BASE_URL || 'http://127.0.0.1:5500/kds').replace(/\/+$/, '');
const CURRENCY = process.env.CURRENCY || 'Rp';

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MENU = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'menu.json'), 'utf8'));
const KDS_PATHS = new Set(['walkIns/get', 'tables/search', 'orders/details', 'reservations/update', 'walkIns/update']);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

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

function send(res, code, data, type) {
  const payload = typeof data === 'string' ? data : JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  const route = url.pathname.replace(/^\/api\//, '');

  if (req.method === 'GET' && route === 'menu') return send(res, 200, MENU);

  if (req.method === 'GET' && route === 'config') {
    return send(res, 200, {
      currency: CURRENCY,
      kds_mode: KDS_MODE,
      store: MENU.store,
      payment_methods: kdsMock.PAYMENT_METHODS,
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

  // Checkout — the simulation extension (real KDS has no create-order API).
  if (req.method === 'POST' && route === 'checkout') {
    const body = await readBody(req);
    if (!Array.isArray(body.meals) || body.meals.length === 0) {
      return send(res, 400, { status: false, msg: 'empty_cart', data: [] });
    }
    const catalog = new Map(MENU.meals.map(m => [m.meal_id, m]));
    const meals = body.meals.map(m => {
      const cat = catalog.get(Number(m.meal_id));
      if (!cat) throw new Error('unknown meal ' + m.meal_id);
      const extras = Number(m.options_price) || 0;
      const catName = (MENU.categories.find(c => c.id === cat.category_id) || {}).name || null;
      return {
        meal_id: cat.meal_id, meal_name: cat.meal_name,
        quantity: Math.max(1, Number(m.quantity) || 1),
        price: cat.price + extras,
        remarks: String(m.remarks || ''),
        category_id: cat.category_id, category_name: catName,
      };
    });
    try {
      const { order, reservation } = kdsMock.createOrder({
        type: body.type === 'dinein' ? 'dinein' : 'walkin',
        table_id: body.table_id, guest_count: body.guest_count,
        customer: body.customer || {}, note: body.note || '', meals,
      });
      return send(res, 200, {
        status: true, msg: 'success',
        data: {
          order_no: order.order_no, order_id: order.id,
          reservation_id: reservation ? reservation.id : null,
          total_price: order.total_price,
          local_only: KDS_MODE === 'real',
        },
      });
    } catch (e) {
      return send(res, 400, { status: false, msg: e.message, data: [] });
    }
  }

  // Payment — maps to the documented status-update endpoints.
  if (req.method === 'POST' && route === 'pay') {
    const body = await readBody(req);
    try {
      if (body.mode === 'dinein') {
        const out = await kds('reservations/update', {
          id: Number(body.reservation_id),
          status: 'COMPLETED',
          payment_method: body.payment_method || '00',
        });
        return send(res, 200, out);
      }
      const out = await kds('walkIns/update', {
        order_no: String(body.order_no),
        status: 'paid',
        payment_method: body.payment_method || '00',
      });
      return send(res, 200, out);
    } catch (e) {
      return send(res, 502, { status: false, msg: 'KDS unreachable: ' + e.message, data: [] });
    }
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

server.listen(PORT, () => {
  console.log(`Hong Chiang Ordering System listening on http://0.0.0.0:${PORT} (KDS_MODE=${KDS_MODE}${KDS_MODE === 'real' ? ', KDS=' + KDS_BASE_URL : ''})`);
});
