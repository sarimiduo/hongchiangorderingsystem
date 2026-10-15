'use strict';
/* Edo Sushi Ordering — the stack of coloured plates (the kaiten bill) as the interface.
 * Journey: home → (dine-in: table + pax | takeout) → menu (the belt) → slip (the stack) → Save Order → status (pay at the cashier).
 * Backed by the Hong-Chiang KDS API (the SaaS vendor's kitchen display) via /api/kds/* (tables/search,
 * orders/details, walkIns/get) plus the app's own /api/menu, /api/checkout and /api/bridge/* (proxied from midhong).
 */

const $app = document.getElementById('app');
const $sheet = document.getElementById('sheet-root');
const $toast = document.getElementById('toast-root');
const CALM = matchMedia('(prefers-reduced-motion: reduce)');

const S = {
  config: null,
  menu: null,
  session: load('hc_session', { mode: null, table: null, pax: null, note: '' }),
  cart: load('hc_cart', []),
  lastOrder: load('hc_last_order', null),
  timers: [],
  observers: [],
};

/* Real pictures of this subject's world, found in the open collections and downloaded into /img
 * (credits in FOOTER_CREDITS): Edo-period prints for the name, a real plate stack for the ritual.
 * They show the world around the restaurant, never its own dishes. */
const PHOTOS = {
  nihonbashi: { src: '/img/edo-nihonbashi.jpg',  w: 1200, h: 1779, pos: '50% 40%', cap: 'Nihonbashi, Edo, 1858 (Hiroshige)',
                alt: 'Woodblock print of a crowded street of shops in Edo, with parasols and a large decorated umbrella, by Hiroshige' },
  sushi:      { src: '/img/edo-sake-sushi.jpg',  w: 1600, h: 1211, pos: '60% 60%', cap: 'New Year’s sake and sushi, Edo, about 1810',
                alt: 'Woodblock print of a tray of rolled and pressed sushi beside a patterned cup of sake, with a poem' },
  bonito:     { src: '/img/edo-bonito.jpg',      w: 1600, h: 1093, pos: '40% 60%', cap: 'Bonito, Hiroshige, about 1832',
                alt: 'Woodblock print of a blue bonito lying beside sprigs of saxifrage, with calligraphy above' },
  fish:       { src: '/img/edo-flying-fish.jpg', w: 1600, h: 1112, pos: '50% 50%', cap: 'Flying fish and ichimochi, Hiroshige, about 1840',
                alt: 'Woodblock print of a flying fish and a white croaker on a pale ground' },
  stack:      { src: '/img/plate-stack.jpg',     w: 1200, h: 1800, pos: '50% 45%', cap: 'Plates at a sushi belt, Taiwan',
                alt: 'A tall stack of empty orange, black and white plates beside a sushi conveyor belt' },
  piled:      { src: '/img/plates-piled.jpg',    w: 1200, h: 1600, pos: '50% 50%', cap: 'Plates piled up, Ueno, Tokyo',
                alt: 'Empty sushi plates piled high on a counter at a conveyor-belt restaurant in Tokyo' },
};
const FOOTER_CREDITS = 'Pictures: '
  + '<a href="https://www.artic.edu/artworks/34241">“View of Nihonbashi Tori-itchome”</a> (1858) and <a href="https://www.artic.edu/artworks/26727">“Bonito and saxifrage”</a> and <a href="https://www.artic.edu/artworks/26724">“Flying fish and ichimochi”</a> by Utagawa Hiroshige, the Art Institute of Chicago, <a href="https://creativecommons.org/publicdomain/zero/1.0/">CC0</a>; '
  + '<a href="https://www.metmuseum.org/art/collection/search/54455">“New Year’s Sake and Sushi”</a> (about 1810), the Metropolitan Museum of Art, <a href="https://creativecommons.org/publicdomain/zero/1.0/">CC0</a>; '
  + '<a href="https://commons.wikimedia.org/w/index.php?curid=179146020">“A stack of empty sushi plates at a conveyor belt sushi restaurant in Taiwan”</a>, <a href="https://creativecommons.org/licenses/by-sa/4.0/">CC BY-SA 4.0</a>; '
  + '<a href="https://commons.wikimedia.org/w/index.php?curid=56825774">“お皿が山積み”</a> by Taichiro Ueki, <a href="https://creativecommons.org/licenses/by/2.0/">CC BY 2.0</a>. '
  + 'Footage: <a href="https://commons.wikimedia.org/wiki/File:Moving_Sushi_P1130190.ogv">“Moving Sushi”</a> (2012), <a href="https://creativecommons.org/licenses/by-sa/3.0/">CC BY-SA 3.0</a>, via Wikimedia Commons.';

const BRIDGE_STAGES = [
  ['queued', 'Sent to the till bridge'],
  ['picked_up', 'Picked up by the branch agent'],
  ['table_opened', 'Table opened on the ESB till'],
  ['order_saved', 'Order saved, table marked occupied'],
  ['waiting_cashier', 'Waiting for the cashier'],
  ['settled', 'Bill settled'],
];

/* ------------------------------------------------------------------ helpers */
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
function cjk(s) { const m = String(s || '').match(/[぀-ヿ㐀-鿿][぀-ヿ㐀-鿿\s]*/); return m ? m[0].trim() : ''; }
/* every item is a plate of one colour; the catalog says which, else the price tier decides */
function plateOf(meal) {
  if (meal.plate) return meal.plate;
  const tiers = (S.menu.store && S.menu.store.plates) || {};
  let best = 'red';
  for (const [c, p] of Object.entries(tiers)) if (meal.price >= p && p >= (tiers[best] || 0)) best = c;
  return best;
}
function plateHTML(colour, cls) { return `<span class="plate plate-${esc(colour)} ${cls || ''}" aria-hidden="true"></span>`; }
function plateCounts(cart) {
  const counts = {};
  for (const i of cart) { const c = plateOf(mealById(i.meal_id)); counts[c] = (counts[c] || 0) + i.qty; }
  return counts;
}
function stackHTML(counts, limit = 18) {
  const order = ['red', 'blue', 'green', 'black', 'gold'];
  const plates = order.flatMap(c => Array(counts[c] || 0).fill(c));
  if (!plates.length) return '';
  const shown = plates.slice(0, limit);
  return `<div class="stack" aria-hidden="true">${shown.map(c => plateHTML(c)).join('')}</div>`;
}
function stackSummary(counts) {
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (!total) return '';
  const parts = ['red', 'blue', 'green', 'black', 'gold'].filter(c => counts[c]).map(c => `${counts[c]} ${c}`);
  return `<p class="stack-sum">${total} ${total === 1 ? 'plate' : 'plates'} <span>${parts.join(', ')}</span></p>`;
}
function word(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); }
function norm(s) { return String(s || '').trim().toLowerCase().replace(/^(table|meja|t)\s*/, ''); }
function hours() { return (S.menu && S.menu.store && S.menu.store.hours) || 'Open today 10:00–22:00'; }

