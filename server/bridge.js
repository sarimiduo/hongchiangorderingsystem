'use strict';
/**
 * Bridge middleware — the order queue between the Hong Chiang web app and the
 * local SQL agent that writes into the ESB POS database.
 *
 * Flow (docs/HC_ESB_SQL_BRIDGE_DESIGN.md, docs/superpowers/specs/2026-10-13-midhong-split-design.md):
 *   apphong checkout -> POST /api/bridge/orders (midhong) -> enqueue command
 *   -> agent polls /api/bridge/agent/commands
 *   -> agent runs TXN A (open table, yellow) + TXN B (save order, red)
 *   -> agent watches the sale -> reports "settled" when the cashier finishes
 *   -> midhong calls apphong back -> apphong feeds the KDS (reservations/walkIns update).
 *
 * Stages: queued -> picked_up -> table_opened -> order_saved ->
 *         waiting_cashier -> settled | voided | error
 *
 * When no live agent is connected (demo mode), the built-in simulator advances
 * the stages on timers so the full journey can be shown end to end.
 */

const crypto = require('crypto');

const AGENT_TOKEN = process.env.AGENT_TOKEN || ''; // mid.js refuses to start when empty
const SIM_ENABLED = (process.env.BRIDGE_SIM || '1') !== '0';
const SIM_SETTLE_SECONDS = Number(process.env.BRIDGE_SIM_SETTLE_SECONDS || 25);
const AGENT_LIVE_WINDOW_MS = 30000; // a real agent heartbeat suppresses the simulator

// Map an ESB payment-method name to the Hong Chiang KDS enum
// ('00' Cash, '01' Card, '02' Bonus, '03' Installment, '04' UnionPay).
function mapPaymentMethod(esbName) {
  const n = String(esbName || '').toLowerCase();
  if (!n || n.includes('cash') || n.includes('tunai')) return '00';
  if (n.includes('unionpay') || n.includes('union pay')) return '04';
  if (n.includes('install') || n.includes('cicil')) return '03';
  if (n.includes('bonus') || n.includes('point')) return '02';
  return '01'; // card / QRIS / e-wallet and anything else settled electronically
}

const state = {
  commands: [],        // newest last
  esbMenu: null,       // catalog pushed by the agent's menu sync
  esbTables: null,     // floor plan pushed by the agent's table sync
  agentSeen: 0,        // last time a real agent called any agent endpoint
  agentInfo: null,     // {name, version} from the last agent call
  onSettled: null,     // set by server/mid.js — sends the settlement callback to apphong (not awaited)
};

function now() { return Date.now(); }
function isAgentLive() { return now() - state.agentSeen < AGENT_LIVE_WINDOW_MS; }

function touchAgent(info) {
  state.agentSeen = now();
  if (info) state.agentInfo = info;
}

function addEvent(cmd, stage, detail) {
  cmd.stage = stage;
  cmd.updated = now();
  cmd.events.push({ t: new Date().toISOString().replace('T', ' ').slice(0, 19), stage, detail: detail || '' });
}

/** Called from checkout. order ctx comes from the KDS order the app created. */
function enqueueOrder(ctx) {
  const cmd = {
    id: 'cmd_' + crypto.randomBytes(5).toString('hex'),
    created: now(),
    updated: now(),
    type: 'create_order',
    order_no: ctx.order_no,                 // Hong Chiang order number
    reservation_id: ctx.reservation_id,     // for dine-in KDS feedback
    mode: ctx.mode,                         // 'dinein' | 'walkin'
    table_name: ctx.table_name || null,
    pax: ctx.pax || 1,
    customer: ctx.customer || {},
    note: ctx.note || '',
    items: ctx.items,                       // [{menu_code, menu_name, qty, price, notes}]
    total: ctx.total,
    stage: 'queued',
    salesNum: null, billNum: null, payment_method: null,
    simulated: false,
    error: null,
    events: [],
  };
  addEvent(cmd, 'queued', 'Order pushed to middleware');
  state.commands.push(cmd);
  if (state.commands.length > 200) state.commands.splice(0, state.commands.length - 200);
  return cmd;
}

function findCommand(idOrOrderNo) {
  return state.commands.find(c => c.id === idOrOrderNo || c.order_no === idOrOrderNo);
}

/** Agent: list queued commands (does not change state — agent confirms via report). */
function listQueued() {
  return state.commands.filter(c => c.stage === 'queued').map(c => ({
    id: c.id, type: c.type, order_no: c.order_no, mode: c.mode,
    table_name: c.table_name, pax: c.pax, customer: c.customer,
    note: c.note, items: c.items, total: c.total, created: c.created,
  }));
}

