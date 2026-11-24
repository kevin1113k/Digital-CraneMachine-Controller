/* 數位夾娃娃機 — 手機遙控 (協定見 PROTOCOL.md) */
'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const machineId = params.get('m') || '';
  const TOKEN_KEY = 'crane.token.' + (machineId || 'default');
  const SIDE_KEY = 'crane.side';
  const SEND_INTERVAL = 50;        // 搖桿按住時每 50ms 送一次 (PC 端超時即放開)
  const DEADZONE = 0.15;

  const PHASE_TEXT = {
    opening: '開爪', descending: '下降中…', closing: '收爪！', lifting: '上升中…',
    returning: '回到出貨口', releasing: '放爪', idle: '',
  };

  let connected = false, machineOnline = true;
  let token = sessionStorage.getItem(TOKEN_KEY) || newToken();
  let mode = 'connect';          // connect | qr | play | result
  let myState = 'idle';          // idle | playing | dropping | retry
  let timeLeft = 0, timeStamp = 0, expireAt = 0;
  let side = Number(localStorage.getItem(SIDE_KEY) || 0);
  let stick = { x: 0, y: 0, active: false }, lastSent = { x: 0, y: 0 }, lastSendTime = 0;
  let pingSent = 0, wakeLock = null;

  // ---------------------------------------------------------------- 連線
  // 兩種傳輸方式，訊息格式完全相同 (見 PROTOCOL.md)：
  //   relay：WebSocket 連 server.js 中繼 (或 Unity 區網伺服器)
  //   mqtt ：網頁放在 GitHub Pages 等靜態網站時，經 MQTT broker 與機台溝通
  const CFG = Object.assign({ transport: 'relay', defaultMachine: 'crane01' }, window.CRANE_CONFIG || {});
  const MACHINE = machineId || CFG.defaultMachine;
  let link = null;

  function onLinkOpen() { connected = true; setDot('ok'); register(); }
  function onLinkClose() {
    connected = false; setDot('bad');
    banner('連線中斷，重新連線中…');
  }
  function onLinkText(text) { try { onMessage(JSON.parse(text)); } catch (err) { console.warn(err); } }

  function connect() {
    setDot('warn');
    link = CFG.transport === 'mqtt' ? mqttLink() : wsLink();
  }

  function wsLink() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const url = `${proto}://${location.host}/ws${machineId ? '?m=' + encodeURIComponent(machineId) : ''}`;
    let ws, retryDelay = 500, closed = false;
    (function open() {
      ws = new WebSocket(url);
      ws.onopen = () => { retryDelay = 500; onLinkOpen(); };
      ws.onclose = () => {
        onLinkClose();
        if (!closed) setTimeout(open, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 5000);
      };
      ws.onerror = () => {};
      ws.onmessage = e => onLinkText(e.data);
    })();
    return { send: text => { if (ws && ws.readyState === 1) ws.send(text); } };
  }

  function mqttLink() {
    if (!window.mqtt) { banner('無法載入連線元件，請重新整理'); return { send() {} }; }
    // 每支手機一個隨機 id，機台用它回訊息給你
    const cid = sessionStorage.getItem('crane.cid') || ('p' + Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(36).padStart(2, '0')).join('').slice(0, 12));
    sessionStorage.setItem('crane.cid', cid);
    const base = `${CFG.topicRoot}/${MACHINE}`;
    const up = `${base}/up/${cid}`;
    const client = window.mqtt.connect(CFG.mqttUrl, {
      clientId: cid + '-' + Math.random().toString(36).slice(2, 6),
      clean: true,
      keepalive: 20,
      reconnectPeriod: 1000,
      connectTimeout: 8000,
      will: { topic: up, payload: '{"type":"__bye"}', qos: 0, retain: false },
    });
    client.on('connect', () => {
      client.subscribe([`${base}/down/${cid}`, `${base}/down/all`, `${base}/status`], { qos: 0 }, () => {
        client.publish(up, '{"type":"__hello"}');
        onLinkOpen();
      });
    });
    client.on('message', (topic, payload) => {
      const text = payload.toString();
      if (topic.endsWith('/status')) {
        // 機台上下線 (retained)，轉成和 relay 一樣的訊息
        onMessage({ type: 'relay', machine: text === 'online' ? 'online' : 'offline', machineId: MACHINE });
      } else onLinkText(text);
    });
    client.on('offline', onLinkClose);
    client.on('error', () => {});
    return { send: text => { if (client.connected) client.publish(up, text); } };
  }

  function send(obj) { if (link) link.send(JSON.stringify(obj)); }
  function register() { send({ type: 'register', token }); }

  function newToken() {
    const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const b = crypto.getRandomValues(new Uint8Array(12));
    const t = Array.from(b, x => a[x % a.length]).join('');
    sessionStorage.setItem(TOKEN_KEY, t);
    return t;
  }

  // ---------------------------------------------------------------- 訊息
  function onMessage(m) {
    switch (m.type) {
      case 'relay':
        machineOnline = m.machine === 'online';
        if (machineOnline) { banner(null); register(); }
        else { banner('機台目前離線，請稍候…'); setChip('off', '機台離線'); }
        break;
      case 'registered':
        banner(null);
        token = m.token;
        sessionStorage.setItem(TOKEN_KEY, token);
        expireAt = Date.now() + m.expiresIn * 1000;
        if (myState === 'idle' && mode !== 'result') { renderQr(); show('qr'); }
        break;
      case 'rejected':
        if (m.reason === 'alreadyused' || m.reason === 'invalid') { token = newToken(); register(); }
        else banner('目前排隊人數過多，請稍後再試');
        break;
      case 'machine':
        if (m.state === 'ready') setChip('ready', '● 機台空閒中，可以掃描');
        else if (m.state === 'booting') setChip('busy', '機台準備中…');
        else setChip('busy', '● 有人正在遊玩，請稍候');
        break;
      case 'start':
        myState = 'playing';
        setTime(m.timeLeft);
        $('roundBadge').textContent = `第 ${m.round || 1} 次`;
        $('roundBadge').classList.toggle('hide', !(m.round > 1 || m.guarantee));
        $('retry').classList.add('hide');
        setPhase('移動爪子，對準後按下爪');
        setPlayUi();
        show('play');
        vibrate([30, 40, 30]);
        keepAwake();
        break;
      case 'tick':
        setTime(m.timeLeft);
        break;
      case 'phase':
        if (m.phase !== 'idle') myState = 'dropping';
        setPhase(PHASE_TEXT[m.phase] ?? m.phase);
        if (m.phase === 'closing') vibrate(40);
        setPlayUi();
        break;
      case 'retry':
        myState = 'retry';
        setPlayUi();
        $('retryText').textContent = `準備第 ${m.round} 次…（不用重新掃描）`;
        $('retry').classList.remove('hide');
        vibrate([80, 60, 80]);
        break;
      case 'result':
        showResult(m.win, m.prize, m.rounds);
        break;
      case 'end':
        myState = 'idle';
        sessionStorage.removeItem(TOKEN_KEY);
        break;
      case 'pong':
        if (m.seq === pingSent) $('ping').textContent = `${Date.now() - pingSent} ms`;
        break;
    }
  }

  // ---------------------------------------------------------------- 畫面
  function show(name) {
    mode = name;
    document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === 'scr-' + name));
  }

  function banner(text) {
    const b = $('banner');
    b.classList.toggle('hide', !text);
    if (text) b.textContent = text;
  }

  function setDot(cls) { $('connDot').className = 'dot ' + cls; }
  function setChip(cls, text) { const c = $('machineChip'); c.className = 'chip ' + cls; c.textContent = text; }
  function setPhase(text) { $('phaseText').textContent = text; }

  function setTime(t) { timeLeft = t; timeStamp = performance.now(); }

  function renderQr() {
    $('tokenText').textContent = token;
    if (typeof qrcode !== 'function') { $('qr').textContent = token; return; }
    const qr = qrcode(0, 'M');
    qr.addData(token);
    qr.make();
    $('qr').innerHTML = qr.createSvgTag({ cellSize: 8, margin: 2, scalable: true });
  }

  function setPlayUi() {
    const canMove = myState === 'playing';
    $('stick').classList.toggle('disabled', !canMove);
    $('btnDrop').disabled = !canMove;
    $('btnGrab').disabled = myState !== 'dropping';
    $('btnGrab').classList.toggle('hot', myState === 'dropping');
    if (!canMove) releaseStick();
  }

  function showResult(win, prize, rounds) {
    myState = 'idle';
    releaseStick();
    $('retry').classList.add('hide');
    $('resultIcon').textContent = win ? '🎉' : '😢';
    $('resultTitle').textContent = win ? '恭喜夾到了！' : '差一點點！';
    $('resultText').textContent = win
      ? `獲得「${prize || '獎品'}」，請到機台取物口領取${rounds > 1 ? `（共 ${rounds} 次）` : ''}`
      : '下次一定可以！';
    show('result');
    vibrate(win ? [60, 50, 60, 50, 200] : 120);
    releaseWake();
  }

  // 每 200ms 更新畫面上的倒數 / 到期時間
  setInterval(() => {
    if (mode === 'play' && myState === 'playing') {
      const t = Math.max(0, timeLeft - (performance.now() - timeStamp) / 1000);
      $('timeLeft').textContent = Math.ceil(t);
      document.querySelector('.timer').classList.toggle('low', t <= 5);
    }
    if (mode === 'qr' && expireAt) {
      const s = Math.max(0, Math.round((expireAt - Date.now()) / 1000));
      $('expireText').textContent = s > 0 ? `QR Code 有效時間 ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` : 'QR Code 已過期，更新中…';
      if (s === 0) { expireAt = 0; token = newToken(); register(); }
    }
  }, 200);

  setInterval(() => { if (connected) { pingSent = Date.now(); send({ type: 'ping', seq: pingSent }); } }, 3000);

  // ---------------------------------------------------------------- 蘑菇頭搖桿
  const stickEl = $('stick'), knob = $('knob');
  const arrows = { up: stickEl.querySelector('.up'), down: stickEl.querySelector('.down'), left: stickEl.querySelector('.left'), right: stickEl.querySelector('.right') };
  let stickPointer = null;

  stickEl.addEventListener('pointerdown', e => {
    if (myState !== 'playing' || stickPointer !== null) return;
    e.preventDefault();
    stickPointer = e.pointerId;
    stickEl.setPointerCapture(e.pointerId);
    stickEl.classList.add('active');
    moveStick(e);
  });
  stickEl.addEventListener('pointermove', e => { if (e.pointerId === stickPointer) moveStick(e); });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(t =>
    stickEl.addEventListener(t, e => { if (e.pointerId === stickPointer) releaseStick(); }));

  function moveStick(e) {
    const r = stickEl.getBoundingClientRect();
    const radius = r.width / 2;
    let dx = (e.clientX - (r.left + radius)) / radius;
    let dy = (e.clientY - (r.top + radius)) / radius;
    const len = Math.hypot(dx, dy);
    if (len > 1) { dx /= len; dy /= len; }
    const travel = radius * 0.58;
    knob.style.transform = `translate(${dx * travel}px, ${dy * travel}px)`;

    // 類比搖桿：方向 = 推的角度，速度 = 推的距離 (死區外重新映射到 0..1)
    const mag = Math.min(1, len);
    let x = 0, y = 0;
    if (mag > DEADZONE) {
      const k = (mag - DEADZONE) / (1 - DEADZONE) / mag;
      x = q(dx * k);
      y = q(-dy * k);                                        // 往上推 = 往機台內
    }
    const wasIdle = stick.x === 0 && stick.y === 0;
    if (wasIdle && (x || y)) vibrate(8);
    const changed = Math.abs(x - lastSent.x) >= 0.05 || Math.abs(y - lastSent.y) >= 0.05 || ((x === 0 && y === 0) !== (lastSent.x === 0 && lastSent.y === 0));
    stick = { x, y, active: true };
    arrows.up.classList.toggle('on', y > 0.3);
    arrows.down.classList.toggle('on', y < -0.3);
    arrows.right.classList.toggle('on', x > 0.3);
    arrows.left.classList.toggle('on', x < -0.3);
    // 有變化就送，但最快 30ms 一次 (其餘由 50ms 的持續傳送補上)
    if (changed && performance.now() - lastSendTime > 30) maybeSend(false);
  }

  /** 量化到 0.05，減少無意義的小抖動訊息 */
  function q(v) { return Math.max(-1, Math.min(1, Math.round(v * 20) / 20)); }

  function releaseStick() {
    if (stickPointer !== null) { try { stickEl.releasePointerCapture(stickPointer); } catch {} }
    stickPointer = null;
    stickEl.classList.remove('active');
    knob.style.transform = '';
    Object.values(arrows).forEach(a => a.classList.remove('on'));
    const had = stick.x !== 0 || stick.y !== 0;
    stick = { x: 0, y: 0, active: false };
    if (had || lastSent.x !== 0 || lastSent.y !== 0) maybeSend(true);
  }

  function maybeSend(force) {
    if (myState !== 'playing' && !force) return;
    send({ type: 'input', x: stick.x, y: stick.y, side });
    lastSent = { x: stick.x, y: stick.y };
    lastSendTime = performance.now();
  }

  // 按住期間持續送 (PC 端超過時間沒收到會自動停止，避免斷線暴衝)
  setInterval(() => {
    if (myState === 'playing' && (stick.x !== 0 || stick.y !== 0)) {
      send({ type: 'input', x: stick.x, y: stick.y, side });
      lastSent = { x: stick.x, y: stick.y };
      lastSendTime = performance.now();
    }
  }, SEND_INTERVAL);

  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseStick(); });

  // ---------------------------------------------------------------- 按鈕
  function press(el, fn) {
    el.addEventListener('pointerdown', e => {
      e.preventDefault();
      if (el.disabled) return;
      el.classList.add('pressed');
      vibrate(25);
      fn();
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(t => el.addEventListener(t, () => el.classList.remove('pressed')));
  }
  press($('btnDrop'), () => { releaseStick(); send({ type: 'drop' }); });
  press($('btnGrab'), () => send({ type: 'grab' }));
  $('btnAgain').addEventListener('click', () => {
    token = newToken();
    myState = 'idle';
    show('connect');
    register();
  });

  // 站的位置 (決定搖桿方向)
  const seg = $('sideSeg');
  function renderSide() { seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', Number(b.dataset.side) === side)); }
  seg.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b) return;
    side = Number(b.dataset.side);
    localStorage.setItem(SIDE_KEY, side);
    renderSide();
    vibrate(10);
  });
  renderSide();

  // ---------------------------------------------------------------- 雜項
  function vibrate(p) { try { navigator.vibrate && navigator.vibrate(p); } catch {} }
  async function keepAwake() { try { if ('wakeLock' in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request('screen'); } catch {} }
  function releaseWake() { try { wakeLock && wakeLock.release(); } catch {} wakeLock = null; }
  document.addEventListener('gesturestart', e => e.preventDefault());

  connect();
  keepAwake();
})();
