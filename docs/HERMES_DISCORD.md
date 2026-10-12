# Hermes agent on the VPS + Discord bridge

Goal: chat with your **Hermes agent** from Discord and have it read/modify the
project folder on the VPS (this repo at `/var/www/hongchiangorderingsystem`),
run commands, commit and push.

The bridge lives in [`hermes/`](../hermes): a small Discord bot that forwards
your messages to a coding agent CLI running inside the project folder and posts
the answer back. By default it drives the **Claude Code CLI** (`claude`); you
can point `AGENT_CMD` at any agent CLI you prefer (e.g. a Nous Hermes-based
agent) — anything that accepts a prompt and prints a result works.

## Step 1 — install the agent on the VPS

```bash
# Claude Code CLI (the default agent)
curl -fsSL https://claude.ai/install.sh | bash
claude login            # authenticate once (or set ANTHROPIC_API_KEY)
```

Give the agent access to the project folder simply by running it there — the
bridge already sets `PROJECT_DIR` as the working directory. Make sure the VPS
user running the bot can read/write the folder and use git (see
`docs/VPS_GIT.md` for the deploy key).

## Step 2 — create the Discord bot

1. Go to https://discord.com/developers/applications → **New Application** →
   name it `Hermes`.
2. Left menu **Bot**:
   - **Reset Token** → copy it (this is `DISCORD_TOKEN`). Keep it secret.
   - Under *Privileged Gateway Intents*, enable **MESSAGE CONTENT INTENT**.
3. Left menu **OAuth2 → URL Generator**:
   - Scopes: `bot`
   - Bot permissions: `View Channels`, `Send Messages`, `Read Message History`
   - Open the generated URL, pick your server, authorize.
4. In Discord: **User Settings → Advanced → Developer Mode ON**, then
   right-click your own name → **Copy User ID** (this is `ALLOWED_USER_IDS`).
   Optionally right-click the channel you'll use → **Copy Channel ID**.

## Step 3 — run the bridge on the VPS

```bash
cd /var/www/hongchiangorderingsystem/hermes
npm install
cp .env.example .env    # paste DISCORD_TOKEN, ALLOWED_USER_IDS, check PROJECT_DIR
node bot.js             # test run; you should see "Hermes bridge online as ..."
```

Keep it alive with systemd:

```bash
sudo tee /etc/systemd/system/hermes-bot.service > /dev/null <<'EOF'
[Unit]
Description=Hermes Discord bridge
After=network.target

[Service]
WorkingDirectory=/var/www/hongchiangorderingsystem/hermes
ExecStart=/usr/bin/node bot.js
Restart=always
RestartSec=5
User=www-data
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now hermes-bot
```

## Step 4 — talk to Hermes

In your Discord server (or a DM to the bot):

> change the primary color of the ordering app to green, commit and push

Hermes runs in the project folder, edits the code, and replies. Useful
commands:

- `!new` — start a fresh conversation (drops previous context)
- `!status` — show what the bot is pointing at

After Hermes pushes, deploy the change:

> pull the latest code and restart the hongchiang service

(or let the `post-merge` hook from `docs/VPS_GIT.md` do it automatically).

## Security notes (read this)

- Whoever is on `ALLOWED_USER_IDS` can make the agent run commands on your
  VPS. Keep it to your own ID. The bot refuses to start with an empty list.
- Never commit `hermes/.env` (already gitignored via `.env`).
- Run the bot as a non-root user that owns only the project folder.
- If the token ever leaks, reset it in the Discord Developer Portal.
