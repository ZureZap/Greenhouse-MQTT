/**
 * simulation.js
 * Mô phỏng dữ liệu cảm biến, đánh giá ngưỡng và điều khiển actuator ở chế độ AUTO.
 * Module này giữ cùng luồng xử lý mà MQTT sẽ gọi khi được tích hợp sau này.
 */

// ===================== SIMULATION RULES =====================

const METRIC_DEFAULTS = {
  Temperature: { base: 25, drift: 0.8, min: 10, max: 45 },
  Humidity: { base: 75, drift: 3, min: 0, max: 100 },
  SoilHumidity: { base: 68, drift: 3, min: 0, max: 100 },
  Light: { base: 14000, drift: 800, min: 0, max: 50000 },
  CO2: { base: 700, drift: 70, min: 200, max: 2000 },
  PH: { base: 6.3, drift: 0.2, min: 0, max: 14 }
};

const ACTUATOR_MAP = {
  Temperature: { low: ["Heating"], high: ["Cooling", "Ventilation"] },
  Humidity: { low: ["Misting"], high: ["Ventilation"] },
  SoilHumidity: { low: ["Irrigation"], high: [] },
  Light: { low: ["Lighting"], high: [] },
  CO2: { low: [], high: ["Ventilation"] }
};

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function classifyReading(value, minValue, maxValue) {
  if (minValue !== null && minValue !== undefined && value < Number(minValue)) return "low";
  if (maxValue !== null && maxValue !== undefined && value > Number(maxValue)) return "high";
  return "normal";
}

function severityFor(value, minValue, maxValue, direction) {
  const min = Number(minValue);
  const max = Number(maxValue);
  const span =
    Number.isFinite(max - min) && max > min ? max - min : Math.max(Math.abs(value) * 0.2, 1);
  const distance = direction === "low" ? min - value : value - max;
  return distance > span * 0.35 ? "CRITICAL" : "WARNING";
}

// ===================== SIMULATOR =====================

class BackendSimulator {
  constructor({ getConnection, sql, intervalMs = 10000 }) {
    this.getConnection = getConnection;
    this.sql = sql;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.tickNumber = 0;
    this.tickInProgress = false;
    this.lastTickAt = null;
    this.lastError = null;
  }

  getStatus() {
    return {
      running: Boolean(this.timer),
      intervalMs: this.intervalMs,
      tickNumber: this.tickNumber,
      lastTickAt: this.lastTickAt,
      lastError: this.lastError
    };
  }

  start(intervalMs = this.intervalMs) {
    const parsed = Number(intervalMs);
    if (Number.isFinite(parsed)) this.intervalMs = clamp(parsed, 1000, 3600000);
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(
      () =>
        this.tick().catch((error) => {
          this.lastError = error.message;
          console.error("Simulation tick failed:", error);
        }),
      this.intervalMs
    );
    return this.getStatus();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this.getStatus();
  }

  async tick() {
    if (this.tickInProgress) return { skipped: true, reason: "previous tick still running" };
    this.tickInProgress = true;
    try {
      const pool = await this.getConnection();
      const sensors = await pool.request().query(`
                SELECT device_id AS deviceId
                FROM Device
                WHERE device_type = 'SENSOR'
                  AND status IN ('ONLINE', 'NEEDS_REPLACEMENT')
                ORDER BY device_id
            `);
      const results = [];
      this.tickNumber += 1;
      for (const sensor of sensors.recordset) {
        results.push(await this.processReading(sensor.deviceId, null, null, "SIMULATOR"));
      }
      this.lastTickAt = new Date().toISOString();
      this.lastError = null;
      return { skipped: false, readings: results.length, results };
    } finally {
      this.tickInProgress = false;
    }
  }

  async resetExpiredManualControls(pool) {
    await pool.request().query(`
      DECLARE @ResetDevices TABLE (device_id INT);
      UPDATE ControlProperties
      SET mode = 'AUTO', auto_reset_time = NULL
      OUTPUT INSERTED.device_id INTO @ResetDevices(device_id)
      WHERE mode = 'MANUAL' AND auto_reset_time IS NOT NULL
        AND auto_reset_time <= GETDATE();

      INSERT INTO [Log] (device_id, user_id, action, triggered_by, log_time)
      SELECT device_id, NULL,
        N'Tự động chuyển thiết bị về chế độ AUTO sau khi hết thời gian điều khiển thủ công.',
        'SYSTEM', GETDATE()
      FROM @ResetDevices;
    `);
  }

