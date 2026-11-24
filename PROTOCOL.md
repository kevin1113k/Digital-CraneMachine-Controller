# 數位夾娃娃機 — 手機遙控通訊協定 (v1)

PC (Unity) 端內建 WebSocket 伺服器，手機網頁直接連線。

- WebSocket：`ws://<PC_IP>:8765/`（port 在 `crane_settings.json` 的 `serverPort`）
- 狀態查詢：`GET http://<PC_IP>:8765/api/status`
- 除錯遙控頁：`http://<PC_IP>:8765/`（`Assets/StreamingAssets/remote-debug/index.html`）

所有訊息都是 JSON 文字，必有 `type` 欄位。

## 流程

```
手機開網頁 ─ 產生隨機 token ─► register ─► PC 記錄 (pending, 預設 15 分鐘有效)
手機把 token 顯示成 QR Code
玩家把 QR 對準機台攝影機 ─► PC 掃到 pending token ─► start (開始倒數)
input / drop / grab ...
爪子流程結束 ─► result ─► end ─► PC 刪除該 token 並永久作廢 (存檔，重開機也不能再用)

保夾到出貨模式 (guaranteeUntilWin = true)：
沒出貨 ─► retry ─► (等 delay 秒) ─► start (round+1) ... 直到出貨才 result / end，token 才作廢
```

## token 規則

- 6–64 字元，只允許 `A-Z a-z 0-9 - _`
- 建議 12 碼大寫英數（去掉易混淆的 0/O/1/I），用 `crypto.getRandomValues` 產生
- QR 內容可以是：純 token、`CRANE:<token>`、或含 `?token=<token>` 的網址（之後若要讓 QR 掃了能開網頁也相容）
- 若 `register` 不帶 token，PC 會代為產生並在 `registered` 回傳

## 手機 → PC

| type | 欄位 | 說明 |
|---|---|---|
| `register` | `token` | 註冊/重新綁定 token。斷線重連時再送一次即可接回目前這局 |
| `input` | `x`, `y`, `side` | 搖桿狀態，`x` 右為正、`y` 往機台內(遠離自己)為正，範圍 -1..1（類比，推越多越快）。`side` = 玩家站的面：0 前、1 右、2 後、3 左。**按住期間每 50ms 送一次，放開立刻送 0**。PC 超過 `inputTimeout`（預設 0.6 秒）沒收到就視為放開 |
| `drop` | | 下爪。下降途中再送一次 = 收爪 |
| `grab` | | 收爪（下降途中立刻停止並夾取；不送則觸底自動夾） |
| `ping` | `seq` | 量延遲用，回 `pong` |
| `status` | | 要求回傳目前機台狀態 |

## PC → 手機

| type | 欄位 | 說明 |
|---|---|---|
| `registered` | `token`, `expiresIn` | 註冊成功，`expiresIn` 秒內需掃碼 |
| `rejected` | `token`, `reason` | `alreadyused` / `invalid` / `full` |
| `machine` | `state` | 機台狀態廣播：`booting` `ready` `playing` `dropping` `retry` `result` |
| `start` | `duration`, `timeLeft`, `round`, `guarantee` | 你的局開始了（重連時也會收到）。`round` 從 1 起算，`guarantee` = 是否為保夾到出貨模式 |
| `retry` | `round`, `delay` | 保夾模式沒出貨：`delay` 秒後自動開始第 `round` 局（同一個 token，不用再掃碼） |
| `tick` | `timeLeft` | 每秒剩餘時間（整數） |
| `phase` | `phase` | 爪子動作：`opening` `descending` `closing` `lifting` `returning` `releasing` `idle` |
| `result` | `win`, `prize`, `rounds` | 最終結果，`prize` 為獎品名稱（沒中為 null），`rounds` = 共玩了幾局 |
| `end` | | 本局結束，token 已作廢；要再玩需產生新 token |
| `pong` | `seq` | |
| `error` | `reason` | 例如 `bad_json` |

## 範例

```js
const ws = new WebSocket(`ws://${pcIp}:8765/`);
ws.onopen = () => ws.send(JSON.stringify({ type: 'register', token }));
// 按住右鍵
setInterval(() => ws.send(JSON.stringify({ type: 'input', x: 1, y: 0, side: 0 })), 50);
ws.send(JSON.stringify({ type: 'drop' }));
```

## 連線方式

| 方式 | 手機網址 | 說明 |
|---|---|---|
| **雲端中繼（正式）** | `https://<中繼網域>/?m=<機台ID>` | 手機用行動網路即可。網頁與 WebSocket (`wss://<中繼網域>/ws?m=<機台ID>`) 都由中繼提供，PC 主動連出。實作在 `WebController/` |
| 區網直連（備用） | `http://<PC_IP>:8765/` | 手機需與 PC 同網段 |

兩種方式的訊息格式完全相同，中繼只轉送不改內容。只有中繼會額外送：

| type | 欄位 | 說明 |
|---|---|---|
| `relay` | `machine`, `machineId` | `online` / `offline`：機台 PC 是否連上中繼。收到 `online` 時手機應重新送一次 `register` |

`input` 的 `x`、`y` 為類比值 (-1..1)，推越多移動越快；Unity 設定 `joystickAnalog = false` 時會量化成固定速度 8 方向。
