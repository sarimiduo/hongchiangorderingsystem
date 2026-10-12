# VPS Setup Runbook — Hong Chiang Ordering System

> **How to use this file:** SCP it to your VPS, start Claude Code there, and say:
> *"Read VPS_SETUP.md and perform the setup step by step."*
>
> ```bash
> scp VPS_SETUP.md user@your-vps:~/
> ssh user@your-vps
> claude   # then: "Read ~/VPS_SETUP.md and perform the setup step by step"
> ```

---

## Instructions for the agent executing this runbook

You are setting up a production deployment on this VPS. Work through Parts 1–6
**in order**. After each part, run its **Verify** block and do not continue
until it passes. Rules:

- Ask the user before anything destructive (overwriting existing nginx sites,
  existing services, existing clones).
- If a command fails, diagnose and fix it before moving on — do not skip.
- Values you must ask the user for are marked `<ASK USER>`.
- This runbook assumes Ubuntu/Debian with sudo. If the OS differs, adapt
  package commands and say so.

**Fixed facts for this deployment:**

| Item | Value |
|---|---|
| Repository | `https://github.com/sarimiduo/hongchiangorderingsystem.git` |
| App branch to deploy | `main` if it exists, otherwise `claude/bold-davinci-jpzlmi` |
| Install path | `/var/www/hongchiangorderingsystem` |
| Domain | `apphong.berkatselalu.com` |
| App port (internal) | `3000` |
| Git identity | `Dewa (VPS)` / `dewa@90scaleup.id` |

The app is a **zero-dependency Node server** — no `npm install`, no build step.

---

## Part 1 — Base packages

```bash
sudo apt-get update
# Node 20 LTS (skip if `node -v` is already >= 18)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs nginx git
```

**Verify:** `node -v` prints v18+ ; `nginx -v` works ; `git --version` works.

---## Part 2 — Clone the repository

```bash
sudo mkdir -p /var/www
cd /var/www
sudo git clone https://github.com/sarimiduo/hongchiangorderingsystem.git
cd hongchiangorderingsystem

# Check which branch holds the app; prefer main, else the claude branch:
git branch -r
# if main does not exist on origin:
sudo git checkout claude/bold-davinci-jpzlmi

sudo cp .env.example .env
```

Edit `/var/www/hongchiangorderingsystem/.env`:

- Keep `KDS_MODE=mock` for now (demo mode, no hardware needed).
- When a real KDS device is reachable later, set `KDS_MODE=real` and
  `KDS_BASE_URL=http://<kds-ip>:5500/kds` — ask the user if they want this now.

```bash
sudo chown -R www-data:www-data /var/www/hongchiangorderingsystem
```

**Verify:** `ls /var/www/hongchiangorderingsystem/server/index.js` exists.

---

## Part 3 — Run the app as a systemd service

The repo ships the unit file:

```bash
sudo cp /var/www/hongchiangorderingsystem/deploy/hongchiang.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hongchiang
```

**Verify:**

```bash
systemctl is-active hongchiang          # "active"
curl -s localhost:3000/api/config       # JSON with "kds_mode":"mock"
curl -s -X POST localhost:3000/api/kds/tables/search -d '{}' | head -c 120   # table list JSON
```

---

## Part 4 — Domain + HTTPS (apphong.berkatselalu.com)

**4a. DNS (user action):** ask the user to add an **A record** in the DNS panel
for `berkatselalu.com`: name `apphong`, value = this VPS's public IP
(`curl -s ifconfig.me` shows it). Wait until this resolves correctly:

```bash
dig +short apphong.berkatselalu.com   # must print the VPS IP
```

**4b. nginx:**

```bash
sudo cp /var/www/hongchiangorderingsystem/deploy/nginx.apphong.conf \
        /etc/nginx/sites-available/apphong.berkatselalu.com
sudo ln -sf /etc/nginx/sites-available/apphong.berkatselalu.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

**4c. SSL:**

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d apphong.berkatselalu.com --redirect
```

(Certbot asks for an email — use `dewa@90scaleup.id` unless the user says otherwise.)

**Verify:** `curl -sI https://apphong.berkatselalu.com | head -1` returns `HTTP/2 200`
(or 301→200), and the site opens in a browser showing the Hong Chiang home screen.

---

## Part 5 — Git push/pull from this VPS

Set identity:

```bash
sudo -u www-data git config --global user.name  "Dewa (VPS)"
sudo -u www-data git config --global user.email "dewa@90scaleup.id"
```

Create a **deploy key** with write access:

