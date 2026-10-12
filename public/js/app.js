'use strict';
/* Hong Chiang Ordering — ESB-style self-ordering SPA.
 * Journey: home → (dine-in: table + pax | takeout) → menu → cart → payment → status.
 * Backed by the Hong-Chiang KDS API via /api/kds/* (tables/search, orders/details,
 * walkIns/get, reservations/update, walkIns/update) + the app's own menu/checkout.
 */

const $app = document.getElementById('app');
const $sheet = document.getElementById('sheet-root');
const $toast = document.getElementById('toast-root');

const S = {
  config: null,
  menu: null,
  session: load('hc_session', { mode: null, table: null, pax: null }),
  cart: load('hc_cart', []),
  lastOrder: load('hc_last_order', null),
  statusTimer: null,
};

function load(k, d) { try { return JSON.parse(sessionStorage.getItem(k)) ?? d; } catch { return d; } }
function save() {
  sessionStorage.setItem('hc_session', JSON.stringify(S.session));
  sessionStorage.setItem('hc_cart', JSON.stringify(S.cart));
  sessionStorage.setItem('hc_last_order', JSON.stringify(S.lastOrder));
}

async function api(path, body, method) {
  const res = await fetch('/api/' + path, {
    method: method || (body !== undefined ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

function fmt(n) {
  const cur = (S.config && S.config.currency) || 'Rp';
  return cur + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = msg;
  $toast.appendChild(el);
  setTimeout(() => el.remove(), 2200);
}

function mealById(id) { return S.menu.meals.find(m => m.meal_id === Number(id)); }
function catName(id) { return (S.menu.categories.find(c => c.id === id) || {}).name || ''; }
function tile(meal, cls, withZh) {
  const zh = withZh ? `<div class="zhname">${esc(meal.meal_name.split(' ')[0])}</div>` : '';
  return `<div class="${cls}" style="background:linear-gradient(145deg,${meal.color1},${meal.color2})">${zh}${meal.emoji}</div>`;
}

function cartCount() { return S.cart.reduce((s, i) => s + i.qty, 0); }
function itemPrice(i) { const m = mealById(i.meal_id); return (m.price + i.options_price) * i.qty; }
function cartSubtotal() { return S.cart.reduce((s, i) => s + itemPrice(i), 0); }
function serviceFee() { return Math.round(cartSubtotal() * 0.1); }
function cartTotal() { return cartSubtotal() + serviceFee(); }

/* ------------------------------------------------------------------ router */
const routes = {
  '': renderHome, home: renderHome, tables: renderTables, menu: renderMenu,
  cart: renderCart, payment: renderPayment, status: renderStatus, takeout: renderTakeout,
};
function go(r) { location.hash = '#/' + r; }
window.addEventListener('hashchange', route);
function route() {
  clearInterval(S.statusTimer);
  $sheet.innerHTML = '';
  const name = (location.hash.replace(/^#\//, '') || '').split('?')[0];
  (routes[name] || renderHome)();
  window.scrollTo(0, 0);
}

/* ------------------------------------------------------------------- home */
function renderHome() {
  $app.innerHTML = `
    <div class="home-hero">
      <div class="logo">🥡</div>
      <h1>${esc(S.menu.store.name)}</h1>
      <p>${esc(S.menu.store.tagline)} · ${esc(S.menu.store.hours)}</p>
    </div>
    <div class="wrap mt16">
      <button class="mode-btn" id="btn-dinein">
        <span class="ic">🍽️</span>
        <span><b>Dine In 內用</b><p>Choose your table & order from your seat</p></span>
        <span class="chev">›</span>
      </button>
      <button class="mode-btn" id="btn-takeout">
        <span class="ic">🥤</span>
        <span><b>Takeout 外帶</b><p>Order now, pick up at the counter</p></span>
        <span class="chev">›</span>
      </button>
      <button class="mode-btn" id="btn-board">
        <span class="ic">📋</span>
        <span><b>Takeout Board</b><p>Live walk-in queue from the KDS</p></span>
        <span class="chev">›</span>
      </button>
      <p class="center muted">Powered by Hong-Chiang KDS API v2.0.1 · ${esc(S.config.kds_mode)} mode</p>
    </div>`;
  document.getElementById('btn-dinein').onclick = () => { S.session.mode = 'dinein'; save(); go('tables'); };
  document.getElementById('btn-takeout').onclick = () => { S.session.mode = 'walkin'; S.session.table = null; S.session.pax = null; save(); go('menu'); };
  document.getElementById('btn-board').onclick = () => go('takeout');
}

/* ------------------------------------------------------------- table pick */
async function renderTables() {
  $app.innerHTML = `
    <div class="topbar"><button class="back" onclick="history.back()">←</button><h1>Choose Your Table</h1></div>
    <div class="wrap"><div class="center mt16"><span class="spin"></span></div></div>`;
  const out = await api('kds/tables/search', {});
  if (!out.status) { $app.querySelector('.wrap').innerHTML = `<p class="center muted">KDS error: ${esc(out.msg)}</p>`; return; }
  const tables = out.data;
  $app.querySelector('.wrap').innerHTML = `
    <div class="card"><b>Select an available table</b>
      <p class="muted mt8">Live table status from the kitchen display system</p></div>
    <div class="tgrid" id="tgrid">
      ${tables.map(t => {
        const busy = t.status !== 'IDLE';
        return `<button class="tcell ${busy ? 'busy' : ''}" data-id="${t.id}" data-name="${esc(t.name)}" ${busy ? 'disabled' : ''}>
          <b>${esc(t.name)}</b>
          <div class="st ${busy ? 'busy' : ''}">${busy ? esc(t.status) : t.seats + ' seats'}</div>
        </button>`;
      }).join('')}
    </div>`;
  document.getElementById('tgrid').onclick = e => {
    const cell = e.target.closest('.tcell'); if (!cell || cell.disabled) return;
    S.session.table = { id: Number(cell.dataset.id), name: cell.dataset.name };
    save();
    paxSheet();
  };
}

function paxSheet() {
  const opts = ['2 Orang', '3-5 Orang', '6-8 Orang', '10 - 15 Orang', '>15 Orang'];
  $sheet.innerHTML = `
    <div class="sheet-mask"><div class="sheet"><div class="sheet-pad">
      <h2>Total Anda makan bersama berapa orang?</h2>
      ${opts.map(o => `<button class="choice" data-pax="${esc(o)}">${esc(o)}</button>`).join('')}
    </div></div></div>`;
  $sheet.querySelector('.sheet-mask').onclick = e => {
    const b = e.target.closest('.choice');
    if (b) { S.session.pax = b.dataset.pax; save(); $sheet.innerHTML = ''; go('menu'); }
    else if (e.target.classList.contains('sheet-mask')) $sheet.innerHTML = '';
  };
}

/* -------------------------------------------------------------------- menu */
function renderMenu() {
  if (!S.session.mode) { go('home'); return; }
  const cats = S.menu.categories.filter(c => S.menu.meals.some(m => m.category_id === c.id));
  const dinein = S.session.mode === 'dinein';
  $app.innerHTML = `
    ${dinein && S.session.table ? `<div class="table-chip">Table ${esc(S.session.table.name)}</div>` : `<div class="table-chip">Takeout 外帶</div>`}
    <div class="topbar">
      <button class="back" id="mback">←</button>
      <h1>${esc(S.menu.store.name)}</h1>
      <button class="icon-btn">🔍</button>
    </div>
    <div class="hero">
      <div class="zh">新菜上市 · 歡迎光臨</div>
      <div class="sub">${esc(S.menu.store.banner)}</div>
      <div class="bowls">🍜🍛🍲</div>
      <div class="ribbon">Yuk Cobain Sekarang!</div>
    </div>
    <div class="wrap">
      <div class="card store-card">
        <span><b>${esc(S.menu.store.name)}</b><div class="hours">${esc(S.menu.store.hours)}</div></span>
        <span class="chev">›</span>
      </div>
      <div class="banner-card">
        <div class="tno">${dinein && S.session.table ? `Table Number: <b>${esc(S.session.table.name)}</b>${S.session.pax ? ` · ${esc(S.session.pax)}` : ''}` : 'Takeout — pick up at counter'}</div>
        <div class="points"><span class="coin">🪙</span><span>Spend, get points &amp; redeem voucher<a href="javascript:void 0">Click here!</a></span></div>
      </div>
    </div>
    <div class="tabs" id="tabs">
      ${cats.map((c, i) => `<button class="tab ${i === 0 ? 'active' : ''}" data-cat="${c.id}">${esc(c.name)}</button>`).join('')}
    </div>
    <div id="sections">
      ${cats.map(c => `
        <div class="msection" id="cat-${c.id}">
          <div class="section-title">${esc(c.name)}</div>
          <div class="grid2">
            ${S.menu.meals.filter(m => m.category_id === c.id).map(m => `
              <div class="meal-card" data-meal="${m.meal_id}">
                ${tile(m, 'meal-tile', true)}
                <div class="meal-body">
                  <div class="name">${esc(m.short_name)}</div>
                  <div class="price">${fmt(m.price)}</div>
                  <button class="btn-add" data-add="${m.meal_id}">Add</button>
                </div>
              </div>`).join('')}
          </div>
        </div>`).join('')}
    </div>
    <div id="cartbar-slot"></div>`;

  document.getElementById('mback').onclick = () => go('home');
  document.getElementById('tabs').onclick = e => {
    const t = e.target.closest('.tab'); if (!t) return;
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
    const sec = document.getElementById('cat-' + t.dataset.cat);
    if (sec) window.scrollTo({ top: sec.offsetTop - 110, behavior: 'smooth' });
  };
  document.getElementById('sections').onclick = e => {
    const b = e.target.closest('[data-add]'); if (!b) return;
    const meal = mealById(b.dataset.add);
    if (meal.option_groups && meal.option_groups.length) mealSheet(meal);
    else { addToCart(meal, 1, {}, 0, ''); toast(meal.short_name + ' added'); }
  };
  renderCartBar();
}

function renderCartBar() {
  const slot = document.getElementById('cartbar-slot');
  if (!slot) return;
  const n = cartCount();
  slot.innerHTML = n === 0 ? '' : `
    <button class="cartbar" onclick="location.hash='#/cart'">
      <span class="basket">🧺<span class="bubble">${n}</span></span>
      <span class="mid"><span class="l1">Total</span><br><span class="l2">${fmt(cartSubtotal())}</span></span>
      <span class="go">CHECK OUT (${n}) ›</span>
    </button>`;
}

function addToCart(meal, qty, options, optionsPrice, remarks) {
  S.cart.push({
    uid: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    meal_id: meal.meal_id, qty, options, options_price: optionsPrice, remarks: remarks || '',
  });
  save(); renderCartBar();
}

/* --------------------------------------------------- package option sheet */
function mealSheet(meal, existing) {
  const sel = {};   // groupName -> Set of option names
  (meal.option_groups || []).forEach(g => {
    sel[g.name] = new Set(existing ? (existing.options[g.name] || []) : []);
  });
  let qty = existing ? existing.qty : 1;

  function optPrice() {
    let p = 0;
    (meal.option_groups || []).forEach(g => g.options.forEach(o => { if (sel[g.name].has(o.name)) p += o.price; }));
    return p;
  }
  function valid() { return (meal.option_groups || []).every(g => !g.required || sel[g.name].size >= 1); }

  let animated = false;
  function paint() {
    $sheet.innerHTML = `
      <div class="sheet-mask"><div class="sheet"${animated ? ' style="animation:none"' : ''}>
        <div class="pkg-hero" style="background:linear-gradient(145deg,${meal.color1},${meal.color2})">
          ${meal.emoji}
          <button class="x" id="pkg-x">✕</button>
        </div>
        <div class="pkg-head">
          <div class="nm">${esc(meal.short_name)}</div>
          <div class="pr">${fmt(meal.price)}</div>
          <div class="ds">${esc(meal.desc || '')}</div>
        </div>
        ${(meal.option_groups || []).map((g, gi) => `
          <div class="og" data-g="${gi}">
            <div class="og-head">
              <div>
                <div class="og-name">${esc(g.name)}</div>
                <div class="og-req ${g.required && sel[g.name].size === 0 ? 'must' : 'done'}">
                  ${g.required ? 'Must be selected' : 'Optional'} max. ${g.max}
                </div>
              </div>
              ${(!g.required || sel[g.name].size > 0) ? '<span class="ok">✔</span>' : ''}
            </div>
            ${g.options.map((o, oi) => `
              <div class="opt" data-g="${gi}" data-o="${oi}">
                <span>${esc(o.name)}</span>
                <span style="display:flex;align-items:center">
                  ${o.price ? `<span class="op-price">+${fmt(o.price)}</span>` : ''}
                  <span class="cbox ${sel[g.name].has(o.name) ? 'on' : ''}">${sel[g.name].has(o.name) ? '✔' : ''}</span>
                </span>
              </div>`).join('')}
          </div>`).join('')}
        <div class="sheet-foot">
          <div class="tot-row">
            <span>Total Order</span>
            <span class="stepper">
              <button id="q-minus">−</button><b>${qty}</b><button id="q-plus">+</button>
            </span>
          </div>
          <button class="btn-primary" id="pkg-add" ${valid() ? '' : 'disabled'}>
            ${existing ? 'Update Order' : 'Add Orders'}  -  ${fmt((meal.price + optPrice()) * qty)}
          </button>
        </div>
      </div></div>`;
    animated = true;

    const mask = $sheet.querySelector('.sheet-mask');
    mask.onclick = e => {
      if (e.target === mask || e.target.id === 'pkg-x') { $sheet.innerHTML = ''; return; }
      const opt = e.target.closest('.opt');
      if (opt) {
        const g = meal.option_groups[Number(opt.dataset.g)];
        const o = g.options[Number(opt.dataset.o)];
        const set = sel[g.name];
        if (set.has(o.name)) set.delete(o.name);
        else {
          if (g.max === 1) set.clear();
          if (set.size < g.max) set.add(o.name); else { toast('Max ' + g.max + ' for ' + g.name); return; }
        }
        paint(); return;
      }
      if (e.target.id === 'q-plus') { qty++; paint(); }
      if (e.target.id === 'q-minus') { if (qty > 1) qty--; paint(); }
      if (e.target.id === 'pkg-add' && valid()) {
        const options = {};
        for (const [k, v] of Object.entries(sel)) if (v.size) options[k] = [...v];
        if (existing) {
          existing.qty = qty; existing.options = options; existing.options_price = optPrice();
          save();
          $sheet.innerHTML = '';
          if (location.hash.includes('cart')) renderCart(); else renderCartBar();
        } else {
          addToCart(meal, qty, options, optPrice(), '');
          $sheet.innerHTML = '';
          toast(meal.short_name + ' added');
        }
      }
    };
  }
  paint();
}

/* -------------------------------------------------------------------- cart */
function renderCart() {
  if (S.cart.length === 0) {
    $app.innerHTML = `
      <div class="topbar"><button class="back" onclick="location.hash='#/menu'">←</button><h1>Order</h1></div>
      <div class="wrap center mt16"><div style="font-size:50px">🧺</div>
        <p class="muted mt8">Your cart is empty</p>
        <button class="btn-ghost mt16" onclick="location.hash='#/menu'">Back to Menu</button></div>`;
    return;
  }
  const dinein = S.session.mode === 'dinein';
  $app.innerHTML = `
    <div class="topbar"><button class="back" id="cback">←</button><h1 class="center" style="text-align:center">Order</h1><span style="width:36px"></span></div>
    <div class="wrap">
      <div class="ordertype"><span>Order Type</span><b>${dinein ? 'Dine In' : 'Takeout'} ✓</b></div>
      <div class="card">
        <div class="sec-head"><h3>Ordered Items (${cartCount()})</h3>
          <button class="add-item" onclick="location.hash='#/menu'">+ Add Item</button></div>
        <div id="citems">
          ${S.cart.map(i => {
            const m = mealById(i.meal_id);
            const subs = Object.entries(i.options || {}).flatMap(([g, arr]) => arr.map(o => `1x ${esc(o)}`));
            return `
            <div class="citem" data-uid="${i.uid}">
              <div class="n"><span>${esc(m.short_name)}</span>
                ${m.option_groups ? `<button class="edit" data-edit="${i.uid}">✏️ Edit</button>` : ''}</div>
              ${subs.length ? `<div class="sub">${subs.join('<br>')}</div>` : ''}
              <div class="note">${i.remarks ? '📝 ' + esc(i.remarks) : '📝 No notes yet'}</div>
              <div class="row">
                <span class="pr">${fmt((m.price + i.options_price) * i.qty)}</span>
                <span class="stepper">
                  <button data-dec="${i.uid}">−</button><b>${i.qty}</b><button data-inc="${i.uid}">+</button>
                </span>
              </div>
            </div>`;
          }).join('')}
        </div>
      </div>
      <div class="notes-row">✍️ <input id="order-note" placeholder="Add another notes" value="${esc(S.session.note || '')}"></div>
      <div class="card pay-detail">
        <h3>Payment Details</h3>
        <div class="pd-row"><span class="lbl">Subtotal <span class="muted">(${cartCount()} menu)</span></span><span>${fmt(cartSubtotal())}</span></div>
        <div class="pd-row"><span class="lbl">Rounding</span><span>${fmt(0)}</span></div>
        <div class="pd-row"><span class="lbl">Other fees (10%)</span><span>${fmt(serviceFee())}</span></div>
        <div class="pd-row total"><span>Total</span><span class="val">${fmt(cartTotal())}</span></div>
      </div>
    </div>
    <div class="footbar">
      <span class="tp"><span class="l1">Total Payment</span><br><span class="l2">${fmt(cartTotal())}</span></span>
      <button class="btn-primary" id="to-pay">Continue to Payment</button>
    </div>`;

  document.getElementById('cback').onclick = () => go('menu');
  document.getElementById('order-note').onchange = e => { S.session.note = e.target.value; save(); };
  document.getElementById('citems').onclick = e => {
    const inc = e.target.closest('[data-inc]'), dec = e.target.closest('[data-dec]'), ed = e.target.closest('[data-edit]');
    if (inc) { S.cart.find(i => i.uid === inc.dataset.inc).qty++; save(); renderCart(); }
    if (dec) {
      const i = S.cart.find(x => x.uid === dec.dataset.dec);
      i.qty--; if (i.qty <= 0) S.cart = S.cart.filter(x => x !== i);
      save(); renderCart();
    }
    if (ed) {
      const i = S.cart.find(x => x.uid === ed.dataset.edit);
      mealSheet(mealById(i.meal_id), i);
    }
  };
  document.getElementById('to-pay').onclick = () => go('payment');
}

/* ----------------------------------------------------------------- payment */
function renderPayment() {
  if (S.cart.length === 0) { go('menu'); return; }
  const dinein = S.session.mode === 'dinein';
  const pm = S.config.payment_methods; // {'00':'Cash',...}
  const online = [['QR', 'QRIS (simulated)', '01'], ['04', pm['04'] + ' 銀聯', '04']];
  const cashier = [['00', pm['00'] + ' 現金', '00'], ['01', pm['01'] + ' 刷卡', '01'], ['02', pm['02'] + ' 紅利', '02'], ['03', pm['03'] + ' 分期', '03']];
  let payType = 'online', method = online[0];

  function paint() {
    const methods = payType === 'online' ? online : cashier;
    if (!methods.includes(method)) method = methods[0];
    $app.innerHTML = `
      <div class="topbar"><button class="back" id="pback">←</button><h1 style="text-align:center">Payment</h1><span style="width:36px"></span></div>
      <div class="wrap">
        <div class="ordertype"><span>Order Type</span><b>${dinein ? 'Dine In' : 'Takeout'} ✓</b></div>
        <div>
          <h3 style="font-size:16px;font-weight:800">Customer Information</h3>
          <div class="flabel">Help us serve you better<span class="req">*</span></div>
          <div class="finput"><span class="fi">👤</span><input id="f-name" placeholder="Enter your name" value="${esc(S.session.custName || '')}"></div>
          <div class="flabel">Phone Number (for upcoming promos)</div>
          <div class="finput"><span class="fi">📞</span><input id="f-phone" placeholder="Phone Number" value="${esc(S.session.custPhone || '')}"></div>
          <div class="flabel">Send Receipt to Email</div>
          <div class="finput"><span class="fi">✉️</span><input id="f-email" placeholder="Email"></div>
          ${dinein ? `
          <div class="flabel">Table Number<span class="req">*</span></div>
          <div class="finput"><span class="fi">🍽️</span><input id="f-table" value="${esc(S.session.table ? S.session.table.name : '')}" readonly></div>` : ''}
        </div>
        <div class="promo-row"><span>🎟️ Add Promos or Vouchers</span><span>›</span></div>
        <div>
          <h3 style="font-size:16px;font-weight:800;margin-bottom:10px">Payment Method</h3>
          <div class="paytype">
            <button id="pt-online" class="${payType === 'online' ? 'sel' : ''}">💳 Online Payment</button>
            <button id="pt-cashier" class="${payType === 'cashier' ? 'sel' : ''}">💵 Pay at Cashier</button>
          </div>
          <h3 style="font-size:15px;font-weight:800;margin:16px 0 10px">Complete Payment</h3>
          <div id="methods">
            ${methods.map(m => `
              <div class="method ${m === method ? 'sel' : ''}" data-code="${m[0]}">
                <span class="mi">${m[0] === 'QR' ? '🔳' : m[2] === '00' ? '💵' : m[2] === '01' ? '💳' : m[2] === '02' ? '🎁' : m[2] === '03' ? '📆' : '🏦'}</span>
                <span class="mn">${esc(m[1])}</span><span class="radio"></span>
              </div>`).join('')}
          </div>
        </div>
      </div>
      <div class="footbar">
        <span class="tp"><span class="l1">Payment Total</span><br><span class="l2">${fmt(cartTotal())}</span></span>
        <button class="btn-primary" id="do-pay">Pay</button>
      </div>`;

    document.getElementById('pback').onclick = () => go('cart');
    document.getElementById('pt-online').onclick = () => { payType = 'online'; paint(); };
    document.getElementById('pt-cashier').onclick = () => { payType = 'cashier'; paint(); };
    document.getElementById('methods').onclick = e => {
      const el = e.target.closest('.method'); if (!el) return;
      method = (payType === 'online' ? online : cashier).find(m => m[0] === el.dataset.code);
      paint();
    };
    document.getElementById('do-pay').onclick = doPay;
  }

  async function doPay() {
    const name = document.getElementById('f-name').value.trim();
    if (!name) { toast('Please enter your name'); return; }
    S.session.custName = name;
    S.session.custPhone = document.getElementById('f-phone').value.trim();
    save();
    const btn = document.getElementById('do-pay');
    btn.disabled = true; btn.textContent = 'Processing…';

    // 1) create the order (simulation of the POS -> KDS flow)
    const out = await api('checkout', {
      type: S.session.mode, table_id: S.session.table ? S.session.table.id : null,
      guest_count: S.session.pax ? parseInt(S.session.pax) || 2 : 2,
      customer: { name, phone: S.session.custPhone },
      note: S.session.note || '',
      meals: S.cart.map(i => ({
        meal_id: i.meal_id, quantity: i.qty, options_price: i.options_price,
        remarks: [Object.entries(i.options || {}).map(([g, a]) => a.join(', ')).filter(Boolean).join(' / '), i.remarks].filter(Boolean).join(' · '),
      })),
    });
    if (!out.status) { toast('Checkout failed: ' + out.msg); btn.disabled = false; btn.textContent = 'Pay'; return; }

    S.lastOrder = {
      order_no: out.data.order_no, reservation_id: out.data.reservation_id,
      mode: S.session.mode, table: S.session.table, paid: false,
      payment_method: method[2], pay_at_cashier: payType === 'cashier',
      total: cartTotal(),
    };
    S.cart = []; save();

    // 2) online payment settles immediately through the KDS status endpoints
    if (payType === 'online') {
      const pay = await api('pay', S.session.mode === 'dinein'
        ? { mode: 'dinein', reservation_id: S.lastOrder.reservation_id, payment_method: method[2] }
        : { mode: 'walkin', order_no: S.lastOrder.order_no, payment_method: method[2] });
      S.lastOrder.paid = !!pay.status;
      save();
    }
    go('status');
  }
  paint();
}

/* ------------------------------------------------------------------ status */
async function renderStatus() {
  const o = S.lastOrder;
  if (!o) { go('home'); return; }
  $app.innerHTML = `
    <div class="topbar"><button class="back" onclick="location.hash='#/home'">←</button><h1 style="text-align:center">Order Status</h1><span style="width:36px"></span></div>
    <div class="success-hero">
      <div class="big">${o.paid ? '✅' : '🧾'}</div>
      <h2>${o.paid ? 'Payment Successful!' : 'Order Placed!'}</h2>
      <p>${o.paid ? 'Your order has been paid & sent to the kitchen.' : o.pay_at_cashier ? 'Please pay at the cashier with your order number.' : 'Your order is being processed.'}</p>
    </div>
    <div class="wrap">
      <div class="ordno">Order No: ${esc(o.order_no)}</div>
      ${o.mode === 'dinein' && o.table ? `<div class="banner-card"><div class="tno">Table Number: <b>${esc(o.table.name)}</b></div></div>` : ''}
      <div class="card"><h3 style="font-size:15.5px;font-weight:800;margin-bottom:6px">Kitchen Status <span class="muted">(live from KDS)</span></h3>
        <div id="meals-live"><div class="center mt8"><span class="spin"></span></div></div>
      </div>
      <div id="pay-slot"></div>
      <button class="btn-ghost" onclick="location.hash='#/menu'">Order More</button>
      <button class="btn-ghost" onclick="sessionStorage.clear();location.hash='#/home'">New Session</button>
    </div>`;

  async function poll() {
    const out = await api('kds/orders/details', { order_id: o.order_no });
    const box = document.getElementById('meals-live');
    if (!box) return;
    if (!out.status) { box.innerHTML = `<p class="muted">No details (${esc(out.msg)})</p>`; return; }
    const ord = out.data.order;
    box.innerHTML = `
      ${out.data.order_meals.map(m => `
        <div class="meal-status">
          <span>${m.quantity}× ${esc(m.meal_name)}${m.remarks ? `<br><span class="muted">${esc(m.remarks)}</span>` : ''}</span>
          <span class="badge ${esc(m.status)}">${esc(m.status)}</span>
        </div>`).join('')}
      <div class="pd-row total" style="margin-top:8px"><span>Total</span><span class="val">${fmt(Number(ord.total_price))}</span></div>
      <div class="pd-row"><span class="lbl">Order status</span><span><span class="badge ${ord.status === 'paid' ? 'PAID' : 'PREPARING'}">${esc(ord.status)}</span></span></div>`;
    const slot = document.getElementById('pay-slot');
    if (slot) {
      if (ord.status !== 'paid' && o.pay_at_cashier) {
        slot.innerHTML = `<button class="btn-primary" id="paid-cashier">I have paid at the cashier</button>`;
        document.getElementById('paid-cashier').onclick = async () => {
          const pay = await api('pay', o.mode === 'dinein'
            ? { mode: 'dinein', reservation_id: o.reservation_id, payment_method: o.payment_method }
            : { mode: 'walkin', order_no: o.order_no, payment_method: o.payment_method });
          if (pay.status) { o.paid = true; save(); toast('Payment recorded'); poll(); }
          else toast('KDS error: ' + pay.msg);
        };
      } else slot.innerHTML = '';
    }
  }
  poll();
  S.statusTimer = setInterval(poll, 5000);
}

/* ----------------------------------------------------------- takeout board */
async function renderTakeout() {
  $app.innerHTML = `
    <div class="topbar"><button class="back" onclick="location.hash='#/home'">←</button><h1>Takeout Board 外帶看板</h1></div>
    <div class="wrap" id="tk-wrap"><div class="center mt16"><span class="spin"></span></div></div>`;
  const out = await api('kds/walkIns/get', {});
  const wrap = document.getElementById('tk-wrap');
  if (!out.status) { wrap.innerHTML = `<p class="center muted">KDS error: ${esc(out.msg)}</p>`; return; }
  const nos = out.data.order_nos || [];
  wrap.innerHTML = `
    <div class="card"><b>Open walk-in orders</b><p class="muted mt8">Live from <code>walkIns/get</code> — tap an order to view & settle it.</p></div>
    ${nos.length === 0 ? '<p class="center muted mt16">No open takeout orders 🎉</p>' : ''}
    <div id="tk-list">${nos.map(n => `
      <button class="tk-row" data-no="${esc(n)}" style="width:100%"><b>${esc(n)}</b><span class="chev">›</span></button>`).join('')}
    </div>
    <div id="tk-detail"></div>`;
  document.getElementById('tk-list').onclick = async e => {
    const b = e.target.closest('[data-no]'); if (!b) return;
    const d = await api('kds/orders/details', { order_id: b.dataset.no });
    const box = document.getElementById('tk-detail');
    if (!d.status) { box.innerHTML = `<p class="muted center">Error: ${esc(d.msg)}</p>`; return; }
    const ord = d.data.order;
    box.innerHTML = `
      <div class="card mt8">
        <div class="ordno">${esc(ord.order_no)}</div>
        ${d.data.order_meals.map(m => `
          <div class="meal-status"><span>${m.quantity}× ${esc(m.meal_name)}</span>
          <span class="badge ${esc(m.status)}">${esc(m.status)}</span></div>`).join('')}
        <div class="pd-row total"><span>Total</span><span class="val">${fmt(Number(ord.total_price))}</span></div>
        ${ord.status !== 'paid' ? `<button class="btn-primary mt8" id="tk-pay" style="margin-top:10px">Mark as Paid (Cash)</button>` : '<p class="center muted mt8">Paid ✓</p>'}
      </div>`;
    const payBtn = document.getElementById('tk-pay');
    if (payBtn) payBtn.onclick = async () => {
      const r = await api('pay', { mode: 'walkin', order_no: ord.order_no, payment_method: '00' });
      if (r.status) { toast('Marked as paid'); renderTakeout(); } else toast('Error: ' + r.msg);
    };
  };
}

/* -------------------------------------------------------------------- boot */
(async function boot() {
  const [config, menu] = await Promise.all([api('config'), api('menu')]);
  S.config = config; S.menu = menu;
  route();
})();
