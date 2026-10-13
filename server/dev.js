'use strict';
/**
 * Local two-process runner: midhong (bridge) + apphong (ordering app).
 *   node server/dev.js          # http://localhost:3000 (app), http://localhost:3100 (bridge monitor)
 * Reads .env if present (no dotenv dependency: simple KEY=VALUE lines), then
 * fills dev defaults for anything missing so it works with zero setup.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const env = { ...process.env };
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && env[m[1]] === undefined) env[m[1]] = m[2];
  }
}
const PORT = env.PORT || '3000';
const MID_PORT = env.MID_PORT || '3100';
Object.assign(env, {
  PORT, MID_PORT,
  BRIDGE_URL: env.BRIDGE_URL || `http://127.0.0.1:${MID_PORT}`,
  APP_URL: env.APP_URL || `http://127.0.0.1:${PORT}`,
  BRIDGE_TOKEN: env.BRIDGE_TOKEN || 'dev-bridge-token',
  AGENT_TOKEN: env.AGENT_TOKEN || 'dev-agent-token',
});

function run(name, file) {
  const child = spawn(process.execPath, [path.join(__dirname, file)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = d => String(d).trimEnd().split('\n').map(l => `[${name}] ${l}`).join('\n') + '\n';
  child.stdout.on('data', d => process.stdout.write(tag(d)));
  child.stderr.on('data', d => process.stderr.write(tag(d)));
  child.on('exit', c => { console.log(`[${name}] exited (${c})`); process.exit(c || 0); });
  return child;
}
const kids = [run('midhong', 'mid.js'), run('apphong', 'index.js')];
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { kids.forEach(k => k.kill()); process.exit(0); });
console.log(`dev: app http://localhost:${PORT}  ·  bridge monitor http://localhost:${MID_PORT}  (AGENT_TOKEN=${env.AGENT_TOKEN})`);