  async processReading(
    deviceId,
    suppliedValue = null,
    timestamp = null,
    source = "MANUAL_TEST",
    expectedContext = null
  ) {
    const pool = await this.getConnection();
    await this.resetExpiredManualControls(pool);
    const contextResult = await pool.request().input("deviceId", this.sql.Int, deviceId).query(`
                SELECT d.device_id AS deviceId, d.device_name AS deviceName,
                    d.metric_type AS metricType, d.status AS deviceStatus,
                    z.zone_id AS zoneId, z.zone_name AS zoneName,
                    z.greenhouse_id AS greenhouseId,
                    latest.raw_value AS latestValue,
                    threshold.min_value AS minValue, threshold.max_value AS maxValue,
                    threshold.stage_name AS stageName
                FROM Device d
                JOIN Zone z ON d.zone_id = z.zone_id
                OUTER APPLY (
                    SELECT TOP 1 sd.raw_value
                    FROM SensorData sd
                    WHERE sd.device_id = d.device_id
                    ORDER BY sd.[timestamp] DESC
                ) latest
                OUTER APPLY (
                    SELECT TOP 1 th.min_value, th.max_value, gs.stage_name
                    FROM GrowthStage gs
                    JOIN Threshold th ON th.stage_id = gs.stage_id
                    WHERE gs.recipe_id = z.recipe_id AND th.metric_type = d.metric_type
                      AND z.start_date IS NOT NULL
                      AND DATEDIFF(DAY, z.start_date, GETDATE()) + 1
                          - ISNULL(z.cycle_adjustment_days, 0)
                          BETWEEN gs.start_day AND gs.end_day
                    ORDER BY gs.start_day
                ) threshold
                WHERE d.device_id = @deviceId AND d.device_type = 'SENSOR'
            `);

    if (contextResult.recordset.length === 0) {
      const error = new Error("Không tìm thấy cảm biến");
      error.statusCode = 404;
      throw error;
    }

    const context = contextResult.recordset[0];
    if (expectedContext &&
        (Number(context.greenhouseId) !== Number(expectedContext.greenhouseId) ||
         Number(context.zoneId) !== Number(expectedContext.zoneId))) {
      const error = new Error("Greenhouse/Zone trong topic không khớp với cảm biến");
      error.statusCode = 400;
      throw error;
    }
    let value =
      suppliedValue === null || suppliedValue === undefined
        ? this.generateValue(context)
        : Number(suppliedValue);
    if (!Number.isFinite(value)) {
      const error = new Error("Giá trị cảm biến không hợp lệ");
      error.statusCode = 400;
      throw error;
    }
    value = Number(value.toFixed(2));

    await pool
      .request()
      .input("deviceId", this.sql.Int, context.deviceId)
      .input("timestamp", this.sql.DateTime2, timestamp ? new Date(timestamp) : null)
      .input("value", this.sql.Decimal(10, 2), value).query(`
                DECLARE @recordedAt DATETIME2 = COALESCE(@timestamp, GETDATE());
                BEGIN TRANSACTION;
                BEGIN TRY
                  IF NOT EXISTS (
                    SELECT 1 FROM SensorData WITH (UPDLOCK, HOLDLOCK)
                    WHERE device_id = @deviceId AND [timestamp] = @recordedAt
                  )
                    INSERT INTO SensorData (device_id, [timestamp], raw_value)
                    VALUES (@deviceId, @recordedAt, @value);
                  UPDATE Device SET last_heartbeat = @recordedAt,
                      status = CASE WHEN status = 'ONLINE' THEN 'ONLINE' ELSE status END
                  WHERE device_id = @deviceId;
                  COMMIT TRANSACTION;
                END TRY
                BEGIN CATCH
                  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;
                  THROW;
                END CATCH
            `);

    if (context.metricType === "Temperature" || context.metricType === "Humidity") {
      const column = context.metricType === "Temperature" ? "temperature" : "humidity";
      await pool
        .request()
        .input("zoneId", this.sql.Int, context.zoneId)
        .input(
          "value",
          context.metricType === "Temperature" ? this.sql.Decimal(5, 2) : this.sql.Int,
          value
        )
        .query(`UPDATE Zone SET ${column} = @value WHERE zone_id = @zoneId`);
    }

    const direction = classifyReading(value, context.minValue, context.maxValue);
    const alert = await this.syncAlert(pool, context, value, direction, source);
    await this.syncZoneStatus(pool, context.zoneId);
    const controls = await this.syncControls(pool, context, direction);
    return {
      deviceId: context.deviceId,
      zoneId: context.zoneId,
      greenhouseId: context.greenhouseId,
      metricType: context.metricType,
      value,
      direction,
      threshold:
        context.minValue === null ? null : { min: context.minValue, max: context.maxValue },
      alert,
      controls
    };
  }

