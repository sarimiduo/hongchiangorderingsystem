# quehong - fresh Windows PC install (branch server)

Setting up a new Windows machine as the quehong queue server. Secrets
(QUE_TOKEN, PIN) are NOT in this file or the repo - bring them from the VPS
`.env` / the previous machine's `run_que.bat`.

## 1. Base tools (defaults are fine)

- Git: https://git-scm.com
- Node.js LTS: https://nodejs.org
- Python 3.10+: https://python.org - tick "Add python.exe to PATH"

## 2. Clone the repo

```bat
mkdir C:\hcbridge
cd C:\hcbridge
git clone https://github.com/sarimiduo/hongchiangorderingsystem.git repo
cd repo
git checkout claude/bold-davinci-jpzlmi
```

The repo is private: the first clone opens a GitHub sign-in window once.

## 3. Voice

```bat
pip install edge-tts
```

## 4. Launcher

```bat
copy repo\que\run_que.bat.example C:\hcbridge\run_que.bat
notepad C:\hcbridge\run_que.bat
```

Fill in QUE_TOKEN (must equal the VPS `.env` value), QUE_PIN, QUE_WA_NUMBER;
recommended voices: QUE_TTS_VOICE_ID=id-ID-GadisNeural,
QUE_TTS_VOICE_EN=en-US-JennyNeural. Leave QUE_PRINT for step 6.

## 5. Firewall (Administrator cmd, once)

```bat
netsh advfirewall firewall add rule name="quehong 3200" dir=in action=allow protocol=TCP localport=3200
```

## 6. Printer (TM-T82X over USB)

Add Printer -> "Add a local printer with manual settings" -> port USB001 ->
driver Generic / Text Only -> name + SHARE name `TMT82X`. Prove it in cmd:

```bat
echo test > %TEMP%\t.txt
copy /b %TEMP%\t.txt \\localhost\TMT82X
```

Paper must move. "copied" but silent = wrong USB port (Printer properties ->
Ports -> try the next USB00x). Then in the bat:

```bat
set QUE_PRINT=share:\\localhost\TMT82X
```

## 7. Run + point the devices

Double-click `C:\hcbridge\run_que.bat` -> banner `quehong local on
http://0.0.0.0:3200`. Give the PC a FIXED IP on the router; `ipconfig`
shows it. Devices (same LAN):

- tablet: `http://<ip>:3200/register`
- queue TV: `http://<ip>:3200/display?view=queue` (click once for sound, F11)
- seat TV: `http://<ip>:3200/display?view=seat`
- scanner station: `http://<ip>:3200/scan` (page must stay the focused window)
- staff: `http://<ip>:3200/admin` (PIN from the bat)

VPS link check: `https://quehong.berkatselalu.com/healthz` -> `age_s` under
~35 means the mirror is receiving.

## 8. Optional

- WhatsApp worker: `cd C:\hcbridge\repo\que\wa && npm install && node
  worker.js`, scan the terminal QR from the bot phone (Linked devices).
  Session persists in `que\wa\auth\` (treat as a credential).
- ESB occupancy feed (only if this PC reaches the ESB MySQL): agent.ini
  `[que]` / `url = http://127.0.0.1:3200`, run hc_bridge_agent.py --run.
- Autostart: Task Scheduler -> Create Task -> trigger "At startup" ->
  action `C:\hcbridge\run_que.bat` (second task for the WA worker), and set
  Windows to never sleep while plugged in.

## Update loop

Code changes are pushed to branch `claude/bold-davinci-jpzlmi` from the
development session. On this PC:

```bat
cd C:\hcbridge\repo
git pull
```

Then restart the bat for server changes, or just Ctrl+F5 the browser pages
for page-only changes. Queue state (`que\data\que_state.json`) survives
restarts; delete that file (bat stopped) only to reset the queue to Q001.
