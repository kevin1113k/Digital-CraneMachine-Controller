# 數位夾娃娃機 — 手機遙控 + 雲端中繼

手機用 **4G / 5G / 任何 Wi-Fi** 都能玩，不需要和機台 PC 同一個網路。

```
手機瀏覽器 ──HTTPS / WSS──►  雲端中繼 (本專案 server.js)  ◄──WSS (PC 主動連出)──  機台 PC (Unity)
```

- 中繼同時提供手機網頁（`public/`）
- PC 是主動連出去，現場**不用開 port、不用設路由器、不用固定 IP**，只要 PC 能上網
- 中繼只轉送訊息，遊戲邏輯都在 Unity；協定見 [../docs/RemoteProtocol.md](../docs/RemoteProtocol.md)
- 支援多台機台：每台用不同的機台 ID（手機網址 `?m=<機台ID>`）

## 手機操作

1. 掃機台旁海報上的網址 QR（例如 `https://你的網域/?m=crane01`）開啟網頁
2. 網頁產生一次性 QR Code → 對準機台攝影機
3. 掃描成功後變成遙控器：**蘑菇頭搖桿**（推越多走越快）、**下爪**、**收爪**
4. 上方選「我站在機台的 正面/右側/背面/左側」，搖桿方向會跟著你看到的方向走

## 本機測試

```bash
cd WebController
npm install
npm start                 # http://localhost:8080/?m=crane01
npm test                  # 中繼伺服器整合測試
```

Unity `crane_settings.json`：

```json
"remoteMode": "both",
"relayUrl": "ws://localhost:8080/machine",
"machineId": "crane01",
"relayKey": ""
```

（本機沒設 `MACHINE_KEY` 時金鑰留空即可）

**用手機行動網路測試（不用部署）**：用 Cloudflare 快速通道把本機中繼暫時公開成 HTTPS 網址

```bash
cloudflared tunnel --url http://localhost:8080
# 會給一個 https://xxxx.trycloudflare.com
# 手機開 https://xxxx.trycloudflare.com/?m=crane01
# Unity relayUrl 可維持 ws://localhost:8080/machine
```

## 正式部署

任何支援 WebSocket 的 Node.js 主機都可以（Render、Railway、Fly.io、自己的 VPS…）。

| 環境變數 | 說明 |
|---|---|
| `MACHINE_KEY` | **必設**，機台連線金鑰（長隨機字串），Unity 的 `relayKey` 要一樣 |
| `DEFAULT_MACHINE` | 手機網址沒帶 `?m=` 時連哪台，預設 `crane01` |
| `PORT` | 平台通常自動提供 |

### Render

1. 把這個資料夾推到 GitHub
2. Render → New → Blueprint → 選這個 repo（會讀 `render.yaml`）
3. 部署完到 Environment 複製 `MACHINE_KEY`
4. Unity 設定：`"relayUrl": "wss://crane-relay.onrender.com/machine"`、`"relayKey": "<MACHINE_KEY>"`

> 免費方案閒置會休眠，第一次連線要等幾十秒；展場正式使用建議付費方案。

### Docker / VPS

```bash
docker build -t crane-relay .
docker run -d -p 8080:8080 -e MACHINE_KEY=換成長隨機字串 --restart unless-stopped crane-relay
```

前面需要接 HTTPS（Nginx / Caddy），手機瀏覽器在 HTTPS 頁面才允許震動、螢幕常亮等功能，正式環境也一定要用 `wss://`。

## 延遲

行動網路經雲端中繼，按鍵延遲約 50–150 ms（右上角會顯示 ping）。
搖桿按住時每 50 ms 送一次狀態；PC 端 `inputTimeout`（預設 0.6 秒）沒收到就自動停止，網路斷掉不會暴衝。

## 檔案

```
server.js          中繼伺服器 + 靜態網頁
public/index.html  手機頁面
public/app.js      連線、QR、蘑菇頭搖桿、按鈕
public/style.css   樣式
test/relay-test.js 整合測試
```
