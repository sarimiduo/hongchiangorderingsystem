'use strict';
/**
 * quehong - queue/ticketing core for the walk-in waiting line (Edo Sushi).
 *
 * Pure state machine + persistence, no HTTP (que/server.js owns that), so the
 * whole flow is unit-testable. Ticket life:
 *
 *   waiting → called → seated → finished
 *                ↓ (no-show 5 min)      ↑
 *             pending ── scan ──→ re-inserted into the main queue at
 *                                 position `reinsertDepth` (default 2)
 *
 * Tables come from que/data/tables.json (capacity + floor-plan coords).
 * A table is busy when: ESB POS has an open head on it (pushed by the mini-PC
 * agent), OR the queue holds it for a called/seated ticket, OR staff marked it
 * busy manually. ESB taking over a seated table ("handoff") finishes the ticket.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
const OPEN_STATES = ['waiting', 'called', 'pending'];

function todayStr(now) {
  const d = new Date(now);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function fmtNumber(n) { return 'Q' + String(n).padStart(3, '0'); }

class QueStore {
  constructor(opts = {}) {
    this.file = opts.file || process.env.QUE_STATE || path.join(__dirname, 'data', 'que_state.json');
    const inv = opts.tables ||
      JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'tables.json'), 'utf8')).tables;
    this.inventory = inv.map(t => ({ esb_name: t.id, ...t }));
    this.storeName = opts.storeName || 'Edo Sushi';
    this.upsizeReserve = opts.upsizeReserve != null ? opts.upsizeReserve : 1;
    this.noShowMs = opts.noShowMs != null ? opts.noShowMs : 5 * 60 * 1000;
    this.reinsertDepth = opts.reinsertDepth != null ? opts.reinsertDepth : 2;
    this.seatedTimeoutMs = opts.seatedTimeoutMs != null ? opts.seatedTimeoutMs : 45 * 60 * 1000;
    this.pendingExpireMs = opts.pendingExpireMs != null ? opts.pendingExpireMs : 60 * 60 * 1000;
    this.now = opts.now || (() => Date.now());
    this.listeners = [];
    this.state = {
      day: todayStr(this.now()), next_number: 1, last_called: null,
      tickets: {},        // token -> ticket
      main: [],           // waiting tokens, queue order
      pending: [],        // no-show tokens
      holds: {},          // tableId -> {token, kind: 'hold'|'seated'}
      esb_busy: [],       // ESB tableName list (from the agent)
      manual_busy: [],    // tableIds staff marked busy
      outbox: [],         // WhatsApp messages [{id, wa, jid, text}]
      next_msg: 1,
    };
    if (fs.existsSync(this.file)) {
      try { Object.assign(this.state, JSON.parse(fs.readFileSync(this.file, 'utf8'))); }
      catch (e) { console.error('[que] state file unreadable, starting fresh:', e.message); }
    }
    // Migrate pre-2026-11-05 state: 'seated' tickets are now finished at scan
    // time, and seated holds carry a timestamp for the hold timeout.
    for (const t of Object.values(this.state.tickets)) {
      if (t.state === 'seated') { t.state = 'finished'; t.revoked = true; }
    }
    for (const h of Object.values(this.state.holds)) {
      if (h.kind === 'seated' && !h.at) h.at = this.now();
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 1));
    fs.renameSync(tmp, this.file);
  }

  listen(fn) { this.listeners.push(fn); return () => { this.listeners = this.listeners.filter(f => f !== fn); }; }
  emit(type, data) { for (const fn of this.listeners) { try { fn({ type, ...data }); } catch (e) { /* listener's problem */ } } }

  ticket(token) { return this.state.tickets[token] || null; }
  byNumber(n) { return Object.values(this.state.tickets).find(t => t.number === Number(n)) || null; }

  // ---------------------------------------------------------------- lifecycle
  rollDay() {
    const day = todayStr(this.now());
    if (day === this.state.day) return;
    for (const t of Object.values(this.state.tickets)) {
      if (OPEN_STATES.includes(t.state) || t.state === 'seated') { t.state = 'cancelled'; t.revoked = true; }
    }
    Object.assign(this.state, { day, next_number: 1, last_called: null, main: [], pending: [], holds: {} });
    this.save();
    this.emit('day', { day });
  }

  register({ name, wa, pax, lang }) {
    this.rollDay();
    pax = Math.max(1, Math.min(30, Number(pax) || 1));
    const token = crypto.randomBytes(10).toString('hex');
    let code = 'EDQ-';
    for (const b of crypto.randomBytes(4)) code += CODE_ALPHABET[b % 32];
    const t = {
      token, code, number: this.state.next_number++, day: this.state.day,
      name: String(name || '').slice(0, 60), wa: normalizeWa(wa), pax,
      lang: lang === 'en' ? 'en' : 'id',
      wa_verified: false, wa_jid: null, nudged: false, revoked: false,
      split: pax > this.floorMaxFit(), state: 'waiting', table_ids: [],
      created_at: this.now(), called_at: null, pending_at: null, seated_at: null,
    };
    this.state.tickets[token] = t;
    this.state.main.push(token);
    this.save();
    this.emit('queue', {});
    return t;
  }

  // ---------------------------------------------------------------- tables
  tableById(id) { return this.inventory.find(t => t.id === id) || null; }

  tableState(t) {
    if (this.state.holds[t.id]) return this.state.holds[t.id].kind === 'hold' ? 'held' : 'seated';
    if (this.state.manual_busy.includes(t.id)) return 'manual';
    if (this.state.esb_busy.includes(t.esb_name)) return 'busy';
    return 'free';
  }

  freeTables() { return this.inventory.filter(t => this.tableState(t) === 'free'); }

  floorMaxFit() {
    const floor = this.inventory.filter(t => t.zone !== 'counter');
    const pool = floor.length ? floor : this.inventory;
    return Math.max(...pool.map(t => t.max_pax || t.capacity));
  }

  /** Which seating resources a party needs (for the starvation guard). */
  needClasses(pax) { return pax <= 2 ? ['counter', 'floor'] : ['floor']; }

  /** Two adjacent free counter stools (same column, consecutive numbers). */
  counterPair(counterFree) {
    const num = id => parseInt(id, 10);
    const sorted = counterFree.slice().sort((a, b) => num(a.id) - num(b.id));
    for (let i = 0; i < sorted.length - 1; i++) {
      const a = sorted[i], b = sorted[i + 1];
      const sameCol = a.x == null || b.x == null || a.x === b.x;
      if (sameCol && num(b.id) - num(a.id) === 1) return [a.id, b.id];
    }
    return null;
  }

  /** Pick table(s) for a party. Returns {tables:[ids], split} or null.
   * Owner rules (2026-11-05): counter 01-16 serves 1-2 pax (couples on two
   * adjacent stools); floor 4-seaters hold up to their max_pax (6); the
   * priority-1 zone (20-45) fills before priority-2 (46-60); larger parties
   * split across floor tables, priority zone first. */
  assignFor(pax, blocked) {
    blocked = blocked || new Set();
    const free = this.freeTables();
    const num = id => parseInt(id, 10);
    const counter = free.filter(t => t.zone === 'counter');
    const floor = free.filter(t => t.zone !== 'counter').sort((a, b) =>
      (a.priority || 1) - (b.priority || 1) || a.capacity - b.capacity || num(a.id) - num(b.id));

    if (pax <= 2 && !blocked.has('counter')) {
      if (pax === 1 && counter.length) {
        const seat = counter.slice().sort((a, b) => num(a.id) - num(b.id))[0];
        return { tables: [seat.id], split: false };
      }
      if (pax === 2) {
        const pair = this.counterPair(counter);
        if (pair) return { tables: pair, split: false };
      }
    }
    if (blocked.has('floor')) return null;
    if (pax <= this.floorMaxFit()) {
      for (const t of floor) {
        if (pax > (t.max_pax || t.capacity)) continue;
        // 1-2 pax overflow to a floor table only while more than
        // `upsizeReserve` floor tables stay free for bigger groups.
        if (pax <= 2 && floor.length <= this.upsizeReserve) break;
        return { tables: [t.id], split: false };
      }
      return null;
    }
    // Split party: floor tables only, priority zone first, biggest first.
    const desc = floor.slice().sort((a, b) =>
      (a.priority || 1) - (b.priority || 1) || b.capacity - a.capacity || num(a.id) - num(b.id));
    const pick = []; let sum = 0;
    for (const t of desc) { pick.push(t.id); sum += t.capacity; if (sum >= pax) break; }
    return sum >= pax ? { tables: pick, split: true } : null;
  }

  // ---------------------------------------------------------------- the tick
  /** Advance the queue: expire no-shows, call every front ticket that fits. */
  tick() {
    this.rollDay();
    const now = this.now();
    let changed = false;

    for (const t of Object.values(this.state.tickets)) {
      if (t.state === 'called' && now - t.called_at >= this.noShowMs) { this.toPending(t); changed = true; }
    }
    // Seated holds without an ESB handoff (agent offline) free themselves
    // after seatedTimeoutMs so tables cannot leak.
    for (const [id, h] of Object.entries(this.state.holds)) {
      if (h.kind === 'seated' && h.at && now - h.at >= this.seatedTimeoutMs) { delete this.state.holds[id]; changed = true; }
    }
    // A no-show that never returns leaves the Missed lane after pendingExpireMs.
    for (const token of [...this.state.pending]) {
      const t = this.state.tickets[token];
      if (t && now - t.pending_at >= this.pendingExpireMs) {
        this.state.pending = this.state.pending.filter(x => x !== token);
        t.state = 'cancelled';
        t.revoked = true;
        if (t.wa_verified) this.sendWa(t,
          `Mohon maaf, antrian ${fmtNumber(t.number)} dibatalkan karena tidak hadir. Silakan daftar ulang saat tiba di ${this.storeName}.\nSorry, your queue number was cancelled as a no-show. Please register again when you arrive.`);
        changed = true;
      }
    }

    // Call in queue order; a blocked party reserves its seating class so the
    // parties behind it cannot starve it (other classes flow past).
    const blocked = new Set();
    for (const token of [...this.state.main]) {
      const t = this.state.tickets[token];
      if (!t || t.state !== 'waiting') continue;
      const res = this.assignFor(t.pax, blocked);
      if (res) { this.call(t, res.tables); changed = true; }
      else for (const c of this.needClasses(t.pax)) blocked.add(c);
    }

    // "Come back now" nudge when one group (or none) is ahead.
    this.state.main.forEach((token, i) => {
      const t = this.state.tickets[token];
      if (t && i <= 1 && t.wa_verified && !t.nudged && t.state === 'waiting') {
        t.nudged = true;
        this.sendWa(t, i === 0
          ? `Giliran Anda berikutnya di ${this.storeName}! Nomor ${fmtNumber(t.number)}, mohon segera ke pintu masuk.\nYou are next, please head to the entrance now.`
          : `Halo${t.name ? ' ' + t.name : ''}, tinggal 1 antrian lagi sebelum nomor Anda ${fmtNumber(t.number)} di ${this.storeName}. Mohon segera kembali ya.\nOnly 1 group ahead of you, please head back to the restaurant now.`);
        changed = true;
      }
    });

    if (changed) { this.save(); this.emit('queue', {}); }
    return changed;
  }

  call(t, tableIds) {
    this.state.main = this.state.main.filter(x => x !== t.token);
    for (const id of tableIds) this.state.holds[id] = { token: t.token, kind: 'hold' };
    t.table_ids = tableIds;
    t.state = 'called';
    t.called_at = this.now();
    this.state.last_called = t.number;
    if (t.wa_verified) this.sendWa(t,
      `Giliran Anda tiba! Nomor ${fmtNumber(t.number)}, silakan ke pintu masuk ${this.storeName} dan pindai QR antrian Anda.\nIt's your turn! Come to the entrance and scan your queue QR.`);
    this.emit('called', { number: t.number, token: t.token });
  }

  toPending(t) {
    this.releaseHolds(t);
    t.table_ids = [];
    t.state = 'pending';
    t.pending_at = this.now();
    this.state.pending.push(t.token);
    if (t.wa_verified) this.sendWa(t,
      `Kami memanggil nomor ${fmtNumber(t.number)} namun belum bertemu Anda, jadi antrian dipindah sementara. Saat tiba, langsung pindai QR antrian Anda di pintu masuk ya.\nWe called your number but missed you. Scan your queue QR at the entrance when you arrive.`);
    this.emit('queue', {});
  }

  releaseHolds(t) {
    for (const [id, h] of Object.entries(this.state.holds)) if (h.token === t.token) delete this.state.holds[id];
  }

  // ---------------------------------------------------------------- scanning
  /** A QR Queue scan at the door. Accepts the raw token or the landing URL. */
  scan(data) {
    this.rollDay();
    const m = String(data || '').trim().match(/([0-9a-f]{20})\s*$/i);
    const t = m ? this.ticket(m[1].toLowerCase()) : null;
    if (!t) return { ok: false, result: 'unknown', msg: 'QR tidak dikenal / unknown QR' };
    // A finished ticket scanned again today re-shows its table on the TV.
    if (t.day === this.state.day && t.state === 'finished' && t.table_ids.length) {
      this.emitSeat(t);
      return this.seatResult(t, true);
    }
    if (t.day !== this.state.day || ['finished', 'cancelled'].includes(t.state)) {
      return { ok: false, result: 'expired', number: t.number, msg: 'Antrian sudah selesai / queue already finished' };
    }
    if (t.state === 'called') return this.seat(t);
    if (t.state === 'pending') {
      this.state.pending = this.state.pending.filter(x => x !== t.token);
      t.state = 'waiting';
      t.called_at = null;
      const at = Math.min(this.reinsertDepth, this.state.main.length);
      this.state.main.splice(at, 0, t.token);
      this.save();
      this.emit('queue', {});
      this.tick(); // tables may be free right now
      if (this.state.tickets[t.token].state === 'called') return this.seat(t);
      return { ok: true, result: 'requeued', number: t.number, position: at,
        msg: `Nomor ${fmtNumber(t.number)} masuk kembali, ${at} antrian di depan Anda / re-queued, ${at} group(s) ahead` };
    }
    // waiting: a guest who walks straight in on their turn
    const idx = this.state.main.indexOf(t.token);
    if (idx === 0) {
      const res = this.assignFor(t.pax, new Set());
      if (res) { this.call(t, res.tables); return this.seat(t); }
    }
    return { ok: true, result: 'waiting', number: t.number, position: idx,
      msg: `Belum giliran Anda, ${idx} antrian di depan / not your turn yet, ${idx} group(s) ahead` };
  }

  seat(t) {
    const now = this.now();
    for (const id of t.table_ids) this.state.holds[id] = { token: t.token, kind: 'seated', at: now };
    t.seated_at = now;
    // Owner rule (2026-11-05): a scanned ticket is FINISHED - it leaves the
    // kanban immediately (the seat TV still blinks from the event). The table
    // stays held until ESB sees the order, staff free it, or the hold times out.
    t.state = 'finished';
    t.revoked = true; // the public landing page dies here
    this.save();
    this.emitSeat(t);
    this.tick(); // call the next number right away
    return this.seatResult(t, false);
  }

  emitSeat(t) {
    this.emit('seat', { number: t.number, token: t.token, tables: t.table_ids, pax: t.pax, split: t.split, lang: t.lang });
  }

  seatResult(t, again) {
    return { ok: true, result: 'seated', again, number: t.number, tables: t.table_ids, split: t.split,
      msg: `Nomor ${fmtNumber(t.number)}: silakan ke meja ${t.table_ids.join(', ')} / please proceed to table ${t.table_ids.join(', ')}` };
  }

  // ---------------------------------------------------------------- WhatsApp
  sendWa(t, text) {
    this.state.outbox.push({ id: this.state.next_msg++, token: t.token,
      wa: t.wa, jid: t.wa_jid, text });
  }

  /** Inbound WA message carrying an EDQ-code: binds + verifies the number. */
  waInbound({ code, jid, number }) {
    const c = String(code || '').toUpperCase().trim();
    const t = Object.values(this.state.tickets).find(x =>
      x.code === c && x.day === this.state.day && !['finished', 'cancelled'].includes(x.state));
    if (!t) return { ok: false, reply: 'Maaf, kode antrian tidak dikenal atau sudah selesai. / Sorry, this queue code is unknown or already finished.' };
    t.wa_jid = jid || t.wa_jid;
    if (number) t.wa = normalizeWa(number); // the sender's number is ground truth
    t.wa_verified = true;
    this.save();
    this.emit('queue', {});
    return { ok: true, token: t.token, reply:
      `Terima kasih! WhatsApp Anda terhubung dengan antrian ${fmtNumber(t.number)} di ${this.storeName}. Kami akan mengabari saat giliran Anda hampir tiba.\nThank you! Your WhatsApp is now linked to queue ${fmtNumber(t.number)}. We will message you when your turn is near.` };
  }

  pullOutbox() { return this.state.outbox.slice(0, 20); }
  ackOutbox(ids) {
    const set = new Set(ids || []);
    this.state.outbox = this.state.outbox.filter(m => !set.has(m.id));
    this.save();
  }

  // ---------------------------------------------------------------- ESB feed
  /** The mini-PC agent pushes the busy tableName list from the ESB POS DB. */
  esbOccupancy(busyNames) {
    this.state.esb_busy = (busyNames || []).map(String);
    let changed = false;
    for (const [id, h] of Object.entries(this.state.holds)) {
      const tbl = this.tableById(id);
      // ESB opened a head on a seated table: the POS owns it now (handoff).
      if (h.kind === 'seated' && tbl && this.state.esb_busy.includes(tbl.esb_name)) {
        delete this.state.holds[id];
        changed = true;
      }
    }
    if (changed) { this.save(); this.emit('queue', {}); }
    this.tick(); // freed tables may unlock the queue
  }

  // ---------------------------------------------------------------- admin
  admin(op, arg) {
    const t = arg && this.ticket(arg);
    switch (op) {
      case 'pending': if (t && t.state === 'called') { this.toPending(t); this.save(); return { ok: true }; } break;
      case 'cancel': if (t) {
        this.releaseHolds(t);
        this.state.main = this.state.main.filter(x => x !== t.token);
        this.state.pending = this.state.pending.filter(x => x !== t.token);
        t.state = 'cancelled'; t.revoked = true;
        this.save(); this.emit('queue', {}); this.tick(); return { ok: true };
      } break;
      case 'seated': if (t && t.state === 'called') { this.seat(t); return { ok: true }; } break;
      case 'finish': if (t) { this.releaseHolds(t); t.state = 'finished'; t.revoked = true; this.save(); this.emit('queue', {}); this.tick(); return { ok: true }; } break;
      case 'requeue': if (t && t.state === 'pending') return { ok: this.scan(t.token).ok }; break;
      case 'table-busy': if (this.tableById(arg) && !this.state.manual_busy.includes(arg)) { this.state.manual_busy.push(arg); this.save(); this.emit('queue', {}); return { ok: true }; } break;
      case 'table-free': {
        this.state.manual_busy = this.state.manual_busy.filter(x => x !== arg);
        delete this.state.holds[arg];
        this.save(); this.emit('queue', {}); this.tick(); return { ok: true };
      }
    }
    return { ok: false, msg: 'bad op/state' };
  }

  // ---------------------------------------------------------------- reads
  overview() {
    const list = st => st.map((token, i) => {
      const t = this.state.tickets[token];
      return t && { token: t.token, number: t.number, disp: fmtNumber(t.number), name: t.name,
        pax: t.pax, wa_verified: t.wa_verified, split: t.split, position: i, state: t.state };
    }).filter(Boolean);
    const called = Object.values(this.state.tickets)
      .filter(t => t.state === 'called' && t.day === this.state.day)
      .sort((a, b) => b.called_at - a.called_at)
      .map(t => ({ token: t.token, number: t.number, disp: fmtNumber(t.number), name: t.name, pax: t.pax,
        state: t.state, tables: t.table_ids, called_at: t.called_at, wait_left: Math.max(0, this.noShowMs - (this.now() - t.called_at)) }));
    return {
      store: this.storeName, day: this.state.day, last_called: this.state.last_called,
      waiting: list(this.state.main), pending: list(this.state.pending), called,
      tables: this.inventory.map(t => ({ ...t, status: this.tableState(t),
        held_by: this.state.holds[t.id] ? fmtNumber(this.ticket(this.state.holds[t.id].token).number) : null })),
      outbox_depth: this.state.outbox.length,
    };
  }

  /** Snapshot for the public VPS mirror (landing pages). */
  mirror() {
    const cutoff = this.now() - 2 * 3600 * 1000;
    return {
      store: this.storeName, day: this.state.day, last_called: this.state.last_called,
      tickets: Object.values(this.state.tickets)
        .filter(t => t.day === this.state.day &&
          (OPEN_STATES.includes(t.state) || (t.seated_at || t.created_at) > cutoff))
        .map(t => ({ token: t.token, number: t.number, disp: fmtNumber(t.number), state: t.state,
          revoked: t.revoked, ahead: t.state === 'waiting' ? this.state.main.indexOf(t.token) : 0 })),
    };
  }
}

function normalizeWa(wa) {
  let d = String(wa || '').replace(/[^\d]/g, '');
  if (d.startsWith('0')) d = '62' + d.slice(1); // Indonesian local format
  return d;
}

module.exports = { QueStore, fmtNumber, normalizeWa };