/**
 * Agent progress report.
 * body: {id|order_no, stage, salesNum?, billNum?, payment_method_name?, detail?, error?}
 */
async function report(body) {
  const cmd = findCommand(body.id || body.order_no);
  if (!cmd) return { status: false, msg: 'unknown command' };
  const stage = String(body.stage || '');
  const valid = ['picked_up', 'table_opened', 'order_saved', 'waiting_cashier', 'settled', 'voided', 'error'];
  if (!valid.includes(stage)) return { status: false, msg: 'invalid stage' };

  if (body.salesNum) cmd.salesNum = String(body.salesNum);
  if (body.billNum) cmd.billNum = String(body.billNum);
  if (body.error) cmd.error = String(body.error).slice(0, 500);
  addEvent(cmd, stage, body.detail || '');

  if (stage === 'settled') {
    cmd.payment_method = body.payment_method_kds
      ? String(body.payment_method_kds)
      : mapPaymentMethod(body.payment_method_name);
    if (state.onSettled) {
      // Fire-and-forget: the hook may retry for minutes; the agent's HTTP
      // report call must return immediately. The hook records its own events.
      Promise.resolve()
        .then(() => state.onSettled(cmd))
        .catch(e => addEvent(cmd, 'settled', 'Callback failed: ' + e.message));
    }
  }
  return { status: true, msg: 'success' };
}

/** Agent: push the ESB menu catalog (menu sync). */
function setEsbMenu(payload) {
  if (!payload || !Array.isArray(payload.meals)) return { status: false, msg: 'bad payload' };
  state.esbMenu = {
    synced_at: new Date().toISOString(),
    categories: payload.categories || [],
    meals: payload.meals,
  };
  return { status: true, msg: 'success', data: { meals: payload.meals.length } };
}

/** Agent: push the ESB floor plan (table sync). */
function setEsbTables(payload) {
  if (!payload || !Array.isArray(payload.tables)) return { status: false, msg: 'bad payload' };
  state.esbTables = {
    synced_at: new Date().toISOString(),
    tables: payload.tables.map(t => ({
      id: Number(t.table_id), name: String(t.table_name), seats: Number(t.seats) || 2,
    })),
  };
  return { status: true, msg: 'success', data: { tables: state.esbTables.tables.length } };
}

/** The floor plan the app serves: ESB-synced tables when present, else null. */
function appTablesFromEsb() {
  if (!state.esbTables) return null;
  return { source: 'esb', synced_at: state.esbTables.synced_at, tables: state.esbTables.tables };
}

const TILE_COLORS = [
  ['#8C2B2B', '#C4541F'], ['#1E5B2E', '#4CA05C'], ['#1E3E5B', '#4C7CA0'],
  ['#6B3A1D', '#A0662C'], ['#4A1D6B', '#7C2CA0'], ['#8C6B2B', '#C4A41F'],
  ['#5B2B1E', '#9C5A3C'], ['#2B5B4A', '#1FA47C'], ['#8C2B4A', '#C41F5A'],
];
const CAT_EMOJI = [['drink', '🥤'], ['minum', '🥤'], ['tea', '🧋'], ['kopi', '☕'], ['coffee', '☕'],
  ['mie', '🍜'], ['noodle', '🍜'], ['nasi', '🍚'], ['rice', '🍚'], ['soup', '🍲'], ['sup', '🍲'],
  ['sate', '🍢'], ['ikan', '🐟'], ['fish', '🐟'], ['ayam', '🍗'], ['chicken', '🍗'],
  ['snack', '🍟'], ['dessert', '🍧'], ['paket', '🍱']];
function emojiFor(name, cat) {
  const hay = (String(name) + ' ' + String(cat)).toLowerCase();
  for (const [k, e] of CAT_EMOJI) if (hay.includes(k)) return e;
  return '🍽️';
}

