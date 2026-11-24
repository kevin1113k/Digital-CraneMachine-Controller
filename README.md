# 數位夾娃娃機 — 手機遙控

手機用 **4G / 5G / 任何 Wi-Fi** 都能玩，不需要和機台 PC 同一個網路。

## 兩種架設方式

**A. GitHub Pages + MQTT（目前使用，免費、免架伺服器）**

```
手機瀏覽器 (GitHub Pages 網頁) ──WSS──►  MQTT broker (broker.emqx.io)  ◄──WSS──  機台 PC (Unity)
```

- 手機網址：`https://kevin1113k.github.io/Digital-CraneMachine-Controller/?m=crane01`
- 設定在 `public/config.js`；Unity `crane_settings.json` 的 `mqttUrl`、`mqttTopicRoot`、`machineId` 必須一致
- PC 主動連出，現場不用開 port

**B. 自架中繼 server.js（需要 Node.js 主機，例如 Render）**

```
手機瀏覽器 ──HTTPS / WSS──►  server.js  ◄──WSS──  機台 PC (Unity)
```

- 由 server.js 提供網頁時會自動改走中繼，不需改 config.js
- 有機台金鑰保護，延遲較低、不依賴第三方服務

兩種方式的訊息格式相同，協定見 [PROTOCOL.md](PROTOCOL.md)。支援多台機台：每台用不同的機台 ID（網址 `?m=<機台ID>`）。

> **關於公開 MQTT broker**：`broker.emqx.io` 是公開測試服務，任何知道主題名稱的人都看得到訊息，也不保證穩定。
> 遊戲開始仍需在機台實體掃 QR，所以無法遠端白玩；但正式長期營運建議改用私人 broker（例如 EMQX Cloud / HiveMQ Cloud 免費方案，
> 選亞洲機房延遲較低，填入 `mqttUrl`、`mqttUser`、`mqttPassword`）或方式 B。

## 手機操作

1. 掃機台旁海報上的網址 QR（例如 `https://你的網域/?m=crane01`）開啟網頁
2. 網頁產生一次性 QR Code → 對準機台攝影機
3. 掃描成功後變成遙控器（**橫式**）：左手**蘑菇頭搖桿**（推越多走越快），右手一顆大按鈕
   - 遊戲中按 = **下爪**；爪子下降時同一顆按鈕變成 **收爪**，再按即提早夾取（不按則觸底自動夾）
4. 方向以機台**正面**為準
5. 手機鎖定直向也沒關係：介面會自動轉 90°，橫拿即可（Android 會嘗試全螢幕並鎖定橫向）

## 更新 GitHub Pages

改完 `public/` 裡的檔案後：

```bash
git add -A
git commit -m "說明"
git push
```

約 1 分鐘後 Pages 會自動更新。

## 本機測試 (方式 B)

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

## 部署方式 B

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

經公開 MQTT broker 單程約 150–200 ms；自架中繼或亞洲機房的私人 broker 約 50–100 ms（右上角會顯示 ping 來回時間）。
搖桿按住時每 50 ms 送一次狀態；PC 端 `inputTimeout`（預設 0.6 秒）沒收到就自動停止，網路斷掉不會暴衝。

## 檔案

```
server.js          中繼伺服器 + 靜態網頁
public/index.html  手機頁面
public/app.js      連線 (MQTT / 中繼)、QR、蘑菇頭搖桿、按鈕
public/config.js   連線設定
public/vendor/     qrcode-generator (MIT)、mqtt.js (MIT)
index.html         GitHub Pages 入口 (導向 public/)
public/style.css   樣式
test/relay-test.js 整合測試
```
