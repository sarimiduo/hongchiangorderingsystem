'use strict';
/**
 * Hermes ⇄ Discord bridge.
 *
 * Runs on the VPS. Forwards messages from allow-listed Discord users to the
 * Hermes coding agent (Claude Code CLI by default) working inside PROJECT_DIR,
 * and streams the agent's answer back to the channel.
 *
 * SECURITY: anyone on ALLOWED_USER_IDS effectively has shell-level access to
 * PROJECT_DIR through the agent. Keep the list to yourself, keep the token
 * secret, and run the bot as a low-privilege user.
 *
 * Commands:
 *   !new            start a fresh agent conversation
 *   !status         show bot/agent settings
 *   anything else   sent to the agent as a prompt
 */

require('node:fs').existsSync(require('node:path').join(__dirname, '.env')) &&
  require('node:fs').readFileSync(require('node:path').join(__dirname, '.env'), 'utf8')
    .split('\n').forEach(l => {
      const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    });

const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { spawn } = require('node:child_process');

const TOKEN = process.env.DISCORD_TOKEN;
const ALLOWED = new Set((process.env.ALLOWED_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
const CHANNEL = (process.env.ALLOWED_CHANNEL_ID || '').trim();
const PROJECT_DIR = process.env.PROJECT_DIR || process.cwd();
const AGENT_CMD = process.env.AGENT_CMD || 'claude --continue -p {prompt}';
const TIMEOUT = (Number(process.env.AGENT_TIMEOUT) || 600) * 1000;

if (!TOKEN) { console.error('DISCORD_TOKEN missing (see .env.example)'); process.exit(1); }
if (ALLOWED.size === 0) { console.error('ALLOWED_USER_IDS missing — refusing to run open to everyone'); process.exit(1); }

let freshNext = false;
let busy = false;

function runAgent(prompt) {
  return new Promise(resolve => {
    let cmd = AGENT_CMD;
    if (freshNext) { cmd = cmd.replace(/--continue\s*/, ''); freshNext = false; }
    const parts = cmd.split(' ').map(p => (p === '{prompt}' ? prompt : p));
    const child = spawn(parts[0], parts.slice(1), { cwd: PROJECT_DIR, env: process.env });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); err += '\n[hermes] timed out'; }, TIMEOUT);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => {
      clearTimeout(timer);
      resolve(out.trim() || err.trim() || `[hermes] agent exited with code ${code} and no output`);
    });
    child.on('error', e => { clearTimeout(timer); resolve('[hermes] failed to start agent: ' + e.message); });
  });
}

async function replyChunked(message, text) {
  const chunks = [];
  for (let i = 0; i < text.length && chunks.length < 8; i += 1900) chunks.push(text.slice(i, i + 1900));
  if (chunks.length === 0) chunks.push('(empty response)');
  for (const c of chunks) await message.reply({ content: c, allowedMentions: { parse: [] } });
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel],
});

client.on('clientReady', () => console.log(`Hermes bridge online as ${client.user.tag}, project: ${PROJECT_DIR}`));
client.on('ready', () => {}); // older discord.js versions

client.on('messageCreate', async message => {
  if (message.author.bot) return;
  if (!ALLOWED.has(message.author.id)) return;
  if (CHANNEL && message.channelId !== CHANNEL && message.guildId) return;

  const text = message.content.trim();
  if (!text) return;

  if (text === '!status') {
    return message.reply(`project: \`${PROJECT_DIR}\`\nagent: \`${AGENT_CMD}\`\nbusy: ${busy}`);
  }
  if (text === '!new') {
    freshNext = true;
    return message.reply('Next message starts a fresh Hermes conversation.');
  }
  if (busy) return message.reply('Hermes is still working on the previous request — try again shortly.');

  busy = true;
  try {
    await message.channel.sendTyping().catch(() => {});
    const answer = await runAgent(text);
    await replyChunked(message, answer);
  } finally {
    busy = false;
  }
});

client.login(TOKEN);
