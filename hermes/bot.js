'use strict';
/**
 * Hermes ⇄ Discord bridge.
 *
 * Runs on the VPS. Forwards messages from allow-listed Discord users to the
 * Hermes coding agent (Claude Code CLI by default) working inside PROJECT_DIR,
 * and streams the agent's answer back to the channel.
 *
 * When the agent is the Claude CLI, the bridge adds
 * `--output-format stream-json --verbose` and relays progress live: every
 * narration line and every tool call the agent makes is appended to a rolling
 * status message in the channel, and the final answer is posted as a normal
 * reply. Set AGENT_STREAM=0 to go back to silent buffer-until-done mode
 * (or =1 to force streaming for a custom AGENT_CMD that accepts the flags).
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
const STREAMING = process.env.AGENT_STREAM
  ? process.env.AGENT_STREAM === '1'
  : /(^|\/)claude$/.test(AGENT_CMD.split(' ')[0]); // auto-on for the Claude CLI

if (!TOKEN) { console.error('DISCORD_TOKEN missing (see .env.example)'); process.exit(1); }
if (ALLOWED.size === 0) { console.error('ALLOWED_USER_IDS missing — refusing to run open to everyone'); process.exit(1); }

let freshNext = false;
let busy = false;

// One short line per tool call, e.g. "⚙️ Bash — Run the KDS mock test loop".
function summarizeToolUse(name, input) {
  input = input || {};
  let detail = input.description || input.file_path || input.path || input.pattern ||
    input.command || input.prompt || input.query || input.url || '';
  if (typeof detail !== 'string') detail = JSON.stringify(detail);
  detail = detail.replace(/\s+/g, ' ').trim();
  if (detail.length > 160) detail = detail.slice(0, 157) + '…';
  return '⚙️ `' + name + '`' + (detail ? ' — ' + detail : '');
}

/**
 * Rolling progress log in the channel: lines are batched (one Discord API
 * call every ~2s) and appended to a single status message by editing it;
 * when it would exceed Discord's limit a fresh message is started.
 */
function progressReporter(message) {
  let pending = [], current = '', statusMsg = null, timer = null, sending = false, dead = false;

  async function flush() {
    timer = null;
    if (sending || dead || pending.length === 0) return;
    sending = true;
    try {
      while (pending.length) {
        let text = current;
        while (pending.length && (text ? text.length + 1 + pending[0].length : pending[0].length) <= 1900) {
          text += (text ? '\n' : '') + pending.shift();
        }
        if (text !== current) {
          if (statusMsg) await statusMsg.edit(text);
          else statusMsg = await message.reply({ content: text, allowedMentions: { parse: [] } });
          current = text;
        }
        if (pending.length) { statusMsg = null; current = ''; } // overflow → new message
      }
    } catch (e) {
      console.error('[hermes] progress relay failed:', e.message);
      dead = true; // stop editing; the final answer still gets posted normally
    }
    sending = false;
    if (pending.length && !dead) schedule();
  }
  function schedule() { if (!timer) timer = setTimeout(flush, 2000); }

  return {
    add(line) {
      line = String(line).trim();
      if (!line || dead) return;
      if (line.length > 1000) line = line.slice(0, 997) + '…';
      pending.push(line);
      schedule();
    },
    async finish() {
      if (timer) { clearTimeout(timer); timer = null; }
      await flush();
    },
  };
}

function runAgent(prompt, onProgress) {
  return new Promise(resolve => {
    let cmd = AGENT_CMD;
    if (freshNext) { cmd = cmd.replace(/--continue\s*/, ''); freshNext = false; }
    const parts = cmd.split(' ').map(p => (p === '{prompt}' ? prompt : p));
    if (STREAMING) parts.push('--output-format', 'stream-json', '--verbose');
    const child = spawn(parts[0], parts.slice(1), { cwd: PROJECT_DIR, env: process.env });
    let out = '', err = '', lineBuf = '', finalText = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); err += '\n[hermes] timed out'; }, TIMEOUT);

    child.stdout.on('data', d => {
      out += d;
      if (!STREAMING) return;
      lineBuf += d;
      let nl;
      while ((nl = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
          for (const block of ev.message.content) {
            if (block.type === 'text' && block.text && block.text.trim()) onProgress(block.text);
            else if (block.type === 'tool_use') onProgress(summarizeToolUse(block.name, block.input));
          }
        } else if (ev.type === 'result') {
          finalText = ev.result || (ev.is_error ? '[hermes] agent reported an error' : '');
        }
      }
    });
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => {
      clearTimeout(timer);
      if (STREAMING) resolve(finalText.trim() || err.trim() || `[hermes] agent exited with code ${code} and no output`);
      else resolve(out.trim() || err.trim() || `[hermes] agent exited with code ${code} and no output`);
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
    return message.reply(`project: \`${PROJECT_DIR}\`\nagent: \`${AGENT_CMD}\`\nstreaming: ${STREAMING}\nbusy: ${busy}`);
  }
  if (text === '!new') {
    freshNext = true;
    return message.reply('Next message starts a fresh Hermes conversation.');
  }
  if (busy) return message.reply('Hermes is still working on the previous request — try again shortly.');

  busy = true;
  const typing = setInterval(() => message.channel.sendTyping().catch(() => {}), 8000);
  try {
    await message.channel.sendTyping().catch(() => {});
    const progress = progressReporter(message);
    const answer = await runAgent(text, line => progress.add(line));
    await progress.finish();
    await replyChunked(message, answer);
  } finally {
    clearInterval(typing);
    busy = false;
  }
});

client.login(TOKEN);
