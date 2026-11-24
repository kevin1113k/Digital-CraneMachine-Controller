/**
 * 數位夾娃娃機 — 雲端中繼伺服器
 *
 *   手機 (4G/5G/任何網路)  ──wss /ws?m=<機台ID>──►  本伺服器  ◄──wss /machine?id=<機台ID>&key=<金鑰>──  機台 PC (Unity)
 *
 * - 同時提供手機遙控網頁 (public/)
 * - PC 是「主動連出」，現場不需要開 port、不需要和手機同一個 Wi-Fi
 * - 中繼只轉送訊息，不解讀遊戲內容；手機端協定與 PC 直連完全相同 (docs/RemoteProtocol.md)
 *
 * 環境變數：
 *   PORT             監聽 port (雲端平台通常自動給)            預設 8080
 *   MACHINE_KEY      機台連線金鑰 (必設！Unity 端 relayKey 要相同)
 *   DEFAULT_MACHINE  手機網址沒帶 ?m= 時連哪台                  預設 crane01
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT) || 8080;
const MACHINE_KEY = process.env.MACHINE_KEY || '';
const DEFAULT_MACHINE = process.env.DEFAULT_MACHINE || 'crane01';
const PUBLIC_DIR = path.join(__dirname, 'public');
const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

if (!MACHINE_KEY) console.warn('[relay] 警告：未設定 MACHINE_KEY，任何人都能冒充機台。正式部署請務必設定。');

// ------------------------------------------------------------------ HTTP (靜態網頁)
const STATIC = {
  '/vendor/qrcode.js': path.join(__dirname, 'node_modules', 'qrcode-generator', 'qrcode.js'),
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') return send(res, 200, 'text/plain', 'ok');
  if (url.pathname === '/api/machines') {
    const list = [...machines.keys()].map(id => ({ id, phones: machines.get(id).phones.size }));
    return send(res, 200, 'application/json', JSON.stringify(list));
  }
  let file = STATIC[url.pathname];
  if (!file) {
    const p = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
    file = path.normalize(path.join(PUBLIC_DIR, p));
    if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'text/plain', 'forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'text/plain', 'not found');
    send(res, 200, MIME[path.extname(file)] || 'application/octet-stream', data,
      path.extname(file) === '.html' ? 'no-cache' : 'public, max-age=300');
  });
});

function send(res, status, type, body, cache = 'no-cache') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': cache, 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

// ------------------------------------------------------------------ WebSocket 中繼
/** @type {Map<string, {ws: WebSocket, phones: Set<number>}>} */
const machines = new Map();
/** @type {Map<number, {ws: WebSocket, machineId: string, ip: string}>} */
const phones = new Map();
let nextPhoneId = 1;

const wssPhone = new WebSocketServer({ noServer: true, maxPayload: 2048 });
const wssMachine = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/machine') {
    const id = url.searchParams.get('id') || '';
    const key = url.searchParams.get('key') || '';
    if (!ID_RE.test(id) || !keyOk(key)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    wssMachine.handleUpgrade(req, socket, head, ws => onMachine(ws, id));
  } else if (url.pathname === '/ws') {
    const m = url.searchParams.get('m') || DEFAULT_MACHINE;
    if (!ID_RE.test(m)) return socket.destroy();
    wssPhone.handleUpgrade(req, socket, head, ws => onPhone(ws, m, clientIp(req)));
  } else {
    socket.destroy();
  }
});

function keyOk(key) {
  if (!MACHINE_KEY) return true;
  const a = Buffer.from(key), b = Buffer.from(MACHINE_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  return (typeof xf === 'string' && xf.split(',')[0].trim()) || req.socket.remoteAddress || '';
}

function sendJson(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function relayStatus(machineId, online) {
  for (const p of phones.values())
    if (p.machineId === machineId) sendJson(p.ws, { type: 'relay', machine: online ? 'online' : 'offline' });
}

function onMachine(ws, id) {
  const old = machines.get(id);
  if (old) { old.replaced = true; old.ws.close(4000, 'replaced'); }
  const entry = { ws, phones: new Set(), alive: true };
  ws.owner = entry;
  machines.set(id, entry);
  console.log(`[relay] 機台上線 ${id}`);

  // 告訴機台目前已在線的手機
  for (const [pid, p] of phones)
    if (p.machineId === id) {
      entry.phones.add(pid);
      sendJson(ws, { ev: 'connect', id: pid, ip: p.ip });
    }
  relayStatus(id, true);

  ws.on('pong', () => { entry.alive = true; });
  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    let env;
    try { env = JSON.parse(raw.toString()); } catch { return; }
    if (typeof env.data !== 'string') return;
    if (env.to > 0) {
      const p = phones.get(env.to);
      if (p && p.machineId === id && p.ws.readyState === WebSocket.OPEN) p.ws.send(env.data);
    } else {
      for (const pid of entry.phones) {
        const p = phones.get(pid);
        if (p && p.ws.readyState === WebSocket.OPEN) p.ws.send(env.data);
      }
    }
  });
  ws.on('close', () => {
    if (machines.get(id) === entry) {
      machines.delete(id);
      console.log(`[relay] 機台離線 ${id}`);
      relayStatus(id, false);
    }
  });
  ws.on('error', () => {});
}

function onPhone(ws, machineId, ip) {
  const id = nextPhoneId++;
  const p = { ws, machineId, ip, alive: true, tokens: 40, last: Date.now() };
  ws.owner = p;
  phones.set(id, p);
  const m = machines.get(machineId);
  if (m) {
    m.phones.add(id);
    sendJson(m.ws, { ev: 'connect', id, ip });
  }
  sendJson(ws, { type: 'relay', machine: m ? 'online' : 'offline', machineId });

  ws.on('pong', () => { p.alive = true; });
  ws.on('message', (raw, isBinary) => {
    if (isBinary) return;
    // 簡易限流：每秒補 40 個額度 (搖桿 20Hz 綽綽有餘)
    const now = Date.now();
    p.tokens = Math.min(40, p.tokens + (now - p.last) * 0.04);
    p.last = now;
    if (p.tokens < 1) return;
    p.tokens -= 1;

    const mm = machines.get(machineId);
    if (!mm) return sendJson(ws, { type: 'relay', machine: 'offline', machineId });
    mm.phones.add(id);
    sendJson(mm.ws, { ev: 'msg', id, data: raw.toString() });
  });
  ws.on('close', () => {
    phones.delete(id);
    const mm = machines.get(machineId);
    if (mm && mm.phones.delete(id)) sendJson(mm.ws, { ev: 'disconnect', id });
  });
  ws.on('error', () => {});
}

// 心跳：雲端平台的代理會切斷閒置連線，也用來清掉死連線
setInterval(() => {
  for (const set of [wssPhone.clients, wssMachine.clients])
    for (const ws of set) {
      const owner = ws.owner;
      if (owner && !owner.alive) { ws.terminate(); continue; }
      if (owner) owner.alive = false;
      try { ws.ping(); } catch {}
    }
}, 15000);

server.listen(PORT, () => console.log(`[relay] listening on :${PORT}  手機網址 http://localhost:${PORT}/?m=${DEFAULT_MACHINE}`));
