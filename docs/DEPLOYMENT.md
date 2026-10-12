# Deploying to your VPS (apphong.berkatselalu.com)

Two options: plain Node + systemd (recommended, zero dependencies) or Docker.
Commands below assume Ubuntu/Debian with sudo.

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
sudo cp .env.example .env     # then edit: KDS_MODE, KDS_BASE_URL
sudo chown -R www-data:www-data /var/www/hongchiangorderingsystem
```

## 2. Run as a service

```bash
sudo cp deploy/hongchiang.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hongchiang
systemctl status hongchiang        # should be active (running)
curl -s localhost:3000/api/config  # sanity check
```

## 3. Bind the domain

**DNS:** in the DNS panel for `berkatselalu.com`, add an **A record**
`apphong` → your VPS public IP (TTL 300 is fine). Wait until
`dig +short apphong.berkatselalu.com` returns the IP.

**nginx:**

```bash
sudo cp deploy/nginx.apphong.conf /etc/nginx/sites-available/apphong.berkatselalu.com
sudo ln -s /etc/nginx/sites-available/apphong.berkatselalu.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

**HTTPS (Let's Encrypt):**

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d apphong.berkatselalu.com --redirect
```

Open https://apphong.berkatselalu.com — done.

## 4. Updating after a git push

```bash
cd /var/www/hongchiangorderingsystem
sudo -u www-data git pull
sudo systemctl restart hongchiang
```

(No build step and no `npm install` — the server is dependency-free.)

## Docker alternative

```bash
docker compose up -d --build       # listens on :3000; same nginx config in front
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
