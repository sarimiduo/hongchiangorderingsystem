# Git workflow: GitHub ⇄ VPS ⇄ your workplaces

Goal: edit anywhere (laptop, office, the Hermes agent on the VPS), push to
GitHub (`sarimiduo/hongchiangorderingsystem`), pull anywhere.

```
 laptop ──push──▶ GitHub ◀──push── VPS (Hermes agent)
    ▲               │                ▲
    └──────pull─────┴──────pull──────┘
```

GitHub stays the single source of truth; the VPS is just another clone.

## 1. Give the VPS access to the repo

**Recommended: a deploy key with write access (SSH).** On the VPS:

```bash
ssh-keygen -t ed25519 -C "vps-apphong" -f ~/.ssh/id_ed25519_apphong -N ""
cat ~/.ssh/id_ed25519_apphong.pub
```

Copy the printed public key, then on GitHub:
**repo → Settings → Deploy keys → Add deploy key**, paste it and tick
**Allow write access**.

Tell ssh to use it for github.com (`~/.ssh/config`):

```
Host github.com
  IdentityFile ~/.ssh/id_ed25519_apphong
  IdentitiesOnly yes
```

Clone (or switch an existing clone) to SSH:

```bash
git clone git@github.com:sarimiduo/hongchiangorderingsystem.git
# or: git remote set-url origin git@github.com:sarimiduo/hongchiangorderingsystem.git
```

*Alternative:* a fine-grained **Personal Access Token** (GitHub → Settings →
Developer settings → Fine-grained tokens, scope: only this repo, permission
Contents: Read & write), then
`git remote set-url origin https://<TOKEN>@github.com/sarimiduo/hongchiangorderingsystem.git`.
Deploy keys are safer: they are scoped to one repo and one machine.

## 2. Identity on the VPS

```bash
git config --global user.name  "Dewa (VPS)"
git config --global user.email "dewa@90scaleup.id"
```

## 3. Daily flow

On any machine:

```bash
git pull origin main        # start from latest
# ... edit ...
git add -A && git commit -m "describe the change"
git push origin main
```

On the VPS after someone pushed:

```bash
cd /var/www/hongchiangorderingsystem
git pull origin main
sudo systemctl restart hongchiang
```

## 4. Optional: auto-deploy on pull

Add a `post-merge` hook on the VPS so every `git pull` restarts the app:

```bash
cat > .git/hooks/post-merge <<'EOF'
#!/bin/sh
sudo systemctl restart hongchiang
EOF
chmod +x .git/hooks/post-merge
```

(Allow the restart without password: `sudo visudo` →
`www-data ALL=(ALL) NOPASSWD: /bin/systemctl restart hongchiang`.)

## 5. Branch discipline (suggested)

- `main` = what runs on the VPS.
- Feature work on branches (`feature/...`), merge into `main` via PR when you
  want review, or push directly for quick fixes.
- The Hermes agent should commit to a branch like `hermes/<topic>` and open a
  PR, unless you tell it to push `main` directly.