```bash
sudo -u www-data ssh-keygen -t ed25519 -C "vps-apphong" \
  -f /var/www/.ssh/id_ed25519_apphong -N ""
sudo -u www-data mkdir -p /var/www/.ssh
cat /var/www/.ssh/id_ed25519_apphong.pub
```

**User action:** show the printed public key to the user and ask them to add it
on GitHub → repo `sarimiduo/hongchiangorderingsystem` → **Settings → Deploy
keys → Add deploy key**, with **"Allow write access" ticked**. Wait for their
confirmation.

Then configure ssh and switch the remote to SSH:

```bash
sudo -u www-data tee /var/www/.ssh/config > /dev/null <<'EOF'
Host github.com
  IdentityFile /var/www/.ssh/id_ed25519_apphong
  IdentitiesOnly yes
EOF
cd /var/www/hongchiangorderingsystem
sudo -u www-data git remote set-url origin git@github.com:sarimiduo/hongchiangorderingsystem.git
```

Optional auto-restart on every pull (recommended — ask the user):

```bash
sudo tee /var/www/hongchiangorderingsystem/.git/hooks/post-merge > /dev/null <<'EOF'
#!/bin/sh
sudo systemctl restart hongchiang
EOF
sudo chmod +x /var/www/hongchiangorderingsystem/.git/hooks/post-merge
# allow passwordless restart for www-data:
echo 'www-data ALL=(ALL) NOPASSWD: /bin/systemctl restart hongchiang' | \
  sudo tee /etc/sudoers.d/hongchiang-restart
```

**Verify:** `sudo -u www-data git -C /var/www/hongchiangorderingsystem fetch origin`
succeeds with no password prompt. Daily flow from any machine is then:
`git pull` → edit → `git commit` → `git push`, and on the VPS: `git pull`.

---

## Part 6 — Hermes agent + Discord bridge

This lets the user chat with the agent from Discord to modify the project.
The bridge code is already in the repo at `hermes/`.

**6a. Install the agent CLI** (Claude Code, the default):

```bash
curl -fsSL https://claude.ai/install.sh | bash
claude login     # the user must complete this authentication interactively
```

**6b. Discord bot (user actions — walk the user through these):**

1. https://discord.com/developers/applications → **New Application** → name `Hermes`.
2. **Bot** tab → **Reset Token** → copy it (`DISCORD_TOKEN`). Keep secret.
3. Same tab: enable **MESSAGE CONTENT INTENT**.
4. **OAuth2 → URL Generator** → scope `bot`; permissions `View Channels`,
   `Send Messages`, `Read Message History` → open the URL, add to their server.
5. In Discord: Settings → Advanced → **Developer Mode ON** → right-click their
   own name → **Copy User ID** (`ALLOWED_USER_IDS`).

**6c. Configure and run the bridge:**

```bash
cd /var/www/hongchiangorderingsystem/hermes
npm install
cp .env.example .env
# edit .env:
#   DISCORD_TOKEN=<ASK USER — from step 6b.2>
#   ALLOWED_USER_IDS=<ASK USER — from step 6b.5>
#   PROJECT_DIR=/var/www/hongchiangorderingsystem
node bot.js      # test: should print "Hermes bridge online as Hermes#...."
# Ctrl+C after the test, then install as a service:

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

> Note: the agent CLI must be usable by the service user. If `claude` was
> installed for a different user, either run the service as that user
> (change `User=` and the PROJECT_DIR ownership accordingly) or install/login
> the CLI for `www-data`. Verify with:
> `sudo -u www-data claude -p "say ok"` (should print a response).

**Verify:** in Discord, the user sends the bot `!status` → it replies with the
project path. Then a real test: *"add a comment at the top of README.md saying
hello from hermes, commit and push"* → check the commit appears on GitHub.

**Security notes (tell the user):**

- Anyone on `ALLOWED_USER_IDS` effectively has shell access to the project
  folder via the agent — keep it to their own Discord ID only.
- Never commit `hermes/.env` (it is already gitignored).
- If the Discord token leaks, reset it in the Developer Portal.

---

## Final checklist

- [ ] `https://apphong.berkatselalu.com` serves the ordering app over HTTPS
- [ ] `systemctl is-active hongchiang hermes-bot` → both `active`
- [ ] `git pull` / `git push` works on the VPS without password prompts
- [ ] Discord `!status` answers; a chat request produces a commit on GitHub
- [ ] (Optional) `.env` points at the real KDS device (`KDS_MODE=real`)

When everything passes, report each checklist item's status to the user.
