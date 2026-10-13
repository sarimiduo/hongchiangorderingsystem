'use strict';
/** HTTP helpers shared by server/index.js (apphong) and server/mid.js (midhong). */

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

/** True when the request carries exactly `Bearer <token>` and token is non-empty. */
function bearerOk(req, token) {
  if (!token) return false;
  return (req.headers.authorization || '') === 'Bearer ' + token;
}

/** Exit at startup with a clear message when required env vars are missing. */
function requireEnv(names, who) {
  const missing = names.filter(n => !process.env[n]);
  if (missing.length) {
    console.error(`[${who}] missing required env: ${missing.join(', ')} — see .env.example`);
    process.exit(1);
  }
}

module.exports = { send, readBody, bearerOk, requireEnv };
