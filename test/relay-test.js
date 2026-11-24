// 中繼伺服器整合測試：npm test
'use strict';
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const assert = require('assert');
const WebSocket = require('ws');

const PORT = 18080 + Math.floor(Math.random() * 1000);
const KEY = 'test-key';
const base = `ws://127.0.0.1:${PORT}`;

function waitFor(ws, pred, ms = 2000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { ws.off('message', on); reject(new Error('timeout')); }, ms);
    function on(raw) {
      const m = JSON.parse(raw.toString());
      if (pred(m)) { clearTimeout(t); ws.off('message', on); resolve(m); }
    }
    ws.on('message', on);
  });
}
const open = ws => new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
const get = p => new Promise((res, rej) => http.get(`http://127.0.0.1:${PORT}${p}`, r => {
  let b = ''; r.on('data', d => (b += d)); r.on('end', () => res({ status: r.statusCode, body: b }));
}).on('error', rej));

(async () => {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT, MACHINE_KEY: KEY }, stdio: 'pipe' });
  await new Promise(r => srv.stdout.on('data', d => d.toString().includes('listening') && r()));
  let ok = 0;
  const pass = name => { ok++; console.log('  ✓', name); };
  try {
    // 靜態網頁
    assert.strictEqual((await get('/')).status, 200);
    assert.ok((await get('/vendor/qrcode.js')).body.includes('qrcode'));
    assert.strictEqual((await get('/../server.js')).status !== 200, true);
    pass('靜態網頁 / QR 函式庫 / 路徑穿越防護');

    // 錯誤金鑰
    const bad = new WebSocket(`${base}/machine?id=crane01&key=wrong`);
    await assert.rejects(open(bad));
    pass('錯誤金鑰被拒');

    // 手機先連 (機台離線)
    const phone = new WebSocket(`${base}/ws?m=crane01`);
    const off = waitFor(phone, m => m.type === 'relay');
    await open(phone);
    assert.strictEqual((await off).machine, 'offline');
    pass('機台離線時手機收到 offline');

    // 機台上線 → 機台收到既有手機、手機收到 online
    const machine = new WebSocket(`${base}/machine?id=crane01&key=${KEY}`);
    const conn = waitFor(machine, m => m.ev === 'connect');
    const online = waitFor(phone, m => m.type === 'relay' && m.machine === 'online');
    await open(machine);
    const { id } = await conn;
    await online;
    pass(`機台上線，收到手機 id=${id}`);

    // 手機 → 機台
    const got = waitFor(machine, m => m.ev === 'msg');
    phone.send(JSON.stringify({ type: 'register', token: 'ABCDEF123456' }));
    const msg = await got;
    assert.strictEqual(JSON.parse(msg.data).token, 'ABCDEF123456');
    pass('手機訊息轉送到機台 (原文不變)');

    // 機台 → 指定手機
    const reply = waitFor(phone, m => m.type === 'registered');
    machine.send(JSON.stringify({ to: id, data: JSON.stringify({ type: 'registered', token: 'ABCDEF123456', expiresIn: 900 }) }));
    assert.strictEqual((await reply).expiresIn, 900);
    pass('機台訊息轉送到指定手機');

    // 廣播
    const phone2 = new WebSocket(`${base}/ws?m=crane01`);
    await open(phone2);
    const b1 = waitFor(phone, m => m.type === 'machine'), b2 = waitFor(phone2, m => m.type === 'machine');
    machine.send(JSON.stringify({ to: 0, data: JSON.stringify({ type: 'machine', state: 'ready' }) }));
    await Promise.all([b1, b2]);
    pass('廣播給所有手機');

    // 別台機台的手機收不到
    const other = new WebSocket(`${base}/ws?m=crane02`);
    await open(other);
    let leaked = false;
    other.on('message', r => { if (JSON.parse(r.toString()).type === 'machine') leaked = true; });
    machine.send(JSON.stringify({ to: 0, data: JSON.stringify({ type: 'machine', state: 'playing' }) }));
    await new Promise(r => setTimeout(r, 200));
    assert.ok(!leaked);
    pass('不同機台 ID 互相隔離');

    // 手機離線 → 機台收到 disconnect
    const disc = waitFor(machine, m => m.ev === 'disconnect' && m.id === id);
    phone.close();
    await disc;
    pass('手機離線通知機台');

    // 機台離線 → 手機收到 offline
    const off2 = waitFor(phone2, m => m.type === 'relay' && m.machine === 'offline');
    machine.close();
    await off2;
    pass('機台離線通知手機');

    phone2.close(); other.close();
    console.log(`\n全部通過 (${ok} 項)`);
  } catch (e) {
    console.error('\n測試失敗:', e);
    process.exitCode = 1;
  } finally {
    srv.kill();
  }
})();
