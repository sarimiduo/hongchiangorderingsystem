'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

function freePort() {
  return new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
}

test('dev.js boots both servers and never prints the tokens', async () => {
  const PORT = String(await freePort()), MID_PORT = String(await freePort());
  const env = {
    ...process.env, PORT, MID_PORT,
    BRIDGE_URL: `http://127.0.0.1:${MID_PORT}`, APP_URL: `http://127.0.0.1:${PORT}`,
    BRIDGE_TOKEN: 'bt-SECRET-1', AGENT_TOKEN: 'at-SECRET-2', KDS_MODE: 'mock', BRIDGE_SIM: '0',
  };
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'dev.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const t0 = Date.now();
  while (!(/\[midhong\].*listening/.test(out) && /\[apphong\].*listening/.test(out))) {
    if (Date.now() - t0 > 8000) break;
    await new Promise(r => setTimeout(r, 50));
  }
  child.kill('SIGTERM');
  await new Promise(r => child.on('exit', r));
  assert.match(out, /\[midhong\].*listening/);
  assert.match(out, /\[apphong\].*listening/);
  assert.doesNotMatch(out, /at-SECRET-2/, 'AGENT_TOKEN must not be printed');
  assert.doesNotMatch(out, /bt-SECRET-1/, 'BRIDGE_TOKEN must not be printed');
});