  generateValue(context) {
    const config = METRIC_DEFAULTS[context.metricType] || {
      base: 50,
      drift: 2,
      min: -9999,
      max: 9999
    };
    const previous = context.latestValue === null ? config.base : Number(context.latestValue);
    let value = previous + (Math.random() * 2 - 1) * config.drift;
    const anomalyTurn = this.tickNumber > 0 && this.tickNumber % 20 === context.deviceId % 20;
    if (anomalyTurn && context.maxValue !== null) {
      const span = Number(context.maxValue) - Number(context.minValue || 0);
      value = Number(context.maxValue) + Math.max(span * 0.5, config.drift * 2);
    }
    return clamp(value, config.min, config.max);
  }

  async syncAlert(pool, context, value, direction, source) {
    if (context.minValue === null || context.minValue === undefined) return null;
    const marker = `[AUTO:${context.metricType}]`;
    const activeResult = await pool
      .request()
      .input("zoneId", this.sql.Int, context.zoneId)
      .input("marker", this.sql.NVarChar, marker).query(`SELECT TOP 1 alert_id FROM AlertLog
                    WHERE zone_id = @zoneId AND LEFT(message, LEN(@marker)) = @marker AND status <> 'RESOLVED'
                    ORDER BY created_at DESC`);

    if (direction === "normal") {
      if (activeResult.recordset.length > 0) {
        await pool
          .request()
          .input("id", this.sql.Int, activeResult.recordset[0].alert_id)
          .query(
            `UPDATE AlertLog SET status = 'RESOLVED', resolved_at = GETDATE() WHERE alert_id = @id`
          );
        return { action: "resolved", id: activeResult.recordset[0].alert_id };
      }
      return null;
    }

    const severity = severityFor(value, context.minValue, context.maxValue, direction);
    const limit = direction === "low" ? context.minValue : context.maxValue;
    const message = `${marker} ${context.deviceName} tại ${context.zoneName}: ${value} ${direction === "low" ? "thấp hơn" : "cao hơn"} ngưỡng ${limit}. Nguồn: ${source}.`;
    if (activeResult.recordset.length > 0) {
      await pool
        .request()
        .input("id", this.sql.Int, activeResult.recordset[0].alert_id)
        .input("message", this.sql.NVarChar, message)
        .input("severity", this.sql.NVarChar, severity)
        .query(`UPDATE AlertLog SET message = @message, severity = @severity,
                        escalation_level = CASE WHEN DATEDIFF(MINUTE, created_at, GETDATE()) >= 10 THEN 2 ELSE 1 END
                        WHERE alert_id = @id`);
      return {
        action: "updated",
        id: activeResult.recordset[0].alert_id,
        severity
      };
    }
    const inserted = await pool
      .request()
      .input("zoneId", this.sql.Int, context.zoneId)
      .input("message", this.sql.NVarChar, message)
      .input("severity", this.sql.NVarChar, severity)
      .query(`INSERT INTO AlertLog (zone_id, message, severity, status, escalation_level)
                    OUTPUT INSERTED.alert_id AS id
                    VALUES (@zoneId, @message, @severity, 'UNSOLVED', 1)`);
    return { action: "created", id: inserted.recordset[0].id, severity };
  }

  async syncZoneStatus(pool, zoneId) {
    await pool.request().input("zoneId", this.sql.Int, zoneId).query(`
      UPDATE Zone
      SET status = CASE
        WHEN EXISTS (
          SELECT 1 FROM AlertLog
          WHERE zone_id = @zoneId AND status <> 'RESOLVED'
            AND severity = 'CRITICAL'
        ) THEN 'high'
        WHEN EXISTS (
          SELECT 1 FROM AlertLog
          WHERE zone_id = @zoneId AND status <> 'RESOLVED'
            AND severity = 'WARNING'
        ) THEN 'warning'
        ELSE 'optimal'
      END
      WHERE zone_id = @zoneId
    `);
  }