function mealById(id) { return S.menu.meals.find(m => m.meal_id === Number(id)); }
function cartCount() { return S.cart.reduce((s, i) => s + i.qty, 0); }
function cartQty(mealId) { return S.cart.filter(i => i.meal_id === Number(mealId)).reduce((s, i) => s + i.qty, 0); }
function itemPrice(i) { const m = mealById(i.meal_id); return (m.price + i.options_price) * i.qty; }
function cartSubtotal() { return S.cart.reduce((s, i) => s + itemPrice(i), 0); }
function serviceFee() { return Math.round(cartSubtotal() * 0.1); }
function cartTotal() { return cartSubtotal() + serviceFee(); }

/* ------------------------------------------------------------------- motion */
function startCrossfade(fig, every = 5500) {
  if (!fig) return;
  const imgs = [...fig.querySelectorAll('img')];
  if (imgs.length < 2 || CALM.matches) return;
  let i = imgs.findIndex(im => im.classList.contains('is-on')); if (i < 0) i = 0;
  const step = () => {
    if (document.hidden || fig.dataset.hold) return;
    imgs[i].classList.remove('is-on'); i = (i + 1) % imgs.length; imgs[i].classList.add('is-on');
  };
  const first = setTimeout(step, 2200);
  const t = setInterval(step, every);
  S.timers.push(t, first);
}
function showPhoto(fig, key) {
  if (!fig) return;
  fig.querySelectorAll('img').forEach(im => im.classList.toggle('is-on', im.dataset.key === key));
}
function reveal(root) {
  const els = [...(root || $app).querySelectorAll('[data-reveal]:not(.is-in)')];
  if (!els.length) return;
  const io = new IntersectionObserver(es => {
    for (const e of es) if (e.isIntersecting) { e.target.classList.add('is-in'); io.unobserve(e.target); }
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.05 });
  els.forEach(el => io.observe(el));
  S.observers.push(io);
}
function calmVideos() {
  for (const v of document.querySelectorAll('video[autoplay]')) {
    const sync = () => { if (CALM.matches) { v.removeAttribute('autoplay'); v.pause(); } else { v.play().catch(() => {}); } };
    sync(); CALM.addEventListener('change', sync);
  }
}

