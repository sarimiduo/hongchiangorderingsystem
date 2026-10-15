'use strict';
/**
 * In-memory simulator of the Hong-Chiang KDS System API v2.0.1.
 *
 * Implements the five documented endpoints with the exact request/response
 * shapes from the spec (Base Path = http://{host}:5500/kds/):
 *
 *   POST walkIns/get           -> takeout order numbers
 *   POST tables/search         -> tables + reservations
 *   POST orders/details        -> order header + order_meals (by table_id or order_id)
 *   POST reservations/update   -> update a table reservation (status/payment)
 *   POST walkIns/update        -> update a walk-in order (status/payment)
 *
 * The real KDS has no "create order" endpoint — orders normally appear from the
 * POS. createOrder() below is the simulation hook the web app uses to inject
 * orders so the full ESB-style journey can be exercised end to end.
 */

const PAYMENT_METHODS = { '00': 'Cash', '01': 'Card', '02': 'Bonus', '03': 'Installment', '04': 'UnionPay' };

function now() { return new Date(); }
function fmtDate(d) { return d.toISOString().slice(0, 10); }
function fmtTime(d) { return d.toTimeString().slice(0, 8); }
function fmtDateTime(d) { return `${fmtDate(d)} ${fmtTime(d)}`; }

function genOrderNo() {
  const d = now();
  const ymd = fmtDate(d).replace(/-/g, '');
  const rand = Array.from({ length: 6 }, () =>
    'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 34)]).join('');
  return `ORD${ymd}${rand}`;
}

// ---------------------------------------------------------------- state
const state = {
  nextReservationId: 316,
  nextOrderId: 361,
  nextMealRowId: 1062,
  // Table names match the ESB POS floor plan (ms_table.tableName) so the
  // bridge can resolve them 1:1; remap per-site via the agent's [tables] map.
  tables: [
    { id: 10, name: '1', status: 'IDLE', sort: 1, seats: 4 },
    { id: 11, name: '2', status: 'IDLE', sort: 2, seats: 4 },
    { id: 12, name: '3', status: 'IDLE', sort: 3, seats: 4 },
    { id: 13, name: '5', status: 'IDLE', sort: 4, seats: 2 },
    { id: 14, name: '6', status: 'IDLE', sort: 5, seats: 4 },
    { id: 15, name: '8', status: 'IDLE', sort: 6, seats: 6 },
    { id: 16, name: '23', status: 'IDLE', sort: 7, seats: 6 },
    { id: 17, name: '25', status: 'IDLE', sort: 8, seats: 8 },
  ],
  reservations: [],  // {id, table_id, date, time, name, phone, status, guest_count, dining_duration, seated_time, completed_time, note, order_id}
  orders: [],        // {id, order_no, table_id|null, status, total_price, payment_method, invoice_no, paidtime, createtime, updatetime, type}
  orderMeals: [],    // rows per spec: {id, order_id, meal_id, meal_name, quantity, price, subtotal, status, first, remarks, createtime, updatetime, tablet_id, image_path, category_id, category_name}
};

function tableById(id) { return state.tables.find(t => t.id === Number(id)); }

/**
 * Replace the floor plan with the ESB-synced table list (mock mode only).
 * Tables are matched by NAME: existing ones keep their id and status so open
 * reservations keep pointing at them; a DINING table that ESB no longer lists
 * stays until its reservation completes. list: [{id, name, seats}].
 */
function setTables(list) {
  if (!Array.isArray(list) || list.length === 0) return;
  const prevByName = new Map(state.tables.map(t => [t.name, t]));
  const next = [];
  const fresh = [];
  for (const t of list) {
    const name = String(t.name);
    const prev = prevByName.get(name);
    if (prev) {
      next.push(Object.assign(prev, { seats: Number(t.seats) || prev.seats }));
    } else {
      const row = { id: Number(t.id), name, status: 'IDLE', sort: 0, seats: Number(t.seats) || 2 };
      next.push(row);
      fresh.push(row);
    }
  }
  for (const t of state.tables) {
    if (t.status === 'DINING' && !next.includes(t)) next.push(t);
  }
  // Only brand-new rows may be renumbered; preserved ids anchor reservations.
  const usedIds = new Set(next.filter(t => !fresh.includes(t)).map(t => t.id));
  for (const t of fresh) {
    while (!t.id || usedIds.has(t.id)) t.id = (t.id || 0) + 1;
    usedIds.add(t.id);
  }
  next.sort((a, b) => (Number(a.name) - Number(b.name)) || String(a.name).localeCompare(String(b.name)));
  next.forEach((t, i) => { t.sort = i + 1; });
  state.tables = next;
}
function ok(data) { return { status: true, msg: 'success', data }; }
function fail(code) { return { status: false, msg: code || 'S00001', data: [] }; }

// Kitchen simulation: meals advance PREPARING -> READY -> SERVED over time.
function tickMeals() {
  const t = Date.now();
  for (const m of state.orderMeals) {
    const age = (t - m._created) / 1000;
    const prev = m.status;
    if (m.status === 'PREPARING' && age > 40) m.status = 'READY';
    if (m.status === 'READY' && age > 80) m.status = 'SERVED';
    if (prev !== m.status) m.updatetime = fmtDateTime(now());
  }
}

// ------------------------------------------------------- API handlers
function walkInsGet() {
  const order_nos = state.orders
    .filter(o => o.type === 'walkin' && o.status !== 'paid' && o.status !== 'cancelled')
    .map(o => o.order_no);
  return ok({ order_nos });
}

function tablesSearch() {
  tickMeals();
  const data = state.tables.map(t => ({
    id: t.id, name: t.name, status: t.status, sort: t.sort, seats: t.seats,
    reservations: state.reservations
      .filter(r => r.table_id === t.id && r.status !== 'COMPLETED' && r.status !== 'CANCELLED')
      .map(r => ({
        id: r.id, date: r.date, time: r.time, name: r.name, phone: r.phone,
        status: r.status, guest_count: r.guest_count, dining_duration: r.dining_duration,
        seated_time: r.seated_time, completed_time: r.completed_time, note: r.note,
      })),
  }));
  return ok(data);
}

function ordersDetails(body) {
  tickMeals();
  let order = null;
  if (body && body.order_id != null) {
    order = state.orders.find(o => o.order_no === String(body.order_id));
  } else if (body && body.table_id != null) {
    // newest open dining order on this table
    order = [...state.orders].reverse().find(o =>
      o.table_id === Number(body.table_id) && o.status !== 'paid' && o.status !== 'cancelled');
  }
  if (!order) return fail('S00001');
  const table = order.table_id ? tableById(order.table_id) : null;
  const meals = state.orderMeals.filter(m => m.order_id === order.id).map(m => {
    const { _created, ...row } = m;
    return row;
  });
  return ok({
    order: {
      id: order.id, order_no: order.order_no, table_id: order.table_id,
      status: order.status, total_price: order.total_price,
      payment_method: order.payment_method, invoice_no: order.invoice_no,
      paidtime: order.paidtime, createtime: order.createtime,
      updatetime: order.updatetime, table_name: table ? table.name : null,
    },
    order_meals: meals,
  });
}

function reservationsUpdate(body) {
  const r = state.reservations.find(x => x.id === Number(body && body.id));
  if (!r) return fail('S00001');
  if (body.status) r.status = String(body.status);
  const order = state.orders.find(o => o.id === r.order_id) || null;
  if (r.status === 'COMPLETED') {
    r.completed_time = fmtDateTime(now());
    const t = tableById(r.table_id);
    if (t) t.status = 'IDLE';
    if (order) {
      order.status = 'paid';
      order.payment_method = body.payment_method != null ? String(body.payment_method) : order.payment_method;
      order.paidtime = fmtDateTime(now());
      order.updatetime = order.paidtime;
    }
  }
  const t = tableById(r.table_id);
  return ok({
    id: r.id, table_id: r.table_id, table_name: t ? t.name : null,
    appointment: `${r.date} ${r.time}`, name: r.name, phone: r.phone,
    guest_count: r.guest_count, dining_duration: r.dining_duration,
    seated_time: r.seated_time, completed_time: r.completed_time,
    status: r.status, order_id: order ? order.id : null, note: r.note,
    order_number: order ? order.order_no : null,
  });
}

function walkInsUpdate(body) {
  const o = state.orders.find(x => x.type === 'walkin' && x.order_no === String(body && body.order_no));
  if (!o) return fail('S00001');
  if (body.status) o.status = String(body.status);
  if (o.status === 'paid') {
    o.payment_method = body.payment_method != null ? String(body.payment_method) : o.payment_method;
    o.paidtime = fmtDateTime(now());
  }
  o.updatetime = fmtDateTime(now());
  return ok('');
}

// ------------------------------------------- simulation hook (not in spec)
/**
 * Inject an order as the POS would.
 * @param {object} p {type:'dinein'|'walkin', table_id, guest_count, customer:{name,phone}, note,
 *                    meals:[{meal_id, meal_name, quantity, price, remarks, image_path, category_id, category_name}]}
 */
function createOrder(p) {
  const d = now();
  const total = p.meals.reduce((s, m) => s + m.price * m.quantity, 0);
  const order = {
    id: state.nextOrderId++,
    order_no: genOrderNo(),
    table_id: p.type === 'dinein' ? Number(p.table_id) : null,
    status: 'in_progress',
    total_price: total.toFixed(2),
    payment_method: null, invoice_no: null, paidtime: null,
    createtime: fmtDateTime(d), updatetime: fmtDateTime(d),
    type: p.type === 'dinein' ? 'dinein' : 'walkin',
  };
  state.orders.push(order);

  p.meals.forEach((m, i) => {
    state.orderMeals.push({
      id: state.nextMealRowId++, order_id: order.id,
      meal_id: m.meal_id, meal_name: m.meal_name,
      quantity: m.quantity, price: Number(m.price).toFixed(2),
      subtotal: (m.price * m.quantity).toFixed(2),
      status: 'PREPARING', first: i === 0 ? 1 : 0,
      remarks: m.remarks || '',
      createtime: fmtDateTime(d), updatetime: fmtDateTime(d),
      tablet_id: null,
      image_path: m.image_path || null,
      category_id: m.category_id || null,
      category_name: m.category_name || null,
      _created: Date.now(),
    });
  });

  let reservation = null;
  if (order.type === 'dinein') {
    const t = tableById(p.table_id);
    if (t) t.status = 'DINING';
    reservation = {
      id: state.nextReservationId++,
      table_id: Number(p.table_id),
      date: fmtDate(d), time: fmtTime(d),
      name: (p.customer && p.customer.name) || '直接來店',
      phone: (p.customer && p.customer.phone) || '0000000000',
      status: 'SEATED',
      guest_count: Number(p.guest_count) || 2,
      dining_duration: 90,
      seated_time: fmtDateTime(d), completed_time: null,
      note: p.note || '直接入座',
      order_id: order.id,
    };
    state.reservations.push(reservation);
  }
  return { order, reservation };
}

// Seed one walk-in order so the takeout board is not empty on first run.
createOrder({
  type: 'walkin',
  customer: { name: 'Walk-in Guest', phone: '0000000000' },
  meals: [
    { meal_id: 102, meal_name: '鮭 Sake, salmon nigiri', quantity: 2, price: 15000, category_id: 1, category_name: 'Nigiri' },
    { meal_id: 161, meal_name: 'お茶 Ocha, hot green tea', quantity: 2, price: 5000, category_id: 6, category_name: 'Drinks' },
  ],
});

/** Route a KDS-style request. url is relative, e.g. "walkIns/get". */
function handle(url, body) {
  switch (url.replace(/^\/+|\/+$/g, '')) {
    case 'walkIns/get': return walkInsGet();
    case 'tables/search': return tablesSearch();
    case 'orders/details': return ordersDetails(body);
    case 'reservations/update': return reservationsUpdate(body);
    case 'walkIns/update': return walkInsUpdate(body);
    default: return { code: 'S00002', msg: 'Error:method_not_allowed' };
  }
}

module.exports = { handle, createOrder, setTables, state, PAYMENT_METHODS };
