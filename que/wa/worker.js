'use strict';
/**
 * quehong WhatsApp worker - Baileys (unofficial WhatsApp Web bridge).
 *
 * Runs on the mini-PC next to que/server.js. First run shows a QR in the
 * terminal: scan it with the bot phone's WhatsApp (Linked devices). The
 * session is kept in ./auth/ (gitignored) and survives restarts.
 *
 *  inbound:  any message containing an EDQ-xxxx code -> POST /api/que/wa/inbound
 *            (binds + verifies the customer's number; the reply text comes
 *            from the server). The SENDER's number is ground truth - typos
 *            from the registration tablet are auto-corrected.
 *  outbound: polls GET /api/que/wa/outbox every 3 s and sends the queued
 *            nudges ("1 group ahead", "your turn", "missed you").
 *
 * NOTE this uses an unofficial client: keep the traffic human-like (we only
 * message people who messaged us first) and accept that WhatsApp may still
 * ban the number. Setup: `npm install` in this folder, then `node worker.js`.
 */

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const path = require('path');

const SERVER = (process.env.QUE_URL || 'http://127.0.0.1:3200').replace(/\/+$/, '');
const CODE_RE = /\bEDQ-[A-Z0-9]{4,8}\b/i;

async function api(method, route, body) {
  const r = await fetch(SERVER + route, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(route + ' HTTP ' + r.status);
  return r.json();
}

function textOf(msg) {
  const m = msg.message || {};
  return m.conversation || (m.extendedTextMessage && m.extendedTextMessage.text) ||
    (m.imageMessage && m.imageMessage.caption) || '';
}

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(path.join(__dirname, 'auth'));
  const sock = makeWASocket({ auth: state, printQRInTerminal: true });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', u => {
    if (u.connection === 'open') console.log('[wa] connected');
    if (u.connection === 'close') {
      const code = u.lastDisconnect && u.lastDisconnect.error &&
        u.lastDisconnect.error.output && u.lastDisconnect.error.output.statusCode;
      if (code === DisconnectReason.loggedOut) {
        console.error('[wa] logged out - delete que/wa/auth/ and re-link the phone');
        process.exit(1);
      }
      console.log('[wa] reconnecting (code %s)…', code);
      setTimeout(start, 3000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        if (!msg.key || msg.key.fromMe || !msg.key.remoteJid) continue;
        const jid = msg.key.remoteJid;
        if (jid.endsWith('@g.us') || jid === 'status@broadcast') continue; // no groups/status
        const m = textOf(msg).match(CODE_RE);
        if (!m) continue;
        const out = await api('POST', '/api/que/wa/inbound', {
          code: m[0].toUpperCase(), jid, number: jid.split('@')[0],
        });
        if (out.reply) await sock.sendMessage(jid, { text: out.reply });
        console.log('[wa] inbound %s from %s -> %s', m[0], jid, out.ok ? 'linked' : 'unknown');
      } catch (e) { console.error('[wa] inbound failed:', e.message); }
    }
  });

  // outbox: the queue server decides WHAT to send and WHEN; we just deliver.
  setInterval(async () => {
    try {
      const { messages } = await api('GET', '/api/que/wa/outbox');
      const done = [];
      for (const m of messages || []) {
        const jid = m.jid || (m.wa ? m.wa + '@s.whatsapp.net' : null);
        if (jid) {
          try { await sock.sendMessage(jid, { text: m.text }); }
          catch (e) { console.error('[wa] send to %s failed: %s', jid, e.message); continue; }
        }
        done.push(m.id); // undeliverable (no number) is dropped, not retried forever
      }
      if (done.length) await api('POST', '/api/que/wa/ack', { ids: done });
    } catch (e) { /* server down - next poll retries */ }
  }, 3000);
}

start().catch(e => { console.error(e); process.exit(1); });
