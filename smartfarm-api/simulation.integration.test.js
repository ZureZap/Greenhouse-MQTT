/**
 * Integration test for SensorData -> AlertLog -> AUTO actuator.
 * The test restores database state in the finally block.
 */

const assert = require("assert");
const { getConnection, sql } = require("./db");
const { BackendSimulator } = require("./simulation");

async function main() {
  const pool = await getConnection();
  const simulator = new BackendSimulator({ getConnection, sql });
  const contextResult = await pool.request().query(`
        SELECT TOP 1 d.device_id AS sensorId, d.zone_id AS zoneId,
            z.temperature, z.humidity, z.status AS zoneStatus,
            th.min_value AS minValue, th.max_value AS maxValue
        FROM Device d
        JOIN Zone z ON z.zone_id = d.zone_id
        JOIN GrowthStage gs ON gs.recipe_id = z.recipe_id
        JOIN Threshold th ON th.stage_id = gs.stage_id AND th.metric_type = d.metric_type
        WHERE d.device_type = 'SENSOR' AND d.metric_type = 'Temperature'
          AND d.status IN ('ONLINE', 'NEEDS_REPLACEMENT')
          AND EXISTS (
              SELECT 1 FROM Device outputDevice
              JOIN ControlProperties cp ON cp.device_id = outputDevice.device_id
              WHERE outputDevice.zone_id = d.zone_id
                AND outputDevice.device_type = 'OUTPUT_DEVICE'
                AND outputDevice.metric_type IN ('Cooling', 'Ventilation')
                AND outputDevice.status = 'ONLINE' AND cp.mode = 'AUTO'
          )
        ORDER BY CASE
            WHEN z.start_date IS NOT NULL
             AND DATEDIFF(DAY, z.start_date, GETDATE()) + 1 BETWEEN gs.start_day AND gs.end_day THEN 0
            WHEN gs.completed = 0 THEN 1 ELSE 2 END,
            gs.start_day
    `);
  assert(contextResult.recordset.length > 0, "No suitable Temperature sensor was found");

  const context = contextResult.recordset[0];
  const controlsResult = await pool.request().input("zoneId", sql.Int, context.zoneId).query(`
        SELECT d.device_id AS deviceId, cp.is_active AS isActive, cp.value_percent AS valuePercent
        FROM Device d JOIN ControlProperties cp ON cp.device_id = d.device_id
        WHERE d.zone_id = @zoneId AND d.device_type = 'OUTPUT_DEVICE'
          AND d.metric_type IN ('Cooling', 'Ventilation') AND cp.mode = 'AUTO'
    `);
  const originalControls = controlsResult.recordset;
  const maxLogResult = await pool
    .request()
    .query("SELECT COALESCE(MAX(log_id), 0) AS id FROM [Log]");
  const maxLogId = maxLogResult.recordset[0].id;
  const marker = "[AUTO:Temperature]";
  const highValue = Number(context.maxValue) + 7.77;
  const normalValue = Number(
    (
      Number(context.minValue) +
      (Number(context.maxValue) - Number(context.minValue)) * 0.43
    ).toFixed(2)
  );

  try {
    // Start from a deterministic actuator state; finally restores the original values.
    for (const control of originalControls) {
      await pool.request().input("deviceId", sql.Int, control.deviceId)
        .query(`UPDATE ControlProperties SET is_active = 0, value_percent = 0
                WHERE device_id = @deviceId`);
    }

    await pool
      .request()
      .input("zoneId", sql.Int, context.zoneId)
      .input("marker", sql.NVarChar, marker).query(`DELETE FROM AlertLog
                    WHERE zone_id = @zoneId AND LEFT(message, LEN(@marker)) = @marker`);

    const high = await simulator.processReading(
      context.sensorId,
      highValue,
      null,
      "INTEGRATION_TEST"
    );
    assert.strictEqual(high.direction, "high");
    assert.strictEqual(high.alert.action, "created");
    assert(
      high.controls.some((control) => control.active),
      "AUTO actuator was not enabled"
    );
    const systemLog = await pool.request().input("maxLogId", sql.Int, maxLogId).query(`
      SELECT COUNT(*) AS logCount FROM [Log]
      WHERE log_id > @maxLogId AND triggered_by = 'SYSTEM' AND user_id IS NULL
    `);
    assert(systemLog.recordset[0].logCount > 0, "Automatic control did not create a system Log");
    const activeState = await pool.request().input("zoneId", sql.Int, context.zoneId)
      .input("marker", sql.NVarChar, marker).query(`
        SELECT COUNT(*) AS alertCount FROM AlertLog
        WHERE zone_id = @zoneId AND LEFT(message, LEN(@marker)) = @marker
          AND status = 'UNSOLVED';
        SELECT status FROM Zone WHERE zone_id = @zoneId;
      `);
    assert.strictEqual(activeState.recordsets[0][0].alertCount, 1, "AlertLog was not created");
    assert.notStrictEqual(activeState.recordsets[1][0].status, "optimal", "Zone status was not updated");

    const normal = await simulator.processReading(
      context.sensorId,
      normalValue,
      null,
      "INTEGRATION_TEST"
    );
    assert.strictEqual(normal.direction, "normal");
    assert.strictEqual(normal.alert.action, "resolved");

    const databaseState = await pool
      .request()
      .input("sensorId", sql.Int, context.sensorId)
      .input("zoneId", sql.Int, context.zoneId)
      .input("marker", sql.NVarChar, marker).query(`
                SELECT TOP 1 raw_value AS latestValue FROM SensorData
                WHERE device_id = @sensorId ORDER BY [timestamp] DESC;
                SELECT TOP 1 status, resolved_at AS resolvedAt FROM AlertLog
                WHERE zone_id = @zoneId AND LEFT(message, LEN(@marker)) = @marker
                ORDER BY created_at DESC;
            `);
    assert.strictEqual(Number(databaseState.recordsets[0][0].latestValue), normalValue);
    assert.strictEqual(databaseState.recordsets[1][0].status, "RESOLVED");
    assert(databaseState.recordsets[1][0].resolvedAt, "Alert has no resolved timestamp");
    const resolvedZone = await pool.request().input("zoneId", sql.Int, context.zoneId).query(`
      SELECT z.status,
        CASE
          WHEN EXISTS (SELECT 1 FROM AlertLog a WHERE a.zone_id = z.zone_id
            AND a.status <> 'RESOLVED'
            AND a.severity = 'CRITICAL') THEN 'high'
          WHEN EXISTS (SELECT 1 FROM AlertLog a WHERE a.zone_id = z.zone_id
            AND a.status <> 'RESOLVED'
            AND a.severity = 'WARNING') THEN 'warning'
          ELSE 'optimal'
        END AS expectedStatus
      FROM Zone z WHERE z.zone_id = @zoneId
    `);
    assert.strictEqual(resolvedZone.recordset[0].status, resolvedZone.recordset[0].expectedStatus);

    console.log(
      JSON.stringify(
        {
          sensorId: context.sensorId,
          zoneId: context.zoneId,
          high: {
            value: highValue,
            alert: high.alert,
            controls: high.controls
          },
          normal: {
            value: normalValue,
            alert: normal.alert,
            controls: normal.controls
          },
          result: "PASS"
        },
        null,
        2
      )
    );
  } finally {
    await pool
      .request()
      .input("sensorId", sql.Int, context.sensorId)
      .input("highValue", sql.Decimal(10, 2), highValue)
      .input("normalValue", sql.Decimal(10, 2), normalValue).query(`
                WITH LatestHigh AS (
                    SELECT TOP 1 * FROM SensorData
                    WHERE device_id = @sensorId AND raw_value = @highValue
                    ORDER BY [timestamp] DESC
                ) DELETE FROM LatestHigh;
                WITH LatestNormal AS (
                    SELECT TOP 1 * FROM SensorData
                    WHERE device_id = @sensorId AND raw_value = @normalValue
                    ORDER BY [timestamp] DESC
                ) DELETE FROM LatestNormal;
            `);
    await pool
      .request()
      .input("zoneId", sql.Int, context.zoneId)
      .input("marker", sql.NVarChar, marker).query(`DELETE FROM AlertLog
                    WHERE zone_id = @zoneId AND LEFT(message, LEN(@marker)) = @marker`);
    await pool
      .request()
      .input("maxLogId", sql.Int, maxLogId)
      .query("DELETE FROM [Log] WHERE log_id > @maxLogId");
    for (const control of originalControls) {
      await pool
        .request()
        .input("deviceId", sql.Int, control.deviceId)
        .input("active", sql.Bit, control.isActive)
        .input("value", sql.Int, control.valuePercent)
        .query(`UPDATE ControlProperties SET is_active = @active, value_percent = @value
                        WHERE device_id = @deviceId`);
    }
    await pool
      .request()
      .input("zoneId", sql.Int, context.zoneId)
      .input("temperature", sql.Decimal(5, 2), context.temperature)
      .input("humidity", sql.Int, context.humidity)
      .input("status", sql.NVarChar, context.zoneStatus)
      .query(`UPDATE Zone SET temperature = @temperature, humidity = @humidity, status = @status
                    WHERE zone_id = @zoneId`);
    await sql.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