/* ---------------------------------------------------------------- fragments */
const WORDMARK = `<a class="wordmark" href="#/">Edo Sushi <span lang="ja">江戸</span></a>`;
function topnav(left, right) { return `<nav class="topnav" aria-label="Top">${left}${WORDMARK}${right}</nav>`; }
function photoStack(keys, { eager } = {}) {
  return `<figure class="photos" data-photos="${keys.join(',')}">${keys.map((k, i) => {
    const p = PHOTOS[k];
    return `<img src="${p.src}" width="${p.w}" height="${p.h}" alt="${esc(p.alt)}" style="object-position:${p.pos}" class="${i === 0 ? 'is-on' : ''}" data-key="${k}" ${i === 0 && eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async">`;
  }).join('')}</figure>`;
}
function hoursBar(right) { return `<div class="hours" data-rise style="--i:2"><span>${esc(hours())}</span><span>${right || 'Pay at the counter'}</span></div>`; }
function slipDemo() {
  const demo = { red: 3, blue: 1, gold: 1 };
  return `<div class="slipdemo" data-ui data-state="1" aria-hidden="true">
    <div class="sd-head"><span class="sd-table">5</span><span class="sd-meta">Table 卓<br>2 orang</span></div>
    <div class="sd-stack">${stackHTML(demo)}${stackSummary(demo)}</div>
    <ul class="sd-lines">
      <li>${plateHTML('red')}<span>3 × Salmon</span><span>Rp45.000</span></li>
      <li>${plateHTML('blue')}<span>1 × Maguro, tuna</span><span>Rp20.000</span></li>
      <li>${plateHTML('gold')}<span>1 × Ikura, salmon roe</span><span>Rp40.000</span></li>
    </ul>
    <p class="sd-empty">No plates on the stack yet</p>
    <dl class="sd-sum"><div><dt>Subtotal</dt><dd>Rp105.000</dd></div><div><dt>Service 10%</dt><dd>Rp10.500</dd></div><div class="tot"><dt>Total</dt><dd>Rp115.500</dd></div></dl>
    <div class="sd-stamp">Paid 済<small>bill 2026101500017</small></div>
  </div>`;
}
function footer() {
  return `<footer class="foot">
    <img class="foot-img" src="/img/sushi-train-poster.jpg" width="1280" height="720" alt="" loading="lazy" decoding="async">
    <video autoplay muted loop playsinline preload="metadata" poster="/img/sushi-train-poster.jpg" width="854" height="480" aria-hidden="true"><source src="/img/sushi-train.webm" type="video/webm"></video>
    <div class="foot-top">
      <nav aria-label="Pages"><a href="#/tables">Dine-in</a><a href="#/menu?mode=walkin">Takeout</a><a href="#/takeout">Takeout board</a><a href="#/bridge">Bridge monitor</a></nav>
      <p>${esc(hours())}<br>Pay by the plate at the counter</p>
    </div>
    <div>
      <p class="foot-name" aria-hidden="true">Edo Sushi <span lang="ja">江戸</span></p>
      <p class="credits">${FOOTER_CREDITS}</p>
    </div>
  </footer>`;
}

/* ------------------------------------------------------------------ router */
const routes = {
  '': renderHome, home: renderHome, tables: renderTables, menu: renderMenu,
  cart: renderCart, status: renderStatus, takeout: renderTakeout, bridge: renderBridge,
};
function go(r) { location.hash = '#/' + r; }
function cleanup() {
  S.timers.forEach(clearInterval); S.timers = [];
  S.observers.forEach(o => o.disconnect()); S.observers = [];
  $sheet.innerHTML = '';
}
window.addEventListener('hashchange', route);
function route() {
  cleanup();
  const raw = location.hash.replace(/^#\/?/, '');
  const [name, qs] = raw.split('?');
  const q = new URLSearchParams(qs || '');
  if (q.get('mode')) { // deep link, e.g. a QR code on the table: #/menu?mode=dinein&table=5
    S.session.mode = q.get('mode') === 'dinein' ? 'dinein' : 'walkin';
    if (S.session.mode === 'walkin') { S.session.table = null; S.session.pax = null; }
    else if (q.get('table')) S.session.table = { id: Number(q.get('table_id')) || null, name: q.get('table') };
    if (q.get('pax')) S.session.pax = q.get('pax');
    save();
  }
  (routes[name] || renderHome)(q);
  window.scrollTo(0, 0);
}

/* -------------------------------------------------------------------- home */
function renderHome() {
  $app.innerHTML = `
    <div class="stage home">
      <aside class="still" id="still" data-show="photo">
        ${photoStack(['nihonbashi', 'sushi', 'bonito', 'fish'], { eager: true })}
        <div class="stage-slip">${slipDemo()}</div>
        ${hoursBar()}
      </aside>
      <section class="sheet">
        ${topnav(`<a href="#/menu?mode=walkin">Takeout</a>`, `<a href="#/takeout">Board</a>`)}
        <div class="hero">
          <h1 class="head" data-rise style="--i:0">Order here,<br>pay by the plate</h1>
          <p class="lead" data-rise style="--i:1">Take plates from the belt or tick them here. Every plate has a colour and a price, and the cashier counts your stack at the counter.</p>
          <a class="button" href="#/tables" data-rise style="--i:2">Order dine-in</a>
          <a class="link" href="#/menu?mode=walkin" data-rise style="--i:3">Order for takeout</a>
        </div>
        <section class="howit" id="howit" aria-labelledby="howit-h">
          <h2 class="lead-h" id="howit-h">How the plates work</h2>
          <ol class="statements">
            <li data-step="1"><p class="statement">Pick your plates.</p><p>Every item on the belt is a plate of one colour. Tap it and it joins your stack, with its price.</p></li>
            <li data-step="2"><p class="statement">The kitchen sends them.</p><p>Your stack goes straight to the kitchen display and to the till. The plates come down the lane to your seat.</p></li>
            <li data-step="3"><p class="statement">Pay by the plate.</p><p>Show the cashier your table number. The stack is counted by colour, settled, and stamped paid.</p></li>
          </ol>
        </section>
        <section class="tablefield" aria-labelledby="tf-h">
          <p class="prompt" id="tf-h"><span class="muted">Which table are you at?</span><br>Type the number on your table stand</p>
          <form id="table-form" autocomplete="off">
            <label class="sr-only" for="table-input">Table number</label>
            <input class="field" id="table-input" inputmode="numeric" placeholder="5">
            <button class="go" type="submit" aria-label="Check the table">→</button>
          </form>
          <p class="after small" id="table-msg">We check it against the floor plan before you order.</p>
          <dl class="facts">
            <div><dt>Hours</dt><dd>${esc(hours())}</dd></div>
            <div><dt>Plates</dt><dd>${platePrices()}</dd></div>
            <div><dt>Takeout</dt><dd><a href="#/menu?mode=walkin">Order and collect at the counter</a></dd></div>
            <div><dt>Floor plan</dt><dd><a href="#/tables">Pick a table from the list</a></dd></div>
          </dl>
        </section>
      </section>
    </div>
    ${footer()}`;

  startCrossfade(document.querySelector('#still .photos'));
  howitObserver();
  tableForm();
  calmVideos();
}

function platePrices() {
  const tiers = (S.menu.store && S.menu.store.plates) || {};
  const parts = Object.entries(tiers).sort((a, b) => a[1] - b[1]).map(([c, p]) => `${plateHTML(c)} ${c} ${fmt(p)}`);
  return parts.length ? `<span class="plate-list">${parts.join(', ')}</span>` : 'One price per plate colour';
}

function howitObserver() {
  const still = document.getElementById('still');
  const lis = [...document.querySelectorAll('.statements li')];
  const demos = [...document.querySelectorAll('.slipdemo')];
  const mid = new IntersectionObserver(es => {
    es.forEach(e => {
      if (!e.isIntersecting) return;
      lis.forEach(l => l.classList.toggle('is-active', l === e.target));
      demos.forEach(d => { d.dataset.state = e.target.dataset.step; });
    });
  }, { rootMargin: '-40% 0px -40% 0px', threshold: 0 });
  lis.forEach(l => mid.observe(l));
  const sec = new IntersectionObserver(es => {
    es.forEach(e => { still.dataset.show = e.isIntersecting ? 'slip' : 'photo'; });
  }, { rootMargin: '-30% 0px -30% 0px', threshold: 0 });
  sec.observe(document.getElementById('howit'));
  S.observers.push(mid, sec);
}

function tableForm() {
  const form = document.getElementById('table-form');
  const input = document.getElementById('table-input');
  const msg = document.getElementById('table-msg');
  form.onsubmit = async e => {
    e.preventDefault();
    const want = norm(input.value);
    if (!want) { input.focus(); return; }
    msg.textContent = 'Checking the floor plan…';
    const out = await api('kds/tables/search', {});
    if (!out.status) { msg.textContent = 'The kitchen display did not answer. Pick a table from the list instead.'; return; }
    const t = out.data.find(x => norm(x.name) === want);
    const free = out.data.filter(x => x.status === 'IDLE').map(x => esc(x.name)).join(', ') || 'none';
    if (!t) { msg.innerHTML = `There is no table ${esc(input.value)} on the floor plan. Free now: ${free}.`; return; }
    if (t.status !== 'IDLE') { msg.innerHTML = `Table ${esc(t.name)} is taken right now. Free now: ${free}.`; return; }
    S.session.mode = 'dinein'; S.session.table = { id: t.id, name: t.name }; save();
    msg.textContent = `Table ${t.name} is free.`;
    paxSheet();
  };
}

/* ------------------------------------------------------------- table pick */
async function renderTables() {
  $app.innerHTML = `
    <div class="stage">
      <aside class="still">${photoStack(['bonito', 'nihonbashi', 'sushi', 'fish'])}${hoursBar()}</aside>
      <section class="sheet">
        ${topnav(`<a class="back" href="#/">Home</a>`, `<a href="#/menu?mode=walkin">Takeout</a>`)}
        <h1 class="head" data-rise style="--i:0">Pick a free table</h1>
        <p class="muted" data-rise style="--i:1">Live from the kitchen display. Taken tables are greyed out.</p>
        <div id="tgrid" class="wait">Asking the kitchen display…</div>
      </section>
    </div>`;
  startCrossfade(document.querySelector('.still .photos'));
  const out = await api('kds/tables/search', {});
  const box = document.getElementById('tgrid');
  if (!box) return;
  if (!out.status) { box.textContent = `The kitchen display did not answer (${out.msg}).`; return; }
  box.className = 'tables';
  box.innerHTML = out.data.map((t, i) => {
    const busy = t.status !== 'IDLE';
    return `<button class="tile ${busy ? 'busy' : ''}" data-id="${t.id}" data-name="${esc(t.name)}" ${busy ? 'disabled' : ''} data-reveal style="--i:${i}">
      <b>${esc(t.name)}</b><span>${busy ? 'taken' : t.seats + ' seats'}</span></button>`;
  }).join('');
  box.onclick = e => {
    const c = e.target.closest('.tile'); if (!c || c.disabled) return;
    S.session.mode = 'dinein'; S.session.table = { id: Number(c.dataset.id), name: c.dataset.name }; save();
    paxSheet();
  };
  reveal(box);
}

function paxSheet() {
  const opts = ['2 orang', '3–5 orang', '6–8 orang', '10–15 orang', '15 or more'];
  $sheet.innerHTML = `
    <div class="mask"><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="pax-h">
      <h2 id="pax-h">Makan bersama berapa orang?</h2>
      <p class="muted">How many are eating at table ${esc(S.session.table.name)}?</p>
      <div class="choices">${opts.map(o => `<button class="choice" data-pax="${esc(o)}">${esc(o)}</button>`).join('')}</div>
    </div></div>`;
  $sheet.querySelector('.mask').onclick = e => {
    const b = e.target.closest('.choice');
    if (b) { S.session.pax = b.dataset.pax; save(); $sheet.innerHTML = ''; go('menu'); }
    else if (e.target.classList.contains('mask')) $sheet.innerHTML = '';
  };
}

/* -------------------------------------------------------- menu: the sheet */
function photoFor(cat) {
  const n = String(cat.name).toLowerCase();
  if (/nigiri|sashimi/.test(n)) return 'bonito';
  if (/gunkan|roe/.test(n)) return 'fish';
  if (/maki|roll|sweet|dessert/.test(n)) return 'sushi';
  return 'nihonbashi';
}
function rowHTML(m, i) {
  const zh = cjk(m.meal_name);
  const n = cartQty(m.meal_id);
  const colour = plateOf(m);
  return `<li class="row" data-meal="${m.meal_id}" data-reveal style="--i:${i}">
    ${plateHTML(colour)}
    <button class="row-name" data-open="${m.meal_id}"><span class="nm">${esc(m.short_name)}</span>${zh ? `<span class="zh">${esc(zh)}</span>` : ''}<span class="ds">${esc(colour)} plate${m.desc ? ', ' + esc(m.desc) : ''}</span></button>
    <span class="price nums">${fmt(m.price)}</span>
    ${qtyHTML(m, n)}
  </li>`;
}
function qtyHTML(m, n) {
  return `<span class="qty ${n ? 'on' : ''}">${n ? `<button data-dec="${m.meal_id}" aria-label="One less ${esc(m.short_name)}">−</button><b>${n}</b>` : ''}<button data-inc="${m.meal_id}" aria-label="Add ${esc(m.short_name)}">+</button></span>`;
}
function refreshRow(mealId) {
  const li = document.querySelector(`.row[data-meal="${mealId}"]`);
  if (!li) return;
  const m = mealById(mealId);
  li.querySelector('.qty').outerHTML = qtyHTML(m, cartQty(mealId));
}

function renderMenu() {
  if (!S.session.mode) { go('home'); return; }
  const dinein = S.session.mode === 'dinein';
  const cats = S.menu.categories.filter(c => S.menu.meals.some(m => m.category_id === c.id));
  const keys = [...new Set(cats.map(photoFor))];
  if (dinein && S.session.table && !S.session.table.id) {
    api('kds/tables/search', {}).then(out => {
      if (!out.status) return;
      const t = out.data.find(x => norm(x.name) === norm(S.session.table.name));
      if (t) { S.session.table.id = t.id; save(); }
    });
  }
  $app.innerHTML = `
    <div class="stage">
      <aside class="still still-menu">
        ${photoStack(keys)}
        <p class="cap" id="photo-cap">${esc(PHOTOS[keys[0]].cap)}</p>
        <div class="slip" id="slip"></div>
      </aside>
      <section class="sheet">
        ${topnav(`<a class="back" href="${dinein ? '#/tables' : '#/'}">${dinein ? 'Tables' : 'Home'}</a>`, `<a href="#/cart">Stack</a>`)}
        <h1 class="head head-xl">The belt</h1>
        <p class="lead">${dinein && S.session.table ? `Table ${esc(S.session.table.name)}${S.session.pax ? ', ' + esc(S.session.pax) : ''}` : 'Takeout, collected at the counter'}</p>
        <nav class="cats" id="cats" aria-label="Categories">${cats.map((c, i) => `<a href="#/menu" data-cat="${c.id}" class="${i === 0 ? 'is-on' : ''}">${esc(c.name)}</a>`).join('')}</nav>
        ${cats.map(c => `
          <section class="cat" id="cat-${c.id}" data-photo="${photoFor(c)}">
            <h2>${esc(c.name)}</h2>
            <ul class="rows">${S.menu.meals.filter(m => m.category_id === c.id).map((m, i) => rowHTML(m, i)).join('')}</ul>
          </section>`).join('')}
      </section>
    </div>
    <a class="slipbar" id="slipbar" href="#/cart" hidden></a>`;

  document.getElementById('cats').onclick = e => {
    const a = e.target.closest('a[data-cat]'); if (!a) return;
    e.preventDefault();
    const sec = document.getElementById('cat-' + a.dataset.cat);
    if (sec) sec.scrollIntoView({ behavior: CALM.matches ? 'auto' : 'smooth', block: 'start' });
  };
  $app.querySelector('.sheet').onclick = e => {
    const open = e.target.closest('[data-open]'), inc = e.target.closest('[data-inc]'), dec = e.target.closest('[data-dec]');
    if (open) { mealSheet(mealById(open.dataset.open)); return; }
    if (inc) {
      const meal = mealById(inc.dataset.inc);
      if (meal.option_groups && meal.option_groups.length) mealSheet(meal);
      else { addToCart(meal, 1, {}, 0, ''); toast(meal.short_name + ' on the stack'); }
      return;
    }
    if (dec) {
      const id = Number(dec.dataset.dec);
      const line = [...S.cart].reverse().find(i => i.meal_id === id);
      if (!line) return;
      line.qty--; if (line.qty <= 0) S.cart = S.cart.filter(x => x !== line);
      save(); refreshRow(id); renderSlip();
    }
  };

  const fig = document.querySelector('.still-menu .photos');
  const cap = document.getElementById('photo-cap');
  const catIO = new IntersectionObserver(es => {
    es.forEach(e => {
      if (!e.isIntersecting) return;
      const key = e.target.dataset.photo;
      showPhoto(fig, key); cap.textContent = PHOTOS[key].cap;
      const id = e.target.id.replace('cat-', '');
      document.querySelectorAll('#cats a').forEach(a => a.classList.toggle('is-on', a.dataset.cat === id));
    });
  }, { rootMargin: '-15% 0px -70% 0px', threshold: 0 });
  document.querySelectorAll('.cat').forEach(s => catIO.observe(s));
  S.observers.push(catIO);

  renderSlip();
  reveal();
}

function addToCart(meal, qty, options, optionsPrice, remarks) {
  S.cart.push({
    uid: Date.now() + '-' + Math.random().toString(36).slice(2, 7),
    meal_id: meal.meal_id, qty, options, options_price: optionsPrice, remarks: remarks || '',
  });
  save(); refreshRow(meal.meal_id); renderSlip();
}

/* the slip: sticky beside the menu, a full page on #/cart, a bar on a phone */
function slipHTML({ full } = {}) {
  const dinein = S.session.mode === 'dinein';
  const head = dinein && S.session.table
    ? `<div class="slip-table"><span class="t-num nums">${esc(S.session.table.name)}</span><span class="t-meta">Table 卓${S.session.pax ? '<br>' + esc(S.session.pax) : ''}</span></div>`
    : `<div class="slip-table"><span class="t-meta">Takeout 持ち帰り<br>collected at the counter</span></div>`;
  const counts = plateCounts(S.cart);
  const stack = S.cart.length ? `${stackHTML(counts)}${stackSummary(counts)}` : '';
  const lines = S.cart.length ? `<ul class="slip-lines">${S.cart.map(i => {
    const m = mealById(i.meal_id);
    const ops = Object.values(i.options || {}).flat();
    return `<li data-uid="${i.uid}">
      ${plateHTML(plateOf(m))}
      <span class="ln">${i.qty} × ${esc(m.short_name)}${ops.length ? `<span class="op">${ops.map(esc).join(', ')}</span>` : ''}</span>
      <span class="pr nums">${fmt(itemPrice(i))}</span>
      ${full ? `<span class="ctl"><span class="stepper"><button data-dec-uid="${i.uid}" aria-label="One less">−</button><b>${i.qty}</b><button data-inc-uid="${i.uid}" aria-label="One more">+</button></span>${m.option_groups && m.option_groups.length ? `<button class="ghost" data-edit="${i.uid}">Change options</button>` : ''}</span>` : ''}
    </li>`;
  }).join('')}</ul>` : `<p class="slip-empty">No plates on your stack yet.</p>`;
  const sums = S.cart.length ? `<dl class="sum nums">
      <div><dt>Subtotal</dt><dd>${fmt(cartSubtotal())}</dd></div>
      <div><dt>Service 10%</dt><dd>${fmt(serviceFee())}</dd></div>
      <div class="tot"><dt>Total</dt><dd>${fmt(cartTotal())}</dd></div></dl>` : '';
  const note = S.cart.length ? `<p class="note"><label class="sr-only" for="order-note">A note for the kitchen</label><input class="field" id="order-note" placeholder="A note for the kitchen" value="${esc(S.session.note || '')}"></p>` : '';
  const action = S.cart.length ? `<button class="button button-wide" id="save-order">Save order</button>` : '';
  const title = full ? `<h1 class="head">Your stack</h1>` : `<h2 class="lead-h">Your stack</h2>`;
  return `${title}${head}${stack}${lines}${sums}${note}${action}${!full && S.cart.length ? `<a class="ghost" href="#/cart">Change plates</a>` : ''}`;
}
function bindSlip(slip, repaint) {
  const btn = slip.querySelector('#save-order'); if (btn) btn.onclick = saveOrder;
  const note = slip.querySelector('#order-note'); if (note) note.onchange = e => { S.session.note = e.target.value; save(); };
  slip.onclick = e => {
    const inc = e.target.closest('[data-inc-uid]'), dec = e.target.closest('[data-dec-uid]'), ed = e.target.closest('[data-edit]');
    if (inc) { S.cart.find(i => i.uid === inc.dataset.incUid).qty++; save(); repaint(); }
    if (dec) { const i = S.cart.find(x => x.uid === dec.dataset.decUid); i.qty--; if (i.qty <= 0) S.cart = S.cart.filter(x => x !== i); save(); repaint(); }
    if (ed) { const i = S.cart.find(x => x.uid === ed.dataset.edit); mealSheet(mealById(i.meal_id), i, repaint); }
  };
}
function renderSlip() {
  const slip = document.getElementById('slip');
  if (slip && !slip.classList.contains('slip-full')) { slip.innerHTML = slipHTML(); bindSlip(slip, renderSlip); }
  const bar = document.getElementById('slipbar');
  if (bar) {
    const n = cartCount();
    bar.hidden = n === 0;
    bar.innerHTML = `<span>${n} ${n === 1 ? 'plate' : 'plates'} on your stack</span><b class="nums">${fmt(cartTotal())}</b>`;
  }
}

/* ---------------------------------------------------- options (a dialog) */
function mealSheet(meal, existing, after) {
  const groups = meal.option_groups || [];
  const sel = {};
  groups.forEach(g => { sel[g.name] = new Set(existing ? (existing.options[g.name] || []) : []); });
  let qty = existing ? existing.qty : 1;
  const zh = cjk(meal.meal_name);

  function optPrice() { let p = 0; groups.forEach(g => g.options.forEach(o => { if (sel[g.name].has(o.name)) p += o.price; })); return p; }
  function valid() { return groups.every(g => !g.required || sel[g.name].size >= 1); }

  let painted = false;
  function paint() {
    $sheet.innerHTML = `
      <div class="mask"><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="opt-h"${painted ? ' style="animation:none"' : ''}>
        <button class="x" id="opt-x" aria-label="Close">×</button>
        <h2 id="opt-h">${esc(meal.short_name)}</h2>
        ${zh ? `<p class="zh">${esc(zh)}</p>` : ''}
        <p class="dp nums">${plateHTML(plateOf(meal))} ${fmt(meal.price)}</p>
        ${meal.desc ? `<p class="ds">${esc(meal.desc)}</p>` : ''}
        ${groups.map((g, gi) => `
          <div class="og" data-g="${gi}">
            <h3>${esc(g.name)}</h3>
            <p class="req ${g.required && sel[g.name].size === 0 ? 'must' : ''}">${g.required ? 'Choose one' : 'Optional'}${g.max > 1 ? `, up to ${g.max}` : ''}</p>
            ${g.options.map((o, oi) => `
              <button class="opt ${sel[g.name].has(o.name) ? 'on' : ''}" data-g="${gi}" data-o="${oi}" aria-pressed="${sel[g.name].has(o.name)}">
                <span class="box"></span><span>${esc(o.name)}</span>${o.price ? `<span class="op nums">+${fmt(o.price)}</span>` : '<span class="op"></span>'}
              </button>`).join('')}
          </div>`).join('')}
        <div class="dialog-foot">
          <div class="tot-row"><span>How many</span><span class="stepper"><button id="q-minus" aria-label="One less">−</button><b>${qty}</b><button id="q-plus" aria-label="One more">+</button></span></div>
          <button class="button button-wide" id="pkg-add" ${valid() ? '' : 'disabled'}>${existing ? 'Update the plate' : 'Add to the stack'}, ${fmt((meal.price + optPrice()) * qty)}</button>
        </div>
      </div></div>`;
    painted = true;
    const mask = $sheet.querySelector('.mask');
    mask.onclick = e => {
      if (e.target === mask || e.target.closest('#opt-x')) { $sheet.innerHTML = ''; return; }
      const opt = e.target.closest('.opt');
      if (opt) {
        const g = groups[Number(opt.dataset.g)], o = g.options[Number(opt.dataset.o)], set = sel[g.name];
        if (set.has(o.name)) set.delete(o.name);
        else {
          if (g.max === 1) set.clear();
          if (set.size < g.max) set.add(o.name); else { toast('Up to ' + g.max + ' for ' + g.name); return; }
        }
        paint(); return;
      }
      if (e.target.closest('#q-plus')) { qty++; paint(); }
      if (e.target.closest('#q-minus')) { if (qty > 1) qty--; paint(); }
      if (e.target.closest('#pkg-add') && valid()) {
        const options = {};
        for (const [k, v] of Object.entries(sel)) if (v.size) options[k] = [...v];
        if (existing) {
          existing.qty = qty; existing.options = options; existing.options_price = optPrice();
          save(); $sheet.innerHTML = '';
          if (after) after(); else renderSlip();
        } else {
          addToCart(meal, qty, options, optPrice(), '');
          $sheet.innerHTML = '';
          toast(meal.short_name + ' on the stack');
        }
      }
    };
  }
  paint();
}

/* -------------------------------------------------------------------- slip */
function renderCart() {
  $app.innerHTML = `
    <div class="paper"><div class="inner">
      ${topnav(`<a class="back" href="${S.session.mode ? '#/menu' : '#/'}">${S.session.mode ? 'The belt' : 'Home'}</a>`, `<span></span>`)}
      <div class="slip slip-full" id="slip"></div>
    </div></div>`;
  paintCart();
}
function paintCart() {
  const slip = document.getElementById('slip');
  if (!slip) return;
  slip.innerHTML = slipHTML({ full: true }) + (S.cart.length ? '' : `<p><a class="button" href="${S.session.mode ? '#/menu' : '#/'}">Back to the belt</a></p>`);
  bindSlip(slip, paintCart);
}

/* Save Order — the only customer action: the order goes to the kitchen (KDS)
 * AND is pushed to midhong → local agent → ESB POS (table turns red).
 * Only the ESB cashier can finish it; the status page waits for that. */
async function saveOrder() {
  const btn = document.getElementById('save-order');
  btn.disabled = true; btn.textContent = 'Saving…';
  const out = await api('checkout', {
    type: S.session.mode,
    table_id: S.session.table ? S.session.table.id : null,
    table_name: S.session.table ? S.session.table.name : null,
    guest_count: S.session.pax ? parseInt(S.session.pax) || 2 : 2,
    customer: { name: S.session.custName || 'Guest', phone: S.session.custPhone || '' },
    note: S.session.note || '',
    meals: S.cart.map(i => ({
      meal_id: i.meal_id, quantity: i.qty, options_price: i.options_price,
      remarks: [Object.entries(i.options || {}).map(([, a]) => a.join(', ')).filter(Boolean).join(' / '), i.remarks].filter(Boolean).join(', '),
    })),
  });
  if (!out.status) { toast('Could not save: ' + out.msg); btn.disabled = false; btn.textContent = 'Save order'; return; }
  S.lastOrder = {
    order_no: out.data.order_no, reservation_id: out.data.reservation_id,
    mode: S.session.mode, table: S.session.table, paid: false, total: cartTotal(), plates: plateCounts(S.cart),
  };
  S.cart = []; S.session.note = ''; save();
  go('status');
}

/* ------------------------------------------------------------------ status */
/* The "show the cashier" screen: the table number (or the takeout call number) at display size,
 * then what the till bridge and the kitchen display report. The slip is stamped paid when
 * midhong reports that the ESB cashier settled the bill. #/status?order_no=… reopens an order
 * from the bridge record (after a refresh, or from another device). */
async function renderStatus(q) {
  const want = q && q.get('order_no');
  if (want && (!S.lastOrder || S.lastOrder.order_no !== want)) {
    const st = await api('bridge/status?order_no=' + encodeURIComponent(want));
    if (st && st.stage) {
      S.lastOrder = { order_no: want, mode: st.mode, table: st.table_name ? { name: st.table_name } : null, paid: st.stage === 'settled', total: Number(st.total) || 0 };
      save();
    }
  }
  const o = S.lastOrder;
  if (!o) { go('home'); return; }
  const dinein = o.mode === 'dinein' && o.table;
  const call = String(o.order_no).slice(-4);
  $app.innerHTML = `
    <div class="stage">
      <aside class="still">${photoStack(['stack', 'piled', 'bonito', 'sushi'])}${hoursBar('Show this screen to the cashier')}</aside>
      <section class="sheet cashier">
        <div data-rise style="--i:0">${topnav(`<a class="back" href="#/">Home</a>`, `<span></span>`)}</div>
        <h1 class="display nums" data-rise style="--i:1">${esc(dinein ? o.table.name : call)}</h1>
        <p class="lead" data-rise style="--i:2">${dinein ? `Table 卓 ${esc(o.table.name)}<br><span class="muted">Order ${esc(o.order_no)}</span>` : `Takeout 持ち帰り, order ${esc(o.order_no)}<br><span class="muted">Collect at the counter when ${esc(call)} is called</span>`}</p>
        <p class="total head nums" data-rise style="--i:3">${fmt(o.total)}</p>
        ${o.plates ? `<div class="plates" data-rise style="--i:4">${stackHTML(o.plates)}${stackSummary(o.plates)}</div>` : ''}
        <p class="msg" id="cc-msg" data-rise style="--i:5">${o.paid ? 'Finished, paid.' : 'Pay at the counter. Show this screen to the cashier; the plates are counted by colour.'}</p>
        <div class="stamp" id="stamp" ${o.paid ? '' : 'hidden'}>Paid 済<small id="stamp-sub"></small></div>
        <section class="status-sec" data-reveal><h2 class="lead-h">At the counter</h2><ol class="steps" id="bridge-live"><li class="wait">Asking the till bridge…</li></ol></section>
        <section class="status-sec" data-reveal style="--i:1"><h2 class="lead-h">In the kitchen</h2><ul class="kitchen" id="meals-live"><li class="wait">Asking the kitchen display…</li></ul></section>
        <p class="after-links" data-reveal style="--i:2"><a class="link-plain" href="#/menu">Order more</a><a class="link-plain" href="#/" id="new-session">New session</a></p>
      </section>
    </div>`;
  document.getElementById('new-session').onclick = () => { sessionStorage.clear(); };
  startCrossfade(document.querySelector('.still .photos'));
  reveal();

  function markPaid(st) {
    const stamp = document.getElementById('stamp'), msg = document.getElementById('cc-msg');
    if (!stamp) return;
    stamp.hidden = false;
    document.getElementById('stamp-sub').textContent = `payment ${st.payment_method || ''}${st.billNum ? ', bill ' + st.billNum : ''}`;
    msg.textContent = 'Finished, paid.';
    o.paid = true; save();
  }
  async function pollBridge() {
    const box = document.getElementById('bridge-live');
    if (!box) return;
    let st = null;
    try { st = await api('bridge/status?order_no=' + encodeURIComponent(o.order_no)); } catch (e) { /* keep the last state */ }
    if (!st || !st.stage) { box.innerHTML = `<li class="wait">${st && st.msg ? esc(st.msg) : 'No bridge record for this order yet.'}</li>`; return; }
    if (st.stage === 'settled') markPaid(st);
    const at = BRIDGE_STAGES.findIndex(s => s[0] === st.stage);
    const ended = ['voided', 'error'].includes(st.stage);
    box.innerHTML = BRIDGE_STAGES.map((s, i) => {
      const done = at > i || ended, now = at === i;
      let sub = '';
      if (s[0] === 'queued' && st.pending_push) sub = 'The bridge is not reachable yet, retrying';
      if (s[0] === 'table_opened' && st.salesNum && (done || now)) sub = 'Sale ' + esc(st.salesNum);
      if (s[0] === 'settled' && now && st.payment_method) sub = `Payment ${esc(st.payment_method)}${st.billNum ? ', bill ' + esc(st.billNum) : ''}`;
      return `<li class="${done ? 'is-done' : ''}${now ? ' is-now' : ''}"><span>${s[1]}${sub ? `<span class="sub">${sub}</span>` : ''}</span></li>`;
    }).join('')
      + (st.stage === 'voided' ? '<li class="is-now"><span>Voided by the cashier on the ESB till</span></li>' : '')
      + (st.stage === 'error' ? `<li class="is-now"><span>Bridge error: ${esc(st.error || '')}</span></li>` : '')
      + `<li class="small"><span>${st.agent_live ? 'Live branch agent connected' : (st.simulated ? 'Simulator, no live agent' : 'No branch agent connected')}</span></li>`;
  }
  async function poll() {
    pollBridge();
    const out = await api('kds/orders/details', { order_id: o.order_no });
    const box = document.getElementById('meals-live');
    if (!box) return;
    if (!out.status) { box.innerHTML = `<li class="wait">No details yet (${esc(out.msg)})</li>`; return; }
    const ord = out.data.order;
    box.innerHTML = out.data.order_meals.map(m => `
      <li><span>${m.quantity} × ${esc(m.meal_name)}${m.remarks ? `<span class="op">${esc(m.remarks)}</span>` : ''}</span><span class="st st-${esc(m.status)}">${esc(word(m.status))}</span></li>`).join('')
      + `<li><span>Order</span><span class="st st-${esc(ord.status)}">${esc(word(ord.status))}, ${fmt(Number(ord.total_price))}</span></li>`;
  }
  poll();
  S.timers.push(setInterval(poll, 5000));
}

/* ---------------------------------------------------------- bridge monitor */
async function renderBridge() {
  $app.innerHTML = `
    <div class="stage">
      <aside class="still">${photoStack(['sushi', 'bonito', 'nihonbashi', 'fish'])}${hoursBar('Staff screen')}</aside>
      <section class="sheet">
        <div data-rise style="--i:0">${topnav(`<a class="back" href="#/">Home</a>`, `<a href="#/takeout">Board</a>`)}</div>
        <h1 class="head head-xl" data-rise style="--i:1">Bridge monitor</h1>
        <p class="muted" id="bm-agent" data-rise style="--i:2">Edo Sushi, through the Hong Chiang kitchen display, to the ESB till.</p>
        <div class="blocks" id="bm-list" data-rise style="--i:3"><p class="wait">Asking the bridge…</p></div>
      </section>
    </div>`;
  startCrossfade(document.querySelector('.still .photos'));
  const LABEL = {
    queued: 'Queued', picked_up: 'Agent', table_opened: 'Table open', order_saved: 'Occupied',
    waiting_cashier: 'At the cashier', settled: 'Finished, paid', voided: 'Voided', error: 'Error',
  };
  async function paint() {
    const list = document.getElementById('bm-list');
    if (!list) return;
    const ov = await api('bridge/overview');
    document.getElementById('bm-agent').textContent =
      (ov.agent_live ? 'Live branch agent connected. ' : ov.simulator ? 'Simulator, no live agent. ' : 'Agent offline. ')
      + (ov.esb_menu ? `Menu synced from the ESB till: ${ov.esb_menu.meals} items, ${String(ov.esb_menu.synced_at).slice(0, 16).replace('T', ' ')}.` : 'Menu from the local catalog.');
    const first = !list.dataset.painted; list.dataset.painted = '1';
    list.innerHTML = (ov.commands || []).length === 0 ? '<p class="wait">No orders yet. Place one from the sheet.</p>' : ov.commands.map((c, i) => `
      <div class="block" ${first ? `data-reveal style="--i:${i}"` : ''}>
        <div class="ln" ${first ? `data-reveal style="--i:${i + 1}"` : ''}><b>${esc(c.order_no)}</b><span>${LABEL[c.stage] || esc(c.stage)}</span></div>
        <div class="ln muted" ${first ? `data-reveal style="--i:${i + 2}"` : ''}><span>${c.mode === 'dinein' ? 'Dine-in, table ' + esc(c.table_name || '?') : 'Takeout'}</span><span>${c.items} ${c.items === 1 ? 'line' : 'lines'}, ${fmt(c.total)}</span></div>
        ${c.salesNum ? `<div class="ln muted"><span>Sale ${esc(c.salesNum)}</span><span>${c.payment_method ? 'paid ' + esc(c.payment_method) : ''}</span></div>` : ''}
        <p class="muted">${(c.events || []).slice(-3).map(e => `${esc(String(e.t).slice(11, 19))} ${esc(e.detail || e.stage)}`).join('<br>')}</p>
      </div>`).join('');
    if (first) reveal(list);
  }
  paint();
  S.timers.push(setInterval(paint, 3000));
}

/* ----------------------------------------------------------- takeout board */
async function renderTakeout() {
  $app.innerHTML = `
    <div class="stage">
      <aside class="still">${photoStack(['nihonbashi', 'sushi', 'fish', 'bonito'])}${hoursBar('Staff screen')}</aside>
      <section class="sheet">
        <div data-rise style="--i:0">${topnav(`<a class="back" href="#/">Home</a>`, `<a href="#/bridge">Bridge</a>`)}</div>
        <h1 class="head head-xl" data-rise style="--i:1">Takeout board</h1>
        <p class="muted" data-rise style="--i:2">Open walk-in orders, live from the kitchen display. Tap one to see its lines.</p>
        <div class="blocks" id="tk-list" data-rise style="--i:3"><p class="wait">Asking the kitchen display…</p></div>
        <div id="tk-detail"></div>
      </section>
    </div>`;
  startCrossfade(document.querySelector('.still .photos'));
  const out = await api('kds/walkIns/get', {});
  const list = document.getElementById('tk-list');
  if (!list) return;
  if (!out.status) { list.innerHTML = `<p class="wait">The kitchen display did not answer (${esc(out.msg)}).</p>`; return; }
  const nos = out.data.order_nos || [];
  list.innerHTML = nos.length === 0 ? '<p class="wait">No open takeout orders.</p>'
    : nos.map((n, i) => `<button class="block" data-no="${esc(n)}" data-reveal style="--i:${i}"><div class="ln" data-reveal style="--i:${i + 1}"><b data-reveal style="--i:${i + 2}">${esc(String(n).slice(-4))}</b><span>${esc(n)}</span></div></button>`).join('');
  reveal(list);
  list.onclick = async e => {
    const b = e.target.closest('[data-no]'); if (!b) return;
    const d = await api('kds/orders/details', { order_id: b.dataset.no });
    const box = document.getElementById('tk-detail');
    if (!d.status) { box.innerHTML = `<p class="wait">No details (${esc(d.msg)}).</p>`; return; }
    const ord = d.data.order;
    box.innerHTML = `
      <section class="status-sec">
        <h2 class="lead-h">${esc(ord.order_no)}</h2>
        <ul class="kitchen">${d.data.order_meals.map(m => `<li><span>${m.quantity} × ${esc(m.meal_name)}</span><span class="st st-${esc(m.status)}">${esc(word(m.status))}</span></li>`).join('')}
          <li><span>Order</span><span class="st st-${esc(ord.status)}">${esc(word(ord.status))}, ${fmt(Number(ord.total_price))}</span></li></ul>
        <p class="small muted">Settled by the cashier on the ESB till.</p>
      </section>`;
    box.scrollIntoView({ behavior: CALM.matches ? 'auto' : 'smooth', block: 'start' });
  };
}

/* -------------------------------------------------------------------- boot */
(async function boot() {
  const [config, menu] = await Promise.all([api('config'), api('menu')]);
  S.config = config; S.menu = menu;
  route();
})();
