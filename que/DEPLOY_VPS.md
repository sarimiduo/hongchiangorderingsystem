# quehong - VPS deployment runbook (public mirror)

Open this file in a Claude Code session **on the VPS** and follow it top to
bottom. It deploys the only internet-facing part of the walk-in queue system:
`que/pub.js`, the public mirror that serves customers' "QR Queue" landing
pages at `https://quehong.berkatselalu.com/q/<token>`.

Context: the full queue system (registration tablet, TM-T82X printing, TV
displays, scanner, WhatsApp worker) runs on the branch **mini-PC** - see
`que/README.md`. The mini-PC pushes queue snapshots here outbound-only with a
shared Bearer token; this service holds no customer data beyond the live
snapshot and writes nothing back.

The VPS already runs `hongchiang` (apphong, :3000) and `hongchiang-mid`
(midhong, :3100). quehong uses **port 3200**. The real checkout is
`/home/dewa-dev/work/hongchiang-esb`, owned by `dewa-dev` - do everything as
`dewa-dev`, plain `git pull` (NO `sudo -u www-data`, it trips git's
dubious-ownership refusal).

## 0. DNS first

Add an A record `quehong.berkatselalu.com` → this VPS's IP (same as apphong /
midhong). Wait until `dig +short quehong.berkatselalu.com` answers before the
certbot step.

## 1. Pull the code

```bash
cd /home/dewa-dev/work/hongchiang-esb
git pull
node --check que/pub.js        # sanity
```

## 2. Generate the shared token and extend .env

```bash
openssl rand -hex 24           # this is QUE_TOKEN - note it, the mini-PC needs the same value
```

Append to the existing `.env` in the checkout (do NOT print the whole file):

```
QUE_TOKEN=<the generated hex>
QUE_PUB_PORT=3200
```

`HOST` stays unset: pub.js binds 127.0.0.1 and nginx fronts it.

## 3. systemd unit

`deploy/hongchiang-que.service` is the template; its paths/user are the
generic example. Install it with the REAL checkout and user:

```bash
sudo cp deploy/hongchiang-que.service /etc/systemd/system/hongchiang-que.service
sudo sed -i -e 's#/var/www/hongchiangorderingsystem#/home/dewa-dev/work/hongchiang-esb#g' \
            -e 's#^User=www-data#User=dewa-dev#' /etc/systemd/system/hongchiang-que.service
sudo systemctl daemon-reload
sudo systemctl enable --now hongchiang-que
systemctl status hongchiang-que --no-pager
curl -s http://127.0.0.1:3200/healthz   # {"status":true,...}
```

If it fails to start, `journalctl -u hongchiang-que -n 30` - the usual cause
is a missing `QUE_TOKEN` in `.env` (the service refuses to boot without it).

## 4. nginx + SSL

```bash
sudo cp deploy/nginx.quehong.conf /etc/nginx/sites-available/quehong.berkatselalu.com
sudo ln -s /etc/nginx/sites-available/quehong.berkatselalu.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d quehong.berkatselalu.com
```

## 5. Verify

```bash
curl -s https://quehong.berkatselalu.com/healthz
# {"status":true,"tickets":0,"age_s":null}   (age_s fills once the mini-PC pushes)

# simulate one mirror push (use the real token):
curl -s -X POST https://quehong.berkatselalu.com/api/mirror \
  -H "Authorization: Bearer $QUE_TOKEN" -H 'Content-Type: application/json' \
  -d '{"store":"Edo Sushi","day":"test","last_called":1,"tickets":[{"token":"abcdef0123456789abcd","number":2,"disp":"Q002","state":"waiting","revoked":false,"ahead":1}]}'

# then open https://quehong.berkatselalu.com/q/abcdef0123456789abcd
# -> landing page "Q002, 1 antrian di depan Anda"
```

A wrong/missing token must answer `401 unauthorized`.

## 6. Hand the two values to the mini-PC

The mini-PC's `run_que.bat` (see `que/README.md`) needs:

```
QUE_PUB_URL=https://quehong.berkatselalu.com
QUE_TOKEN=<same value as the VPS .env>
```

Once the local server starts, `curl -s https://quehong.berkatselalu.com/healthz`
shows `age_s` under ~35 even when the queue is idle - that is the liveness
signal for the mirror link.

## Notes

- Deploy updates later = `git pull` + `sudo systemctl restart hongchiang-que`.
- The landing page auto-refreshes every 7 s and dies (no refresh, "Antrian
  selesai") once the mini-PC revokes the token at seat/finish time.
- If the mini-PC loses internet the queue keeps running at the branch; this
  mirror just goes stale (age_s grows) and landing pages freeze - nothing to
  do on the VPS side.
