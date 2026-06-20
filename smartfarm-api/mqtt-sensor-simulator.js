const mqtt = require("mqtt");
require("dotenv").config();
const { getConnection, sql } = require("./db");

const BROKER_URL = process.env.MQTT_URL || "mqtt://127.0.0.1:1883";
const INTERVAL_MS = Math.max(1000, Number(process.env.MQTT_SENSOR_INTERVAL_MS) || 5000);
const METRIC_CONFIG = {
  Temperature: { base: 25, drift: 0.5, min: 10, max: 45 },
  Humidity: { base: 72, drift: 2, min: 0, max: 100 },
  SoilHumidity: { base: 68, drift: 2, min: 0, max: 100 },
  Light: { base: 14000, drift: 700, min: 0, max: 50000 },
  PH: { base: 6.3, drift: 0.12, min: 0, max: 14 },
  CO2: { base: 750, drift: 40, min: 200, max: 2000 }
};

const values = new Map();
let tick = 0;
let timer = null;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function nextValue(sensor) {
  const config = METRIC_CONFIG[sensor.metricType] || { base: 50, drift: 2, min: -9999, max: 9999 };
  const previous = values.get(sensor.deviceId) ?? config.base;
  let value = previous + (Math.random() * 2 - 1) * config.drift;
  const anomaly = tick > 0 && tick % 20 === sensor.deviceId % 20;
  if (anomaly && sensor.maxValue !== null) {
    const span = Math.max(Number(sensor.maxValue) - Number(sensor.minValue), config.drift * 2);
    value = Number(sensor.maxValue) + span * 0.5;
  } else if (sensor.minValue !== null && sensor.maxValue !== null) {
    const center = (Number(sensor.minValue) + Number(sensor.maxValue)) / 2;
    value += (center - value) * 0.25;
  }
  value = Number(clamp(value, config.min, config.max).toFixed(2));
  values.set(sensor.deviceId, value);
  return value;
}

async function loadSensors() {
  const pool = await getConnection();
  const result = await pool.request().query(`
    SELECT d.device_id AS deviceId, d.metric_type AS metricType,
      d.zone_id AS zoneId, z.greenhouse_id AS greenhouseId,
      threshold.min_value AS minValue, threshold.max_value AS maxValue
    FROM Device d
    JOIN Zone z ON z.zone_id = d.zone_id
    OUTER APPLY (
      SELECT TOP 1 th.min_value, th.max_value
      FROM GrowthStage gs JOIN Threshold th ON th.stage_id = gs.stage_id
      WHERE gs.recipe_id = z.recipe_id AND th.metric_type = d.metric_type
        AND z.start_date IS NOT NULL
        AND DATEDIFF(DAY, z.start_date, GETDATE()) + 1 - ISNULL(z.cycle_adjustment_days, 0)
          BETWEEN gs.start_day AND gs.end_day
      ORDER BY gs.start_day
    ) threshold
    WHERE d.device_type = 'SENSOR' AND d.status IN ('ONLINE', 'NEEDS_REPLACEMENT')
    ORDER BY d.device_id
  `);
  return result.recordset;
}

async function main() {
  const client = mqtt.connect(BROKER_URL, {
    clientId: `smartfarm-sensor-simulator-${Date.now()}`,
    reconnectPeriod: 3000
  });

  client.on("connect", () => {
    console.log(`✅ Sensor simulator đã kết nối ${BROKER_URL}`);
    console.log(`📡 Tải lại danh sách cảm biến và phát mỗi ${INTERVAL_MS / 1000} giây. Nhấn Ctrl+C để dừng.`);
    let publishing = false;
    const publishAll = async () => {
      if (publishing) return;
      publishing = true;
      try {
      const sensors = await loadSensors();
      if (!sensors.length) {
        console.warn("⚠️ Không có cảm biến đang hoạt động để mô phỏng");
        return;
      }
      tick += 1;
      for (const sensor of sensors) {
        const value = nextValue(sensor);
        const topic = `greenhouse/${sensor.greenhouseId}/zone/${sensor.zoneId}/sensor/${sensor.deviceId}/data`;
        const payload = JSON.stringify({
          metricType: sensor.metricType,
          value,
          timestamp: new Date().toISOString()
        });
        client.publish(topic, payload, { qos: 1, retain: false });
        console.log(`[${tick}] ${topic} -> ${sensor.metricType}=${value}`);
      }
      } catch (error) {
        console.error("❌ Lỗi tải/phát dữ liệu cảm biến:", error.message);
      } finally {
        publishing = false;
      }
    };
    void publishAll();
    timer = setInterval(() => void publishAll(), INTERVAL_MS);
  });
  client.on("error", (error) => console.error("❌ Lỗi MQTT simulator:", error.message));

  const shutdown = async () => {
    if (timer) clearInterval(timer);
    client.end(true);
    await sql.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch(async (error) => {
  console.error("❌ Không thể chạy sensor simulator:", error.message);
  await sql.close().catch(() => {});
  process.exitCode = 1;
});