  async syncControls(pool, context, direction) {
    const mapping = ACTUATOR_MAP[context.metricType];
    if (!mapping) return [];
    const targetTypes =
      direction === "normal" ? [...mapping.low, ...mapping.high] : mapping[direction];
    if (!targetTypes || targetTypes.length === 0) return [];
    const requiredTypes = await this.getRequiredActuatorTypes(pool, context.zoneId);
    const result = await pool.request().input("zoneId", this.sql.Int, context.zoneId).query(`
            SELECT d.device_id AS deviceId, d.device_name AS deviceName, d.metric_type AS metricType,
                cp.is_active AS isActive, cp.value_percent AS valuePercent
            FROM Device d
            JOIN ControlProperties cp ON cp.device_id = d.device_id
            WHERE d.zone_id = @zoneId AND d.device_type = 'OUTPUT_DEVICE'
              AND d.status = 'ONLINE' AND cp.mode = 'AUTO'
        `);
    const changed = [];
    for (const actuator of result.recordset.filter((row) => targetTypes.includes(row.metricType))) {
      const shouldActivate = requiredTypes.has(actuator.metricType);
      const targetValue = shouldActivate ? 80 : 0;
      if (
        Boolean(actuator.isActive) === shouldActivate &&
        Number(actuator.valuePercent) === targetValue
      )
        continue;
      await pool
        .request()
        .input("deviceId", this.sql.Int, actuator.deviceId)
        .input("active", this.sql.Bit, shouldActivate)
        .input("value", this.sql.Int, targetValue)
        .query(`UPDATE ControlProperties SET is_active = @active, value_percent = @value
                        WHERE device_id = @deviceId`);
      const action = `${shouldActivate ? "Tự động bật" : "Tự động tắt"} ${actuator.deviceName} do ${context.metricType} ${direction}.`;
      await pool
        .request()
        .input("deviceId", this.sql.Int, actuator.deviceId)
        .input("action", this.sql.NVarChar, action).query(`INSERT INTO [Log]
                  (device_id, user_id, entity_type, entity_id, action, triggered_by)
                VALUES
                  (@deviceId, NULL, 'DEVICE', @deviceId, @action, 'SYSTEM')`);
      changed.push({
        deviceId: actuator.deviceId,
        active: shouldActivate,
        valuePercent: targetValue
      });
    }
    return changed;
  }

  async getRequiredActuatorTypes(pool, zoneId) {
    const result = await pool.request().input("zoneId", this.sql.Int, zoneId).query(`
            SELECT d.metric_type AS metricType, latest.raw_value AS latestValue,
                threshold.min_value AS minValue, threshold.max_value AS maxValue
            FROM Device d
            JOIN Zone z ON z.zone_id = d.zone_id
            OUTER APPLY (
                SELECT TOP 1 sd.raw_value
                FROM SensorData sd
                WHERE sd.device_id = d.device_id
                ORDER BY sd.[timestamp] DESC
            ) latest
            OUTER APPLY (
                SELECT TOP 1 th.min_value, th.max_value
                FROM GrowthStage gs
                JOIN Threshold th ON th.stage_id = gs.stage_id
                WHERE gs.recipe_id = z.recipe_id AND th.metric_type = d.metric_type
                  AND z.start_date IS NOT NULL
                  AND DATEDIFF(DAY, z.start_date, GETDATE()) + 1
                      - ISNULL(z.cycle_adjustment_days, 0)
                      BETWEEN gs.start_day AND gs.end_day
                ORDER BY gs.start_day
            ) threshold
            WHERE d.zone_id = @zoneId AND d.device_type = 'SENSOR'
              AND d.status IN ('ONLINE', 'NEEDS_REPLACEMENT')
        `);
    const requiredTypes = new Set();
    for (const sensor of result.recordset) {
      if (sensor.latestValue === null || sensor.minValue === null) continue;
      const sensorDirection = classifyReading(
        Number(sensor.latestValue),
        sensor.minValue,
        sensor.maxValue
      );
      if (sensorDirection === "normal") continue;
      const sensorMapping = ACTUATOR_MAP[sensor.metricType];
      for (const actuatorType of sensorMapping?.[sensorDirection] || []) {
        requiredTypes.add(actuatorType);
      }
    }
    return requiredTypes;
  }
}

module.exports = { BackendSimulator, clamp, classifyReading, severityFor };
