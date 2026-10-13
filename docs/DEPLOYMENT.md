# Deploying to your VPS (apphong + midhong)

Two options: plain Node + systemd (recommended, zero dependencies) or Docker.
Commands below assume Ubuntu/Debian with sudo.

Two Node processes run from one checkout:

| Process | File | Port | Domain | systemd unit |
|---|---|---|---|---|
| **apphong** — ordering app | `server/index.js` | 3000 | `apphong.berkatselalu.com` | `hongchiang` |
| **midhong** — ESB bridge middleware | `server/mid.js` | 3100 | `midhong.berkatselalu.com` | `hongchiang-mid` |

Both read the same `.env` and bind `127.0.0.1` only; nginx is the public surface.

## 1. One-time VPS setup

```bash
# Node 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs nginx git

# App folder + clone (see docs/VPS_GIT.md for auth setup)
sudo mkdir -p /var/www
cd /var/www
sudo git clone https://github.com/sarimiduo/hongchiangorderingsystem.git
cd hongchiangorderingsystem
sudo cp .env.example .env     # then edit: KDS_MODE, KDS_BASE_URL, BRIDGE_TOKEN, AGENT_TOKEN (openssl rand -hex 24 for each)
sudo chown -R www-data:www-data /var/www/hongchiangorderingsystem
```

## 2. Run as services

```bash
sudo cp deploy/hongchiang.service deploy/hongchiang-mid.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hongchiang hongchiang-mid
systemctl status hongchiang hongchiang-mid   # both active (running)
curl -s localhost:3000/api/config            # apphong
curl -s localhost:3100/api/health            # midhong
```

## 3. Bind the domains

**DNS:** in the DNS panel for `berkatselalu.com`, add two **A records**
pointing at the same VPS public IP (TTL 300 is fine): `apphong` and `midhong`.
Wait until `dig +short apphong.berkatselalu.com` and
`dig +short midhong.berkatselalu.com` both return the IP.

**nginx:**

```bash
sudo cp deploy/nginx.apphong.conf /etc/nginx/sites-available/apphong.berkatselalu.com
sudo cp deploy/nginx.midhong.conf /etc/nginx/sites-available/midhong.berkatselalu.com
sudo ln -s /etc/nginx/sites-available/apphong.berkatselalu.com /etc/nginx/sites-enabled/
sudo ln -s /etc/nginx/sites-available/midhong.berkatselalu.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

**HTTPS (Let's Encrypt):**

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d apphong.berkatselalu.com --redirect
sudo certbot --nginx -d midhong.berkatselalu.com --redirect
```

Open https://apphong.berkatselalu.com (app) and https://midhong.berkatselalu.com
(bridge monitor) — done.

## 4. Updating after a git push

```bash
cd /var/www/hongchiangorderingsystem
sudo -u www-data git pull
sudo systemctl restart hongchiang hongchiang-mid
```

(No build step and no `npm install` — both servers are dependency-free.)

## 5. Connect the mini-PC agent

The agent at the branch talks to **midhong**, not to the app. In its
`agent.ini`:

```ini
[webapp]
url = https://midhong.berkatselalu.com
token = <the AGENT_TOKEN value from the VPS .env>
```

Verify from anywhere:

```bash
curl -s https://midhong.berkatselalu.com/api/health   # {"ok":true,"agent_live":...}
```

and open https://midhong.berkatselalu.com/ — once the agent polls, the monitor
page shows "🟢 live agent connected" (until then: simulator or offline).

## Docker alternative

```bash
docker compose up -d --build       # app on :3000, mid on :3100; same nginx configs in front
```

## Pointing at a real KDS device

Edit `.env` on the VPS:

```
KDS_MODE=real
KDS_BASE_URL=http://<kds-ip>:5500/kds
```

then `sudo systemctl restart hongchiang`. The VPS must be able to reach the KDS
host (usually that means the KDS is on the same network or exposed via VPN —
do **not** expose port 5500 to the public internet).
