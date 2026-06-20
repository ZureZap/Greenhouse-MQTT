const assert = require("assert");
const { getConnection, sql } = require("./db");

(async () => {
  const pool = await getConnection();
  try {
    const result = await pool.request().query(`
      SELECT alert.alert_id AS id, alert.zone_id, zone.greenhouse_id,
        alert.severity, alert.status
      FROM AlertLog alert
      JOIN Zone zone ON zone.zone_id = alert.zone_id
    `);
    assert(result.recordset.length > 0, "No alerts found for filter test");
    assert(result.recordset.every((row) => row.greenhouse_id), "Alert is missing greenhouse_id");
    assert(result.recordset.every((row) => ["SIGNIFICANT", "WARNING", "CRITICAL"].includes(row.severity)));
    console.log(JSON.stringify({ alerts: result.recordset.length, greenhouses: new Set(result.recordset.map((row) => row.greenhouse_id)).size, severities: [...new Set(result.recordset.map((row) => row.severity))], result: "PASS" }, null, 2));
  } finally {
    await sql.close();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
