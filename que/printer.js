'use strict';
/**
 * ESC/POS ticket printing for the Epson TM-T82X (and compatibles).
 *
 * The TM-T82X prints QR codes natively (GS ( k), so the whole ticket - header,
 * queue number, QR Queue (landing URL), QR WhatsApp (wa.me deep link), notes,
 * cut - is one raw byte job. Transports (QUE_PRINT):
 *   file:<path>            append jobs to a file (dev/test; default)
 *   net:<host>:<port>      ESC/POS over TCP (Ethernet interface, port 9100)
 *   share:\\HOST\Printer   Windows shared printer - raw `copy /b` (USB on the
 *                          mini-PC: install the Epson driver, share it, done)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { execFile } = require('child_process');

const ESC = 0x1b, GS = 0x1d;
const b = (...xs) => Buffer.from(xs);
const txt = s => Buffer.from(s.replace(/[^\x20-\x7e\n]/g, '?'), 'ascii');

function qr(data, size = 7) {
  const d = Buffer.from(data, 'ascii');
  const len = d.length + 3;
  return Buffer.concat([
    b(GS, 0x28, 0x6b, 4, 0, 0x31, 0x41, 0x32, 0x00),            // model 2
    b(GS, 0x28, 0x6b, 3, 0, 0x31, 0x43, size),                  // module size
    b(GS, 0x28, 0x6b, 3, 0, 0x31, 0x45, 0x31),                  // EC level M
    b(GS, 0x28, 0x6b, len & 0xff, len >> 8, 0x31, 0x50, 0x30), d, // store
    b(GS, 0x28, 0x6b, 3, 0, 0x31, 0x51, 0x30),                  // print
  ]);
}

const center = b(ESC, 0x61, 1);
const left = b(ESC, 0x61, 0);
const big = b(GS, 0x21, 0x11);
const normal = b(GS, 0x21, 0x00);
const bold = on => b(ESC, 0x45, on ? 1 : 0);
const feed = n => b(ESC, 0x64, n);
const cut = b(GS, 0x56, 0x42, 0x03);

/** One roll segment: both QRs in sequence, as specified. */
function buildTicket({ store, disp, pax, name, queueUrl, waUrl, split }) {
  const parts = [
    b(ESC, 0x40), center,
    bold(1), txt(`${store}\n`), bold(0),
    txt('ANTRIAN / QUEUE\n'), feed(1),
    big, txt(`${disp}\n`), normal,
    txt(`${name ? name + ' - ' : ''}${pax} pax\n`), feed(1),
    txt('--- QR ANTRIAN / QR QUEUE ---\n'),
    txt('Pantau antrian & pindai di pintu masuk\nTrack your queue + scan at the entrance\n'), feed(1),
    qr(queueUrl, 7), feed(1),
    txt('--- QR WHATSAPP ---\n'),
    txt('Pindai & kirim untuk info giliran via WA\nScan & send to get your turn on WhatsApp\n'), feed(1),
    qr(waUrl, 7), feed(1),
  ];
  if (split) {
    parts.push(left, txt(
      'Mohon maaf: untuk pendaftaran langsung dengan\n' +
      'rombongan besar, tempat duduk mengikuti meja\n' +
      'yang tersedia sehingga Anda mungkin duduk\n' +
      'terpisah. Terima kasih atas pengertiannya.\n' +
      'Large walk-in groups are seated at available\n' +
      'tables and may be split up - thank you for\n' +
      'understanding.\n'), center, feed(1));
  }
  parts.push(txt('Terima kasih / Thank you\n'), feed(3), cut);
  return Buffer.concat(parts);
}

function printRaw(buf, target) {
  target = target || 'file:' + path.join(__dirname, 'data', 'printer-out.bin');
  return new Promise((resolve, reject) => {
    if (target.startsWith('file:')) {
      const p = target.slice(5);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.appendFile(p, buf, e => e ? reject(e) : resolve());
    } else if (target.startsWith('net:')) {
      const [host, port] = target.slice(4).split(':');
      const sock = net.connect({ host, port: Number(port) || 9100 }, () => {
        sock.end(buf, () => resolve());
      });
      sock.setTimeout(5000, () => { sock.destroy(); reject(new Error('printer timeout')); });
      sock.on('error', reject);
    } else if (target.startsWith('share:')) {
      // Windows: raw bytes to a shared printer. `copy /b job \\HOST\Printer`
      const share = target.slice(6);
      const tmp = path.join(os.tmpdir(), `que-print-${Date.now()}.bin`);
      fs.writeFileSync(tmp, buf);
      execFile('cmd.exe', ['/c', 'copy', '/b', tmp, share], (err, stdout, stderr) => {
        fs.unlink(tmp, () => {});
        if (!err) return resolve();
        // Surface what `copy` actually said (share name wrong, access denied,
        // network name not found) instead of a generic exit-code message.
        const detail = (String(stderr || '') + ' ' + String(stdout || '')).trim();
        reject(new Error('copy to ' + share + ' failed: ' + (detail || err.message)));
      });
    } else reject(new Error('bad QUE_PRINT target: ' + target));
  });
}

module.exports = { buildTicket, printRaw, qr };
