/*
 * 手機網頁連線設定
 *
 * transport:
 *   'mqtt'  —— 放在 GitHub Pages 等靜態網站時使用，透過 MQTT broker 和機台 PC 溝通 (免架伺服器)
 *   'relay' —— 由 server.js 提供網頁時使用 (server.js 會自動改成 relay)
 *
 * mqttUrl / topicRoot 必須和 Unity crane_settings.json 的 mqttUrl / mqttTopicRoot 一樣。
 * 手機網址的 ?m=<機台ID> 必須和 Unity 的 machineId 一樣。
 */
window.CRANE_CONFIG = {
  transport: 'mqtt',
  mqttUrl: 'wss://broker.emqx.io:8084/mqtt',
  topicRoot: 'dcrane/adh2cv4agu',
  defaultMachine: 'crane01',
};
