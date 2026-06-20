const assert = require("assert");
const { getConnection, sql } = require("./db");

async function main() {
  const pool = await getConnection();
  try {
    const result = await pool.request().query(`
      SELECT COUNT(DISTINCT metric_type) AS metricCount
      FROM Device WHERE device_type = 'SENSOR'
        AND metric_type IN ('Temperature','Humidity','Light','SoilHumidity','PH','CO2');
      SELECT COUNT(*) AS invalidLogs FROM [Log]
      WHERE (triggered_by = 'SYSTEM' AND user_id IS NOT NULL)
         OR (triggered_by = 'USER' AND user_id IS NULL);
      SELECT COUNT(*) AS duplicateAlerts FROM (
        SELECT zone_id, LEFT(message, CHARINDEX(']', message + ']')) AS marker
        FROM AlertLog WHERE status <> 'RESOLVED' AND LEFT(message, 6) = '[AUTO:'
        GROUP BY zone_id, LEFT(message, CHARINDEX(']', message + ']'))
        HAVING COUNT(*) > 1
      ) duplicates;
      SELECT COUNT(*) AS orphanAlerts FROM AlertLog alert
      LEFT JOIN Zone zone ON zone.zone_id = alert.zone_id
      WHERE zone.zone_id IS NULL;
    `);
    const summary = result.recordsets.map((rows) => rows[0]);
    assert.strictEqual(summary[0].metricCount, 6, "Database does not contain all six metrics");
    assert.strictEqual(summary[1].invalidLogs, 0, "Log has invalid triggered_by/user_id data");
    assert.strictEqual(summary[2].duplicateAlerts, 0, "Active automatic alerts are duplicated");
    assert.strictEqual(summary[3].orphanAlerts, 0, "AlertLog contains orphan zone references");
    console.log(JSON.stringify({ ...summary[0], ...summary[1], ...summary[2], ...summary[3], result: "PASS" }, null, 2));
  } finally {
    await sql.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
