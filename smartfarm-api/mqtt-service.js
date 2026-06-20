const mqtt = require("mqtt");

const SENSOR_TOPIC = "greenhouse/+/zone/+/sensor/+/data";
const SHARED_SENSOR_TOPIC = `$share/smartfarm-backend/${SENSOR_TOPIC}`;
const SENSOR_TOPIC_PATTERN = /^greenhouse\/(\d+)\/zone\/(\d+)\/sensor\/(\d+)\/data$/;

class MqttService {
  constructor({ simulator, brokerUrl = "mqtt://localhost:1883" }) {
    this.simulator = simulator;
    this.brokerUrl = brokerUrl;
    this.client = null;
  }

  connect() {
    if (this.client) return this.client;
    this.client = mqtt.connect(this.brokerUrl, {
      clientId: `smartfarm-server-${Date.now()}`,
      clean: true,
      reconnectPeriod: 3000,
      connectTimeout: 10000
    });

    this.client.on("connect", () => {
      console.log(`✅ Đã kết nối MQTT: ${this.brokerUrl}`);
      this.client.subscribe(SHARED_SENSOR_TOPIC, { qos: 1 }, (error) => {
        if (error) console.error("❌ Không thể subscribe MQTT:", error.message);
        else console.log(`📡 Đang nghe MQTT topic: ${SHARED_SENSOR_TOPIC}`);
      });
    });
    this.client.on("message", (topic, payload) => this.handleMessage(topic, payload));
    this.client.on("reconnect", () => console.log("⏳ Đang kết nối lại MQTT..."));
    this.client.on("error", (error) => console.error("❌ Lỗi MQTT:", error.message));
    return this.client;
  }

  async handleMessage(topic, payload) {
    try {
      const match = topic.match(SENSOR_TOPIC_PATTERN);
      if (!match) throw new Error("Topic cảm biến không hợp lệ");
      const [, greenhouseIdText, zoneIdText, deviceIdText] = match;
      const greenhouseId = Number(greenhouseIdText);
      const zoneId = Number(zoneIdText);
      const deviceId = Number(deviceIdText);
      const data = JSON.parse(payload.toString("utf8"));
      const value = Number(data.value);
      if (!Number.isFinite(value)) throw new Error("Payload phải có value dạng số");

      const result = await this.simulator.processReading(
        deviceId,
        value,
        data.timestamp || null,
        "MQTT",
        { greenhouseId, zoneId }
      );
      for (const control of result.controls || []) {
        this.publishCommand({ greenhouseId, zoneId, ...control });
      }
      console.log(`📥 MQTT ${result.metricType}=${result.value} tại Zone #${zoneId}`);
    } catch (error) {
      console.error(`❌ Bỏ qua MQTT message '${topic}':`, error.message);
    }
  }

  publishCommand({ greenhouseId, zoneId, deviceId, active, valuePercent }) {
    if (!this.client?.connected) return false;
    const topic = `greenhouse/${greenhouseId}/zone/${zoneId}/device/${deviceId}/command`;
    const payload = JSON.stringify({
      action: active ? "TURN_ON" : "TURN_OFF",
      valuePercent,
      mode: "AUTO",
      timestamp: new Date().toISOString()
    });
    this.client.publish(topic, payload, { qos: 1, retain: false });
    console.log(`📤 MQTT command ${topic}: ${payload}`);
    return true;
  }

  close() {
    if (this.client) this.client.end(true);
    this.client = null;
  }
}

module.exports = { MqttService, SENSOR_TOPIC, SHARED_SENSOR_TOPIC, SENSOR_TOPIC_PATTERN };
