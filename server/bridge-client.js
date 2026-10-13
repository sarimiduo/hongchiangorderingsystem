'use strict';
/**
 * apphong -> midhong client. apphong never loads server/bridge.js; everything
 * bridge-related goes over HTTP to BRIDGE_URL with the shared BRIDGE_TOKEN.
 *
 * pushOrder() never throws: if midhong is unreachable (or rejects), the order
 * waits in an in-memory outbox and is retried every 5 s until accepted, so a
 * checkout succeeds even when midhong is restarting.
 */

const BRIDGE_URL = (process.env.BRIDGE_URL || '').replace(/\/+$/, '');
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || '';
const TIMEOUT_MS = 5000;
const OUTBOX_RETRY_MS = 5000;
const MENU_CACHE_MS = 30000;

class BridgeDown extends Error {}

const outbox = []; // [{ctx, attempts, last_error, created}]
let menuCache = { at: 0, value: null };

async function call(method, path, body) {
  let res;
  try {
    res = await fetch(BRIDGE_URL + path, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + BRIDGE_TOKEN },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new BridgeDown('midhong unreachable: ' + e.message);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`midhong ${res.status}: ${data.msg || ''}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function pushOrder(ctx) {
  try {
    await call('POST', '/api/bridge/orders', ctx);
    return { pushed: true };
  } catch (e) {
    console.error(`[bridge-client] push ${ctx.order_no} failed (${e.message}) — queued in outbox`);
    outbox.push({ ctx, attempts: 1, last_error: e.message, created: Date.now() });
    return { pushed: false, error: e.message };
  }
}

/** Retry everything in the outbox once. Returns how many are still pending.
 * Only one flush runs at a time: the 5 s interval can fire while a previous
 * flush is still waiting on a hanging midhong, and two flushes over the same
 * items would deliver twice and remove the wrong entries. */
let flushing = false;
async function flushOutbox() {
  if (flushing) return outbox.length;
  flushing = true;
  try {
    for (const item of [...outbox]) {
      try {
        await call('POST', '/api/bridge/orders', item.ctx);
        const i = outbox.indexOf(item);
        if (i >= 0) outbox.splice(i, 1);
        console.log(`[bridge-client] push ${item.ctx.order_no} delivered after ${item.attempts} failed attempt(s)`);
      } catch (e) {
        item.attempts++;
        item.last_error = e.message;
      }
    }
  } finally {
    flushing = false;
  }
  return outbox.length;
}
setInterval(() => { if (outbox.length) flushOutbox(); }, OUTBOX_RETRY_MS).unref();

function pendingStatus(item) {
  const t = new Date(item.created).toISOString().replace('T', ' ').slice(0, 19);
  return {
    id: null, order_no: item.ctx.order_no, stage: 'queued', simulated: false,
    mode: item.ctx.mode, reservation_id: item.ctx.reservation_id, table_name: item.ctx.table_name, total: item.ctx.total,
    salesNum: null, billNum: null, payment_method: null, callback: null, pending_push: true,
    error: item.last_error, agent_live: false,
    events: [{ t, stage: 'queued', detail: `Waiting for middleware — push retried ${item.attempts}×` }],
  };
}

async function status(orderNo) {
  const pending = outbox.find(i => i.ctx.order_no === orderNo);
  if (pending) return pendingStatus(pending);
  try {
    return await call('GET', '/api/bridge/status?order_no=' + encodeURIComponent(orderNo));
  } catch (e) {
    if (e.status === 404) return null;
    throw e;
  }
}

function overview() { return call('GET', '/api/bridge/overview'); }

/** ESB-synced catalog from midhong, or null (no sync yet). Cached 30 s.
 * While midhong is unreachable the last catalog it served stays in use, so
 * meal ids the customer already loaded still resolve at checkout (the push
 * itself waits in the outbox). */
let lastGoodMenu = null;
async function menu() {
  if (Date.now() - menuCache.at < MENU_CACHE_MS) return menuCache.value;
  let value = null;
  try {
    const m = await call('GET', '/api/bridge/menu');
    if (m && m.source === 'esb') value = m;
    lastGoodMenu = value;
  } catch (e) {
    console.error('[bridge-client] menu fetch failed: ' + e.message + (lastGoodMenu ? ' — serving the last synced catalog' : ''));
    value = lastGoodMenu;
  }
  menuCache = { at: Date.now(), value };
  return value;
}
/** Force the next menu() call to ask midhong again (keeps the last-good fallback). */
function resetMenuCache() { menuCache = { at: 0, value: null }; }

module.exports = { pushOrder, flushOutbox, status, overview, menu, resetMenuCache, outbox, BridgeDown, BRIDGE_URL };
