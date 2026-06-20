const assert = require("assert");
const { getConnection, sql } = require("./db");
const { BackendSimulator } = require("./simulation");
const { MqttService } = require("./mqtt-service");

async function main() {
  const brokerUrl = process.env.MQTT_URL || "mqtt://localhost:1883";
  const pool = await getConnection();
  const simulator = new BackendSimulator({ getConnection, sql });
  const service = new MqttService({ simulator, brokerUrl });
  const marker = "[AUTO:Temperature]";
  const highValue = 35.77;
  const normalValue = 25.15;
  const maxLogId = (await pool.request().query("SELECT COALESCE(MAX(log_id), 0) AS id FROM [Log]"))
    .recordset[0].id;

  try {
    await pool.request().input("marker", sql.NVarChar, marker).query(`
      DELETE FROM AlertLog WHERE zone_id = 1 AND LEFT(message, LEN(@marker)) = @marker
    `);
    const topic = "greenhouse/1/zone/1/sensor/1/data";
    const invalidValue = 44.44;
    await service.handleMessage(
      "greenhouse/1/zone/2/sensor/1/data",
      Buffer.from(JSON.stringify({ value: invalidValue }))
    );
    const invalidWrite = await pool.request().input("value", sql.Decimal(10, 2), invalidValue)
      .query("SELECT COUNT(*) AS count FROM SensorData WHERE device_id = 1 AND raw_value = @value");
    assert.strictEqual(invalidWrite.recordset[0].count, 0, "Invalid MQTT topic wrote SensorData");
    await service.handleMessage(topic, Buffer.from(JSON.stringify({ value: highValue })));
    const active = await pool.request().input("marker", sql.NVarChar, marker).query(`
      SELECT TOP 1 status, message FROM AlertLog
      WHERE zone_id = 1 AND LEFT(message, LEN(@marker)) = @marker ORDER BY created_at DESC
    `);
    assert.strictEqual(active.recordset[0].status, "UNSOLVED");
    assert(active.recordset[0].message.includes("Nguồn: MQTT"));

    await service.handleMessage(topic, Buffer.from(JSON.stringify({ value: normalValue })));
    const resolved = await pool.request().input("marker", sql.NVarChar, marker).query(`
      SELECT TOP 1 status FROM AlertLog WHERE zone_id = 1
        AND LEFT(message, LEN(@marker)) = @marker ORDER BY created_at DESC
    `);
    assert.strictEqual(resolved.recordset[0].status, "RESOLVED");
    console.log(JSON.stringify({ topic, highValue, normalValue, alert: "created-and-resolved", result: "PASS" }, null, 2));
  } finally {
    service.close();
    await pool.request().input("high", sql.Decimal(10, 2), highValue)
      .input("normal", sql.Decimal(10, 2), normalValue).query(`
        DELETE FROM SensorData WHERE device_id = 1 AND raw_value IN (@high, @normal);
      `);
    await pool.request().input("marker", sql.NVarChar, marker)
      .query("DELETE FROM AlertLog WHERE zone_id = 1 AND LEFT(message, LEN(@marker)) = @marker");
    await pool.request().input("maxLogId", sql.Int, maxLogId)
      .query("DELETE FROM [Log] WHERE log_id > @maxLogId");
    await sql.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