/** The menu the app serves: ESB-synced catalog when present, else null. */
function appMenuFromEsb() {
  if (!state.esbMenu) return null;
  const cats = state.esbMenu.categories.length
    ? state.esbMenu.categories
    : [{ id: 1, name: 'Menu' }];
  return {
    source: 'esb',
    synced_at: state.esbMenu.synced_at,
    categories: cats,
    meals: state.esbMenu.meals.map((m, i) => {
      const [c1, c2] = TILE_COLORS[i % TILE_COLORS.length];
      const catName = (cats.find(c => c.id === m.category_id) || {}).name || '';
      return {
        meal_id: m.meal_id,
        meal_name: m.meal_name,
        short_name: m.short_name || m.meal_name,
        menu_code: m.menu_code || '',
        price: Number(m.price) || 0,
        category_id: m.category_id || cats[0].id,
        emoji: m.emoji || emojiFor(m.meal_name, catName),
        color1: c1, color2: c2,
        desc: m.desc || '',
        option_groups: m.option_groups || undefined,
      };
    }),
  };
}

/** Public status views (frontend via apphong proxy, and the midhong monitor). */
function statusFor(orderNo) {
  const c = findCommand(orderNo);
  if (!c) return null;
  return {
    id: c.id, order_no: c.order_no, stage: c.stage, simulated: c.simulated,
    mode: c.mode, reservation_id: c.reservation_id, table_name: c.table_name, total: c.total,
    salesNum: c.salesNum, billNum: c.billNum, payment_method: c.payment_method,
    callback: c.callback || null, pending_push: false,
    error: c.error, events: c.events, agent_live: isAgentLive(),
  };
}
function overview() {
  return {
    agent_live: isAgentLive(),
    agent_info: state.agentInfo,
    simulator: SIM_ENABLED && !isAgentLive(),
    esb_menu: state.esbMenu ? { synced_at: state.esbMenu.synced_at, meals: state.esbMenu.meals.length } : null,
    esb_tables: state.esbTables ? { synced_at: state.esbTables.synced_at, tables: state.esbTables.tables.length } : null,
    commands: [...state.commands].reverse().slice(0, 50).map(c => ({
      id: c.id, order_no: c.order_no, mode: c.mode, table_name: c.table_name,
      total: c.total, stage: c.stage, simulated: c.simulated,
      salesNum: c.salesNum, billNum: c.billNum, payment_method: c.payment_method,
      callback: c.callback || null,
      items: c.items.length, created: c.created, events: c.events,
    })),
  };
}

/* ----------------------------- simulator ------------------------------- */
// Advances stages like a real agent would, so the journey can be demoed
// before the local agent/ESB DB is wired up. A live agent suppresses it.
function genSalesNum() {
  const seq = String(Math.floor(Math.random() * 90) + 10);
  return 'SSUSHO' + Math.floor(Date.now() / 1000) + seq;
}

function simTick() {
  if (!SIM_ENABLED || isAgentLive()) return;
  const t = now();
  for (const c of state.commands) {
    const age = (t - c.updated) / 1000;
    if (c.stage === 'queued' && age > 2) {
      c.simulated = true;
      addEvent(c, 'picked_up', 'Local agent picked up the order [SIMULATED]');
    } else if (c.stage === 'picked_up' && age > 1.5) {
      c.salesNum = genSalesNum();
      if (c.mode === 'dinein') {
        addEvent(c, 'table_opened', `TXN A: tr_saleshead + tr_tableusage inserted — table ${c.table_name} OPEN (yellow) · salesNum ${c.salesNum} [SIMULATED]`);
      } else {
        addEvent(c, 'table_opened', `TXN A: tr_saleshead inserted (takeaway) · salesNum ${c.salesNum} [SIMULATED]`);
      }
    } else if (c.stage === 'table_opened' && age > 2) {
      addEvent(c, 'order_saved', `TXN B: ${c.items.length} item(s) into tr_salesmenu, head totals updated — table OCCUPIED (red) [SIMULATED]`);
    } else if (c.stage === 'order_saved' && age > 1) {
      addEvent(c, 'waiting_cashier', 'Watching tr_saleshead — waiting for the cashier to finish the bill on ESB POS [SIMULATED]');
    } else if (c.stage === 'waiting_cashier' && c.simulated && age > SIM_SETTLE_SECONDS) {
      report({ id: c.id, stage: 'settled', payment_method_name: 'Cash', billNum: 'OUT' + String(Date.now()).slice(-9), detail: 'Cashier settled the bill on ESB POS [SIMULATED]' });
    }
  }
}
setInterval(simTick, 1000).unref();

module.exports = {
  AGENT_TOKEN, enqueueOrder, findCommand, addEvent, listQueued, report, setEsbMenu,
  appMenuFromEsb, setEsbTables, appTablesFromEsb, statusFor, overview, touchAgent,
  mapPaymentMethod, state,
};
